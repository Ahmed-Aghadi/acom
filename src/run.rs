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
    app.dir.join(".acom/logs").join(format!("{id}.{ext}"))
}

fn append(path: &PathBuf, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// Start one turn of an agent with this prompt. The agent becomes `working`.
pub fn start_turn(app: &Arc<App>, st: &mut St, id: i64, prompt: &str) -> R<()> {
    let a = st.agent(id)?;
    let s = st.settings();
    let turns: i64 = st
        .db
        .query_row("SELECT turns FROM agents WHERE id=?1", [id], |r| r.get(0))?;
    let flags = s
        .harnesses
        .get(&a.harness)
        .map(|h| h.flags.clone())
        .unwrap_or_default();
    let launch = Launch {
        harness: &a.harness,
        model: &a.model,
        effort: &a.effort,
        session: a.session.as_deref(),
        resume: turns > 0 && a.session.is_some(),
        prompt,
        context_limit: s.limits.context.hard as u64,
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
    cmd.current_dir(&app.dir)
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
            thread::spawn(move || follow_side_file(&app, id, &harness, &done))
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
        if let Err(e) = app.turn_ended(id, ok) {
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
fn follow_side_file(app: &Arc<App>, id: i64, harness: &str, done: &AtomicBool) {
    let mut pos = 0u64;
    let mut path: Option<PathBuf> = None;
    let mut partial = String::new();
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
            let mut buf = String::new();
            if let Ok(n) = f.read_to_string(&mut buf) {
                pos += n as u64;
                partial.push_str(&buf);
                while let Some(i) = partial.find('\n') {
                    let line: String = partial.drain(..=i).collect();
                    for ev in harness::parse_line(harness, line.trim_end()) {
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
