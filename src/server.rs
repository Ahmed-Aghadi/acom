// The HTTP API. Thin: it parses requests and calls into App.

use crate::app::{
    AgentFilter, App, Fail, HistoryQuery, LaunchReq, PageQuery, ParsedAgentQuery, R, Settings,
    ThreadReq, UsageWatch, WaitAgents, WaitOptions, acom_home, actor, bad, bounded_record,
    not_found,
};
use crate::harness::catalog;
use serde_json::{Value, json};
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

const UI: &str = include_str!("ui.html");
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

extern "C" fn request_stop(_: libc::c_int) {
    STOP_REQUESTED.store(true, Ordering::Relaxed);
}

fn install_stop_handlers() -> std::io::Result<()> {
    // The handler only sets a flag; persistence and process cleanup happen in
    // the normal server thread, never inside the signal handler.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = request_stop as *const () as usize;
    unsafe { libc::sigemptyset(&mut action.sa_mask) };
    for sig in [libc::SIGINT, libc::SIGTERM] {
        if unsafe { libc::sigaction(sig, &action, std::ptr::null_mut()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

pub fn serve(port: u16) {
    if let Err(e) = install_stop_handlers() {
        eprintln!("can't install shutdown handlers: {e}");
        std::process::exit(1);
    }
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
                if STOP_REQUESTED.load(Ordering::Relaxed) {
                    break;
                }
                if let Err(e) = app.tick() {
                    eprintln!("tick: {}", e.1);
                }
                if let Err(e) = crate::usage::schedule(&app) {
                    eprintln!("usage checks: {}", e.1);
                }
            }
        });
    }
    while !STOP_REQUESTED.load(Ordering::Relaxed) {
        match server.recv_timeout(Duration::from_millis(100)) {
            Ok(Some(req)) => {
                let app = app.clone();
                thread::spawn(move || handle(&app, req));
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("server stopped accepting requests: {e}");
                break;
            }
        }
    }
    if let Err(e) = app.shutdown() {
        eprintln!(
            "couldn't save shutdown state: {}. Interrupted agents will be reconciled on restart.",
            e.1
        );
    }
    drop(lock);
}

fn handle(app: &Arc<App>, mut req: tiny_http::Request) {
    let method = req.method().as_str().to_string();
    let url = req.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let mut body = String::new();
    let read = req.as_reader().read_to_string(&mut body);
    let res = if !same_origin(app, &req, &method) {
        Err(Fail(
            403,
            "requests must come from this server's own page or the acom command".into(),
        ))
    } else if let Err(error) = read {
        Err(bad(format!("cannot read request body: {error}")))
    } else if body.trim().is_empty() {
        Ok(json!({}))
    } else {
        parse_body(&body)
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
        Err(Fail(code, msg)) => (code, error_body(&msg), "application/json"),
    };
    let header = tiny_http::Header::from_bytes("Content-Type", ctype).unwrap();
    let _ = req.respond(
        tiny_http::Response::from_string(body)
            .with_status_code(code)
            .with_header(header),
    );
}

fn error_body(msg: &str) -> String {
    const BUDGET: usize = 16000;
    let full = json!({"error":msg}).to_string();
    if full.len() <= BUDGET {
        return full;
    }
    let envelope = |end: usize| {
        json!({"error":format!("{} … (error text truncated)",&msg[..end]),"truncated":true})
            .to_string()
    };
    let mut boundaries: Vec<usize> = msg
        .char_indices()
        .map(|(n, _)| n)
        .take_while(|n| *n <= BUDGET)
        .collect();
    boundaries.push(msg.len().min(BUDGET));
    while boundaries
        .last()
        .is_some_and(|end| !msg.is_char_boundary(*end))
    {
        boundaries.pop();
    }
    let (mut low, mut high) = (0, boundaries.len() - 1);
    while low < high {
        let mid = (low + high).div_ceil(2);
        if envelope(boundaries[mid]).len() <= BUDGET {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    envelope(boundaries[low])
}

fn parse_body(body: &str) -> R<Value> {
    let value = serde_json::from_str::<UniqueJson>(body)
        .map(|value| value.0)
        .map_err(|error| bad(format!("bad JSON: {error}")))?;
    if !value.is_object() {
        return Err(bad("request body must be a JSON object"));
    }
    Ok(value)
}

struct UniqueJson(Value);

impl<'de> serde::Deserialize<'de> for UniqueJson {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueJson;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("JSON without duplicate object fields")
            }
            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(value)))
            }
            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(value)))
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(value)))
            }
            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(value)))
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(value)))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Null))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(UniqueJson(value)) = seq.next_element()? {
                    values.push(value);
                }
                Ok(UniqueJson(Value::Array(values)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some((key, UniqueJson(value))) = map.next_entry::<String, UniqueJson>()? {
                    if values.insert(key.clone(), value).is_some() {
                        return Err(serde::de::Error::custom(format!("duplicate field {key:?}")));
                    }
                }
                Ok(UniqueJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
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
            .find(|(k, _)| decode(k) == key)
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

fn boolean(b: &Value, key: &str, default: bool) -> R<bool> {
    match b.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| bad(format!("{key} must be true or false"))),
    }
}

fn identity(b: &Value, key: &str) -> R<i64> {
    match b.get(key) {
        None => Ok(0),
        Some(value) => value
            .as_i64()
            .filter(|id| *id >= 0)
            .ok_or_else(|| bad(format!("{key} must be 0 (user) or a positive agent ID"))),
    }
}

fn wait_options(b: &Value) -> R<WaitOptions> {
    let agents = match b.get("agents") {
        None => None,
        Some(Value::String(value)) if value == "all" => Some(WaitAgents::All(value.clone())),
        Some(Value::Array(values)) => Some(WaitAgents::Selected(
            values
                .iter()
                .map(|value| {
                    value
                        .as_i64()
                        .filter(|id| *id > 0)
                        .ok_or_else(|| bad("watched agent IDs must be positive integers"))
                })
                .collect::<R<Vec<_>>>()?,
        )),
        _ => return Err(bad("agents must be all or an array of agent IDs")),
    };
    let states = match b.get("states") {
        None => None,
        Some(Value::Array(values)) => Some(
            values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| bad("states must be an array of lifecycle states"))
                })
                .collect::<R<Vec<_>>>()?,
        ),
        _ => return Err(bad("states must be an array of lifecycle states")),
    };
    let after = b
        .get("after")
        .map(|value| {
            value
                .as_i64()
                .filter(|value| *value >= 0)
                .ok_or_else(|| bad("after must be a nonnegative event ID"))
        })
        .transpose()?;
    Ok(WaitOptions {
        agents,
        states,
        status_text: boolean(b, "status_text", false)?,
        after,
        usage: b
            .get("usage")
            .map(|value| {
                serde_json::from_value::<UsageWatch>(value.clone())
                    .map_err(|error| bad(format!("bad usage watch: {error}")))
            })
            .transpose()?,
    })
}

fn subscription_timeout(b: &Value) -> R<Option<u64>> {
    b.get("timeout")
        .map(|value| {
            value
                .as_u64()
                .filter(|value| (1..=3600).contains(value))
                .ok_or_else(|| bad("deferred wait timeout must be 1–3600 seconds"))
        })
        .transpose()
}
fn settings(b: &Value, key: &str) -> R<Settings> {
    serde_json::from_value(b[key].clone()).map_err(|e| bad(format!("bad settings: {e}")))
}
fn id(seg: &str) -> R<i64> {
    seg.parse()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| bad(format!("{seg} must be a positive integer ID")))
}

