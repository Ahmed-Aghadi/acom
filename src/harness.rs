// How to run each harness, and how to read what it prints.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const KNOWN: [&str; 2] = ["claude", "codex"];

pub struct Launch<'a> {
    pub harness: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    /// The session to start (Claude, first turn) or resume.
    pub session: Option<&'a str>,
    pub resume: bool,
    pub prompt: &'a str,
    pub context_limit: u64,
    pub flags: &'a [String],
    pub acom: &'a Path,
}

pub enum Event {
    /// The harness's session ID, needed to resume it.
    Session(String),
    /// Tokens: fresh input, cache writes, cache reads, output. `add` adds them to the totals, otherwise they replace them.
    Tokens { t: [u64; 4], add: bool },
    /// How big the context is now.
    Context(u64),
    /// Subscription usage for one window, in percent.
    Usage {
        win: String,
        used_pct: f64,
        resets_at: Option<i64>,
    },
    /// A short readable line for the agent's activity view.
    Text(String),
    /// A tool action, separate from ordinary assistant text.
    Tool(String),
    /// A structured harness failure. The supervisor decides recovery after exit.
    Failed(String),
    /// An unexpected model switch; stop the process before it can do more work.
    ModelSwitched(String),
    /// The subscription's usage limit was hit mid-turn. acom pauses the agent until the window resets.
    LimitHit(String),
    /// A model-scoped window exhausted; do not mark the whole provider exhausted.
    WindowLimitHit { win: String, text: String },
    /// The model that actually answered.
    Model(String),
}

/// A model the harness offers, with the effort levels it supports.
#[derive(serde::Serialize, Clone)]
pub struct Model {
    pub id: &'static str,
    pub name: &'static str,
    pub efforts: &'static [&'static str],
}

/// The models acom knows for a harness. Others can still be used by typing their ID.
pub fn catalog(harness: &str) -> Vec<Model> {
    match harness {
        "claude" => claude_catalog(),
        _ => codex_catalog(),
    }
}

/// The command for one turn, plus what to write to its stdin (None means stdin is closed).
pub fn command(l: &Launch) -> (Command, Option<String>) {
    match l.harness {
        "claude" => claude_command(l),
        _ => codex_command(l),
    }
}

/// Events from one line of the harness's stdout.
pub fn parse_line(harness: &str, line: &str) -> Vec<Event> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    match harness {
        "claude" => claude_events(&v),
        _ => codex_events(&v),
    }
}

/// A file the harness writes more events to (lines go through `parse_line` too), if any.
pub fn side_file(harness: &str, session: &str) -> Option<PathBuf> {
    match harness {
        "claude" => None,
        _ => codex_side_file(session),
    }
}

/// The native transcript, if the harness has created it. Never invent a path.
pub fn history_file(harness: &str, session: &str) -> Option<PathBuf> {
    if harness != "claude" {
        return codex_side_file(session);
    }
    let home = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")))?;
    find_session(&home.join("projects"), session, 2)
}

