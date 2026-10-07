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
    .map(|(id, name)| Model { id, name, efforts })
    .collect()
}

fn claude_command(l: &Launch) -> (Command, Option<String>) {
    let mut c = Command::new("claude");
    c.args(["-p", "--output-format", "stream-json", "--verbose"]);
    c.args(l.flags);
    // Keep session, model, compaction, hook and subagent controls after the
    // configurable flags so project settings cannot replace these invariants.
    c.args(["--model", l.model, "--effort", l.effort]);
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
    c.args(["--allowedTools", "Bash(acom *)"]);
    c.stdin(Stdio::piped());
    (c, Some(l.prompt.to_string()))
}

fn claude_events(v: &Value) -> Vec<Event> {
    let n = |x: &Value| x.as_u64().unwrap_or(0);
    let mut out = Vec::new();
    match v["type"].as_str().unwrap_or("") {
        "system" if v["subtype"] == "init" => {
            if let Some(s) = v["session_id"].as_str() {
                out.push(Event::Session(s.to_string()));
            }
        }
        "assistant" => {
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
                        out.push(Event::Text(match what {
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
                out.push(Event::Text(format!(
                    "error: {}",
                    short(v["result"].as_str().unwrap_or(""), 300)
                )));
            }
        }
        "rate_limit_event" => {
            for (win, w) in v["rate_limit_info"]["unifiedWindows"]
                .as_object()
                .into_iter()
                .flatten()
            {
                if let Some(u) = w["utilization"].as_f64() {
                    out.push(Event::Usage {
                        win: win.clone(),
                        used_pct: u * 100.0,
                        resets_at: w["resetsAt"].as_i64(),
                    });
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
        "turn.failed" | "error" => {
            let message = v["error"]["message"]
                .as_str()
                .or(v["message"].as_str())
                .unwrap_or("Codex error");
            vec![Event::Text(format!("error: {}", short(message, 300)))]
        }
        "item.completed" => {
            let item = &v["item"];
            let text = match item["type"].as_str().unwrap_or("") {
                "agent_message" => item["text"].as_str().map(|s| short(s, 300)),
                "command_execution" => item["command"]
                    .as_str()
                    .map(|s| format!("shell: {}", short(s, 200))),
                "mcp_tool_call" => item["tool"].as_str().map(|s| format!("MCP: {s}")),
                "web_search" => item["query"]
                    .as_str()
                    .map(|s| format!("search: {}", short(s, 200))),
                "file_change" => Some("changed files".to_string()),
                _ => None,
            };
            text.map(|s| vec![Event::Text(s)]).unwrap_or_default()
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
    fn claude_rate_limit_is_percent() {
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":100}}}}"#;
        let ev = parse_line("claude", line);
        assert!(
            matches!(&ev[0], Event::Usage { win, used_pct, resets_at: Some(100) } if win == "five_hour" && (*used_pct - 25.0).abs() < 1e-9)
        );
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
}
