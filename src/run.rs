// Starting turns, following their output, and stopping them.

use crate::app::{App, Fail, Proc, R, St, now};
use crate::harness::{self, Event, Launch};
use rusqlite::params;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Stdio;
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

/// Start one turn of an agent with this prompt. The agent becomes `working`.
pub fn start_turn(app: &Arc<App>, st: &mut St, id: i64, prompt: &str) -> R<()> {
    if st.procs.contains_key(&id) {
        return Err(crate::app::conflict(format!(
            "agent {id} is still stopping; try again in a moment"
        )));
    }
    let a = st.agent(id)?;
    let s = st.settings();
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
    // Resume only a session the harness actually started. Otherwise this is a fresh
    // session (e.g. the first turn crashed early), which needs the briefing again.
    let resume = started && a.session.is_some();
    let briefed;
    let prompt = if turns > 0 && !resume {
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
    let path = format!("{bin_dir}:{}", std::env::var("PATH").unwrap_or_default());
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
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        });
    }
    let pid = child.id();
    st.procs.insert(
        id,
        Proc {
            pid,
            stopping: false,
        },
    );
    st.db.execute(
        "UPDATE agents SET state='working', pid=?2, turns=turns+1, ended_at=NULL WHERE id=?1",
        params![id, pid],
    )?;
    append(
        &log_path(app, id, "txt"),
        &format!(
            "--- turn {} started at {}",
            turns + 1,
            crate::app::hhmm(now())
        ),
    );

    let app = app.clone();
    let harness = a.harness.clone();
    thread::spawn(move || {
        let done = Arc::new(AtomicBool::new(false));
        let side = {
            let (app, harness, done) = (app.clone(), harness.clone(), done.clone());
            thread::spawn(move || follow_side_file(&app, id, &harness, resume, &done))
        };
        if let Some(out) = child.stdout.take() {
            let raw = log_path(&app, id, "jsonl");
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                append(&raw, &line);
                for ev in harness::parse_line(&harness, &line) {
                    apply(&app, id, &harness, ev);
                }
            }
        }
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        done.store(true, Ordering::SeqCst);
        let _ = side.join();
        append(
            &log_path(&app, id, "txt"),
            &format!(
                "--- turn ended at {}{}",
                crate::app::hhmm(now()),
                if ok { "" } else { " (exit with error)" }
            ),
        );
        if let Err(e) = app.turn_ended(id, pid, ok) {
            eprintln!("agent {id}: {}", e.1);
        }
    });
    Ok(())
}

fn apply(app: &Arc<App>, id: i64, harness: &str, ev: Event) {
    let r = match ev {
        Event::Session(s) => app.set_session(id, &s),
        Event::Tokens { t, add } => app.record_tokens(id, t, add),
        Event::Context(n) => app.record_context(id, n),
        Event::Usage {
            win,
            used_pct,
            resets_at,
        } => app.record_usage(harness, &win, used_pct, resets_at),
        Event::Flagged(reason) => app.flag(id, &reason),
        Event::LimitHit(text) => app.limit_hit(id, &text),
        Event::Model(m) => app.check_model(id, &m),
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
                            apply(app, id, harness, ev);
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