/// What `acom hook` prints so the text lands in the agent's context.
pub fn hook_output(text: &str) -> String {
    json!({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": text}})
        .to_string()
}

pub fn new_uuid() -> String {
    let mut b = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut b);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn short(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n {
        s
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

fn quote(p: &Path) -> String {
    format!("'{}'", p.display().to_string().replace('\'', r"'\''"))
}

// ---------- Claude Code ----------

pub fn claude_catalog() -> Vec<Model> {
    let efforts: &[&str] = &["low", "medium", "high", "xhigh", "max"];
    [
        ("claude-opus-5-5", "Opus 5.5"),
        ("claude-fable-5-1", "Fable 5.1"),
        ("claude-sonnet-5-5", "Sonnet 5.5"),
        ("claude-haiku-5-5", "Haiku 5.5"),
        ("claude-haiku-4-5", "Haiku 4.5"),
        ("claude-sonnet-5", "Sonnet 5"),
        ("claude-opus-5", "Opus 5"),
        ("claude-fable-5", "Fable 5"),
        ("claude-opus-4-8", "Opus 4.8"),
        ("claude-opus-4-7", "Opus 4.7"),
        ("claude-sonnet-4-6", "Sonnet 4.6"),
        ("claude-mythos-5-1", "Mythos 5.1"),
    ]
    .into_iter()
    .map(|(id, name)| Model {
        id,
        name,
        efforts: if id == "claude-haiku-4-5" {
            &["medium"]
        } else {
            efforts
        },
    })
    .collect()
}

fn claude_command(l: &Launch) -> (Command, Option<String>) {
    let mut c = Command::new("claude");
    c.args(["-p", "--output-format", "stream-json", "--verbose"]);
    c.args(l.flags);
    // Keep session, model, compaction, hook and subagent controls after the
    // configurable flags so project settings cannot replace these invariants.
    c.args(["--model", l.model]);
    // Haiku 4.5 has fixed effort; medium is its catalog placeholder, not a knob.
    if !crate::app::same_model("claude-haiku-4-5", l.model) {
        c.args(["--effort", l.effort]);
    }
    if let Some(s) = l.session {
        c.args([if l.resume { "--resume" } else { "--session-id" }, s]);
    }
    // --autocompact takes 100k to 1M. 0 means no hard context limit.
    if l.context_limit > 0 {
        c.args([
            "--autocompact",
            &l.context_limit.clamp(100_000, 1_000_000).to_string(),
        ]);
    }
    let hook = json!({"hooks": {"PostToolUse": [{"matcher": "*", "hooks": [
        {"type": "command", "command": format!("{} hook", quote(l.acom))}]}]}});
    c.args(["--settings", &hook.to_string()]);
    // No subagents or side channels: every agent goes through acom.
    c.args(["--disallowedTools", "Agent,Workflow,SendMessage,ListAgents"]);
    // Model recovery is controlled by acom, never silently by the harness.
    c.env("CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK", "1");
    c.env("CLAUDE_CODE_NO_MODEL_FALLBACK", "1");
    c.args(["--allowedTools", "Bash(acom *)"]);
    c.stdin(Stdio::piped());
    (c, Some(l.prompt.to_string()))
}

/// The Claude stream names Fable's weekly bucket differently from the UI.
pub fn claude_window_name(name: &str) -> &str {
    match name {
        "seven_day_overage_included" => "seven_day_fable",
        _ => name,
    }
}

fn claude_events(v: &Value) -> Vec<Event> {
    let n = |x: &Value| x.as_u64().unwrap_or(0);
    // The stream uses snake_case; transcripts use camelCase.
    let field = |snake: &str, camel: &str| {
        v[snake]
            .as_str()
            .or(v[camel].as_str())
            .unwrap_or("")
            .to_string()
    };
    let mut out = Vec::new();
    match v["type"].as_str().unwrap_or("") {
        "system" => match v["subtype"].as_str().unwrap_or("") {
            "init" => {
                if let Some(s) = v["session_id"].as_str() {
                    out.push(Event::Session(s.to_string()));
                }
            }
            "model_refusal_fallback" | "model_fallback" | "model_consent_fallback" => {
                let from = field("original_model", "originalModel");
                let to = field("fallback_model", "fallbackModel");
                out.push(Event::ModelSwitched(format!(
                    "Claude Code switched from {from} to {to}"
                )));
            }
            _ => {}
        },
        "assistant" => {
            let m = &v["message"];
            if let Some(model) = m["model"].as_str().filter(|x| !x.starts_with('<')) {
                out.push(Event::Model(model.to_string()));
            }
            // A synthetic message stands in for errors such as the session limit.
            if matches!(v["error"].as_str(), Some("rate_limit" | "billing_error")) {
                let text = m["content"][0]["text"]
                    .as_str()
                    .unwrap_or("usage limit reached");
                out.push(Event::LimitHit(short(text, 200)));
            }
            let u = &v["message"]["usage"];
            let ctx = n(&u["input_tokens"])
                + n(&u["cache_creation_input_tokens"])
                + n(&u["cache_read_input_tokens"]);
            if ctx > 0 {
                out.push(Event::Context(ctx));
            }
            for b in v["message"]["content"].as_array().into_iter().flatten() {
                match b["type"].as_str() {
                    Some("text") => {
                        out.push(Event::Text(short(b["text"].as_str().unwrap_or(""), 300)))
                    }
                    Some("tool_use") => {
                        let input = &b["input"];
                        let what = input["command"]
                            .as_str()
                            .or(input["file_path"].as_str())
                            .or(input["pattern"].as_str());
                        let name = b["name"].as_str().unwrap_or("tool");
                        out.push(Event::Tool(match what {
                            Some(w) => format!("{name}: {}", short(w, 200)),
                            None => name.to_string(),
                        }));
                    }
                    _ => {}
                }
            }
        }
        // The turn's totals. Per-message usage repeats and undercounts output, so only this is counted.
        "result" => {
            let u = &v["usage"];
            out.push(Event::Tokens {
                t: [
                    n(&u["input_tokens"]),
                    n(&u["cache_creation_input_tokens"]),
                    n(&u["cache_read_input_tokens"]),
                    n(&u["output_tokens"]),
                ],
                add: true,
            });
            if v["is_error"] == true {
                let errors = v["errors"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("; ");
                let text = v["result"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| {
                        if errors.is_empty() {
                            v["subtype"].as_str().unwrap_or("Claude turn failed")
                        } else {
                            &errors
                        }
                    });
                let lower = text.to_lowercase();
                if [
                    "session limit",
                    "usage limit",
                    "rate limit",
                    "quota exceeded",
                    "out of usage credits",
                ]
                .iter()
                .any(|x| lower.contains(x))
                {
                    out.push(Event::LimitHit(short(text, 200)));
                } else {
                    out.push(Event::Failed(short(text, 300)));
                }
            }
        }
        "rate_limit_event" => {
            let info = &v["rate_limit_info"];
            for (win, w) in info["unifiedWindows"].as_object().into_iter().flatten() {
                if let Some(u) = w["utilization"].as_f64() {
                    out.push(Event::Usage {
                        win: claude_window_name(win).to_string(),
                        used_pct: u * 100.0,
                        resets_at: w["resetsAt"].as_i64(),
                    });
                }
            }
            // Rejected means that window is used up until it resets.
            if info["status"] == "rejected" {
                let window = info["rateLimitType"].as_str().unwrap_or("limit");
                out.push(Event::Usage {
                    win: claude_window_name(window).to_string(),
                    used_pct: 100.0,
                    resets_at: info["resetsAt"].as_i64(),
                });
                let text = format!("Claude subscription window {window} exhausted");
                if claude_window_name(window) == "seven_day_fable" {
                    out.push(Event::WindowLimitHit {
                        win: "seven_day_fable".into(),
                        text,
                    });
                } else {
                    out.push(Event::LimitHit(text));
                }
            }
        }
        _ => {}
    }
    out
}

// ---------- Codex ----------

pub fn codex_catalog() -> Vec<Model> {
    let full: &[&str] = &["low", "medium", "high", "xhigh", "max", "ultra"];
    let luna: &[&str] = &["low", "medium", "high", "xhigh", "max"];
    [
        ("gpt-6.1-sol", "GPT-6.1 Sol", full),
        ("gpt-6-astra", "GPT-6 Astra", full),
        ("gpt-6-sol", "GPT-6 Sol", full),
        ("gpt-6-luna", "GPT-6 Luna", luna),
        ("gpt-5.6-sol", "GPT-5.6 Sol", full),
        ("gpt-5.6-terra", "GPT-5.6 Terra", full),
        ("gpt-5.6-luna", "GPT-5.6 Luna", luna),
    ]
    .into_iter()
    .map(|(id, name, efforts)| Model { id, name, efforts })
    .collect()
}

fn codex_command(l: &Launch) -> (Command, Option<String>) {
    let mut c = Command::new("codex");
    c.arg("exec");
    if l.resume {
        c.arg("resume");
    }
    // A project folder need not be a Git worktree. acom already scopes the
    // process to the folder selected by the user.
    c.args(["--json", "--skip-git-repo-check"]);

    if l.resume {
        // `exec resume` has a smaller option set than `exec`. In particular it
        // does not accept --sandbox; the session keeps its original sandbox.
        let mut skip_value = false;
        for flag in l.flags {
            if skip_value {
                skip_value = false;
                continue;
            }
            if [
                "--sandbox",
                "-s",
                "--cd",
                "-C",
                "--add-dir",
                "--local-provider",
                "--profile",
                "-p",
                "--color",
            ]
            .contains(&flag.as_str())
            {
                skip_value = true;
            } else if [
                "--sandbox=",
                "--cd=",
                "--add-dir=",
                "--local-provider=",
                "--profile=",
                "--color=",
            ]
            .iter()
            .any(|prefix| flag.starts_with(prefix))
            {
                continue;
            } else if !["--approve-for-me", "--oss"].contains(&flag.as_str()) {
                c.arg(flag);
            }
        }
    } else {
        c.args(l.flags);
    }

    // These invariants come after user flags so an extra `-c` or feature flag
    // cannot accidentally disconnect the agent or re-enable untracked helpers.
    c.args(["-m", l.model]);
    c.args(["-c", &format!("model={}", toml_string(l.model))]);
    c.args([
        "-c",
        &format!("model_reasoning_effort={}", toml_string(l.effort)),
    ]);
    c.args(["--disable", "multi_agent"]);
    if l.context_limit > 0 {
        c.args([
            "-c",
            &format!("model_auto_compact_token_limit={}", l.context_limit),
        ]);
    }
    // Workspace-write blocks even localhost by default. Agents need localhost
    // to reach acom, regardless of whether they need other network access.
    c.args(["-c", "sandbox_workspace_write.network_access=true"]);
    let hook_command = format!("{} hook", quote(l.acom));
    let hooks = format!(
        "hooks.PostToolUse=[{{matcher=\".*\",hooks=[{{type=\"command\",command={},timeout=10,additionalContextLimit=4000}}]}}]",
        toml_string(&hook_command)
    );
    c.args(["-c", &hooks, "--dangerously-bypass-hook-trust"]);
    if l.resume
        && let Some(session) = l.session
    {
        c.arg(session);
    }
    // `-` makes the prompt come only from stdin. With a positional prompt,
    // current Codex still warns that it is reading additional piped input even
    // when stdin is closed by the supervisor.
    c.arg("-").stdin(Stdio::piped());
    (c, Some(l.prompt.to_string()))
}

fn codex_events(v: &Value) -> Vec<Event> {
    // Reroutes are observable in the core event stream/rollout. Some clients
    // expose the equivalent app-server notification with camelCase fields.
    let event = if v["type"] == "event_msg" {
        &v["payload"]
    } else if v["method"] == "model/rerouted" {
        &v["params"]
    } else {
        v
    };
    let kind = event["type"].as_str().unwrap_or("");
    if matches!(kind, "model_reroute" | "model.rerouted" | "model_rerouted")
        || v["method"] == "model/rerouted"
    {
        let from = event["from_model"]
            .as_str()
            .or(event["fromModel"].as_str())
            .unwrap_or("the selected model");
        let to = event["to_model"]
            .as_str()
            .or(event["toModel"].as_str())
            .unwrap_or("another model");
        let reason = event["reason"].as_str().unwrap_or("unspecified reason");
        return vec![Event::ModelSwitched(short(
            &format!("Codex rerouted from {from} to {to} ({reason})"),
            300,
        ))];
    }
    if kind == "error" || v["type"] == "turn.failed" {
        let error = if event["error"].is_object() {
            &event["error"]
        } else {
            event
        };
        let message = error["message"]
            .as_str()
            .or(event["error"].as_str())
            .unwrap_or("Codex error");
        // exec sometimes embeds the API error as a JSON string inside message.
        let nested = serde_json::from_str::<Value>(message).ok();
        let message = nested
            .as_ref()
            .and_then(|v| v.pointer("/error/message").or(v.get("message")))
            .and_then(Value::as_str)
            .unwrap_or(message);
        let code = error["code"]
            .as_str()
            .or(event["codex_error_info"].as_str())
            .or(error["codexErrorInfo"].as_str())
            .or(nested
                .as_ref()
                .and_then(|v| v.pointer("/error/code"))
                .and_then(Value::as_str))
            .unwrap_or("");
        // Errors are failures regardless of their wording. Only quota errors
        // have a distinct recovery path; ordinary assistant/tool text is ignored.
        let lower = message.to_ascii_lowercase();
        if matches!(
            code,
            "usage_limit_reached"
                | "rate_limit_exceeded"
                | "insufficient_quota"
                | "UsageLimitExceeded"
        ) || lower.contains("usage limit")
            || lower.contains("rate limit")
            || lower.contains("quota exceeded")
            || lower.contains("out of usage credits")
        {
            return vec![Event::LimitHit(short(message, 200))];
        }
        return vec![Event::Failed(short(message, 300))];
    }
    if matches!(
        v["type"].as_str(),
        Some("response.completed" | "response.created")
    ) && let Some(model) = v["response"]["model"].as_str()
    {
        return vec![Event::Model(model.to_string())];
    }
    let n = |x: &Value| x.as_u64().unwrap_or(0);
    let tokens = |u: &Value, add| {
        let input = n(&u["input_tokens"]);
        let read = n(&u["cached_input_tokens"]);
        let write = n(&u["cache_write_input_tokens"]);
        Event::Tokens {
            t: [
                input.saturating_sub(read).saturating_sub(write),
                write,
                read,
                n(&u["output_tokens"]),
            ],
            add,
        }
    };

    // `codex exec --json` events.
    match v["type"].as_str().unwrap_or("") {
        "thread.started" => v["thread_id"]
            .as_str()
            .map(|s| vec![Event::Session(s.to_string())])
            .unwrap_or_default(),
        "turn.completed" => vec![tokens(&v["usage"], false)],
        "item.completed" => {
            let item = &v["item"];
            let event = match item["type"].as_str().unwrap_or("") {
                "agent_message" => item["text"].as_str().map(|s| Event::Text(short(s, 300))),
                "command_execution" => item["command"]
                    .as_str()
                    .map(|s| Event::Tool(format!("shell: {}", short(s, 200)))),
                "mcp_tool_call" => item["tool"]
                    .as_str()
                    .map(|s| Event::Tool(format!("MCP: {s}"))),
                "web_search" => item["query"]
                    .as_str()
                    .map(|s| Event::Tool(format!("search: {}", short(s, 200)))),
                "file_change" => Some(Event::Tool("changed files".to_string())),
                // Codex also uses error items for nonfatal startup diagnostics,
                // including the hook-trust warning. Only turn/core errors (above)
                // or an unsuccessful process exit establish a failed turn.
                "error" => item["message"]
                    .as_str()
                    .map(|s| Event::Text(format!("notice: {}", short(s, 300)))),
                _ => None,
            };
            event.into_iter().collect()
        }
        // Persisted rollout events. Current Codex writes context and rate-limit
        // data here, but does not include them in the --json stdout stream.
        "event_msg" if v["payload"]["type"] == "token_count" => {
            let payload = &v["payload"];
            let info = &payload["info"];
            let mut out = vec![tokens(&info["total_token_usage"], false)];
            let context = n(&info["last_token_usage"]["total_tokens"]);
            if context > 0 {
                out.push(Event::Context(context));
            }
            for name in ["primary", "secondary"] {
                let window = &payload["rate_limits"][name];
                if let Some(used_pct) = window["used_percent"].as_f64() {
                    let minutes = window["window_minutes"].as_u64();
                    let win = minutes
                        .map(|m| format!("{name} ({m}m)"))
                        .unwrap_or_else(|| name.to_string());
                    out.push(Event::Usage {
                        win,
                        used_pct,
                        resets_at: window["resets_at"].as_i64(),
                    });
                }
            }
            out
        }
        _ => vec![],
    }
}

fn codex_side_file(session: &str) -> Option<PathBuf> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")))?;
    find_session(&home.join("sessions"), session, 4)
}

fn find_session(dir: &Path, session: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path.extension().and_then(|x| x.to_str()) == Some("jsonl")
            && path
                .file_name()
                .and_then(|x| x.to_str())
                .is_some_and(|name| name.contains(session))
        {
            return Some(path);
        }
        if path.is_dir()
            && let Some(found) = find_session(&path, session, depth - 1)
        {
            return Some(found);
        }
    }
    None
}

fn toml_string(s: &str) -> String {
    // JSON and TOML basic strings use the same escaping for this command text.
    serde_json::to_string(s).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_history_lookup_handles_both_layouts_and_missing_files() {
        let root = std::env::temp_dir().join(format!("acom-history-{}", new_uuid()));
        let session = new_uuid();
        let codex = root.join("sessions/2026/10/08");
        let claude = root.join("projects/-project");
        std::fs::create_dir_all(&codex).unwrap();
        std::fs::create_dir_all(&claude).unwrap();
        let rollout = codex.join(format!("rollout-{session}.jsonl"));
        let transcript = claude.join(format!("{session}.jsonl"));
        std::fs::write(&rollout, "{}").unwrap();
        std::fs::write(&transcript, "{}").unwrap();
        assert_eq!(
            find_session(&root.join("sessions"), &session, 4),
            Some(rollout)
        );
        assert_eq!(
            find_session(&root.join("projects"), &session, 2),
            Some(transcript)
        );
        assert_eq!(find_session(&root, &new_uuid(), 4), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn claude_rate_limit_is_percent() {
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":100}}}}"#;
        let ev = parse_line("claude", line);
        assert!(
            matches!(&ev[0], Event::Usage { win, used_pct, resets_at: Some(100) } if win == "five_hour" && (*used_pct - 25.0).abs() < 1e-9)
        );
    }

    #[test]
    fn fable_stream_usage_and_rejections_share_the_weekly_bucket() {
        let value = json!({"type":"rate_limit_event","rate_limit_info":{
            "status":"allowed","unifiedWindows":{
                "seven_day_overage_included":{"utilization":0.87,"resetsAt":999},
                "seven_day":{"utilization":0},"five_hour":null
            }
        }});
        let events = parse_line("claude", &value.to_string());
        assert_eq!(events.len(), 2);
        assert!(events.iter().any(|e| matches!(e, Event::Usage { win, used_pct, resets_at: Some(999) } if win == "seven_day_fable" && (*used_pct - 87.0).abs() < 1e-9)));
        let rejection = json!({"type":"rate_limit_event","rate_limit_info":{
            "status":"rejected","rateLimitType":"seven_day_overage_included","resetsAt":999
        }});
        let events = parse_line("claude", &rejection.to_string());
        assert!(
            matches!(&events[0], Event::Usage {win, used_pct: 100.0, resets_at: Some(999)} if win == "seven_day_fable")
        );
        assert!(
            matches!(&events[1], Event::WindowLimitHit { win, .. } if win == "seven_day_fable")
        );
        assert!(parse_line("claude", r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"seven_day_overage_included":null}}}"#).is_empty());
    }

    #[test]
    fn haiku_55_catalog_has_the_supported_effort_levels() {
        let models = claude_catalog();
        let haiku = models.iter().find(|m| m.id == "claude-haiku-5-5").unwrap();
        assert_eq!(haiku.efforts, &["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(
            models.iter().filter(|m| m.id == "claude-haiku-5-5").count(),
            1
        );
    }

    #[test]
    fn haiku_45_fixed_effort_does_not_send_an_effort_flag() {
        let flags = vec![];
        let launch = Launch {
            harness: "claude",
            model: "claude-haiku-4-5",
            effort: "medium",
            session: None,
            resume: false,
            prompt: "task",
            context_limit: 0,
            flags: &flags,
            acom: Path::new("/bin/acom"),
        };
        let (cmd, _) = command(&launch);
        assert!(!cmd.get_args().any(|arg| arg == "--effort"));
        assert_eq!(
            claude_catalog()
                .iter()
                .find(|m| m.id == "claude-haiku-4-5")
                .unwrap()
                .efforts,
            &["medium"]
        );
    }

    #[test]
    fn catalog_models_and_efforts_are_preserved_in_first_and_resumed_commands() {
        for harness in KNOWN {
            for model in catalog(harness) {
                for effort in model.efforts {
                    for resume in [false, true] {
                        let launch = Launch {
                            harness,
                            model: model.id,
                            effort,
                            session: Some("11111111-1111-4111-8111-111111111111"),
                            resume,
                            prompt: "test task",
                            context_limit: 0,
                            flags: &[],
                            acom: Path::new("/bin/acom"),
                        };
                        let (cmd, input) = command(&launch);
                        let args: Vec<_> = cmd.get_args().map(|s| s.to_string_lossy()).collect();
                        assert_eq!(input.as_deref(), Some("test task"));
                        let model_flag = if harness == "claude" { "--model" } else { "-m" };
                        assert!(
                            args.windows(2)
                                .any(|a| a[0] == model_flag && a[1] == model.id)
                        );
                        if harness == "codex" {
                            assert!(
                                args.iter().any(|a| a
                                    == &format!("model_reasoning_effort={}", toml_string(effort)))
                            );
                            assert_eq!(args.iter().any(|a| a == "resume"), resume);
                        } else {
                            let fixed = model.efforts.len() == 1;
                            assert_eq!(args.iter().any(|a| a == "--effort"), !fixed);
                            if !fixed {
                                assert!(
                                    args.windows(2)
                                        .any(|a| a[0] == "--effort" && a[1] == *effort)
                                );
                            }
                            assert_eq!(args.iter().any(|a| a == "--resume"), resume);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn claude_model_switches_and_limits_are_reported() {
        let refusal = r#"{"type":"assistant","message":{"model":"claude-fable-5-1","stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":"This request triggered restrictions."},"content":[]}}"#;
        let ev = parse_line("claude", refusal);
        assert!(matches!(&ev[0], Event::Model(m) if m == "claude-fable-5-1"));
        assert!(!ev.iter().any(|e| matches!(e, Event::Failed(_))));
        let no_fallback = r#"{"type":"system","subtype":"model_refusal_no_fallback","original_model":"claude-opus-5-5","api_refusal_category":"cyber"}"#;
        assert!(parse_line("claude", no_fallback).is_empty());
        let fallback = r#"{"type":"system","subtype":"model_fallback","originalModel":"claude-opus-5-5","fallbackModel":"claude-opus-4-8","trigger":"overloaded"}"#;
        assert!(
            matches!(&parse_line("claude", fallback)[0], Event::ModelSwitched(r) if r == "Claude Code switched from claude-opus-5-5 to claude-opus-4-8")
        );
        let limit = r#"{"type":"assistant","error":"rate_limit","message":{"model":"<synthetic>","content":[{"type":"text","text":"You've hit your session limit · resets 3:30pm"}]}}"#;
        let ev = parse_line("claude", limit);
        assert!(
            matches!(&ev[0], Event::LimitHit(t) if t.starts_with("You've hit your session limit"))
        );
        let error_result = r#"{"type":"result","is_error":true,"result":"API Error: request could not be completed","usage":{}}"#;
        assert!(
            parse_line("claude", error_result)
                .iter()
                .any(|e| matches!(e, Event::Failed(_)))
        );
        let rejected = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":99}}"#;
        assert!(matches!(
            &parse_line("claude", rejected)[0],
            Event::Usage { used_pct, resets_at: Some(99), .. } if *used_pct == 100.0
        ));
        assert!(
            parse_line("claude", rejected)
                .iter()
                .any(|e| matches!(e, Event::LimitHit(_)))
        );
    }

    #[test]
    fn claude_error_results_fail_without_keyword_classification() {
        for (value, reason) in [
            (
                json!({"type":"result","is_error":true,"result":"stream disconnected before completion"}),
                "stream disconnected before completion",
            ),
            (
                json!({"type":"result","is_error":true,"subtype":"error_during_execution","errors":["authentication failed","server unavailable"]}),
                "authentication failed; server unavailable",
            ),
            (
                json!({"type":"result","is_error":true,"subtype":"error_max_turns"}),
                "error_max_turns",
            ),
            (
                json!({"type":"result","is_error":true}),
                "Claude turn failed",
            ),
        ] {
            let events = parse_line("claude", &value.to_string());
            assert!(
                events
                    .iter()
                    .any(|e| matches!(e, Event::Failed(text) if text == reason))
            );
            assert!(!events.iter().any(|e| matches!(e, Event::LimitHit(_))));
        }
        for reason in [
            "You've hit your session limit",
            "rate limit exceeded",
            "quota exceeded",
        ] {
            let events = parse_line(
                "claude",
                &json!({"type":"result","is_error":true,"result":reason}).to_string(),
            );
            assert!(events.iter().any(|e| matches!(e, Event::LimitHit(_))));
            assert!(!events.iter().any(|e| matches!(e, Event::Failed(_))));
        }
        for value in [
            json!({"type":"result","is_error":false,"result":"An example says safeguards flagged this session; usage limit."}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"error: authentication failed; this is sample output."}]}}),
        ] {
            assert!(
                !parse_line("claude", &value.to_string())
                    .iter()
                    .any(|e| matches!(e, Event::Failed(_) | Event::LimitHit(_)))
            );
        }
    }

    #[test]
    fn claude_turns_off_model_fallback() {
        let flags = vec![];
        let launch = Launch {
            harness: "claude",
            model: "claude-opus-5-5",
            effort: "low",
            session: Some("s"),
            resume: false,
            prompt: "hi",
            context_limit: 0,
            flags: &flags,
            acom: Path::new("/tmp/acom"),
        };
        let (c, _) = command(&launch);
        let env: Vec<(String, String)> = c
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into(),
                    v.unwrap().to_string_lossy().into(),
                )
            })
            .collect();
        for var in [
            "CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK",
            "CLAUDE_CODE_NO_MODEL_FALLBACK",
        ] {
            assert!(env.contains(&(var.to_string(), "1".to_string())), "{var}");
        }
    }

    #[test]
    fn claude_result_adds_tokens() {
        let line = r#"{"type":"result","usage":{"input_tokens":17,"cache_creation_input_tokens":28668,"cache_read_input_tokens":27308,"output_tokens":544}}"#;
        let ev = parse_line("claude", line);
        assert!(matches!(
            &ev[0],
            Event::Tokens {
                t: [17, 28668, 27308, 544],
                add: true
            }
        ));
    }

    #[test]
    fn claude_enforced_flags_follow_configurable_flags() {
        let flags = vec![
            "--model".into(),
            "wrong-model".into(),
            "--settings".into(),
            "{}".into(),
            "--allowedTools".into(),
            "Agent".into(),
        ];
        let launch = Launch {
            harness: "claude",
            model: "right-model",
            effort: "high",
            session: Some("session-1"),
            resume: true,
            prompt: "hello",
            context_limit: 160_000,
            flags: &flags,
            acom: Path::new("/tmp/acom"),
        };
        let (command, input) = command(&launch);
        let args: Vec<String> = command
            .get_args()
            .map(|x| x.to_string_lossy().into_owned())
            .collect();
        let last_model = args.iter().rposition(|x| x == "--model").unwrap();
        assert_eq!(args[last_model + 1], "right-model");
        let last_settings = args.iter().rposition(|x| x == "--settings").unwrap();
        assert!(args[last_settings + 1].contains("PostToolUse"));
        let denied = args.iter().rposition(|x| x == "--disallowedTools").unwrap();
        assert!(args[denied + 1].contains("Agent"));
        assert_eq!(input.as_deref(), Some("hello"));
    }

    #[test]
    fn codex_stdout_has_session_and_absolute_tokens() {
        let ev = parse_line(
            "codex",
            r#"{"type":"thread.started","thread_id":"thread-1"}"#,
        );
        assert!(matches!(&ev[0], Event::Session(s) if s == "thread-1"));
        let ev = parse_line(
            "codex",
            r#"{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,"cache_write_input_tokens":5,"output_tokens":7}}"#,
        );
        assert!(matches!(
            &ev[0],
            Event::Tokens {
                t: [35, 5, 60, 7],
                add: false
            }
        ));
    }

    #[test]
    fn tool_actions_are_typed_from_the_event_not_the_message_prefix() {
        let events = parse_line(
            "claude",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Bash: this is an explanation"},{"type":"tool_use","name":"Bash","input":{"command":"pwd"}}]}}"#,
        );
        assert!(
            matches!(events.as_slice(), [Event::Text(text),Event::Tool(tool)] if text == "Bash: this is an explanation" && tool == "Bash: pwd")
        );
        for (item, expected) in [
            (
                json!({"type":"command_execution","command":"pwd"}),
                "shell: pwd",
            ),
            (
                json!({"type":"mcp_tool_call","tool":"read_resource"}),
                "MCP: read_resource",
            ),
            (
                json!({"type":"web_search","query":"parser"}),
                "search: parser",
            ),
            (json!({"type":"file_change"}), "changed files"),
        ] {
            let events = parse_line(
                "codex",
                &json!({"type":"item.completed","item":item}).to_string(),
            );
            assert!(matches!(events.as_slice(), [Event::Tool(text)] if text == expected));
        }
        let events = parse_line(
            "codex",
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"shell: this is an explanation"}}"#,
        );
        assert!(
            matches!(events.as_slice(), [Event::Text(text)] if text == "shell: this is an explanation")
        );
        assert!(
            parse_line(
                "codex",
                r#"{"type":"item.started","item":{"type":"command_execution","command":"pwd"}}"#
            )
            .is_empty()
        );
    }

    #[test]
    fn codex_rollout_has_context_and_rate_limits() {
        let line = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":0,"output_tokens":9},"last_token_usage":{"total_tokens":71}},"rate_limits":{"primary":{"used_percent":12.5,"window_minutes":300,"resets_at":123},"secondary":null}}}"#;
        let ev = parse_line("codex", line);
        assert!(matches!(
            &ev[0],
            Event::Tokens {
                t: [60, 0, 40, 9],
                add: false
            }
        ));
        assert!(matches!(&ev[1], Event::Context(71)));
        assert!(
            matches!(&ev[2], Event::Usage { win, used_pct, resets_at: Some(123) } if win == "primary (300m)" && (*used_pct - 12.5).abs() < 1e-9)
        );
    }

    #[test]
    fn unset_context_limit_leaves_harness_defaults_alone() {
        for harness in ["claude", "codex"] {
            let launch = Launch {
                harness,
                model: "model",
                effort: "low",
                session: None,
                resume: false,
                prompt: "hello",
                context_limit: 0,
                flags: &[],
                acom: Path::new("/tmp/acom"),
            };
            let (command, _) = command(&launch);
            let args: Vec<String> = command
                .get_args()
                .map(|x| x.to_string_lossy().into_owned())
                .collect();
            assert!(!args.iter().any(|x| x == "--autocompact"));
            assert!(
                !args
                    .iter()
                    .any(|x| x.starts_with("model_auto_compact_token_limit="))
            );
        }
    }

    #[test]
    fn codex_resume_drops_new_turn_only_flags() {
        let flags = vec![
            "--sandbox".into(),
            "workspace-write".into(),
            "--sandbox=read-only".into(),
            "--ignore-rules".into(),
            "-c".into(),
            "sandbox_workspace_write.network_access=false".into(),
            "--enable".into(),
            "multi_agent".into(),
        ];
        let launch = Launch {
            harness: "codex",
            model: "gpt-test",
            effort: "low",
            session: Some("session-1"),
            resume: true,
            prompt: "hello",
            context_limit: 100_000,
            flags: &flags,
            acom: Path::new("/tmp/acom"),
        };
        let (command, input) = command(&launch);
        let args: Vec<String> = command
            .get_args()
            .map(|x| x.to_string_lossy().into_owned())
            .collect();
        assert_eq!(command.get_program(), "codex");
        assert!(args.windows(2).any(|x| x == ["exec", "resume"]));
        assert!(
            !args
                .iter()
                .any(|x| x == "--sandbox" || x == "workspace-write" || x.starts_with("--sandbox="))
        );
        assert!(args.iter().any(|x| x == "--ignore-rules"));
        let network = args
            .iter()
            .rposition(|x| x.starts_with("sandbox_workspace_write.network_access="))
            .unwrap();
        assert_eq!(args[network], "sandbox_workspace_write.network_access=true");
        let multi = args.iter().rposition(|x| x == "multi_agent").unwrap();
        assert_eq!(args[multi - 1], "--disable");
        assert!(args.iter().any(|x| x.starts_with("hooks.PostToolUse=")));
        assert!(args.iter().any(|x| x == "--dangerously-bypass-hook-trust"));
        assert!(args.iter().any(|x| x == "--skip-git-repo-check"));
        assert_eq!(args[args.len() - 2..], ["session-1", "-"]);
        assert_eq!(input.as_deref(), Some("hello"));
    }

    #[test]
    fn permission_defaults_are_used_on_first_and_resumed_turns() {
        let settings = crate::app::Settings::default();
        for (harness, permission) in [
            ("claude", "--dangerously-skip-permissions"),
            ("codex", "--dangerously-bypass-approvals-and-sandbox"),
        ] {
            let cfg = &settings.harnesses[harness];
            assert_eq!(cfg.flags, [permission]);
            for resume in [false, true] {
                let launch = Launch {
                    harness,
                    model: &cfg.model,
                    effort: &cfg.effort,
                    session: Some("session-1"),
                    resume,
                    prompt: "hello",
                    context_limit: 0,
                    flags: &cfg.flags,
                    acom: Path::new("/tmp/acom"),
                };
                let (command, _) = command(&launch);
                assert!(command.get_args().any(|arg| arg == permission));
            }
        }
    }

    #[test]
    fn codex_catalog_has_full_ids_and_model_specific_efforts() {
        let models = codex_catalog();
        assert_eq!(models.len(), 7);
        for model in models {
            assert!(model.id.starts_with("gpt-"));
            assert!(model.efforts.contains(&"medium"));
            assert_eq!(
                model.efforts.contains(&"ultra"),
                !model.id.ends_with("luna")
            );
        }
    }

    #[test]
    fn codex_failures_include_reroutes_and_explicit_error_frames() {
        for line in [
            r#"{"type":"event_msg","payload":{"type":"model_reroute","from_model":"gpt-6-sol","to_model":"gpt-other","reason":"high_risk_cyber_activity"}}"#,
            r#"{"method":"model/rerouted","params":{"fromModel":"gpt-6-sol","toModel":"gpt-other","reason":"highRiskCyberActivity"}}"#,
            r#"{"type":"turn.failed","error":{"code":"policy_violation","message":"request blocked under the usage policy"}}"#,
        ] {
            assert!(
                parse_line("codex", line)
                    .iter()
                    .any(|e| matches!(e, Event::Failed(_) | Event::ModelSwitched(_))),
                "{line}"
            );
        }
    }

    #[test]
    fn codex_does_not_classify_prose_or_tool_output_as_failures() {
        for line in [
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"This test explains usage policy refusals and model reroutes."}}"#,
            r#"{"type":"item.completed","item":{"type":"command_execution","command":"test","aggregated_output":"safeguards flagged this request"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"refusal","refusal":"quoted example"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"not permitted"}]}}"#,
            r#"{"type":"response.refusal.done","refusal":"not permitted"}"#,
            r#"{"type":"refusal","refusal":"not permitted"}"#,
            r#"{"type":"turn_context","payload":{"model":"gpt-requested-model"}}"#,
        ] {
            assert!(
                parse_line("codex", line).iter().all(|e| !matches!(
                    e,
                    Event::Failed(_) | Event::ModelSwitched(_) | Event::Model(_)
                )),
                "{line}"
            );
        }
    }

    #[test]
    fn normally_completed_refusal_is_not_a_failed_turn() {
        for (provider, lines) in [
            (
                "claude",
                vec![
                    r#"{"type":"assistant","message":{"stop_reason":"refusal","content":[{"type":"text","text":"I can't help with this request."}]}}"#,
                    r#"{"type":"system","subtype":"model_refusal_no_fallback"}"#,
                    r#"{"type":"result","is_error":false,"subtype":"success","result":"I can't help with this request."}"#,
                ],
            ),
            (
                "codex",
                vec![
                    r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"I can't help with this request."}]}}"#,
                    r#"{"type":"response.refusal.done","refusal":"I can't help with this request."}"#,
                    r#"{"type":"turn.completed","usage":{}}"#,
                ],
            ),
        ] {
            for line in lines {
                assert!(
                    !parse_line(provider, line)
                        .iter()
                        .any(|e| matches!(e, Event::Failed(_) | Event::ModelSwitched(_))),
                    "{line}"
                );
            }
        }
    }

    #[test]
    fn codex_generic_error_frames_fail_independently_of_message_words() {
        for line in [
            r#"{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}"#,
            r#"{"type":"error","message":"invalid credentials"}"#,
            r#"{"type":"event_msg","payload":{"type":"error","message":"server unavailable"}}"#,
            r#"{"type":"turn.failed","error":"unexpected harness failure"}"#,
            r#"{"type":"turn.failed"}"#,
        ] {
            let events = parse_line("codex", line);
            assert_eq!(events.len(), 1, "{line}");
            assert!(
                matches!(&events[0], Event::Failed(text) if !text.is_empty()),
                "{line}"
            );
        }
    }

    #[test]
    fn codex_error_items_are_diagnostics_not_turn_failures() {
        for message in [
            "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.",
            "model not found",
            "the safeguards flagged this request",
        ] {
            let line = json!({"type":"item.completed","item":{"id":"item_0","type":"error","message":message}}).to_string();
            let events = parse_line("codex", &line);
            assert!(
                matches!(events.as_slice(), [Event::Text(text)] if text == &format!("notice: {message}"))
            );
        }
    }

    #[test]
    fn codex_usage_errors_pause_and_actual_response_models_are_reported() {
        let events = parse_line(
            "codex",
            r#"{"type":"turn.failed","error":{"code":"usage_limit_reached","message":"You've hit your usage limit"}}"#,
        );
        assert!(events.iter().any(|e| matches!(e, Event::LimitHit(_))));
        assert!(!events.iter().any(|e| matches!(e, Event::Failed(_))));
        let events = parse_line(
            "codex",
            r#"{"type":"response.completed","response":{"model":"gpt-6-sol"}}"#,
        );
        assert!(matches!(&events[0], Event::Model(m) if m == "gpt-6-sol"));
    }

    #[test]
    fn codex_unwraps_account_model_errors_as_failures_not_quota() {
        let events = parse_line("codex", &serde_json::json!({"type":"turn.failed","error":{"message":serde_json::json!({"error":{"message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}).to_string()}}).to_string());
        assert!(matches!(&events[0],Event::Failed(t) if t.starts_with("The 'gpt-6.1-sol'")));
        assert!(!events.iter().any(|e| matches!(e, Event::LimitHit(_))));
        let events = parse_line(
            "codex",
            r#"{"type":"turn.failed","error":{"codexErrorInfo":"UsageLimitExceeded","message":"Account blocked"}}"#,
        );
        assert!(events.iter().any(|e| matches!(e, Event::LimitHit(_))));
    }
}
