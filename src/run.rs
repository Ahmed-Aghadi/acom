// Starting turns, following their output, and stopping them.

use crate::app::{App, Fail, Proc, R, St};
use crate::harness::{self, Event, Launch};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::params;
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

pub fn kill_group(pid: u32, sig: i32) {
    unsafe {
        libc::kill(-(pid as i32), sig);
    }
}

/// Whether a PID still belongs to this agent of this server, not a process that reused the number.
#[cfg(test)]
pub fn is_our_agent(pid: u32, id: i64, url: &str) -> bool {
    let Ok(env) = std::fs::read(format!("/proc/{pid}/environ")) else {
        return false;
    };
    let vars: Vec<&[u8]> = env.split(|&b| b == 0).collect();
    vars.contains(&format!("ACOM_ID={id}").as_bytes())
        && vars.contains(&format!("ACOM_URL={url}").as_bytes())
}

/// Scan once for registered agents' tools, including separate process groups.
pub fn server_tools(agent_ids: &HashSet<i64>, url: &str, home: &Path) -> Vec<(i64, u32)> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let server_pid = std::process::id();
    let address = format!("ACOM_URL={url}");
    let home_marker = home_marker(home);
    entries
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_str()?.parse::<u32>().ok()?;
            if pid == 0 || pid > i32::MAX as u32 || pid == server_pid {
                return None;
            }
            let env = std::fs::read(entry.path().join("environ")).ok()?;
            let id = server_tool_id(&env, address.as_bytes(), &home_marker)?;
            agent_ids.contains(&id).then_some((id, pid))
        })
        .collect()
}

/// A matching worker without a home marker cannot be safely owned or ignored.
pub fn unmarked_tools(agent_ids: &HashSet<i64>, url: &str) -> Vec<(i64, u32)> {
    if agent_ids.is_empty() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let address = format!("ACOM_URL={url}");
    entries
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_str()?.parse::<u32>().ok()?;
            if pid == 0 || pid > i32::MAX as u32 || pid == std::process::id() {
                return None;
            }
            let env = std::fs::read(entry.path().join("environ")).ok()?;
            let vars: Vec<&[u8]> = env.split(|&b| b == 0).collect();
            if !vars.contains(&address.as_bytes())
                || vars.iter().any(|v| v.starts_with(b"ACOM_HOME="))
            {
                return None;
            }
            let id = vars.iter().find_map(|v| {
                std::str::from_utf8(v.strip_prefix(b"ACOM_ID=")?)
                    .ok()?
                    .parse::<i64>()
                    .ok()
            })?;
            (id > 0 && agent_ids.contains(&id)).then_some((id, pid))
        })
        .collect()
}

fn home_marker(home: &Path) -> Vec<u8> {
    let mut marker = b"ACOM_HOME=".to_vec();
    marker.extend_from_slice(home.as_os_str().as_bytes());
    marker
}

fn server_tool_id(env: &[u8], address: &[u8], home: &[u8]) -> Option<i64> {
    let vars = env.split(|&b| b == 0);
    if !vars.clone().any(|v| v == address) || !vars.clone().any(|v| v == home) {
        return None;
    }
    vars.filter_map(|v| {
        std::str::from_utf8(v.strip_prefix(b"ACOM_ID=")?)
            .ok()?
            .parse::<i64>()
            .ok()
    })
    .find(|id| *id > 0)
}

fn matches_server_tool(pid: u32, id: i64, address: &[u8], home: &[u8]) -> bool {
    id > 0
        && pid > 0
        && pid <= i32::MAX as u32
        && pid != std::process::id()
        && std::fs::read(format!("/proc/{pid}/environ"))
            .ok()
            .and_then(|env| server_tool_id(&env, address, home))
            == Some(id)
}

pub fn is_server_tool(pid: u32, id: i64, url: &str, home: &Path) -> bool {
    matches_server_tool(
        pid,
        id,
        format!("ACOM_URL={url}").as_bytes(),
        &home_marker(home),
    )
}

#[cfg(test)]
pub fn kill_server_tools(tools: &[(i64, u32)], url: &str, home: &Path, sig: i32) {
    let address = format!("ACOM_URL={url}");
    let home_marker = home_marker(home);
    for &(id, pid) in tools {
        // Revalidate after waiting: never signal an unrelated reused PID.
        if matches_server_tool(pid, id, address.as_bytes(), &home_marker) {
            unsafe {
                libc::kill(pid as i32, sig);
            }
        }
    }
}