/// Route contracts live beside routing so unsupported inputs cannot silently become defaults.
fn validate_request(method: &str, p: &[&str], q: &Query, b: &Value) -> R<()> {
    const PAGE: &str = "before after through revision since limit max_bytes";
    const RECORD: &str = "offset version max_bytes";
    const WATCH: &str = "agents states status_text after usage";
    const LAUNCH: &str = "task harness model effort name group force done ack_crashes";
    let (body, query, extra) = match (method, p) {
        ("GET", []) => ("", "project", ""),
        ("GET", ["models"] | ["catalog"] | ["agents", _, "project"]) => ("", "", ""),
        ("GET", ["overview"]) => ("", "project since", RECORD),
        ("GET", ["settings"] | ["limits"] | ["locks", _]) => ("", "project", RECORD),
        ("GET", ["projects"]) if q.get("path").is_some() => ("", "path", RECORD),
        ("GET", ["projects"] | ["configs"] | ["notices", _]) => ("", "", PAGE),
        ("GET", ["projects", _] | ["configs", _] | ["notices", _, _]) => ("", "", RECORD),
        ("GET", ["agents"]) => (
            "",
            "project group category search state pause_reason provider model effort",
            PAGE,
        ),
        ("GET", ["agent-query"]) => ("", "search", RECORD),
        ("GET", ["agents", _] | ["messages", _] | ["receipts", _]) => ("", "agent", RECORD),
        ("GET", ["agents", _, "log"]) => (
            "",
            "agent lines before after through version since limit max_bytes",
            "",
        ),
        ("GET", ["subscriptions"]) => ("", "agent viewer", PAGE),
        ("GET", ["subscriptions", _]) => ("", "viewer", RECORD),
        ("GET", ["threads"]) => ("", "project agent viewer", PAGE),
        ("GET", ["threads", _]) => ("", "agent offset version", PAGE),
        ("GET", ["threads", _, "metadata"]) => ("", "agent", RECORD),
        ("GET", ["threads", _, "messages"]) => ("", "agent", PAGE),
        ("GET", ["folders"]) => (
            "",
            "path hidden before after revision since limit max_bytes",
            "",
        ),
        ("GET", ["inbox", _]) => ("", "mark", PAGE),
        ("GET", ["locks"]) => ("", "project", PAGE),
        ("GET", ["activity"]) => ("", "project agent", PAGE),
        ("GET", ["activity", _]) => ("", "project agent", RECORD),
        ("GET", ["history"]) => (
            "",
            "project viewer agent thread lock kind before after limit max_bytes",
            "",
        ),
        ("GET", ["history", _]) => ("", "project viewer", RECORD),
        ("POST", ["agent-config"]) => ("id agent model effort continuation ack_crashes", "", ""),
        ("POST", ["projects"]) => ("path via", "", ""),
        (
            "POST",
            ["projects", _, "remove"]
            | ["configs", _, "remove"]
            | ["agents", _, "pause" | "resume" | "close" | "reopen"],
        ) => ("via", "", ""),
        ("POST", ["pause-all"] | ["resume-all"] | ["resume-restart"]) => ("project via", "", ""),
        ("POST", ["agents"]) => (LAUNCH, "", "agent via project"),
        ("POST", ["agents", _, "replacement"]) => (LAUNCH, "", ""),
        ("POST", ["agents", _, "status"]) => ("text", "", ""),
        ("POST", ["agents", _, "group"]) => ("group", "", ""),
        ("POST", ["agents", _, "done"] | ["hook", _]) => ("", "", ""),
        ("POST", ["wait", _]) => (WATCH, "", "timeout"),
        ("POST", ["wait", _, "ack"]) => ("delivery_id", "", ""),
        ("POST", ["subscriptions"]) => (WATCH, "", "agent timeout"),
        ("POST", ["subscriptions", _, "cancel"]) => ("agent", "", ""),
        ("POST", ["threads"]) => (
            "agent project title members include_user watch private joinable",
            "",
            "",
        ),
        ("POST", ["threads", _, "read"]) => ("agent message", "", ""),
        ("POST", ["threads", _, "members"] | ["threads", _, "members", "remove"]) => {
            ("agent members", "", "")
        }
        ("POST", ["threads", _, "owner"]) => ("agent owner", "", ""),
        ("POST", ["threads", _, "user"]) => ("agent joined", "", ""),
        ("POST", ["folders"]) => ("parent name", "", ""),
        ("POST", ["usage", "check"]) => ("provider", "", ""),
        ("POST", ["messages"]) => ("agent thread text", "", ""),
        ("POST", ["marks"]) => ("agent ids mark", "", ""),
        ("POST", ["locks"]) => ("agent project name about", "", ""),
        ("POST", ["locks", "acquire"]) => ("agent name wait ttl", "", ""),
        ("POST", ["locks", "release"]) => ("agent name", "", ""),
        ("POST", ["locks", "free"]) => ("project name via", "", ""),
        ("POST", ["configs"]) | ("PUT", ["configs", _]) => ("name settings via", "", ""),
        ("PUT", ["projects", _, "config"]) => ("config custom via", "", ""),
        _ => return Err(not_found(format!("no route {method} /{}", p.join("/")))),
    };
    let allowed = |key: &str, fields: &str| fields.split_ascii_whitespace().any(|f| f == key);
    let body_extra = if method == "GET" { "" } else { extra };
    match b.as_object() {
        Some(fields) => {
            for (key, value) in fields {
                if !allowed(key, body) && !allowed(key, body_extra) {
                    return Err(bad(format!("unknown request field {key:?}")));
                }
                validate_body_value(method, p, key, value)?;
            }
        }
        None if method == "GET" && b.is_null() => {}
        None => return Err(bad("request body must be a JSON object")),
    }
    let mut seen = std::collections::HashSet::new();
    for part in q.0.split('&').filter(|part| !part.is_empty()) {
        let (key, value) = part
            .split_once('=')
            .ok_or_else(|| bad("query parameters must use name=value"))?;
        let key = strict_decode(key)?;
        let value = strict_decode(value)?;
        if !(allowed(&key, query) || method == "GET" && allowed(&key, extra)) {
            return Err(bad(format!("unknown query parameter {key:?}")));
        }
        if !seen.insert(key.clone()) {
            return Err(bad(format!("query parameter {key:?} must not be repeated")));
        }
        validate_query_value(p, &key, &value)?;
    }
    if method == "GET" && p == ["agents"] {
        AgentFilter {
            group: q.get("group").as_deref(),
            category: q.get("category").as_deref().unwrap_or("all"),
            search: q.get("search").as_deref().unwrap_or(""),
            state: q.get("state").as_deref(),
            pause_reason: q.get("pause_reason").as_deref(),
            provider: q.get("provider").as_deref(),
            model: q.get("model").as_deref(),
            effort: q.get("effort").as_deref(),
        }
        .normalized()?;
    }
    if method == "GET" && p == ["agent-query"] {
        ParsedAgentQuery::parse(q.get("search").as_deref().unwrap_or(""))?;
    }
    if method == "GET" && extra == PAGE {
        page(q)?.validate()?;
    }
    if method == "GET"
        && (extra == RECORD || allowed("offset", query))
        && q.get("version").is_some()
        && q.get("offset").is_none()
    {
        return Err(bad("version requires an explicit record offset"));
    }
    if method == "GET"
        && matches!(p, ["agents", _, "log"])
        && q.get("lines").is_some()
        && q.get("limit").is_some()
    {
        return Err(bad("use lines or limit, not both"));
    }
    if method == "POST"
        && matches!(
            p,
            ["threads", _, "members"] | ["threads", _, "members", "remove"]
        )
        && list(b, "members").is_empty()
    {
        return Err(bad("members must contain at least one selector"));
    }
    if method == "POST"
        && matches!(p, ["agents"] | ["threads"] | ["locks"])
        && b["agent"].as_i64().is_some_and(|agent| agent > 0)
        && b.get("project").is_some()
    {
        return Err(bad("agents use their own project; omit project"));
    }
    Ok(())
}

