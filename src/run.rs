// Starting turns, following their output, and stopping them.

use crate::app::{App, Fail, Proc, R, St, now};
use crate::harness::{self, Event, Launch};
use rusqlite::params;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

pub fn kill_group(pid: u32, sig: i32) {
    unsafe {
        libc::kill(-(pid as i32), sig);
    }
}

/// Whether a PID still belongs to this agent of this server, not a process that reused the number.
pub fn is_our_agent(pid: u32, id: i64, url: &str) -> bool {
    let Ok(env) = std::fs::read(format!("/proc/{pid}/environ")) else {
        return false;
    };
    let vars: Vec<&[u8]> = env.split(|&b| b == 0).collect();
    vars.contains(&format!("ACOM_ID={id}").as_bytes())
        && vars.contains(&format!("ACOM_URL={url}").as_bytes())
}

/// SIGTERM the agent's process group, then SIGKILL whatever is left a few seconds later.
pub fn stop(pid: u32) {
    kill_group(pid, libc::SIGTERM);
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(5));
        if unsafe { libc::kill(-(pid as i32), 0) } == 0 {
            kill_group(pid, libc::SIGKILL);
        }
    });
}

pub fn log_path(app: &App, id: i64, ext: &str) -> PathBuf {
    app.home.join("logs").join(format!("{id}.{ext}"))
}

fn append(path: &PathBuf, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// A child waiting for its prompt. Until the surrounding transaction commits,
/// dropping this value stops and reaps it without delivering the task.
pub(crate) struct PreparedTurn {
    child: Option<Child>,
    input: Option<String>,
    harness: String,
    model: String,
    effort: String,
    resume: bool,
    turns: i64,
    err_from: u64,
}

impl Drop for PreparedTurn {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            kill_group(child.id(), libc::SIGKILL);
            let _ = child.wait();
        }
    }
}

/// Start one turn of an agent with this prompt. The agent becomes `working`.
pub fn start_turn(
    app: &Arc<App>,
    st: &mut St,
    id: i64,
    prompt: &str,
    replaces: Option<i64>,
) -> R<()> {
    st.db.execute_batch("SAVEPOINT turn_preparation")?;
    let result = prepare_turn(app, st, id, prompt, replaces);
    match result {
        Ok(turn) => {
            if let Err(e) = st.db.execute_batch("RELEASE turn_preparation") {
                let _ = st
                    .db
                    .execute_batch("ROLLBACK TO turn_preparation; RELEASE turn_preparation");
                return Err(e.into());
            }
            activate_turn(app, st, id, turn);
            Ok(())
        }
        Err(e) => {
            st.db
                .execute_batch("ROLLBACK TO turn_preparation; RELEASE turn_preparation")?;
            Err(e)
        }
    }
}

