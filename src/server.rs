// The HTTP API. Thin: it parses requests and calls into App.

use crate::app::{App, Fail, LaunchReq, LockMode, R, Settings, acom_home, actor, bad, not_found};
use crate::harness::catalog;
use serde_json::{Value, json};
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const UI: &str = include_str!("ui.html");

pub fn serve(port: u16) {
    let home = acom_home();
    if let Err(e) = std::fs::create_dir_all(&home) {
        eprintln!("can't create {}: {e}", home.display());
        std::process::exit(1);
    }
    // One server per machine: it owns every project's agents.
    let lock = std::fs::File::create(home.join("serve.lock")).expect("serve.lock");
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let port = std::fs::read_to_string(home.join("port")).unwrap_or_default();
        eprintln!(
            "acom is already running (port {}). One server handles every project.",
            port.trim()
        );
        std::process::exit(1);
    }
    let url = format!("http://127.0.0.1:{port}");
    let server = match tiny_http::Server::http(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("can't listen on 127.0.0.1:{port}: {e}. Use --port to pick another.");
            std::process::exit(1);
        }
    };
    let app = match App::open(home.clone(), url.clone()) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("can't start: {}", e.1);
            std::process::exit(1);
        }
    };
    let _ = std::fs::write(home.join("port"), port.to_string());
    println!("acom is running at {url} (data in {})", home.display());
    {
        let app = app.clone();
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_secs(1));
                if let Err(e) = app.tick() {
                    eprintln!("tick: {}", e.1);
                }
                if let Err(e) = crate::usage::schedule(&app) {
                    eprintln!("usage checks: {}", e.1);
                }
            }
        });
    }
    for req in server.incoming_requests() {
        let app = app.clone();
        thread::spawn(move || handle(&app, req));
    }
    drop(lock);
}

fn handle(app: &Arc<App>, mut req: tiny_http::Request) {
    let method = req.method().as_str().to_string();
    let url = req.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    let res = if !same_origin(app, &req, &method) {
        Err(Fail(
            403,
            "requests must come from this server's own page or the acom command".into(),
        ))
    } else if body.trim().is_empty() {
        Ok(Value::Null)
    } else {
        serde_json::from_str(&body).map_err(|e| bad(format!("bad JSON: {e}")))
    }
    .and_then(|b| {
        let segs: Vec<&str> = path
            .trim_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        route(app, &method, &segs, &Query(query), &b)
    });
    let (code, body, ctype) = match res {
        Ok(Reply::Html(h)) => (200, h.to_string(), "text/html; charset=utf-8"),
        Ok(Reply::Text(t)) => (200, t.to_string(), "text/plain; charset=utf-8"),
        Ok(Reply::Json(v)) => (200, v.to_string(), "application/json"),
        Err(Fail(code, msg)) => (
            code,
            json!({ "error": msg }).to_string(),
            "application/json",
        ),
    };
    let header = tiny_http::Header::from_bytes("Content-Type", ctype).unwrap();
    let _ = req.respond(
        tiny_http::Response::from_string(body)
            .with_status_code(code)
            .with_header(header),
    );
}

/// No auth, but a web page elsewhere mustn't be able to drive the server: the Host and
/// Origin must be this server, and writes must be JSON, which browsers won't send
/// cross-origin without a preflight we never answer.
fn same_origin(app: &App, req: &tiny_http::Request, method: &str) -> bool {
    let header = |name: &'static str| {
        req.headers()
            .iter()
            .find(|h| h.field.equiv(name))
            .map(|h| h.value.as_str().to_string())
    };
    let local = app.url.replace("127.0.0.1", "localhost");
    let host_ok = header("Host").is_some_and(|h| {
        app.url.ends_with(&format!("//{h}")) || local.ends_with(&format!("//{h}"))
    });
    let origin_ok = header("Origin").is_none_or(|o| o == app.url || o == local);
    let json_ok = method == "GET"
        || header("Content-Type").is_some_and(|c| c.starts_with("application/json"));
    host_ok && origin_ok && json_ok
}