#[derive(Clone, Copy)]
struct ProcessIdentity {
    start: u64,
    group: u32,
    state: u8,
}

fn process_identity(pid: u32) -> R<Option<ProcessIdentity>> {
    let raw = match std::fs::read(format!("/proc/{pid}/stat")) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Fail(500, format!("can't verify worker PID {pid}: {e}"))),
    };
    let text = String::from_utf8_lossy(&raw);
    let fields: Vec<_> = text
        .rsplit_once(") ")
        .map(|(_, tail)| tail.split_whitespace().collect())
        .unwrap_or_default();
    let identity = fields
        .get(19)
        .and_then(|start| start.parse().ok())
        .zip(fields.get(2).and_then(|group| group.parse().ok()))
        .zip(
            fields
                .first()
                .and_then(|state| state.as_bytes().first().copied()),
        )
        .map(|((start, group), state)| ProcessIdentity {
            start,
            group,
            state,
        });
    identity.map(Some).ok_or_else(|| {
        Fail(
            500,
            format!("can't verify worker PID {pid}: invalid process identity"),
        )
    })
}

/// A retryable stop operation. Call without holding the app mutex. Remembering
/// start times keeps an exec-time environment gap from looking like an exit.
pub struct StopTools {
    ids: HashSet<i64>,
    groups: Vec<(i64, u32)>,
    url: String,
    home: PathBuf,
    tools: HashMap<(u32, u64), i64>,
    signalled: HashSet<(u32, u64, i32)>,
    signalled_groups: HashSet<(u32, i32)>,
}

impl StopTools {
    pub fn new(app: &App, ids: &HashSet<i64>, groups: &[(i64, u32)], url: &str) -> R<Self> {
        let mut stop = Self {
            ids: ids.clone(),
            groups: groups.to_vec(),
            url: url.into(),
            home: app.home.clone(),
            tools: HashMap::new(),
            signalled: HashSet::new(),
            signalled_groups: HashSet::new(),
        };
        stop.capture()?;
        Ok(stop)
    }

    fn capture(&mut self) -> R<()> {
        for (id, pid) in server_tools(&self.ids, &self.url, &self.home) {
            if let Some(p) = process_identity(pid)?
                && !matches!(p.state, b'Z' | b'X')
                && is_server_tool(pid, id, &self.url, &self.home)
            {
                self.tools.insert((pid, p.start), id);
            }
        }
        Ok(())
    }

    fn live(&self, pid: u32, start: u64) -> R<Option<ProcessIdentity>> {
        Ok(process_identity(pid)?.filter(|p| p.start == start && !matches!(p.state, b'Z' | b'X')))
    }

    fn signal(&mut self, sig: i32) -> R<()> {
        let supervisor_group = unsafe { libc::getpgrp() } as u32;
        for &(id, group) in &self.groups {
            // A stale root must never authorize signalling the supervisor's own group.
            if group == 0
                || group > i32::MAX as u32
                || group == supervisor_group
                || self.signalled_groups.contains(&(group, sig))
            {
                continue;
            }
            let mut members = Vec::new();
            let mut owned = false;
            for (&(pid, start), &owner) in &self.tools {
                if self.live(pid, start)?.is_some_and(|p| p.group == group) {
                    members.push((pid, start));
                    owned |= owner == id && is_server_tool(pid, id, &self.url, &self.home);
                }
            }
            if !owned {
                continue;
            }
            signal_worker(-(group as i32), sig)?;
            self.signalled_groups.insert((group, sig));
            self.signalled
                .extend(members.into_iter().map(|(pid, start)| (pid, start, sig)));
        }
        for (&(pid, start), &id) in &self.tools {
            if !self.signalled.contains(&(pid, start, sig))
                && is_server_tool(pid, id, &self.url, &self.home)
                && self.live(pid, start)?.is_some()
            {
                signal_worker(pid as i32, sig)?;
                self.signalled.insert((pid, start, sig));
            }
        }
        Ok(())
    }