pub(crate) fn prepare_turn(
    app: &Arc<App>,
    st: &mut St,
    id: i64,
    prompt: &str,
    replaces: Option<i64>,
) -> R<PreparedTurn> {
    if st.db.is_autocommit() {
        return Err(crate::app::bad("turn preparation requires a transaction"));
    }
    if st.procs.contains_key(&id) {
        return Err(crate::app::conflict(format!(
            "agent {id} is still stopping; try again in a moment"
        )));
    }
    let a = st.agent(id)?;
    if a.state == "replaced" {
        return Err(crate::app::conflict(
            "a replaced agent is read-only; use its replacement",
        ));
    }
    let s = st.settings_for(Some(a.project));
    let (turns, started): (i64, bool) = st.db.query_row(
        "SELECT turns, session_started FROM agents WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let flags = s
        .harnesses
        .get(&a.harness)
        .map(|h| h.flags.clone())
        .unwrap_or_default();
    // The working transition reconciles live memberships before taking updates
    // or rendering a prompt. Failed starts roll all of this back, including
    // notification/history cursors. The mutex also prevents concurrent posts.
    st.expire_locks()?;
    if st
        .db
        .execute("DELETE FROM agent_continuations WHERE agent_id=?1", [id])?
        > 0
    {
        st.event(
            a.project,
            Some(id),
            None,
            "agent.continuation-started",
            "acom",
            serde_json::json!({"model":a.model,"effort":a.effort}),
        )?;
    }
    st.set_state(id, "working")?;
    let updates = st.take_updates(id)?;
    let summary = st.coordination_summary(id, true)?;
    let prompt = [prompt.to_string(), updates, summary]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = prompt.as_str();
    // Resume only a session the harness actually started. Otherwise this is a fresh
    // session (e.g. the first turn crashed early), which needs the briefing again.
    let resume = started && a.session.is_some();
    let briefed;
    let prompt = if resume {
        // Closed/crashed agents do not receive rule-change notices. Refresh every
        // continuation, after queued notices so older rules cannot be the last word.
        briefed = format!(
            "{prompt}\n\n## Running configuration\n\n{} / {} / effort {}\n\n## Limits and rules right now\n\n{}",
            a.harness,
            a.model,
            a.effort,
            st.limits_text(Some(a.project))?
        );
        &briefed
    } else if turns > 0 {
        briefed = format!("{}\n{prompt}", app.briefing(st, id)?);
        &briefed
    } else {
        prompt
    };
    let launch = Launch {
        harness: &a.harness,
        model: &a.model,
        effort: &a.effort,
        session: a.session.as_deref(),
        resume,
        prompt,
        // 0: no hard context limit, so the harness keeps its own default.
        context_limit: s.limits.context.hard.map_or(0, |h| h as u64),
        flags: &flags,
        acom: &app.exe,
    };
    let (mut cmd, input) = harness::command(&launch);
    let bin_dir = app
        .exe
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    #[cfg(not(test))]
    let path = format!("{bin_dir}:{}", std::env::var("PATH").unwrap_or_default());
    // Unit fixtures never search the user's PATH: a missing/invalid fake client
    // must fail rather than fall through to an installed provider client.
    #[cfg(test)]
    let path = bin_dir;
    let err_from = std::fs::metadata(log_path(app, id, "err")).map_or(0, |m| m.len());
    let err = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path(app, id, "err"))
        .map_err(|e| Fail(500, e.to_string()))?;
    let (_, project_dir) = st.project(a.project)?;
    cmd.current_dir(project_dir)
        .env("ACOM_ID", id.to_string())
        .env("ACOM_URL", &app.url)
        .env("PATH", path)
        .stdout(Stdio::piped())
        .stderr(err)
        .process_group(0);
    if input.is_none() {
        cmd.stdin(Stdio::null());
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| Fail(500, format!("can't start {}: {e}", a.harness)))?;
    let pid = child.id();
    // Don't feed the task or register a worker until its state is saved. A DB
    // failure after spawn must stop and reap the child, not leave it unattended.
    let saved = (|| -> R<()> {
        st.db.execute_batch("SAVEPOINT turn_start")?;
        st.db.execute(
            "UPDATE agents SET seen_model=NULL,state='working',pid=?2,turns=turns+1,ended_at=NULL WHERE id=?1",
            params![id, pid])?;
        if let Some(old) = replaces {
            let changed = st.db.execute(
                "UPDATE agents SET state='replaced' WHERE id=?1 AND state IN ('crashed','done')",
                [old],
            )?;
            if changed != 1 {
                return Err(crate::app::conflict(
                    "replacement predecessor is not crashed or awaiting handoff",
                ));
            }
            st.event(
                a.project,
                Some(old),
                None,
                "agent.replaced",
                "acom",
                serde_json::json!({"replacement":id}),
            )?;
            st.event(
                a.project,
                Some(id),
                None,
                "agent.replacement",
                "acom",
                serde_json::json!({"predecessor":old}),
            )?;
        }
        st.event(a.project,Some(id),None,"agent.turn-started","acom",
            serde_json::json!({"turn":turns+1,"harness":a.harness,"model":a.model,"effort":a.effort}))?;
        st.db.execute_batch("RELEASE turn_start")?;
        Ok(())
    })();
    if let Err(e) = saved {
        let _ = st
            .db
            .execute_batch("ROLLBACK TO turn_start; RELEASE turn_start");
        kill_group(pid, libc::SIGKILL);
        let _ = child.wait();
        return Err(e);
    }
    Ok(PreparedTurn {
        child: Some(child),
        input,
        harness: a.harness,
        model: a.model,
        effort: a.effort,
        resume,
        turns,
        err_from,
    })
}