enum Reply {
    Json(Value),
    Html(&'static str),
    Text(&'static str),
}

struct Query<'a>(&'a str);

impl Query<'_> {
    fn get(&self, key: &str) -> Option<String> {
        self.0
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(k, _)| *k == key)
            .map(|(_, v)| decode(v))
    }
    fn int(&self, key: &str) -> R<Option<i64>> {
        self.get(key)
            .map(|v| {
                v.parse()
                    .map_err(|_| bad(format!("{key} must be a number")))
            })
            .transpose()
    }
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn int(b: &Value, key: &str) -> R<i64> {
    b[key]
        .as_i64()
        .ok_or_else(|| bad(format!("{key} is required and must be a number")))
}
fn opt_int(b: &Value, key: &str) -> Option<i64> {
    b[key].as_i64()
}
fn text(b: &Value, key: &str) -> R<String> {
    b[key]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| bad(format!("{key} is required")))
}
fn opt_text(b: &Value, key: &str) -> Option<String> {
    b[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}
fn list(b: &Value, key: &str) -> Vec<String> {
    match &b[key] {
        Value::Array(a) => a
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| v.to_string())
            })
            .collect(),
        Value::String(s) => vec![s.clone()],
        _ => vec![],
    }
}
fn settings(b: &Value, key: &str) -> R<Settings> {
    serde_json::from_value(b[key].clone()).map_err(|e| bad(format!("bad settings: {e}")))
}
fn id(seg: &str) -> R<i64> {
    seg.parse()
        .map_err(|_| bad(format!("{seg} isn't a number")))
}

/// Who a user command came from: "user", or "user (via agent 7)".
fn user(b: &Value) -> String {
    actor(0, opt_int(b, "via"))
}