fn validate_body_value(method: &str, p: &[&str], key: &str, value: &Value) -> R<()> {
    let launch = method == "POST" && matches!(p, ["agents"] | ["agents", _, "replacement"]);
    let nullable = (launch && matches!(key, "harness" | "model" | "effort" | "name" | "group"))
        || (p == ["agent-config"] && matches!(key, "model" | "effort" | "continuation"))
        || (method == "PUT"
            && matches!(p, ["projects", _, "config"])
            && matches!(key, "config" | "custom"))
        || (key == "ttl" && p == ["locks", "acquire"]);
    if nullable && value.is_null() {
        return Ok(());
    }
    let valid = match key {
        "agent" | "via" | "message" | "after" => value.as_i64().is_some_and(|n| n >= 0),
        "id" | "project" | "thread" | "owner" | "delivery_id" | "config" => {
            value.as_i64().is_some_and(|n| n > 0)
        }
        "timeout" | "wait" => value.as_u64().is_some(),
        "ttl" => value.as_u64().is_some_and(|n| n > 0),
        "force" | "done" | "ack_crashes" | "private" | "joinable" | "include_user" | "joined"
        | "status_text" => value.is_boolean(),
        "ids" => value.as_array().is_some_and(|ids| {
            !ids.is_empty() && ids.iter().all(|id| id.as_i64().is_some_and(|n| n > 0))
        }),
        "members" | "watch" => {
            let selector = |v: &Value| v.as_str().is_some_and(|s| !s.trim().is_empty());
            selector(value)
                || value.as_array().is_some_and(|items| {
                    items.iter().all(|item| {
                        selector(item)
                            || (key == "members" && item.as_i64().is_some_and(|id| id >= 0))
                    })
                })
        }
        "agents" | "states" | "usage" => return Ok(()), // Parsed by wait_options before application calls.
        "settings" | "custom" => value.is_object(),
        _ => value.as_str().is_some_and(|text| {
            !(matches!(key, "harness" | "model" | "effort" | "continuation")
                || (key == "name" && method == "PUT" && matches!(p, ["configs", _])))
                || !text.trim().is_empty()
        }),
    };
    if valid {
        Ok(())
    } else {
        if key == "wait" {
            return Err(bad(
                "lock wait must be a nonnegative whole number of seconds",
            ));
        }
        if key == "ttl" {
            return Err(bad("lock TTL must be a positive whole number of seconds"));
        }
        Err(bad(format!(
            "invalid {key}: wrong type, empty value or out of range"
        )))
    }
}

fn validate_query_value(p: &[&str], key: &str, value: &str) -> R<()> {
    let number = || {
        value
            .parse::<i64>()
            .map_err(|_| bad(format!("{key} must be an integer")))
    };
    let valid = match key {
        "agent" | "viewer" | "offset" | "through" => number()? >= 0,
        "project" | "thread" => number()? > 0,
        "limit" | "lines" => (1..=200).contains(&number()?),
        "max_bytes" => (512..=65536).contains(&number()?),
        "before" | "after" if p != ["folders"] => number()? >= 0,
        "hidden" => matches!(value, "0" | "1"),
        "category" => matches!(value, "all" | "active" | "attention" | "finished"),
        "mark" => crate::app::MARKS.contains(&value),
        "group" | "search" | "state" | "pause_reason" | "provider" | "model" | "effort" => true,
        _ => !value.is_empty(),
    };
    if valid {
        Ok(())
    } else {
        Err(bad(format!("invalid query parameter {key}")))
    }
}

fn strict_decode(value: &str) -> R<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = bytes
                    .get(i + 1..i + 3)
                    .and_then(|hex| std::str::from_utf8(hex).ok())
                    .and_then(|hex| u8::from_str_radix(hex, 16).ok())
                    .ok_or_else(|| bad("invalid percent encoding in query parameter"))?;
                out.push(hex);
                i += 3;
            }
            byte => {
                out.push(if byte == b'+' { b' ' } else { byte });
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| bad("query parameters must be valid UTF-8"))
}

/// Who a user command came from: "user", or "user (via agent 7)".
fn user(b: &Value) -> String {
    actor(0, opt_int(b, "via"))
}

fn page(q: &Query) -> R<PageQuery> {
    Ok(PageQuery {
        before: q.int("before")?,
        after: q.int("after")?,
        through: q.int("through")?,
        revision: q.get("revision"),
        since: q.get("since"),
        limit: q.int("limit")?.unwrap_or(50),
        max_bytes: q.int("max_bytes")?.unwrap_or(16000),
    })
}

fn record(value: Value, q: &Query) -> R<Value> {
    bounded_record(
        value,
        q.int("offset")?,
        q.int("max_bytes")?.unwrap_or(16000),
        q.get("version").as_deref(),
    )
}