/// Call only after the last enclosing savepoint has committed, under the mutex.
pub(crate) fn activate_turn(app: &Arc<App>, st: &mut St, id: i64, mut turn: PreparedTurn) {
    debug_assert!(st.db.is_autocommit());
    let mut child = turn.child.take().unwrap();
    let pid = child.id();
    let model = std::mem::take(&mut turn.model);
    let harness = std::mem::take(&mut turn.harness);
    let resume = turn.resume;
    let turns = turn.turns;
    let err_from = turn.err_from;
    st.procs.insert(
        id,
        Proc {
            pid,
            stopping: false,
            model: model.clone(),
            effort: std::mem::take(&mut turn.effort),
            failure: None,
        },
    );
    st.reaped.remove(&id);
    if let (Some(text), Some(mut stdin)) = (turn.input.take(), child.stdin.take()) {
        thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        });
    }
    append(
        &log_path(app, id, "txt"),
        &format!(
            "--- turn {} started at {}",
            turns + 1,
            crate::app::hhmm(now())
        ),
    );

    let app = app.clone();
    thread::spawn(move || {
        let done = Arc::new(AtomicBool::new(false));
        let side = {
            let (app, harness, done) = (app.clone(), harness.clone(), done.clone());
            thread::spawn(move || follow_side_file(&app, id, &harness, resume, &done))
        };
        let out = child.stdout.take();
        // Reap independently of stdout: a descendant can otherwise keep its
        // inherited pipe open after the harness exits and stall a handoff forever.
        let waiter = {
            let app = app.clone();
            thread::spawn(move || {
                let ok = child.wait().map(|s| s.success()).unwrap_or(false);
                cleanup_failed_group(&app, id, pid, ok);
                ok
            })
        };
        if let Some(out) = out {
            let raw = log_path(&app, id, "jsonl");
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                append(&raw, &line);
                for ev in harness::parse_line(&harness, &line) {
                    apply(&app, id, &harness, &model, ev);
                }
            }
        }
        let ok = waiter.join().unwrap_or(false);
        let exit_error = (!ok)
            .then(|| last_line(&log_path(&app, id, "err"), err_from))
            .flatten();
        done.store(true, Ordering::SeqCst);
        let _ = side.join();
        cleanup_failed_group(&app, id, pid, ok);
        append(
            &log_path(&app, id, "txt"),
            &format!(
                "--- turn ended at {}{}",
                crate::app::hhmm(now()),
                if ok { "" } else { " (exit with error)" }
            ),
        );
        let mut last_error = None;
        while let Err(e) = app.turn_ended(id, pid, ok, exit_error.as_deref()) {
            if last_error.as_deref() != Some(e.1.as_str()) {
                eprintln!("agent {id}: couldn't save turn exit; retrying: {}", e.1);
                last_error = Some(e.1);
            }
            thread::sleep(Duration::from_secs(1));
        }
    });
}

/// Failed/stopped turns must not leave old background tools running into recovery.
fn cleanup_failed_group(app: &App, id: i64, pid: u32, ok: bool) {
    let mut st = app.lock();
    let current = st.procs.get(&id).is_some_and(|p| p.pid == pid);
    if current {
        st.reaped.insert(id);
    }
    let kill = st
        .procs
        .get(&id)
        .is_some_and(|p| p.pid == pid && (!ok || p.failure.is_some() || p.stopping));
    let followup = current
        && st
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_handoffs WHERE agent_id=?1)
                OR EXISTS(SELECT 1 FROM agent_continuations WHERE agent_id=?1)",
                [id],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false);
    if kill || followup {
        kill_group(pid, libc::SIGKILL);
    }
}

/// The last non-empty line written to a file after `from` bytes.
fn last_line(path: &PathBuf, from: u64) -> Option<String> {
    let mut f = File::open(path).ok()?;
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let line = text.lines().rev().find(|l| !l.trim().is_empty())?;
    Some(line.chars().take(300).collect())
}

fn apply(app: &Arc<App>, id: i64, harness: &str, asked: &str, ev: Event) {
    let r = match ev {
        Event::Session(s) => app.set_session(id, &s),
        Event::Tokens { t, add } => app.record_tokens(id, t, add),
        Event::Context(n) => app.record_context(id, n),
        Event::Usage {
            win,
            used_pct,
            resets_at,
        } => app.record_usage(harness, &win, used_pct, resets_at),
        Event::Failed(reason) => {
            append(&log_path(app, id, "txt"), &format!("error: {reason}"));
            app.fail_turn(id, &reason)
        }
        Event::ModelSwitched(reason) => {
            append(&log_path(app, id, "txt"), &reason);
            app.fail_and_stop(id, &reason)
        }
        Event::LimitHit(text) => app.limit_hit(id, &text),
        Event::WindowLimitHit { win, text } => app.window_limit_hit(id, &win, &text),
        Event::Model(m) => app.check_model(id, asked, &m),
        Event::Text(t) => {
            append(&log_path(app, id, "txt"), &t);
            Ok(())
        }
    };
    if let Err(e) = r {
        eprintln!("agent {id}: {}", e.1);
    }
}