fn route(app: &Arc<App>, method: &str, p: &[&str], q: &Query, b: &Value) -> R<Reply> {
    use Reply::Json as J;
    Ok(match (method, p) {
        ("GET", []) => Reply::Html(UI),
        ("GET", ["models"]) => Reply::Text(crate::app::MODELS),
        ("POST", ["agent-config"]) => {
            app.configure_agent(
                int(b, "id")?,
                opt_int(b, "agent").unwrap_or(0),
                opt_text(b, "model").as_deref(),
                opt_text(b, "effort").as_deref(),
            )?;
            J(json!({}))
        }
        ("GET", ["overview"]) => {
            // Everything the page shows, for one project (the first one by default).
            let projects = app.projects()?;
            let wanted = q.int("project")?;
            let current = projects
                .iter()
                .find(|p| wanted.is_none_or(|w| p["id"] == w))
                .or(projects.first())
                .cloned();
            let pid = current.as_ref().and_then(|p| p["id"].as_i64());
            let (agents, threads, locks) = match pid {
                Some(p) => (
                    json!(app.agents(Some(p), None)?),
                    json!(app.threads(Some(p), None)?),
                    json!(app.locks(Some(p))?),
                ),
                None => (json!([]), json!([]), json!([])),
            };
            J(json!({
                "url": app.url,
                "projects": projects,
                "project": current,
                "agents": agents,
                "threads": threads,
                "locks": locks,
                "limits": app.limits(pid)?,
                "activity": app.activity(pid, 100)?,
                "settings": app.settings(pid),
                "configs": app.configs()?,
                "model_catalog": { "claude": catalog("claude"), "codex": catalog("codex") },
            }))
        }

        // projects
        ("GET", ["projects"]) => match q.get("path") {
            Some(path) => J(app.project_at(&path)?),
            None => J(json!(app.projects()?)),
        },
        ("POST", ["projects"]) => J(app.add_project(&text(b, "path")?, &user(b))?),
        ("POST", ["projects", p, "remove"]) => {
            app.remove_project(id(p)?, &user(b))?;
            J(json!({}))
        }

        // agents
        ("GET", ["agents"]) => J(json!(
            app.agents(q.int("project")?, q.get("group").as_deref())?
        )),
        ("GET", ["agents", a]) => J(app.agent_view(id(a)?)?),
        ("GET", ["agents", a, "log"]) => {
            let n = q.int("lines")?.unwrap_or(200).max(1) as usize;
            let txt = std::fs::read_to_string(crate::run::log_path(app, id(a)?, "txt"))
                .unwrap_or_default();
            let lines: Vec<&str> = txt.lines().collect();
            J(json!({ "lines": lines[lines.len().saturating_sub(n)..] }))
        }
        ("POST", ["agents"]) => {
            let by = opt_int(b, "agent").unwrap_or(0);
            let req = LaunchReq {
                task: text(b, "task")?,
                harness: opt_text(b, "harness"),
                model: opt_text(b, "model"),
                effort: opt_text(b, "effort"),
                name: opt_text(b, "name"),
                group: opt_text(b, "group"),
                force: b["force"].as_bool().unwrap_or(false),
                done: b["done"].as_bool().unwrap_or(false),
            };
            let (new, warnings) = app.launch(by, opt_int(b, "via"), opt_int(b, "project"), req)?;
            J(json!({ "id": new, "warnings": warnings }))
        }
        ("POST", ["agents", a, "status"]) => {
            app.set_status(id(a)?, &text(b, "text")?)?;
            J(json!({}))
        }
        ("POST", ["agents", a, "group"]) => {
            app.set_group(id(a)?, &text(b, "group")?)?;
            J(json!({}))
        }
        ("POST", ["agents", a, "done"]) => {
            app.mark_done(id(a)?)?;
            J(json!({}))
        }
        ("POST", ["agents", a, "pause"]) => {
            let mode = match b["locks"].as_str() {
                Some("release") => LockMode::Release,
                Some("keep") => LockMode::Keep,
                None => LockMode::Ask,
                Some(x) => return Err(bad(format!("locks must be release or keep, not {x}"))),
            };
            app.pause(id(a)?, mode, &user(b))?;
            J(json!({}))
        }
        ("POST", ["agents", a, "resume"]) => {
            J(json!({ "warnings": app.resume(id(a)?, &user(b))? }))
        }
        ("POST", ["agents", a, "close"]) => {
            app.close(id(a)?, &user(b))?;
            J(json!({}))
        }
        ("POST", ["agents", a, "reopen"]) => {
            app.reopen(id(a)?, &user(b))?;
            J(json!({}))
        }
        ("POST", ["pause-all"]) => J(json!({ "ids": app.pause_all(&user(b))? })),
        ("POST", ["resume-all"]) => J(json!({ "ids": app.resume_all(&user(b))? })),
        ("POST", ["hook", a]) => J(json!({ "text": app.hook(id(a)?)? })),

        // threads and messages
        ("GET", ["threads"]) => J(json!(app.threads(q.int("project")?, q.int("agent")?)?)),
        ("POST", ["threads"]) => {
            let (tid, members) = app.new_thread(
                opt_int(b, "agent").unwrap_or(0),
                opt_int(b, "project"),
                &text(b, "title")?,
                &list(b, "members"),
                b["include_user"].as_bool().unwrap_or(true),
            )?;
            J(json!({ "id": tid, "members": members }))
        }
        ("GET", ["threads", t]) => J(app.thread(id(t)?)?),
        ("POST", ["threads", t, "read"]) => {
            if b.get("agent").is_some_and(|a| a.as_i64() != Some(0)) {
                return Err(bad("only the user can mark a thread read"));
            }
            J(app.read_thread(
                id(t)?,
                b["message"]
                    .as_i64()
                    .ok_or_else(|| bad("message must be an integer"))?,
            )?)
        }
        ("POST", ["threads", t, "members"]) => {
            J(json!({ "members": app.add_members(id(t)?, &list(b, "members"))? }))
        }
        ("POST", ["threads", t, "user"]) => {
            app.user_membership(
                id(t)?,
                b["joined"]
                    .as_bool()
                    .ok_or_else(|| bad("joined must be true or false"))?,
            )?;
            J(json!({}))
        }
        ("GET", ["folders"]) => J(folders(
            q.get("path").as_deref(),
            q.get("hidden").as_deref() == Some("1"),
        )?),
        ("POST", ["folders"]) => {
            let parent =
                std::fs::canonicalize(text(b, "parent")?).map_err(|e| bad(e.to_string()))?;
            if parent.to_str().is_none() {
                return Err(bad("folder path is not valid UTF-8"));
            }
            let name = text(b, "name")?;
            if name.is_empty()
                || name == "."
                || name == ".."
                || name.contains(['/', '\\'])
                || name.contains('\0')
            {
                return Err(bad("give a folder name, not a path"));
            }
            let path = parent.join(name);
            std::fs::create_dir(&path).map_err(|e| bad(format!("cannot create folder: {e}")))?;
            J(json!({"path":path}))
        }
        ("POST", ["usage", "check"]) => {
            let provider = text(b, "provider")?;
            if !crate::harness::KNOWN.contains(&provider.as_str()) {
                return Err(bad("unknown provider"));
            }
            app.lock().db.execute("INSERT INTO usage_checks(provider,next_check) VALUES(?1,?2) ON CONFLICT(provider) DO UPDATE SET next_check=?2", rusqlite::params![provider,crate::app::now()])?;
            J(json!({}))
        }
        ("POST", ["messages"]) => {
            let (mid, not_woken) = app.post(
                opt_int(b, "agent").unwrap_or(0),
                int(b, "thread")?,
                &text(b, "text")?,
            )?;
            let not_woken: Vec<Value> = not_woken
                .into_iter()
                .map(|(agent, reason)| json!({ "agent": agent, "reason": reason }))
                .collect();
            J(json!({ "id": mid, "not_woken": not_woken }))
        }
        ("GET", ["messages", m]) => J(app.message(id(m)?)?),
        ("GET", ["inbox", a]) => J(json!(
            app.inbox(id(a)?, q.get("mark").as_deref().unwrap_or("new"))?
        )),
        ("POST", ["marks"]) => {
            let ids: Vec<i64> = b["ids"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_i64).collect())
                .unwrap_or_default();
            if ids.is_empty() {
                return Err(bad("ids is required"));
            }
            app.set_marks(int(b, "agent")?, &ids, &text(b, "mark")?)?;
            J(json!({}))
        }

        // locks
        ("GET", ["locks"]) => J(json!(app.locks(q.int("project")?)?)),
        ("POST", ["locks"]) => {
            // An agent's lock goes in its own project.
            let project = match opt_int(b, "agent") {
                Some(a) => app.agent_project(a)?,
                None => int(b, "project")?,
            };
            app.new_lock(project, &text(b, "name")?, &text(b, "about")?)?;
            J(json!({}))
        }
        ("POST", ["locks", "acquire"]) => {
            let ttl =
                match b.get("ttl") {
                    None | Some(Value::Null) => None,
                    Some(value) => Some(value.as_u64().ok_or_else(|| {
                        bad("lock TTL must be a positive whole number of seconds")
                    })?),
                };
            let wait = opt_int(b, "wait").unwrap_or(0).max(0) as u64;
            J(json!({ "result": app.acquire(int(b, "agent")?, &text(b, "name")?, wait, ttl)? }))
        }
        ("POST", ["locks", "release"]) => {
            app.release(int(b, "agent")?, &text(b, "name")?)?;
            J(json!({}))
        }
        ("POST", ["locks", "free"]) => {
            app.free(int(b, "project")?, &text(b, "name")?, &user(b))?;
            J(json!({}))
        }

        // limits, activity, settings
        ("GET", ["limits"]) => J(app.limits(q.int("project")?)?),
        ("GET", ["activity"]) => J(json!(
            app.activity(q.int("project")?, q.int("limit")?.unwrap_or(100))?
        )),

        // configs: Default (id 1), saved ones, and each project's choice
        ("GET", ["configs"]) => J(json!(app.configs()?)),
        ("POST", ["configs"]) => {
            let id = app.add_config(&text(b, "name")?, settings(b, "settings")?, &user(b))?;
            J(json!({ "id": id }))
        }
        ("PUT", ["configs", c]) => {
            let name = opt_text(b, "name");
            app.put_config(id(c)?, name.as_deref(), settings(b, "settings")?, &user(b))?;
            J(json!({}))
        }
        ("POST", ["configs", c, "remove"]) => {
            app.remove_config(id(c)?, &user(b))?;
            J(json!({}))
        }
        ("PUT", ["projects", p, "config"]) => {
            let custom = if b["custom"].is_null() {
                None
            } else {
                Some(settings(b, "custom")?)
            };
            app.set_project_config(id(p)?, opt_int(b, "config"), custom, &user(b))?;
            J(json!({}))
        }
        _ => return Err(not_found(format!("no route {method} /{}", p.join("/")))),
    })
}

fn folders(path: Option<&str>, hidden: bool) -> R<Value> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| bad("home folder unavailable"))?;
    let path = path
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.clone());
    let path = std::fs::canonicalize(path).map_err(|e| bad(format!("cannot open folder: {e}")))?;
    if path.to_str().is_none() || home.to_str().is_none() {
        return Err(bad(
            "folder path is not valid UTF-8; use a UTF-8 folder name",
        ));
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| bad(format!("cannot list folder: {e}")))? {
        let entry = entry.map_err(|e| bad(e.to_string()))?;
        if entry.path().to_str().is_none() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !hidden && name.starts_with('.') {
            continue;
        }
        entries.push(json!({"name":name,"path":entry.path(),"directory":entry.path().is_dir()}));
    }
    entries.sort_by(|a, b| {
        b["directory"]
            .as_bool()
            .cmp(&a["directory"].as_bool())
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    let truncated = entries.len() > 1000;
    entries.truncate(1000);
    Ok(
        json!({"path":path,"parent":path.parent(),"home":home,"entries":entries,"truncated":truncated}),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes_query_values() {
        assert_eq!(super::decode("group%3Aparser+team"), "group:parser team");
        assert_eq!(super::decode("100%"), "100%");
    }
}