    fn pending(&self, app: &App) -> R<bool> {
        let native_pending = {
            let st = app.lock();
            self.ids
                .iter()
                .any(|id| st.procs.contains_key(id) && !st.reaped.contains(id))
        };
        if native_pending {
            return Ok(true);
        }
        for &(pid, start) in self.tools.keys() {
            if self.live(pid, start)?.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn wait(&mut self, app: &App, duration: Duration, sig: i32) -> R<bool> {
        let deadline = Instant::now() + duration;
        loop {
            self.capture()?;
            self.signal(sig)?;
            if !self.pending(app)? {
                // Recheck after a short quiet interval, including late forks.
                thread::sleep(Duration::from_millis(20));
                self.capture()?;
                if !self.pending(app)? {
                    return Ok(true);
                }
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    pub fn stop(&mut self, app: &App) -> R<()> {
        if self.wait(app, Duration::from_secs(6), libc::SIGTERM)?
            || self.wait(app, Duration::from_millis(500), libc::SIGKILL)?
        {
            return Ok(());
        }
        Err(Fail(500, "owned workers are still stopping; locks must remain unavailable until cleanup succeeds".into()))
    }
}

fn signal_worker(pid: i32, sig: i32) -> R<()> {
    if unsafe { libc::kill(pid, sig) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(Fail(500, format!("can't stop worker {pid}: {error}")))
}

/// A reaped leader can leave owned tools in its process group. Validate a live
/// member of exactly that group before allowing startup to stop its leftovers.
#[cfg(test)]
pub fn is_our_agent_group(group: u32, id: i64, url: &str) -> bool {
    if group == 0 || group > i32::MAX as u32 {
        return false;
    }
    let belongs = |pid: u32| unsafe { libc::getpgid(pid as i32) == group as i32 };
    if belongs(group) && is_our_agent(group, id, url) && belongs(group) {
        return true;
    }
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    entries.flatten().any(|entry| {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            return false;
        };
        belongs(pid) && is_our_agent(pid, id, url) && belongs(pid)
    })
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

fn append(path: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(format!("{line}\n").as_bytes());
    }
}

fn capture_time() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Only the first line of a logical entry has a capture timestamp and type.
fn append_entry(path: &Path, at: &str, kind: &str, text: &str) {
    append(path, &format!("[{at}] [{kind}] {text}"));
}

fn stdout_line(app: &Arc<App>, id: i64, harness: &str, model: &str, line: &str) {
    let at = capture_time();
    append(&log_path(app, id, "jsonl"), line);
    for event in harness::parse_line(harness, line) {
        apply(app, id, harness, model, event, &at);
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
    side_file: Option<(PathBuf, u64)>,
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
    if st.shutting_down {
        return Err(crate::app::conflict("the server is stopping"));
    }
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
    st.db
        .execute("DELETE FROM agent_starts WHERE agent_id=?1", [id])?;
    let updates = st.take_turn_updates(id)?;
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
    } else if turns > 0 || matches!(a.state.as_str(), "crashed" | "paused") {
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
        .env("ACOM_HOME", &app.home)
        .env("PATH", path)
        .stdout(Stdio::piped())
        .stderr(err)
        .process_group(0);
    if input.is_none() {
        cmd.stdin(Stdio::null());
    }
    // Snapshot resumed history before the client can append this turn's events.
    // The asynchronous follower may not run until after task delivery.
    let side_file = if resume {
        a.session
            .as_deref()
            .and_then(|s| harness::side_file(&a.harness, s))
            .map(|p| {
                let pos = std::fs::metadata(&p).map_or(0, |m| m.len());
                (p, pos)
            })
    } else {
        None
    };
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
        side_file,
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
    let side_file = turn.side_file.take();
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
    append_entry(
        &log_path(app, id, "txt"),
        &capture_time(),
        "turn-start",
        &format!("turn {} started", turns + 1),
    );
    if let (Some(text), Some(mut stdin)) = (turn.input.take(), child.stdin.take()) {
        thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        });
    }
    let app = app.clone();
    thread::spawn(move || {
        let done = Arc::new(AtomicBool::new(false));
        let side = {
            let (app, harness, done) = (app.clone(), harness.clone(), done.clone());
            thread::spawn(move || follow_side_file(&app, id, &harness, side_file, &done))
        };
        let out = child.stdout.take();
        // Reap independently of stdout: a descendant can otherwise keep its
        // inherited pipe open after the harness exits and stall a handoff forever.
        let waiter = {
            let app = app.clone();
            thread::spawn(move || {
                let ok = child.wait().map(|s| s.success()).unwrap_or(false);
                let ended_at = capture_time();
                cleanup_failed_group(&app, id, pid, ok);
                (ok, ended_at)
            })
        };
        if let Some(out) = out {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                stdout_line(&app, id, &harness, &model, &line);
            }
        }
        let (ok, ended_at) = waiter.join().unwrap_or_else(|_| (false, capture_time()));
        let exit_error = (!ok)
            .then(|| last_line(&log_path(&app, id, "err"), err_from))
            .flatten();
        done.store(true, Ordering::SeqCst);
        let _ = side.join();
        cleanup_failed_group(&app, id, pid, ok);
        append_entry(
            &log_path(&app, id, "txt"),
            &ended_at,
            "turn-end",
            &format!(
                "turn {} ended{}",
                turns + 1,
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

fn apply(app: &Arc<App>, id: i64, harness: &str, asked: &str, ev: Event, at: &str) {
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
            append_entry(&log_path(app, id, "txt"), at, "error", &reason);
            app.fail_turn(id, &reason)
        }
        Event::ModelSwitched(reason) => {
            append_entry(&log_path(app, id, "txt"), at, "error", &reason);
            app.fail_and_stop(id, &reason)
        }
        Event::LimitHit(text) => app.limit_hit(id, &text),
        Event::WindowLimitHit { win, text } => app.window_limit_hit(id, &win, &text),
        Event::Model(m) => app.check_model(id, asked, &m),
        Event::Text(t) => {
            append_entry(&log_path(app, id, "txt"), at, "message", &t);
            Ok(())
        }
        Event::Tool(t) => {
            append_entry(&log_path(app, id, "txt"), at, "tool", &t);
            Ok(())
        }
    };
    if let Err(e) = r {
        eprintln!("agent {id}: {}", e.1);
    }
}

/// Some harnesses write usage to a file instead of stdout. Read it while the turn runs.
/// On a resumed session the file already holds earlier turns, so start at its end.
fn follow_side_file(
    app: &Arc<App>,
    id: i64,
    harness: &str,
    initial: Option<(PathBuf, u64)>,
    done: &AtomicBool,
) {
    let (mut path, mut pos) = initial.map_or((None, 0), |(p, pos)| (Some(p), pos));
    let mut partial = Vec::new();
    loop {
        let finished = done.load(Ordering::SeqCst);
        if path.is_none() {
            let session = app.lock().agent(id).ok().and_then(|a| a.session);
            path = session.and_then(|s| harness::side_file(harness, &s));
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
                    let at = capture_time();
                    for ev in
                        harness::parse_line(harness, String::from_utf8_lossy(&line).trim_end())
                    {
                        if !matches!(ev, Event::Text(_) | Event::Tool(_)) {
                            // The running process keeps its original requested model even
                            // if the user/agent has changed the next-turn configuration.
                            let asked = app
                                .lock()
                                .procs
                                .get(&id)
                                .map(|p| p.model.clone())
                                .unwrap_or_default();
                            apply(app, id, harness, &asked, ev, &at);
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
    use crate::app::now;
    use std::sync::{Condvar, Mutex};

    #[test]
    fn readable_entries_preserve_multiline_text_with_one_utc_prefix() {
        let home = std::env::temp_dir().join(format!("acom-log-test-{}", harness::new_uuid()));
        std::fs::create_dir_all(&home).unwrap();
        let path = home.join("output.txt");
        append_entry(
            &path,
            "2026-10-15T12:34:56Z",
            "message",
            "first line\nsecond line ☃",
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "[2026-10-15T12:34:56Z] [message] first line\nsecond line ☃\n"
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn stdout_keeps_raw_lines_once_and_types_entries_at_capture_time() {
        let app = test_app(0);
        std::fs::create_dir_all(app.home.join("logs")).unwrap();
        let lines = [
            r#"{"timestamp":"2000-01-01T00:00:00Z","type":"assistant","message":{"content":[{"type":"text","text":"Bash: explanation, not a tool"},{"type":"tool_use","name":"Bash","input":{"command":"pwd"}}]}}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"shell: also a message"}}"#,
            r#"{"type":"item.completed","item":{"type":"command_execution","command":"pwd"}}"#,
            r#"{"type":"error","message":"captured failure"}"#,
            r#"{"type":"unknown","text":"raw only"}"#,
        ];
        let before = now();
        for (index, line) in lines.iter().enumerate() {
            stdout_line(
                &app,
                1,
                if index == 0 { "claude" } else { "codex" },
                "gpt-6-sol",
                line,
            );
        }
        let after = now();
        assert_eq!(
            std::fs::read_to_string(log_path(&app, 1, "jsonl")).unwrap(),
            format!("{}\n", lines.join("\n"))
        );
        let output = std::fs::read_to_string(log_path(&app, 1, "txt")).unwrap();
        let expected = [
            "[message] Bash: explanation, not a tool",
            "[tool] Bash: pwd",
            "[message] shell: also a message",
            "[tool] shell: pwd",
            "[error] captured failure",
        ];
        assert_eq!(output.lines().count(), expected.len());
        for (line, expected) in output.lines().zip(expected) {
            let (at, text) = line.strip_prefix('[').unwrap().split_once("] ").unwrap();
            assert_eq!(at.len(), 20);
            assert!(at.ends_with('Z'));
            let captured = DateTime::parse_from_rfc3339(at).unwrap().timestamp();
            assert!(captured >= before && captured <= after);
            assert_eq!(text, expected);
        }
        assert_eq!(
            app.lock().procs[&1].failure.as_deref(),
            Some("captured failure")
        );
        std::fs::remove_dir_all(&app.home).unwrap();
    }

    #[test]
    fn resumed_side_file_keeps_events_appended_before_the_follower_starts() {
        const FIXTURE: &str = "ACOM_NATIVE_BASELINE_TEST_DIR";
        // Give this fixture its own environment: other parallel tests must not
        // observe its CODEX_HOME or client directory.
        let Some(home) = std::env::var_os(FIXTURE).map(PathBuf::from) else {
            let home =
                std::env::temp_dir().join(format!("acom-native-test-{}", harness::new_uuid()));
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "run::tests::resumed_side_file_keeps_events_appended_before_the_follower_starts",
                    "--nocapture",
                ])
                .env(FIXTURE, &home)
                .env("CODEX_HOME", home.join("codex"))
                .env("ACOM_HOME", home.join("state"))
                .env("PATH", home.join("bin"))
                .output()
                .unwrap();
            let _ = std::fs::remove_dir_all(&home);
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        };
        use std::os::unix::fs::PermissionsExt;
        struct OwnedGroup(u32);
        impl Drop for OwnedGroup {
            fn drop(&mut self) {
                kill_group(self.0, libc::SIGKILL);
            }
        }
        let bin = home.join("bin");
        let sessions = home.join("codex/sessions/2026/10/08");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        let native = sessions.join("rollout-native-audit-session.jsonl");
        std::fs::write(&native, "{}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"old text must not be replayed\"}}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"command\":\"old tool must not be replayed\"}}\n").unwrap();
        let wrote = home.join("native-wrote");
        let event = serde_json::json!({
            "type":"event_msg", "payload":{
                "type":"token_count",
                "info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":100,"output_tokens":50},"last_token_usage":{"total_tokens":123}},
                "rate_limits":{"primary":{"used_percent":98,"window_minutes":300,"resets_at":now()+3600}}
            }
        });
        let text = serde_json::json!({"type":"item.completed","item":{"type":"agent_message","text":"current stdout message"}});
        let tool = serde_json::json!({"type":"item.completed","item":{"type":"command_execution","command":"current stdout tool"}});
        let session =
            serde_json::json!({"type":"thread.started","thread_id":"native-audit-session"});
        let tokens = serde_json::json!({"type":"turn.completed","usage":{"input_tokens":20,"output_tokens":2}});
        let quote =
            |p: &std::path::Path| format!("'{}'", p.display().to_string().replace('\'', "'\\''"));
        let client = bin.join("codex");
        std::fs::write(&client, format!(
            "#!/bin/sh\nwhile IFS= read -r task; do :; done\nprintf '%s\\n' '{event}' '{text}' '{tool}' >> {}\n: > {}\nprintf '%s\\n' '{session}' '{text}' '{tool}' '{tokens}'\n",
            quote(&native), quote(&wrote)
        )).unwrap();
        std::fs::set_permissions(&client, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut app = App::open(home.join("state"), "http://127.0.0.1:0".into()).unwrap();
        Arc::get_mut(&mut app).unwrap().exe = bin.join("acom");
        let project = app.add_project(home.to_str().unwrap(), "test").unwrap()["id"]
            .as_i64()
            .unwrap();
        let mut st = app.lock();
        st.db.execute(
            "INSERT INTO agents(id,project,name,task,harness,model,effort,state,session_id,session_started,launched_by,launched_at)
             VALUES(1,?1,'a','t','codex','gpt-6-sol','medium','idle','native-audit-session',1,0,0)",
            [project],
        ).unwrap();
        start_turn(&app, &mut st, 1, "isolated fake resumed turn", None).unwrap();
        let _worker = OwnedGroup(st.procs[&1].pid);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        // Holding the normal start mutex keeps the follower from initializing
        // until the client has definitely written this turn's native events.
        while !wrote.exists() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            wrote.exists(),
            "fake client did not write its native events"
        );
        drop(st);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !app.lock().procs.is_empty() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let st = app.lock();
        assert!(st.procs.is_empty(), "fake turn did not finish");
        assert_eq!(
            st.db
                .query_row("SELECT context FROM agents WHERE id=1", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            123
        );
        assert_eq!(st.used_pct("codex").unwrap(), Some(98.0));
        let output = std::fs::read_to_string(log_path(&app, 1, "txt")).unwrap();
        assert_eq!(output.matches("[turn-start] turn 1 started").count(), 1);
        assert_eq!(
            output.matches("[message] current stdout message").count(),
            1
        );
        assert_eq!(
            output.matches("[tool] shell: current stdout tool").count(),
            1
        );
        assert_eq!(output.matches("[turn-end] turn 1 ended").count(), 1);
        assert_eq!(output.lines().count(), 4);
        assert!(!output.contains("old text"));
        assert!(!output.contains("old tool"));
        for line in output.lines() {
            let at = line.strip_prefix('[').unwrap().split_once(']').unwrap().0;
            assert_eq!(at.len(), 20);
            assert!(at.ends_with('Z'));
            chrono::DateTime::parse_from_rfc3339(at).unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(log_path(&app, 1, "jsonl")).unwrap(),
            format!("{session}\n{text}\n{tool}\n{tokens}\n")
        );
    }

    fn test_app(pid: u32) -> Arc<App> {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE agents(id INTEGER PRIMARY KEY,state TEXT); INSERT INTO agents VALUES(1,'working');").unwrap();
        Arc::new(App {
            st: Mutex::new(St {
                db,
                shutting_down: false,
                stopping_agents: Default::default(),
                waiting_updates: Default::default(),
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
                reaped: Default::default(),
            }),
            cv: Condvar::new(),
            home: std::env::temp_dir().join(format!("acom-worker-test-{}", harness::new_uuid())),
            url: String::new(),
            exe: PathBuf::new(),
        })
    }

    struct StopWorker(Child);
    impl Drop for StopWorker {
        fn drop(&mut self) {
            kill_group(self.0.id(), libc::SIGKILL);
            let _ = self.0.wait();
        }
    }

    fn stop_test_app() -> Arc<App> {
        let mut app = test_app(0);
        let inner = Arc::get_mut(&mut app).unwrap();
        inner.url = format!("http://127.0.0.1:65530/stop-{}", harness::new_uuid());
        std::fs::create_dir_all(&inner.home).unwrap();
        inner.lock().procs.clear();
        app
    }

    fn stop_worker(
        app: &App,
        id: i64,
        url: &str,
        home: &Path,
        name: &str,
        resistant: bool,
    ) -> StopWorker {
        let ready = app.home.join(format!("{name}-ready"));
        let terms = app.home.join(format!("{name}-terms"));
        let script = if resistant {
            "trap '' TERM; printf ready > \"$2\"; exec /bin/sleep 30"
        } else {
            "trap 'printf t >> \"$1\"; exit' TERM; printf ready > \"$2\"; while :; do /bin/sleep 30; done"
        };
        let worker = StopWorker(
            std::process::Command::new("/bin/sh")
                .args(["-c", script, "stop-worker"])
                .arg(terms)
                .arg(&ready)
                .env("ACOM_ID", id.to_string())
                .env("ACOM_URL", url)
                .env("ACOM_HOME", home)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        while !ready.exists() {
            assert!(
                Instant::now() < deadline,
                "stop worker did not become ready"
            );
            thread::sleep(Duration::from_millis(5));
        }
        worker
    }

    #[test]
    fn stop_tools_cleans_group_and_late_detached_tools_without_duplicate_term_or_foreign_signals() {
        let app = stop_test_app();
        let mut root = stop_worker(&app, 1, &app.url, &app.home, "root", false);
        let mut foreign_home = stop_worker(
            &app,
            1,
            &app.url,
            &app.home.join("foreign"),
            "foreign-home",
            false,
        );
        let mut foreign_url = stop_worker(
            &app,
            1,
            "http://127.0.0.1:1",
            &app.home,
            "foreign-url",
            false,
        );
        let mut unregistered = stop_worker(&app, 2, &app.url, &app.home, "unregistered", false);
        let mut stop =
            StopTools::new(&app, &HashSet::from([1]), &[(1, root.0.id())], &app.url).unwrap();
        let mut detached = stop_worker(&app, 1, &app.url, &app.home, "late-detached", false);
        stop.stop(&app).unwrap();
        assert!(root.0.try_wait().unwrap().is_some());
        assert!(detached.0.try_wait().unwrap().is_some());
        assert_eq!(
            std::fs::read_to_string(app.home.join("root-terms")).unwrap(),
            "t"
        );
        assert_eq!(
            std::fs::read_to_string(app.home.join("late-detached-terms")).unwrap(),
            "t"
        );
        assert!(foreign_home.0.try_wait().unwrap().is_none());
        assert!(foreign_url.0.try_wait().unwrap().is_none());
        assert!(unregistered.0.try_wait().unwrap().is_none());
        stop.stop(&app).unwrap();
        assert_eq!(
            std::fs::read_to_string(app.home.join("root-terms")).unwrap(),
            "t"
        );
        assert_eq!(
            std::fs::read_to_string(app.home.join("late-detached-terms")).unwrap(),
            "t"
        );
    }

    #[test]
    fn stop_tools_remembers_live_identity_without_markers_and_rejects_reused_pid_generation() {
        let app = stop_test_app();
        let mut worker = stop_worker(
            &app,
            1,
            &app.url,
            &app.home.join("foreign"),
            "unmarked-proof",
            false,
        );
        let mut stop = StopTools::new(&app, &HashSet::from([1]), &[], &app.url).unwrap();
        let pid = worker.0.id();
        let start = process_identity(pid).unwrap().unwrap().start;
        // Model a captured worker whose environment markers are now absent.
        stop.tools.insert((pid, start), 1);
        assert!(!is_server_tool(pid, 1, &app.url, &app.home));
        assert!(stop.pending(&app).unwrap());
        assert!(
            !stop
                .wait(&app, Duration::from_millis(30), libc::SIGTERM)
                .unwrap()
        );
        assert!(worker.0.try_wait().unwrap().is_none());
        assert_eq!(stop.tools.get(&(pid, start)), Some(&1));
        stop.tools.remove(&(pid, start));
        stop.tools.insert((pid, start + 1), 1);
        assert!(!stop.pending(&app).unwrap());
        stop.signal(libc::SIGKILL).unwrap();
        assert!(worker.0.try_wait().unwrap().is_none());
        {
            let mut st = app.lock();
            st.procs.insert(
                1,
                Proc {
                    pid,
                    stopping: true,
                    model: "m".into(),
                    effort: "e".into(),
                    failure: None,
                },
            );
        }
        assert!(stop.pending(&app).unwrap());
        app.lock().reaped.insert(1);
        assert!(!stop.pending(&app).unwrap());
    }

    #[test]
    fn stop_tools_force_kills_term_resistant_worker_with_a_bounded_wait() {
        use std::os::unix::process::ExitStatusExt;
        let app = stop_test_app();
        let mut worker = stop_worker(&app, 1, &app.url, &app.home, "resistant", true);
        let mut stop =
            StopTools::new(&app, &HashSet::from([1]), &[(1, worker.0.id())], &app.url).unwrap();
        let started = Instant::now();
        stop.stop(&app).unwrap();
        assert!(started.elapsed() >= Duration::from_secs(6));
        assert!(started.elapsed() < Duration::from_secs(9));
        assert!(worker.0.wait().unwrap().signal() == Some(libc::SIGKILL));
        assert!(!stop.pending(&app).unwrap());
    }

    #[test]
    fn stop_tools_never_signals_the_supervisors_group() {
        struct SingleWorker(Child);
        impl Drop for SingleWorker {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let app = stop_test_app();
        let mut worker = SingleWorker(
            std::process::Command::new("/bin/sleep")
                .arg("30")
                .env("ACOM_ID", "1")
                .env("ACOM_URL", &app.url)
                .env("ACOM_HOME", &app.home)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let supervisor_group = unsafe { libc::getpgrp() } as u32;
        assert_eq!(
            process_identity(worker.0.id()).unwrap().unwrap().group,
            supervisor_group
        );
        let mut stop = StopTools::new(
            &app,
            &HashSet::from([1]),
            &[(1, supervisor_group)],
            &app.url,
        )
        .unwrap();
        stop.stop(&app).unwrap();
        assert!(worker.0.try_wait().unwrap().is_some());
        assert!(
            !stop
                .signalled_groups
                .contains(&(supervisor_group, libc::SIGTERM))
        );
        assert!(
            !stop
                .signalled_groups
                .contains(&(supervisor_group, libc::SIGKILL))
        );
    }

    #[test]
    fn structured_failure_is_retained_without_ending_the_worker() {
        let app = test_app(0);
        for reason in ["stream disconnected", "duplicate failure"] {
            apply(
                &app,
                1,
                "codex",
                "gpt-6-sol",
                Event::Failed(reason.into()),
                &capture_time(),
            );
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
            apply(&app, 1, "codex", "gpt-6-sol", ev, &capture_time());
        }
        assert!(app.lock().procs[&1].failure.is_none());
        for line in [
            r#"{"type":"error","message":"actual request rejected"}"#,
            r#"{"type":"turn.failed","error":{"message":"actual request rejected"}}"#,
        ] {
            for ev in harness::parse_line("codex", line) {
                apply(&app, 1, "codex", "gpt-6-sol", ev, &capture_time());
            }
        }
        assert_eq!(
            app.lock().procs[&1].failure.as_deref(),
            Some("actual request rejected")
        );
    }

    #[test]
    fn server_tool_cleanup_matches_registered_identity_and_revalidates_before_signalling() {
        let url = format!("http://127.0.0.1:65530/owned-{}", std::process::id());
        let home = PathBuf::from(format!("/owned/run-tools/{}", std::process::id()));
        let spawn = |id: i64, address: &str, home: &Path| {
            std::process::Command::new("sleep")
                .arg("30")
                .env("ACOM_ID", id.to_string())
                .env("ACOM_URL", address)
                .env("ACOM_HOME", home)
                .spawn()
                .unwrap()
        };
        let mut first = spawn(1, &url, &home);
        let mut second = spawn(2, &url, &home);
        let mut unregistered = spawn(3, &url, &home);
        let mut foreign = spawn(1, "http://127.0.0.1:1", &home);
        let mut foreign_home = spawn(1, &url, Path::new("/owned/another-server"));
        let mut missing_home = std::process::Command::new("sleep")
            .arg("30")
            .env("ACOM_ID", "1")
            .env("ACOM_URL", &url)
            .env_remove("ACOM_HOME")
            .spawn()
            .unwrap();
        let mut found = server_tools(&HashSet::from([1, 2]), &url, &home);
        found.sort_unstable();
        let expected = vec![(1, first.id()), (2, second.id())];
        let identity_matches = is_server_tool(first.id(), 1, &url, &home)
            && !is_server_tool(first.id(), 2, &url, &home)
            && !is_server_tool(foreign.id(), 1, &url, &home)
            && !is_server_tool(foreign_home.id(), 1, &url, &home)
            && !is_server_tool(missing_home.id(), 1, &url, &home)
            && !is_server_tool(std::process::id(), 1, &url, &home);
        kill_server_tools(
            &[
                (1, first.id()),
                (1, foreign.id()),
                (1, foreign_home.id()),
                (1, missing_home.id()),
                (99, second.id()),
                (1, 0),
                (1, std::process::id()),
            ],
            &url,
            &home,
            libc::SIGKILL,
        );
        let first_stopped = !first.wait().unwrap().success();
        let others_alive = [
            &mut second,
            &mut unregistered,
            &mut foreign,
            &mut foreign_home,
            &mut missing_home,
        ]
        .into_iter()
        .all(|child| child.try_wait().unwrap().is_none());
        for child in [
            &mut second,
            &mut unregistered,
            &mut foreign,
            &mut foreign_home,
            &mut missing_home,
        ] {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert_eq!(
            found, expected,
            "foreign URLs, homes, missing markers and unregistered IDs are excluded"
        );
        assert!(first_stopped);
        assert!(
            identity_matches,
            "fresh group guards require the same full ownership identity"
        );
        assert!(
            others_alive,
            "each positive PID is revalidated, not signalled by snapshot alone"
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