/// Some harnesses write usage to a file instead of stdout. Read it while the turn runs.
/// On a resumed session the file already holds earlier turns, so start at its end.
fn follow_side_file(app: &Arc<App>, id: i64, harness: &str, resume: bool, done: &AtomicBool) {
    let mut pos = 0u64;
    let mut path: Option<PathBuf> = None;
    let mut partial = Vec::new();
    loop {
        let finished = done.load(Ordering::SeqCst);
        if path.is_none() {
            let session = app.lock().agent(id).ok().and_then(|a| a.session);
            path = session.and_then(|s| harness::side_file(harness, &s));
            if resume && let Some(p) = &path {
                pos = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            }
        }
        if let Some(p) = &path
            && let Ok(mut f) = File::open(p)
            && f.seek(SeekFrom::Start(pos)).is_ok()
        {
            let mut buf = Vec::new();
            if let Ok(n) = f.read_to_end(&mut buf) {
                pos += n as u64;
                partial.extend_from_slice(&buf);
                while let Some(i) = partial.iter().position(|&c| c == b'\n') {
                    let line: Vec<u8> = partial.drain(..=i).collect();
                    for ev in
                        harness::parse_line(harness, String::from_utf8_lossy(&line).trim_end())
                    {
                        if !matches!(ev, Event::Text(_)) {
                            // The running process keeps its original requested model even
                            // if the user/agent has changed the next-turn configuration.
                            let asked = app
                                .lock()
                                .procs
                                .get(&id)
                                .map(|p| p.model.clone())
                                .unwrap_or_default();
                            apply(app, id, harness, &asked, ev);
                        }
                    }
                }
            }
        }
        if finished {
            return;
        }
        thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Condvar, Mutex};

    fn test_app(pid: u32) -> Arc<App> {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE agents(id INTEGER PRIMARY KEY,state TEXT); INSERT INTO agents VALUES(1,'working');").unwrap();
        Arc::new(App {
            st: Mutex::new(St {
                db,
                queues: Default::default(),
                procs: [(
                    1,
                    Proc {
                        pid,
                        stopping: false,
                        model: "gpt-6-sol".into(),
                        effort: "medium".into(),
                        failure: None,
                    },
                )]
                .into(),
                over_soft: Default::default(),
                reaped: Default::default(),
            }),
            cv: Condvar::new(),
            home: std::env::temp_dir().join(format!("acom-worker-test-{}", harness::new_uuid())),
            url: String::new(),
            exe: PathBuf::new(),
        })
    }

    #[test]
    fn structured_failure_is_retained_without_ending_the_worker() {
        let app = test_app(0);
        for reason in ["stream disconnected", "duplicate failure"] {
            apply(&app, 1, "codex", "gpt-6-sol", Event::Failed(reason.into()));
        }
        let st = app.lock();
        let worker = st.procs.get(&1).unwrap();
        assert_eq!(worker.failure.as_deref(), Some("stream disconnected"));
        assert!(!worker.stopping);
        assert_eq!(
            st.db
                .query_row("SELECT state FROM agents WHERE id=1", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "working"
        );
    }

    #[test]
    fn startup_diagnostics_do_not_mask_the_actual_turn_failure() {
        let app = test_app(0);
        let warning = r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation."}}"#;
        for ev in harness::parse_line("codex", warning) {
            apply(&app, 1, "codex", "gpt-6-sol", ev);
        }
        assert!(app.lock().procs[&1].failure.is_none());
        for line in [
            r#"{"type":"error","message":"actual request rejected"}"#,
            r#"{"type":"turn.failed","error":{"message":"actual request rejected"}}"#,
        ] {
            for ev in harness::parse_line("codex", line) {
                apply(&app, 1, "codex", "gpt-6-sol", ev);
            }
        }
        assert_eq!(
            app.lock().procs[&1].failure.as_deref(),
            Some("actual request rejected")
        );
    }

    #[test]
    fn failed_group_cleanup_preserves_successful_and_unrelated_workers() {
        for (ok, failed, stopping) in [
            (true, false, false),
            (false, false, false),
            (true, true, false),
            (true, false, true),
        ] {
            let mut child = std::process::Command::new("sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .unwrap();
            let pid = child.id();
            let app = test_app(pid);
            {
                let mut st = app.lock();
                let worker = st.procs.get_mut(&1).unwrap();
                worker.failure = failed.then(|| "turn failed".into());
                worker.stopping = stopping;
            }
            cleanup_failed_group(&app, 1, pid + 1, false);
            let unaffected = child.try_wait().unwrap().is_none();
            cleanup_failed_group(&app, 1, pid, ok);
            let successful_still_running = if ok && !failed && !stopping {
                let running = child.try_wait().unwrap().is_none();
                kill_group(pid, libc::SIGKILL);
                running
            } else {
                true
            };
            let status = child.wait().unwrap();
            assert!(unaffected, "an unrelated PID must not affect this worker");
            assert!(
                successful_still_running,
                "successful turns keep their background work"
            );
            assert!(!status.success());
        }
    }

    #[test]
    fn late_failure_cleans_a_reaped_workers_remaining_group() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id();
        let app = test_app(pid);
        cleanup_failed_group(&app, 1, pid, true);
        assert!(child.try_wait().unwrap().is_none());
        assert!(app.lock().reaped.contains(&1));
        app.fail_turn(1, "late buffered failure").unwrap();
        assert!(!child.wait().unwrap().success());
    }
}