fn route(app: &Arc<App>, method: &str, p: &[&str], q: &Query, b: &Value) -> R<Reply> {
    use Reply::Json as J;
    validate_request(method, p, q, b)?;
    if app.lock().shutting_down {
        return Err(Fail(503, "the server is stopping".into()));
    }
    // On the HTML shell, project is a client selection hint, not a resource read.
    if !p.is_empty()
        && let Some(project) = q.int("project")?.or_else(|| opt_int(b, "project"))
    {
        app.lock().project(project)?;
    }
    let reply = match (method, p) {
        ("GET", []) => Reply::Html(UI),
        ("GET", ["models"]) => Reply::Text(crate::app::MODELS),
        ("POST", ["agent-config"]) => {
            app.configure_agent(
                int(b, "id")?,
                opt_int(b, "agent").unwrap_or(0),
                opt_text(b, "model").as_deref(),
                opt_text(b, "effort").as_deref(),
                if b["continuation"].is_null() {
                    None
                } else {
                    Some(
                        b["continuation"]
                            .as_str()
                            .ok_or_else(|| bad("continuation must be text"))?,
                    )
                },
                b["ack_crashes"].as_bool().unwrap_or(false),
            )?;
            J(json!({}))
        }
        ("GET", ["overview"]) => J(record(
            app.overview(q.int("project")?, q.get("since").as_deref())?,
            q,
        )?),
        ("GET", ["settings"]) => J(record(json!(app.settings(q.int("project")?)), q)?),
        ("GET", ["catalog"]) => {
            J(json!({ "claude": catalog("claude"), "codex": catalog("codex") }))
        }

        // projects
        ("GET", ["projects"]) => match q.get("path") {
            Some(path) => J(record(app.project_at(&path)?, q)?),
            None => J(app.projects_page(page(q)?)?),
        },
        ("GET", ["projects", p]) => J(record(app.project_view(id(p)?)?, q)?),
        ("POST", ["projects"]) => J(app.add_project(&text(b, "path")?, &user(b))?),
        ("POST", ["projects", p, "remove"]) => {
            app.remove_project(id(p)?, &user(b))?;
            J(json!({}))
        }

        // agents
        ("GET", ["agent-query"]) => J(record(
            ParsedAgentQuery::parse(q.get("search").as_deref().unwrap_or(""))?.view(),
            q,
        )?),
        ("GET", ["agents"]) => J(app.filtered_agents_page(
            q.int("project")?,
            AgentFilter {
                group: q.get("group").as_deref(),
                category: q.get("category").as_deref().unwrap_or("all"),
                search: q.get("search").as_deref().unwrap_or(""),
                state: q.get("state").as_deref(),
                pause_reason: q.get("pause_reason").as_deref(),
                provider: q.get("provider").as_deref(),
                model: q.get("model").as_deref(),
                effort: q.get("effort").as_deref(),
            },
            page(q)?,
        )?),
        ("GET", ["agents", a]) => J(record(app.agent_view_for(id(a)?, q.int("agent")?)?, q)?),
        ("GET", ["agents", a, "project"]) => J(json!({"project":app.agent_project(id(a)?)?})),
        ("GET", ["agents", a, "log"]) => {
            let aid = id(a)?;
            app.agent_project(aid)?;
            if let Some(viewer) = q.int("agent")?.filter(|a| *a > 0) {
                app.agent_project(viewer)?;
                if viewer != aid {
                    return Err(Fail(
                        403,
                        "agents can only read their own output log".into(),
                    ));
                }
            }
            J(log_page(&crate::run::log_path(app, aid, "txt"), q)?)
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
                ack_crashes: b["ack_crashes"].as_bool().unwrap_or(false),
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
        ("POST", ["agents", a, "replacement"]) => {
            let warnings = app.queue_replacement(
                id(a)?,
                LaunchReq {
                    task: text(b, "task")?,
                    harness: opt_text(b, "harness"),
                    model: opt_text(b, "model"),
                    effort: opt_text(b, "effort"),
                    name: opt_text(b, "name"),
                    group: opt_text(b, "group"),
                    force: b["force"].as_bool().unwrap_or(false),
                    done: b["done"].as_bool().unwrap_or(false),
                    ack_crashes: b["ack_crashes"].as_bool().unwrap_or(false),
                },
            )?;
            J(json!({"queued":true,"warnings":warnings}))
        }
        ("POST", ["agents", a, "pause"]) => {
            if b.get("locks").is_some() {
                return Err(bad(
                    "pause releases locks automatically; the locks option is unsupported",
                ));
            }
            app.pause(id(a)?, &user(b))?;
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
        ("POST", ["pause-all"]) => {
            J(json!({ "ids": app.pause_all(opt_int(b, "project"), &user(b))? }))
        }
        ("POST", ["resume-all"]) => {
            J(json!({ "ids": app.resume_all(opt_int(b, "project"), &user(b))? }))
        }
        ("POST", ["resume-restart"]) => J(app.resume_restart(opt_int(b, "project"), &user(b))?),
        ("POST", ["hook", a]) => J(json!({ "text": app.hook(id(a)?)? })),
        ("POST", ["wait", a]) => {
            let timeout = u64::try_from(int(b, "timeout")?)
                .map_err(|_| bad("wait timeout must be 1–3600 seconds"))?;
            J(app.wait_for(id(a)?, timeout, wait_options(b)?)?)
        }
        ("POST", ["wait", a, "ack"]) => {
            app.ack_updates(id(a)?, int(b, "delivery_id")?)?;
            J(json!({"acknowledged":true}))
        }
        ("GET", ["subscriptions"]) => J(app.subscriptions_page(
            q.int("agent")?.ok_or_else(|| bad("agent is required"))?,
            q.int("viewer")?,
            page(q)?,
        )?),
        ("GET", ["subscriptions", subscription]) => J(record(
            app.subscription_view(id(subscription)?, q.int("viewer")?)?,
            q,
        )?),
        ("POST", ["subscriptions"]) => J(app.subscribe(
            identity(b, "agent")?,
            subscription_timeout(b)?,
            wait_options(b)?,
        )?),
        ("POST", ["subscriptions", subscription, "cancel"]) => {
            J(app.cancel_subscription(id(subscription)?, identity(b, "agent")?)?)
        }

        // threads and messages
        ("GET", ["threads"]) => J(app.threads_page(
            q.int("project")?,
            q.int("agent")?,
            q.int("viewer")?,
            page(q)?,
        )?),
        ("POST", ["threads"]) => {
            let by = opt_int(b, "agent").unwrap_or(0);
            let private = boolean(b, "private", false)?;
            let joinable = boolean(b, "joinable", true)? && !private;
            let (tid, members) = app.create_thread(
                by,
                opt_int(b, "project"),
                ThreadReq {
                    title: text(b, "title")?,
                    members: list(b, "members"),
                    include_user: boolean(b, "include_user", by == 0)?,
                    watch: list(b, "watch"),
                    private,
                    joinable,
                },
            )?;
            J(json!({ "id": tid, "members": members, "private": private, "joinable": joinable }))
        }
        ("GET", ["threads", t]) => J(record(
            app.thread_page(id(t)?, q.int("agent")?, page(q)?)?,
            q,
        )?),
        ("GET", ["threads", t, "metadata"]) => {
            J(record(app.thread_metadata(id(t)?, q.int("agent")?)?, q)?)
        }
        ("GET", ["threads", t, "messages"]) => {
            J(app.messages_page(id(t)?, q.int("agent")?, page(q)?)?)
        }
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
        ("POST", ["threads", t, "members"]) => J(
            json!({ "members": app.add_members(id(t)?, &list(b, "members"), opt_int(b, "agent").unwrap_or(0))? }),
        ),
        ("POST", ["threads", t, "members", "remove"]) => J(
            json!({ "members": app.remove_members(id(t)?, &list(b, "members"), opt_int(b, "agent").unwrap_or(0))? }),
        ),
        ("POST", ["threads", t, "owner"]) => {
            let owner = int(b, "owner")?;
            app.transfer_thread_owner(id(t)?, owner, identity(b, "agent")?)?;
            J(json!({"owner":owner}))
        }
        ("POST", ["threads", t, "user"]) => {
            if b.get("agent").is_some_and(|a| a.as_i64() != Some(0)) {
                return Err(bad("only the user can change user membership"));
            }
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
            q,
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
        ("GET", ["messages", m]) => J(record(app.message_for(id(m)?, q.int("agent")?)?, q)?),
        ("GET", ["inbox", a]) => {
            J(app.inbox_page(id(a)?, q.get("mark").as_deref().unwrap_or("new"), page(q)?)?)
        }
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
        ("GET", ["locks"]) => J(app.locks_page(q.int("project")?, page(q)?)?),
        ("GET", ["locks", l]) => J(record(app.lock_view(id(l)?, q.int("project")?)?, q)?),
        ("POST", ["locks"]) => {
            // An agent's lock goes in its own project.
            let project = match opt_int(b, "agent").filter(|agent| *agent > 0) {
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
            let wait = b
                .get("wait")
                .map(|value| {
                    value.as_u64().ok_or_else(|| {
                        bad("lock wait must be a nonnegative whole number of seconds")
                    })
                })
                .transpose()?
                .unwrap_or(0);
            J(json!({ "result": app.acquire(int(b, "agent")?, &text(b, "name")?, wait, ttl)? }))
        }
        ("POST", ["locks", "release"]) => {
            app.release(int(b, "agent")?, &text(b, "name")?)?;
            J(json!({}))
        }
        ("POST", ["locks", "free"]) => {
            let project = int(b, "project")?;
            let name = text(b, "name")?;
            if b.get("expected_holder").is_some() {
                return Err(bad(
                    "expected_holder is unsupported; paused agents release their locks automatically",
                ));
            }
            app.free(project, &name, &user(b))?;
            J(json!({}))
        }

        // limits, activity, settings
        ("GET", ["limits"]) => J(record(app.limits(q.int("project")?)?, q)?),
        ("GET", ["activity"]) => {
            J(app.activity_page(q.int("project")?, page(q)?, q.int("agent")?)?)
        }
        ("GET", ["activity", a]) => J(record(
            app.activity_view(id(a)?, q.int("project")?, q.int("agent")?)?,
            q,
        )?),
        ("GET", ["history"]) => J(app.history(
            q.int("project")?,
            q.int("viewer")?,
            HistoryQuery {
                agent: q.int("agent")?,
                thread: q.int("thread")?,
                lock: q.get("lock"),
                kind: q.get("kind"),
                before: q.int("before")?,
                after: q.int("after")?,
                limit: q.int("limit")?.unwrap_or(50),
                max_bytes: q.int("max_bytes")?.unwrap_or(16000),
            },
        )?),
        ("GET", ["history", event]) => J(record(
            app.history_event(q.int("project")?, id(event)?, q.int("viewer")?)?,
            q,
        )?),
        ("GET", ["receipts", event]) => {
            J(record(app.receipt_view(id(event)?, q.int("agent")?)?, q)?)
        }
        ("GET", ["notices", agent]) => J(app.notices_page(id(agent)?, page(q)?)?),
        ("GET", ["notices", agent, notice]) => {
            J(record(app.notice_view(id(agent)?, id(notice)?)?, q)?)
        }

        // configs: Default (id 1), saved ones, and each project's choice
        ("GET", ["configs"]) => J(app.configs_page(page(q)?)?),
        ("GET", ["configs", c]) => J(record(app.config_view(id(c)?)?, q)?),
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
    };
    if method != "GET"
        && !matches!(p, ["hook", _] | ["wait", ..])
        && let Reply::Json(value) = reply
    {
        let agent = opt_int(b, "agent");
        let thread = opt_int(b, "thread").or_else(|| match p {
            ["threads", t, ..] => t.parse().ok(),
            ["threads"] => value["id"].as_i64(),
            _ => None,
        });
        let project = opt_int(b, "project").or_else(|| match p {
            ["projects", id, ..] => id.parse().ok(),
            ["projects"] => value["id"].as_i64(),
            ["agents", id, ..] => id.parse().ok().and_then(|id| app.agent_project(id).ok()),
            ["agents"] => value["id"]
                .as_i64()
                .and_then(|id| app.agent_project(id).ok()),
            _ => None,
        });
        return Ok(J(app.compact_receipt(value, agent, project, thread)));
    }
    Ok(reply)
}

fn response_bounds(q: &Query, default_limit: i64) -> R<(usize, usize)> {
    let limit = q.int("limit")?.unwrap_or(default_limit);
    let bytes = q.int("max_bytes")?.unwrap_or(16000);
    if !(1..=200).contains(&limit) || !(512..=65536).contains(&bytes) {
        return Err(bad("limit must be 1–200 and max_bytes 512–65536"));
    }
    Ok((limit as usize, bytes as usize))
}

fn fingerprint(value: &str) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

fn log_page(path: &std::path::Path, q: &Query) -> R<Value> {
    let (_, budget) = response_bounds(q, 200)?;
    let lines = q.int("lines")?.or(q.int("limit")?).unwrap_or(200);
    if !(1..=200).contains(&lines) {
        return Err(bad("lines must be 1–200"));
    }
    let before = q.int("before")?;
    let after = q.int("after")?;
    if before.is_some() && after.is_some()
        || before.is_some_and(|n| n < 0)
        || after.is_some_and(|n| n < 0)
    {
        return Err(bad("use one nonnegative before or after byte offset"));
    }
    if before.or(after).is_some_and(|n| n > 0) && q.get("version").is_none() {
        return Err(bad("version is required to continue an agent log"));
    }
    let mut file = match std::fs::File::open(path) {
        Ok(file) => Some(file),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(Fail(500, format!("cannot read agent log: {e}"))),
    };
    let metadata = file
        .as_ref()
        .map(|f| f.metadata())
        .transpose()
        .map_err(|e| Fail(500, e.to_string()))?;
    let size = metadata.as_ref().map_or(0, |m| m.len());
    let version = metadata
        .as_ref()
        .map_or_else(|| "missing".into(), |m| format!("{}:{}", m.dev(), m.ino()));
    let revision = metadata.as_ref().map_or_else(
        || "missing".into(),
        |m| format!("{version}:{}:{}:{}", m.len(), m.mtime(), m.mtime_nsec()),
    );
    if q.get("version").is_some_and(|v| v != version) {
        return Err(Fail(
            409,
            "agent log changed; reload its latest page".into(),
        ));
    }
    let through = q.int("through")?;
    if through.is_some_and(|n| n < 0 || n as u64 > size) {
        return Err(Fail(
            409,
            "agent log changed or was truncated; reload its latest page".into(),
        ));
    }
    let total = through.map_or(size, |n| n as u64);
    if before.is_some_and(|n| n as u64 > total) || after.is_some_and(|n| n as u64 > total) {
        return Err(Fail(
            409,
            "agent log changed or was truncated; reload its latest page".into(),
        ));
    }
    if q.get("since").as_deref() == Some(&revision)
        && before.is_none()
        && after.is_none_or(|n| n as u64 == total)
    {
        return Ok(
            json!({"unchanged":true,"revision":revision,"version":version,"next_after":total,"total_bytes":total}),
        );
    }
    let forward = after.is_some();
    let mut start = after.map_or_else(
        || {
            before
                .map_or(total, |n| n as u64)
                .saturating_sub(budget as u64)
        },
        |n| n as u64,
    );
    let mut end = if forward {
        total.min(start + budget as u64)
    } else {
        before.map_or(total, |n| n as u64)
    };
    let mut bytes = vec![0; (end - start) as usize];
    if let Some(file) = file.as_mut() {
        file.seek(SeekFrom::Start(start))
            .and_then(|_| file.read_exact(&mut bytes))
            .map_err(|e| Fail(500, format!("cannot read agent log: {e}")))?;
    }
    // A tail can begin inside a UTF-8 codepoint; move only that boundary.
    // An explicit cursor must already be a codepoint boundary.
    let leading = bytes.iter().take_while(|b| (**b & 0xc0) == 0x80).count();
    if forward && leading > 0 {
        return Err(bad("after must be a UTF-8 byte boundary"));
    }
    start += leading as u64;
    bytes.drain(..leading);
    let mut previous = [0];
    if start > 0
        && let Some(file) = file.as_mut()
    {
        file.seek(SeekFrom::Start(start - 1))
            .and_then(|_| file.read_exact(&mut previous))
            .map_err(|e| Fail(500, format!("cannot read agent log: {e}")))?;
    }
    if before.is_some() && std::str::from_utf8(&bytes).is_err_and(|e| e.error_len().is_none()) {
        return Err(bad("before must be a UTF-8 byte boundary"));
    }
    while std::str::from_utf8(&bytes).is_err_and(|e| e.error_len().is_none()) {
        bytes.pop();
        end -= 1;
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| bad("agent log is not valid UTF-8"))?;
    let mut lo = 0;
    let mut hi = text.len();
    let newlines: Vec<usize> = text.match_indices('\n').map(|(i, _)| i + 1).collect();
    if forward {
        if let Some(&cut) = newlines.get(lines as usize - 1) {
            hi = cut;
        }
    } else {
        let count = newlines.len() + usize::from(!text.ends_with('\n') && !text.is_empty());
        if count > lines as usize {
            lo = newlines[count - lines as usize - 1];
        }
    }
    let envelope = |lo: usize, hi: usize| {
        let a = start + lo as u64;
        let b = start + hi as u64;
        json!({"text":&text[lo..hi],"start":a,"end":b,"total_bytes":total,"through":total,"version":version,"revision":revision,
            "next_before":if a>0 {Some(a)} else {None},"next_after":b,"has_more":if forward {b<total} else {a>0},"eof":b==total,
            "start_partial":a>0 && (if lo==0 {previous[0]!=b'\n'} else {text.as_bytes()[lo-1]!=b'\n'}),"end_partial":b<total && (hi==0 || text.as_bytes()[hi-1]!=b'\n')})
    };
    if envelope(lo, hi).to_string().len() > budget {
        let mut boundaries: Vec<usize> = text[lo..hi].char_indices().map(|(n, _)| lo + n).collect();
        boundaries.push(hi);
        let (mut a, mut b) = (0, boundaries.len() - 1);
        if forward {
            while a < b {
                let mid = (a + b).div_ceil(2);
                if envelope(lo, boundaries[mid]).to_string().len() <= budget {
                    a = mid;
                } else {
                    b = mid - 1;
                }
            }
            hi = boundaries[a];
        } else {
            while a < b {
                let mid = (a + b) / 2;
                if envelope(boundaries[mid], hi).to_string().len() <= budget {
                    b = mid;
                } else {
                    a = mid + 1;
                }
            }
            lo = boundaries[a];
        }
    }
    let response = envelope(lo, hi);
    if response.to_string().len() > budget || (start < end && lo == hi) {
        return Err(bad("max_bytes too small for agent log metadata"));
    }
    Ok(response)
}

fn folders(path: Option<&str>, hidden: bool, q: &Query) -> R<Value> {
    let (limit, budget) = response_bounds(q, 50)?;
    let before = q.get("before");
    let after = q.get("after");
    if q.get("since").is_some()
        && (before.is_some() || after.is_some() || q.get("revision").is_some())
    {
        return Err(bad(
            "since is only for a fresh folder listing, without a revision cursor",
        ));
    }
    if before.is_some() && after.is_some() {
        return Err(bad("use one before or after folder cursor"));
    }
    if (before.is_some() || after.is_some()) && q.get("revision").is_none() {
        return Err(bad("revision is required to continue a folder listing"));
    }
    for cursor in before.iter().chain(after.iter()) {
        if !cursor.starts_with("d:") && !cursor.starts_with("f:") {
            return Err(bad("folder cursor must begin with d: or f:"));
        }
    }
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
    let revision = fingerprint(&json!([path, hidden, entries]).to_string());
    if q.get("revision").is_some_and(|v| v != revision) {
        return Err(Fail(
            409,
            "folder listing changed; restart its first page".into(),
        ));
    }
    if q.get("since").as_deref() == Some(&revision) {
        return Ok(json!({"unchanged":true,"revision":revision}));
    }
    let key = |entry: &Value| {
        format!(
            "{}:{}",
            if entry["directory"] == true { "d" } else { "f" },
            entry["name"].as_str().unwrap()
        )
    };
    let total = entries.len();
    entries.retain(|entry| {
        before.as_ref().is_none_or(|c| key(entry) < *c)
            && after.as_ref().is_none_or(|c| key(entry) > *c)
    });
    if before.is_some() {
        entries.reverse();
    }
    let count = entries.len();
    let envelope = |items: &Vec<Value>, more: bool| {
        let cursor = items.last().map(&key);
        json!({"path":path,"parent":path.parent(),"home":home,"entries":items,"has_more":more,"truncated":more,
            "next_before":if before.is_some(){cursor.clone()}else{None},"next_after":if before.is_none(){cursor}else{None},"revision":revision,"total":total})
    };
    let mut result = Vec::new();
    for entry in entries.into_iter().take(limit) {
        result.push(entry);
        if envelope(&result, true).to_string().len() > budget {
            result.pop();
            if result.is_empty() {
                return Err(bad(
                    "max_bytes too small for this folder entry; increase max_bytes",
                ));
            }
            break;
        }
    }
    let response = envelope(&result, result.len() < count);
    if response.to_string().len() > budget {
        return Err(bad("max_bytes too small for folder metadata"));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    #[test]
    fn route_contracts_reject_unknown_and_malformed_values() {
        let bad = [
            (
                "POST",
                vec!["subscriptions"],
                "",
                json!({"agent":1,"agents":"all","state":["idle"]}),
            ),
            (
                "POST",
                vec!["wait", "1"],
                "",
                json!({"timeout":1,"agents":"all","state":["idle"]}),
            ),
            (
                "POST",
                vec!["agents"],
                "",
                json!({"task":"test","project":1,"force":"false"}),
            ),
            (
                "POST",
                vec!["agents"],
                "",
                json!({"task":"test","project":1,"model":""}),
            ),
            (
                "POST",
                vec!["agents"],
                "",
                json!({"task":"test","project":"1"}),
            ),
            (
                "POST",
                vec!["agent-config"],
                "",
                json!({"id":1,"ack_crashes":null}),
            ),
            (
                "POST",
                vec!["threads"],
                "",
                json!({"project":1,"title":"test","members":[true]}),
            ),
            (
                "POST",
                vec!["threads"],
                "",
                json!({"project":1,"title":"test","watch":{}}),
            ),
            (
                "POST",
                vec!["threads", "1", "members"],
                "",
                json!({"members":null}),
            ),
            (
                "POST",
                vec!["threads", "1", "members"],
                "",
                json!({"members":[]}),
            ),
            (
                "POST",
                vec!["marks"],
                "",
                json!({"agent":1,"ids":[1,"2"],"mark":"read"}),
            ),
            (
                "POST",
                vec!["projects"],
                "",
                json!({"path":"/unused","via":"1"}),
            ),
            (
                "POST",
                vec!["projects"],
                "ignored=1",
                json!({"path":"/unused"}),
            ),
            ("POST", vec!["pause-all"], "", Value::Null),
            ("POST", vec!["pause-all"], "", json!([])),
            ("GET", vec!["agents"], "project=1&projects=2", Value::Null),
            ("GET", vec!["agents"], "project=1&project=2", Value::Null),
            ("GET", vec!["agents"], "project=1&%70roject=2", Value::Null),
            ("GET", vec!["agents"], "project", Value::Null),
            ("GET", vec!["agents"], "project=", Value::Null),
            ("GET", vec!["agents"], "search=%FF", Value::Null),
            ("GET", vec!["agents"], "search=%2", Value::Null),
            ("GET", vec!["agents"], "before=1&after=0", Value::Null),
            ("GET", vec!["agents"], "category=workng", Value::Null),
            ("GET", vec!["agents"], "max_bytes=1", Value::Null),
            ("GET", vec!["folders"], "hidden=true", Value::Null),
            (
                "GET",
                vec!["threads", "1"],
                "agent=1&version=v",
                Value::Null,
            ),
            ("GET", vec!["agents", "1"], "version=v", Value::Null),
            ("GET", vec!["catalog"], "", json!({"ignored":true})),
        ];
        for (method, path, query, body) in bad {
            let error = super::validate_request(method, &path, &super::Query(query), &body)
                .expect_err(&format!("{method} {path:?}?{query} {body}"));
            assert_eq!(error.0, 400, "{error:?}");
        }
    }

    #[test]
    fn bulk_routes_reject_invalid_scope_instead_of_becoming_global() {
        for route in ["pause-all", "resume-all", "resume-restart"] {
            for value in [
                Value::Null,
                json!(0),
                json!(-1),
                json!(1.5),
                json!("1"),
                json!(true),
                json!([]),
                json!({}),
            ] {
                let error = super::validate_request(
                    "POST",
                    &[route],
                    &super::Query(""),
                    &json!({"project":value}),
                )
                .unwrap_err();
                assert_eq!(error.0, 400, "{route}: {value}");
            }
            assert!(
                super::validate_request("POST", &[route], &super::Query("project=1"), &json!({}))
                    .is_err()
            );
        }
    }

    #[test]
    fn route_contracts_keep_explicit_client_nulls_and_query_filters() {
        for (method, path, query, body) in [
            ("GET", vec![], "project=1", Value::Null),
            ("POST", vec!["pause-all"], "", json!({"project":1})),
            ("POST", vec!["resume-all"], "", json!({"project":1})),
            ("POST", vec!["resume-restart"], "", json!({"project":1})),
            (
                "POST",
                vec!["threads"],
                "",
                json!({"project":1,"title":"test","private":true,"joinable":true}),
            ),
            (
                "POST",
                vec!["agents"],
                "",
                json!({"project":1,"task":"test","harness":null,"model":null,"effort":null,"name":"","group":""}),
            ),
            (
                "POST",
                vec!["threads"],
                "",
                json!({"project":1,"title":"test","members":[1,0,"2"]}),
            ),
            (
                "POST",
                vec!["agent-config"],
                "",
                json!({"id":1,"agent":1,"model":null,"effort":"high","continuation":null,"ack_crashes":false}),
            ),
            (
                "POST",
                vec!["locks", "acquire"],
                "",
                json!({"agent":1,"name":"test","ttl":null,"wait":0}),
            ),
            (
                "PUT",
                vec!["projects", "1", "config"],
                "",
                json!({"config":1,"custom":null}),
            ),
            (
                "GET",
                vec!["agents"],
                "&%70roject=1&group=&search=&limit=50&max_bytes=16000",
                Value::Null,
            ),
            (
                "GET",
                vec!["agents", "1", "log"],
                "after=0&version=missing&since=missing&lines=100",
                Value::Null,
            ),
            (
                "GET",
                vec!["threads", "1"],
                "agent=1&after=0&offset=0&version=abc&max_bytes=512",
                Value::Null,
            ),
            (
                "GET",
                vec!["folders"],
                "path=%2F&hidden=0&after=d%3Atest&revision=abc",
                Value::Null,
            ),
        ] {
            super::validate_request(method, &path, &super::Query(query), &body)
                .unwrap_or_else(|error| panic!("{method} {path:?}?{query} {body}: {error:?}"));
        }
        assert_eq!(super::Query("%70roject=2").get("project"), Some("2".into()));
        assert_eq!(super::id("0").unwrap_err().0, 400);
        assert_eq!(super::id("-1").unwrap_err().0, 400);
    }

    #[test]
    fn rejected_route_inputs_leave_business_state_unchanged() {
        let home = std::env::temp_dir().join(format!(
            "acom-request-validation-{}",
            crate::harness::new_uuid()
        ));
        let app = crate::app::App::open(home.clone(), "http://127.0.0.1:0".into()).unwrap();
        app.lock().db.execute_batch("INSERT INTO projects(id,path,name,created_at) VALUES(1,'/validation','validation',0);
            INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at)
            VALUES(1,1,'watcher','test','codex','gpt-6-sol','medium','working',0,0);").unwrap();
        let before = app.lock().db.total_changes();
        for (path, body) in [
            (
                vec!["subscriptions"],
                json!({"agent":1,"agents":"all","state":["idle"]}),
            ),
            (
                vec!["wait", "1"],
                json!({"timeout":1,"agents":"all","state":["idle"]}),
            ),
            (
                vec!["threads"],
                json!({"title":"must not create","project":1,"members":[true]}),
            ),
            (
                vec!["agents"],
                json!({"task":"must not launch","project":1,"force":"false"}),
            ),
            (
                vec!["agent-config"],
                json!({"id":1,"effort":"high","ack_crashes":"false"}),
            ),
        ] {
            let error = super::route(&app, "POST", &path, &super::Query(""), &body)
                .err()
                .unwrap();
            assert_eq!(error.0, 400, "{error:?}");
            assert_eq!(app.lock().db.total_changes(), before);
        }
        assert_eq!(
            super::route(
                &app,
                "POST",
                &["not-a-route"],
                &super::Query("unknown=1"),
                &json!({"typo":true})
            )
            .err()
            .unwrap()
            .0,
            404
        );
        for path in ["overview", "settings", "limits", "agents"] {
            assert_eq!(
                super::route(
                    &app,
                    "GET",
                    &[path],
                    &super::Query("project=999"),
                    &Value::Null
                )
                .err()
                .unwrap()
                .0,
                404,
                "{path} must not silently fall back to another project"
            );
        }
        for query in [
            "state=",
            "state=Paused",
            "state=active",
            "state=idle,paused",
            "pause_reason=",
            "pause_reason=user",
            "pause_reason=all",
            "pause_reason=unknown",
            "state=working&pause_reason=limit",
            "state=closed&pause_reason=manual",
        ] {
            let error = super::route(&app, "GET", &["agents"], &super::Query(query), &Value::Null)
                .err()
                .unwrap();
            assert_eq!(error.0, 400, "{query}: {error:?}");
            assert!(
                error.1.contains("must be") || error.1.contains("requires state paused"),
                "{error:?}"
            );
            assert_eq!(app.lock().db.total_changes(), before);
        }
        for query in [
            "state=idle",
            "state=paused&pause_reason=manual",
            "pause_reason=limit",
            "pause_reason=restart",
        ] {
            super::route(&app, "GET", &["agents"], &super::Query(query), &Value::Null)
                .unwrap_or_else(|error| panic!("{query}: {error:?}"));
            assert_eq!(app.lock().db.total_changes(), before);
        }
        assert!(matches!(
            super::route(&app, "GET", &[], &super::Query("project=999"), &Value::Null).unwrap(),
            super::Reply::Html(_)
        ));
        assert_eq!(app.lock().db.total_changes(), before);
        drop(app);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn nonobject_bodies_and_conflicting_folder_poll_cursors_are_rejected() {
        for body in ["null", "[]", "true", "1", "\"text\""] {
            assert_eq!(super::parse_body(body).unwrap_err().0, 400);
        }
        for query in [
            "since=r&after=d:a&revision=r",
            "since=r&revision=r",
            "since=r&before=f:a&revision=r",
        ] {
            assert_eq!(
                super::folders(None, false, &super::Query(query))
                    .unwrap_err()
                    .0,
                400
            );
        }
    }

    #[test]
    fn duplicate_json_fields_are_rejected_at_every_depth() {
        for body in [
            r#"{"agent":1,"agent":0}"#,
            r#"{"agent":1,"\u0061gent":0}"#,
            r#"{"settings":{"limits":{"max_active":1,"max_active":2}}}"#,
            r#"{"items":[{"state":"idle","state":"working"}]}"#,
        ] {
            let error = super::parse_body(body).expect_err(body);
            assert_eq!(error.0, 400);
            assert!(error.1.contains("duplicate field"), "{error:?}");
        }
        assert_eq!(
            super::parse_body(r#"{"items":[1,2.5,null,true,"text"],"task":"λ"}"#).unwrap(),
            json!({"items":[1,2.5,null,true,"text"],"task":"λ"})
        );
    }

    #[test]
    fn wait_watch_options_are_strictly_typed() {
        let options = super::wait_options(
            &serde_json::json!({"agents":[3,1],"states":["crashed"],"status_text":true,"after":0}),
        )
        .unwrap();
        assert!(
            matches!(options.agents,Some(crate::app::WaitAgents::Selected(ids)) if ids==vec![3,1])
        );
        assert_eq!(options.states, Some(vec!["crashed".into()]));
        assert!(options.status_text);
        assert_eq!(options.after, Some(0));
        assert!(options.usage.is_none());
        for body in [
            serde_json::json!({"agents":null}),
            serde_json::json!({"agents":"1,2"}),
            serde_json::json!({"agents":["1"]}),
            serde_json::json!({"agents":[1.0]}),
            serde_json::json!({"agents":[0]}),
            serde_json::json!({"states":"crashed"}),
            serde_json::json!({"states":[1]}),
            serde_json::json!({"status_text":null}),
            serde_json::json!({"status_text":"false"}),
            serde_json::json!({"after":-1}),
            serde_json::json!({"after":1.0}),
        ] {
            assert!(super::wait_options(&body).is_err(), "{body}");
        }
    }

    #[test]
    fn usage_watch_shape_and_deferred_timeout_are_strict() {
        let options = super::wait_options(&serde_json::json!({"usage":{
            "provider":"claude","window":"five_hour","condition":"above","percent":80.5
        }}))
        .unwrap();
        let usage = options.usage.unwrap();
        assert_eq!(usage.provider, "claude");
        assert_eq!(usage.window, "five_hour");
        assert_eq!(usage.condition, "above");
        assert_eq!(usage.percent, Some(80.5));
        for usage in [
            serde_json::Value::Null,
            serde_json::json!("claude"),
            serde_json::json!({"provider":1,"window":"five_hour","condition":"reset"}),
            serde_json::json!({"provider":"claude","window":"five_hour"}),
            serde_json::json!({"provider":"claude","window":"five_hour","condition":"above","percent":"80"}),
            serde_json::json!({"provider":"claude","window":"five_hour","condition":"reset","unknown":true}),
        ] {
            assert!(super::wait_options(&serde_json::json!({"usage":usage})).is_err());
        }
        assert_eq!(
            super::subscription_timeout(&serde_json::json!({})).unwrap(),
            None
        );
        for timeout in [1, 60, 3600] {
            assert_eq!(
                super::subscription_timeout(&serde_json::json!({"timeout":timeout})).unwrap(),
                Some(timeout)
            );
        }
        for timeout in [
            serde_json::Value::Null,
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!(3601),
            serde_json::json!(1.0),
            serde_json::json!("60"),
        ] {
            assert!(super::subscription_timeout(&serde_json::json!({"timeout":timeout})).is_err());
        }
    }

    #[test]
    fn malformed_agent_identity_cannot_default_to_the_user() {
        assert_eq!(super::identity(&serde_json::json!({}), "agent").unwrap(), 0);
        for id in [0, 1, i64::MAX] {
            assert_eq!(
                super::identity(&serde_json::json!({"agent":id}), "agent").unwrap(),
                id
            );
        }
        for value in [
            serde_json::Value::Null,
            serde_json::json!("1"),
            serde_json::json!(-1),
            serde_json::json!(1.0),
            serde_json::json!(true),
            serde_json::json!([]),
        ] {
            let error = super::identity(&serde_json::json!({"agent":value}), "agent").unwrap_err();
            assert_eq!(error.0, 400);
            assert_eq!(error.1, "agent must be 0 (user) or a positive agent ID");
        }
    }

    #[test]
    fn thread_access_booleans_only_default_when_absent() {
        for key in ["private", "joinable", "include_user"] {
            assert!(super::boolean(&serde_json::json!({}), key, true).unwrap());
            assert!(!super::boolean(&serde_json::json!({}), key, false).unwrap());
            for value in [true, false] {
                assert_eq!(
                    super::boolean(&serde_json::json!({ key: value }), key, !value).unwrap(),
                    value
                );
            }
            for value in [
                serde_json::Value::Null,
                serde_json::json!("false"),
                serde_json::json!(0),
                serde_json::json!([]),
            ] {
                let error =
                    super::boolean(&serde_json::json!({ key: value }), key, true).unwrap_err();
                assert_eq!(error.0, 400);
                assert_eq!(error.1, format!("{key} must be true or false"));
            }
        }
    }

    #[test]
    fn log_cursors_reject_partial_utf8_boundaries() {
        let path = std::env::temp_dir().join(format!(
            "acom-log-boundary-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        struct OwnedFile(std::path::PathBuf);
        impl Drop for OwnedFile {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let _owned = OwnedFile(path.clone());
        std::io::Write::write_all(&mut file, "漢🙂\n".as_bytes()).unwrap();
        drop(file);
        let version = super::log_page(&path, &super::Query("max_bytes=512")).unwrap()["version"]
            .as_str()
            .unwrap()
            .to_string();
        for key in ["before", "after"] {
            let query = format!("{key}=1&version={version}&max_bytes=512");
            assert_eq!(
                super::log_page(&path, &super::Query(&query)).unwrap_err().0,
                400
            );
        }
    }

    #[test]
    fn error_text_is_explicitly_bounded_without_splitting_utf8() {
        let body = super::error_body(&"\"\\漢🙂".repeat(10000));
        assert!(body.len() <= 16000);
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["truncated"], true);
        assert!(
            value["error"]
                .as_str()
                .unwrap()
                .ends_with("(error text truncated)")
        );
        assert_eq!(
            super::error_body("small error"),
            r#"{"error":"small error"}"#
        );
    }

    #[test]
    fn decodes_query_values() {
        assert_eq!(super::decode("group%3Aparser+team"), "group:parser team");
        assert_eq!(super::decode("100%"), "100%");
    }
}
