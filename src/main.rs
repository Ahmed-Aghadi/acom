mod app;
mod harness;
mod run;
mod server;
mod usage;

use app::{GUIDE, MODELS, hhmm, who};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use std::io::Read;
use std::process::exit;

const HELP: &str = "\
acom: launch coding agents and let them talk and share locks.

One server runs every project: start it once with `acom serve`. A project is a folder;
agents run in their project's folder and only see that project's agents, threads and locks.

Agents never run user commands.

Agent commands (your ID comes from ACOM_ID; they act on your project):
  guide                                   Print the guide for agents
  models [--catalog]                     Model/provider guidance, or IDs and effort choices
  configure [ID] [--model m] [--effort e] [--continue text] [--ack-crashes]
                                          Set next-turn model/effort; optionally queue one turn
  me                                      Your details, usage and locks
  limits                                  Limits and current usage
  status <text>                           Set your status text
  group <name>                            Put yourself in a group
  done                                    Mark your task finished, then end your turn
  agents [--group <name>]                 List agents
  agent <ID>                              One agent's details
  launch --task <text> [--harness h] [--model m] [--effort e] [--name n] [--group g] [--done|--replace] [--ack-crashes]
                                          Launch a helper agent; --done also marks you done,
                                          so you hand over without needing a second slot
                                          --replace queues a terminal cross-provider handoff
  threads                                 List threads
  thread new --title <text> [--members <ID or selector,...> | --watch <states,group:name,...>] [--include-user]
  thread read <TID>                       A thread's full history
  thread add <TID> <ID or selector,...>   Add members
  thread remove <TID> <IDs,user>          Remove members from a static thread
  history [ID] [--agent ID | --all-agents] [--thread TID] [--lock name] [--kind kind]
          [--before ID | --after ID] [--limit N] [--max-bytes N]
                                          Bounded coordination events; ID reads one event
  send --thread <TID> [text]              Post in a thread (stdin if text is left out)
  inbox [--mark new|in-progress|handled]  Your messages with that mark (default new)
  read <msg ID>                           One message in full
  mark <msg ID,...> new|in-progress|handled
  locks                                   List locks
  lock new <name> --about <text>          Create a lock
  lock acquire <name> [--wait <dur>] [--ttl <dur>]
                                          TTL defaults to the project's maximum; larger TTLs fail
  lock release <name>

User commands (they act on the project the current folder is in):
  serve [--port N]                        Run the server (default port 7400; data in ~/.acom)
  projects                                List projects
  project add [path]                      Add a folder as a project (default: this folder)
  project remove <ID>                     Remove a project that has no agents
  launch ... [--force]                    Launch an agent in this folder's project (added if
                                          needed); --force confirms past a hard limit
  send --thread <TID> [text]              Post as user
  pause <ID> [--release-locks|--keep-locks]
  pause-all / resume-all
  resume <ID,...>
  close <ID> / reopen <ID>
  lock free <name>                        Release a lock whoever holds it

Selectors: active, working, idle, paused, done, closed, crashed, group:<name>.
Durations: 30s, 5m, 1h.
";

#[derive(Parser)]
#[command(name = "acom", override_help = HELP, disable_help_subcommand = true)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    #[test]
    fn thread_watch_and_snapshot_members_cannot_mix() {
        let cli = Cli::try_parse_from([
            "acom",
            "thread",
            "new",
            "--title",
            "team",
            "--watch",
            "active,group:parser",
            "--include-user",
        ])
        .unwrap();
        assert!(matches!(
            cli.cmd,
            Cmd::Thread {
                cmd: ThreadCmd::New {
                    watch: Some(_),
                    include_user: true,
                    ..
                }
            }
        ));
        assert!(
            Cli::try_parse_from([
                "acom",
                "thread",
                "new",
                "--title",
                "team",
                "--watch",
                "active",
                "--members",
                "1",
            ])
            .is_err()
        );
        assert!(Cli::try_parse_from(["acom", "thread", "remove", "1", "2,user"]).is_ok());
    }

    #[test]
    fn history_defaults_and_cursor_conflicts_are_explicit() {
        let cli = Cli::try_parse_from(["acom", "history"]).unwrap();
        assert!(matches!(
            cli.cmd,
            Cmd::History {
                agent: None,
                all_agents: false,
                limit: 50,
                max_bytes: 16000,
                ..
            }
        ));
        assert!(Cli::try_parse_from(["acom", "history", "--before", "4", "--after", "1"]).is_err());
        assert!(Cli::try_parse_from(["acom", "history", "--agent", "2", "--all-agents"]).is_err());
        assert!(Cli::try_parse_from(["acom", "history", "12"]).is_ok());
        assert!(Cli::try_parse_from(["acom", "history", "12", "--thread", "1"]).is_err());
    }

    #[test]
    fn membership_context_is_separate_from_the_message_mark() {
        assert_eq!(message_context(&json!({"mark":"new"})), "");
        assert_eq!(
            message_context(&json!({"mark":"handled", "outside_membership":true})),
            "\n[sent while you were not a member]"
        );
        assert_eq!(
            message_context(&json!({"membership_unknown":true, "outside_membership":true})),
            "\n[membership at send time unknown]"
        );
    }

    #[test]
    fn continuation_and_replacement_flags_are_explicit() {
        let cli = Cli::try_parse_from([
            "acom",
            "configure",
            "--effort",
            "high",
            "--continue",
            "Review remaining files",
            "--ack-crashes",
        ])
        .unwrap();
        assert!(matches!(
            cli.cmd,
            Cmd::Configure {
                continuation: Some(_),
                ack_crashes: true,
                ..
            }
        ));
        assert!(Cli::try_parse_from(["acom", "configure", "--continue"]).is_err());
        assert!(Cli::try_parse_from(["acom", "launch", "--replace", "--done"]).is_err());
        assert!(Cli::try_parse_from(["acom", "launch", "--replace", "--force"]).is_err());
        assert!(
            Cli::try_parse_from([
                "acom",
                "launch",
                "--replace",
                "--harness",
                "claude",
                "--task",
                "summary",
                "--ack-crashes"
            ])
            .is_ok()
        );
    }
}

#[derive(Subcommand)]
enum Cmd {
    Guide,
    Models {
        #[arg(long)]
        catalog: bool,
    },
    Configure {
        id: Option<i64>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        effort: Option<String>,
        #[arg(long = "continue")]
        continuation: Option<String>,
        #[arg(long)]
        ack_crashes: bool,
    },
    Me,
    Limits,
    Status {
        text: Vec<String>,
    },
    Group {
        name: String,
    },
    Done,
    Agents {
        #[arg(long)]
        group: Option<String>,
    },
    Agent {
        id: i64,
    },
    Launch {
        #[arg(long)]
        task: Option<String>,
        #[arg(long)]
        harness: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        effort: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        group: Option<String>,
        #[arg(long)]
        force: bool,
        #[arg(long)]
        done: bool,
        #[arg(long, conflicts_with_all = ["done", "force"])]
        replace: bool,
        #[arg(long)]
        ack_crashes: bool,
    },
    Threads,
    Thread {
        #[command(subcommand)]
        cmd: ThreadCmd,
    },
    Send {
        #[arg(long)]
        thread: i64,
        text: Vec<String>,
    },
    Inbox {
        #[arg(long, default_value = "new")]
        mark: String,
    },
    Read {
        id: i64,
    },
    History {
        #[arg(conflicts_with_all = ["agent", "all_agents", "thread", "lock", "kind", "before", "after", "limit", "max_bytes"])]
        id: Option<i64>,
        #[arg(long, conflicts_with = "all_agents")]
        agent: Option<i64>,
        #[arg(long)]
        all_agents: bool,
        #[arg(long)]
        thread: Option<i64>,
        #[arg(long)]
        lock: Option<String>,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long, conflicts_with = "after")]
        before: Option<i64>,
        #[arg(long)]
        after: Option<i64>,
        #[arg(long, default_value_t = 50)]
        limit: i64,
        #[arg(long, default_value_t = 16000)]
        max_bytes: i64,
    },
    Mark {
        ids: String,
        mark: String,
    },
    Locks,
    Lock {
        #[command(subcommand)]
        cmd: LockCmd,
    },
    Serve {
        #[arg(long, default_value_t = 7400)]
        port: u16,
    },
    Pause {
        id: i64,
        #[arg(long)]
        release_locks: bool,
        #[arg(long, conflicts_with = "release_locks")]
        keep_locks: bool,
    },
    PauseAll,
    ResumeAll,
    Resume {
        ids: String,
    },
    Close {
        id: i64,
    },
    Reopen {
        id: i64,
    },
    Projects,
    Project {
        #[command(subcommand)]
        cmd: ProjectCmd,
    },
    #[command(hide = true)]
    Hook,
}

#[derive(Subcommand)]
enum ProjectCmd {
    Add { path: Option<String> },
    Remove { id: i64 },
}

#[derive(Subcommand)]
enum ThreadCmd {
    New {
        #[arg(long)]
        title: String,
        #[arg(long, conflicts_with = "watch")]
        members: Option<String>,
        #[arg(long)]
        watch: Option<String>,
        #[arg(long)]
        include_user: bool,
    },
    Read {
        id: i64,
    },
    Add {
        id: i64,
        members: String,
    },
    Remove {
        id: i64,
        members: String,
    },
}

#[derive(Subcommand)]
enum LockCmd {
    New {
        name: String,
        #[arg(long)]
        about: String,
    },
    Acquire {
        name: String,
        #[arg(long)]
        wait: Option<String>,
        #[arg(long)]
        ttl: Option<String>,
    },
    Release {
        name: String,
    },
    Free {
        name: String,
    },
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    exit(1)
}

/// The server's address: ACOM_URL, or .acom/port in this folder or a parent.
/// The server's address: ACOM_URL, or the port the running server wrote to ~/.acom/port.
fn base_url() -> String {
    if let Ok(u) = std::env::var("ACOM_URL") {
        return u.trim_end_matches('/').to_string();
    }
    match std::fs::read_to_string(app::acom_home().join("port")) {
        Ok(p) => format!("http://127.0.0.1:{}", p.trim()),
        Err(_) => die("acom isn't running. Start it with `acom serve`."),
    }
}

fn my_id() -> Option<i64> {
    std::env::var("ACOM_ID").ok().and_then(|s| s.parse().ok())
}

fn me() -> i64 {
    my_id().unwrap_or_else(|| die("ACOM_ID isn't set. This is an agent command; acom sets ACOM_ID for the agents it launches."))
}

fn call(method: &str, path: &str, body: Option<Value>) -> Value {
    request(method, path, body).unwrap_or_else(|(_, msg)| die(&msg))
}

/// One API call; an error status comes back as (status, message).
fn request(method: &str, path: &str, body: Option<Value>) -> Result<Value, (u16, String)> {
    let url = format!("{}{path}", base_url());
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(None)
            .build(),
    );
    let res = match (method, body) {
        ("GET", _) => agent.get(&url).call(),
        (m, b) => {
            let b = b.unwrap_or(json!({})).to_string();
            let req = if m == "PUT" {
                agent.put(&url)
            } else {
                agent.post(&url)
            };
            req.header("Content-Type", "application/json")
                .send(b.as_bytes())
        }
    };
    let mut res = res.unwrap_or_else(|e| {
        die(&format!(
            "can't reach the acom server at {}: {e}",
            base_url()
        ))
    });
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().unwrap_or_default();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status >= 400 {
        return Err((status, v["error"].as_str().unwrap_or(&text).to_string()));
    }
    Ok(v)
}

fn cwd() -> String {
    std::env::current_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_else(|e| die(&format!("can't read the current folder: {e}")))
}

/// The project the current folder is in, if any.
fn project_here() -> Option<i64> {
    request("GET", &format!("/projects?path={}", encode(&cwd())), None)
        .ok()
        .and_then(|p| p["id"].as_i64())
}

/// For user commands that act on a project: the one the current folder is in.
fn user_project() -> i64 {
    project_here().unwrap_or_else(|| {
        die("this folder isn't in an acom project. Run the command inside one, or add it with `acom project add`.")
    })
}

/// What listings cover: an agent sees its own project; the user sees the project of the
/// current folder, or every project when the folder isn't in one.
fn scope() -> String {
    let project = match my_id() {
        Some(id) => get(&format!("/agents/{id}"))["project"].as_i64(),
        None => project_here(),
    };
    project.map(|p| format!("project={p}")).unwrap_or_default()
}

fn get(path: &str) -> Value {
    call("GET", path, None)
}
fn post(path: &str, body: Value) -> Value {
    call("POST", path, Some(body))
}

/// Body for a user command: records which agent ran it, if any.
fn user_body(mut b: Value) -> Value {
    if let Some(v) = my_id() {
        b["via"] = json!(v);
    }
    b
}

fn duration(s: &str) -> u64 {
    let (num, mult) = match s.chars().last() {
        Some('s') => (&s[..s.len() - 1], 1),
        Some('m') => (&s[..s.len() - 1], 60),
        Some('h') => (&s[..s.len() - 1], 3600),
        _ => (s, 1),
    };
    num.trim()
        .parse::<u64>()
        .ok()
        .and_then(|n| n.checked_mul(mult))
        .unwrap_or_else(|| die(&format!("bad duration {s:?}: use e.g. 30s, 5m, 1h")))
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn ids(s: &str) -> Vec<i64> {
    s.split(',')
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(|x| {
            x.parse()
                .unwrap_or_else(|_| die(&format!("{x} isn't an ID")))
        })
        .collect()
}

fn text_or_stdin(words: Vec<String>) -> String {
    if !words.is_empty() {
        return words.join(" ");
    }
    let mut s = String::new();
    let _ = std::io::stdin().read_to_string(&mut s);
    s
}

fn t(v: &Value) -> String {
    v.as_i64().map(hhmm).unwrap_or_else(|| "-".into())
}

fn sender(v: &Value) -> String {
    who(v.as_i64().unwrap_or(0))
}

fn message_context(m: &Value) -> &'static str {
    if m["membership_unknown"].as_bool() == Some(true) {
        "\n[membership at send time unknown]"
    } else if m["outside_membership"].as_bool() == Some(true) {
        "\n[sent while you were not a member]"
    } else {
        ""
    }
}

fn print_message(m: &Value) {
    let mark = m["mark"]
        .as_str()
        .map(|k| format!(" · {k}"))
        .unwrap_or_default();
    println!(
        "#{} · thread {} \"{}\" · {} · {}{mark}{}",
        m["id"],
        m["thread"],
        m["title"].as_str().unwrap_or(""),
        sender(&m["sender"]),
        t(&m["at"]),
        message_context(m)
    );
    println!("{}\n", m["text"].as_str().unwrap_or(""));
}

fn print_agent_line(a: &Value) {
    let group = a["group"]
        .as_str()
        .map(|g| format!(" [{g}]"))
        .unwrap_or_default();
    let status = a["status"]
        .as_str()
        .map(|s| format!(" · {s}"))
        .unwrap_or_default();
    println!(
        "{:>3}  {}{group} · {} · {}/{}/{} · context {}{status}",
        a["id"],
        a["name"].as_str().unwrap_or(""),
        a["state"].as_str().unwrap_or(""),
        a["harness"].as_str().unwrap_or(""),
        a["model"].as_str().unwrap_or(""),
        a["effort"].as_str().unwrap_or(""),
        a["context"]
    );
}

fn print_agent(a: &Value) {
    println!("Agent {}: {}", a["id"], a["name"].as_str().unwrap_or(""));
    println!(
        "Project: {} ({})",
        a["project_name"].as_str().unwrap_or(""),
        a["project_path"].as_str().unwrap_or("")
    );
    if let Some(g) = a["group"].as_str() {
        println!("Group: {g}");
    }
    println!(
        "State: {}{}",
        a["state"].as_str().unwrap_or(""),
        a["status"]
            .as_str()
            .map(|s| format!(" ({s})"))
            .unwrap_or_default()
    );
    let running = &a["running_configuration"];
    println!(
        "Configuration for next turn: {} / {} / effort {}",
        a["harness"].as_str().unwrap_or(""),
        a["model"].as_str().unwrap_or(""),
        a["effort"].as_str().unwrap_or("")
    );
    if running.is_object() {
        println!(
            "Current turn: {} / {} / effort {}",
            a["harness"].as_str().unwrap_or(""),
            running["model"].as_str().unwrap_or(""),
            running["effort"].as_str().unwrap_or("")
        );
    }
    println!(
        "Launched by {} at {}",
        sender(&a["launched_by"]),
        t(&a["launched_at"])
    );
    println!(
        "Context: {} tokens. Tokens so far: fresh input {}, cache writes {}, cache reads {}, output {}",
        a["context"], a["fresh_in"], a["cache_write"], a["cache_read"], a["output"]
    );
    let locks: Vec<&str> = a["locks"]
        .as_array()
        .map(|l| l.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    println!(
        "Locks held: {}",
        if locks.is_empty() {
            "none".into()
        } else {
            locks.join(", ")
        }
    );
    println!("Task:\n{}", a["task"].as_str().unwrap_or(""));
    for (label, key) in [
        ("Conversation history", "conversation_history"),
        ("Output log", "output_log"),
    ] {
        if let Some(path) = a[key].as_str() {
            println!("{label}: {path}");
        }
    }
    if let Some(new) = a["replacement"]
        .as_i64()
        .or_else(|| a["retry"]["replacement"].as_i64())
    {
        println!("Replacement: agent {new}");
    }
    if let Some(why) = a["retry"]["blocked"].as_str() {
        println!("Retry waiting/stopped: {why}");
    }
    if let Some(text) = a["continuation"]["text"].as_str() {
        println!("Queued continuation: {text}");
        if let Some(why) = a["continuation"]["blocked"].as_str() {
            println!("Continuation waiting: {why}");
        }
    }
    if let Some(harness) = a["replacement_request"]["harness"].as_str() {
        println!(
            "Queued replacement: {harness}/{}",
            a["replacement_request"]["model"].as_str().unwrap_or("")
        );
        if let Some(why) = a["replacement_request"]["blocked"].as_str() {
            println!("Replacement waiting: {why}");
        }
    }
    if let Some(why) = a["problem"].as_str() {
        println!("Previous error: {why}");
    }
}

fn hook() {
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);
    let (Some(id), Ok(url)) = (my_id(), std::env::var("ACOM_URL")) else {
        return;
    };
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(5)))
            .build(),
    );
    let Ok(mut res) = agent
        .post(&format!("{url}/hook/{id}"))
        .header("Content-Type", "application/json")
        .send(&b"{}"[..])
    else {
        return;
    };
    let v: Value = serde_json::from_str(&res.body_mut().read_to_string().unwrap_or_default())
        .unwrap_or(Value::Null);
    if let Some(text) = v["text"].as_str().filter(|s| !s.is_empty()) {
        println!("{}", harness::hook_output(text));
    }
}

fn main() {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Serve { port } => server::serve(port),
        Cmd::Hook => hook(),
        Cmd::Guide => print!("{GUIDE}"),
        Cmd::Models { catalog } => {
            if catalog {
                for h in harness::KNOWN {
                    for m in harness::catalog(h) {
                        println!(
                            "{h}: {} · {} · efforts {}",
                            m.id,
                            m.name,
                            m.efforts.join(", ")
                        );
                    }
                }
            } else {
                print!("{MODELS}");
            }
        }
        Cmd::Configure {
            id,
            model,
            effort,
            continuation,
            ack_crashes,
        } => {
            let by = my_id().unwrap_or(0);
            let id = id.or_else(my_id).unwrap_or_else(|| die("give an agent ID"));
            if by > 0 && id != by {
                die("agents may only configure themselves");
            }
            post(
                "/agent-config",
                json!({ "id": id, "agent": by, "model": model, "effort": effort, "continuation":continuation,"ack_crashes":ack_crashes }),
            );
            if continuation.is_some() {
                println!(
                    "Configuration saved; one continuation queued. End this turn without acom done. Current tools are unchanged."
                );
            } else {
                println!(
                    "Configuration saved for the next turn; this does not schedule a turn. Current tools are unchanged."
                );
            }
        }
        Cmd::Me => print_agent(&get(&format!("/agents/{}", me()))),
        Cmd::Limits => println!(
            "{}",
            get(&format!("/limits?{}", scope()))["text"]
                .as_str()
                .unwrap_or("")
        ),
        Cmd::Status { text } => {
            post(
                &format!("/agents/{}/status", me()),
                json!({ "text": text.join(" ") }),
            );
            println!("status set");
        }
        Cmd::Group { name } => {
            post(&format!("/agents/{}/group", me()), json!({ "group": name }));
            println!("group set to {name}");
        }
        Cmd::Done => {
            post(&format!("/agents/{}/done", me()), json!({}));
            println!("marked done; end your turn now");
        }
        Cmd::Agents { group } => {
            let mut path = format!("/agents?{}", scope());
            if let Some(g) = group {
                path += &format!("&group={}", encode(&g));
            }
            for a in get(&path).as_array().into_iter().flatten() {
                print_agent_line(a);
            }
        }
        Cmd::Agent { id } => print_agent(&get(&format!("/agents/{id}"))),
        Cmd::Launch {
            task,
            harness,
            model,
            effort,
            name,
            group,
            force,
            done,
            replace,
            ack_crashes,
        } => {
            let task = task.unwrap_or_else(|| text_or_stdin(vec![]));
            let mut b = json!({ "task": task, "harness": harness, "model": model, "effort": effort, "name": name, "group": group, "force": force, "done": done, "ack_crashes":ack_crashes });
            if replace {
                let id = me();
                let v = post(&format!("/agents/{id}/replacement"), b);
                println!(
                    "Replacement queued; end this turn without acom done. You become replaced only after it starts."
                );
                for warning in v["warnings"].as_array().into_iter().flatten() {
                    println!("{}", warning.as_str().unwrap_or(""));
                }
                return;
            }
            match my_id() {
                Some(id) => b["agent"] = json!(id),
                None => {
                    let project = project_here().unwrap_or_else(|| {
                        let p = post("/projects", user_body(json!({ "path": cwd() })));
                        println!("added project {}", p["path"].as_str().unwrap_or(""));
                        p["id"].as_i64().unwrap_or(0)
                    });
                    b["project"] = json!(project);
                    b = user_body(b);
                }
            }
            let v = post("/agents", b);
            println!("launched agent {}", v["id"]);
            if done {
                println!("marked you done; end your turn now");
            }
            for w in v["warnings"].as_array().into_iter().flatten() {
                println!("{}", w.as_str().unwrap_or(""));
            }
        }
        Cmd::Threads => {
            for th in get(&format!("/threads?{}", scope()))
                .as_array()
                .into_iter()
                .flatten()
            {
                let members: Vec<String> = th["members"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|m| {
                        if m.as_i64() == Some(0) {
                            "user".into()
                        } else {
                            m.to_string()
                        }
                    })
                    .collect();
                println!(
                    "{:>3}  \"{}\" · members {} · {} messages · last {}",
                    th["id"],
                    th["title"].as_str().unwrap_or(""),
                    members.join(","),
                    th["messages"],
                    t(&th["last_at"])
                );
            }
        }
        Cmd::Thread { cmd } => match cmd {
            ThreadCmd::New {
                title,
                members,
                watch,
                include_user,
            } => {
                let members: Vec<String> = members
                    .map(|m| m.split(',').map(|s| s.trim().to_string()).collect())
                    .unwrap_or_default();
                let watch: Vec<String> = watch
                    .map(|w| w.split(',').map(|s| s.trim().to_string()).collect())
                    .unwrap_or_default();
                let mut b = json!({ "title": title, "members": members, "watch": watch });
                match my_id() {
                    Some(id) => {
                        b["agent"] = json!(id);
                        b["include_user"] = json!(include_user);
                    }
                    None => {
                        b["project"] = json!(user_project());
                        b["include_user"] = json!(true);
                    }
                }
                let v = post("/threads", b);
                let m: Vec<String> = v["members"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|x| {
                        if x.as_i64() == Some(0) {
                            "user".into()
                        } else {
                            x.to_string()
                        }
                    })
                    .collect();
                println!("thread {} (members {})", v["id"], m.join(", "));
            }
            ThreadCmd::Read { id } => {
                let context = my_id().map(|a| format!("?agent={a}")).unwrap_or_default();
                let th = get(&format!("/threads/{id}{context}"));
                let m: Vec<String> = th["members"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|x| {
                        if x.as_i64() == Some(0) {
                            "user".into()
                        } else {
                            x.to_string()
                        }
                    })
                    .collect();
                println!(
                    "Thread {} \"{}\" · members {}\n",
                    th["id"],
                    th["title"].as_str().unwrap_or(""),
                    m.join(", ")
                );
                for event in th["events"].as_array().into_iter().flatten() {
                    println!(
                        "event #{} · {} · {} · {} · {}",
                        event["id"],
                        t(&event["at"]),
                        event["kind"].as_str().unwrap_or(""),
                        sender(&event["agent"]),
                        event["details"]["reason"].as_str().unwrap_or("")
                    );
                }
                if th["events_more"].as_bool() == Some(true) {
                    println!("Older membership events: acom history --thread {id}");
                }
                for msg in th["messages"].as_array().into_iter().flatten() {
                    println!(
                        "#{} · {} · {}{}\n{}\n",
                        msg["id"],
                        sender(&msg["sender"]),
                        t(&msg["at"]),
                        message_context(msg),
                        msg["text"].as_str().unwrap_or("")
                    );
                }
                if my_id().unwrap_or(0) == 0
                    && let Some(last) = th["messages"].as_array().and_then(|m| m.last())
                {
                    post(
                        &format!("/threads/{id}/read"),
                        json!({ "message": last["id"] }),
                    );
                }
            }
            ThreadCmd::Add { id, members } => {
                let members: Vec<String> =
                    members.split(',').map(|s| s.trim().to_string()).collect();
                let v = post(
                    &format!("/threads/{id}/members"),
                    json!({ "members": members }),
                );
                let m: Vec<String> = v["members"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|x| {
                        if x.as_i64() == Some(0) {
                            "user".into()
                        } else {
                            x.to_string()
                        }
                    })
                    .collect();
                println!("added {} to thread {id}", m.join(", "));
            }
            ThreadCmd::Remove { id, members } => {
                let members: Vec<String> =
                    members.split(',').map(|s| s.trim().to_string()).collect();
                let v = post(
                    &format!("/threads/{id}/members/remove"),
                    json!({ "members": members }),
                );
                println!("removed {} from thread {id}", v["members"]);
            }
        },
        Cmd::Send { thread, text } => {
            let text = text_or_stdin(text);
            let mut b = json!({ "thread": thread, "text": text });
            match my_id() {
                Some(id) => b["agent"] = json!(id),
                None => b = user_body(b),
            }
            let v = post("/messages", b);
            println!("sent #{} to thread {thread}", v["id"]);
            for n in v["not_woken"].as_array().into_iter().flatten() {
                println!(
                    "agent {} wasn't woken: {}.",
                    n["agent"],
                    n["reason"].as_str().unwrap_or("")
                );
            }
        }
        Cmd::Inbox { mark } => {
            let msgs = get(&format!("/inbox/{}?mark={mark}", me()));
            let msgs = msgs.as_array().cloned().unwrap_or_default();
            if msgs.is_empty() {
                println!("no {mark} messages");
            }
            for m in &msgs {
                print_message(m);
            }
            if !msgs.is_empty() && mark == "new" {
                println!(
                    "Mark them with `acom mark <IDs> in-progress` or `handled` once you've dealt with them."
                );
            }
        }
        Cmd::Read { id } => {
            let context = my_id().map(|a| format!("?agent={a}")).unwrap_or_default();
            print_message(&get(&format!("/messages/{id}{context}")));
        }
        Cmd::History {
            id,
            agent,
            all_agents,
            thread,
            lock,
            kind,
            before,
            after,
            limit,
            max_bytes,
        } => {
            let mut query = vec![scope()];
            let path = if let Some(id) = id {
                format!("/history/{id}")
            } else {
                let agent = agent.or_else(|| if all_agents { None } else { my_id() });
                for (key, value) in [
                    ("agent", agent),
                    ("thread", thread),
                    ("before", before),
                    ("after", after),
                    ("limit", Some(limit)),
                    ("max_bytes", Some(max_bytes)),
                ] {
                    if let Some(value) = value {
                        query.push(format!("{key}={value}"));
                    }
                }
                for (key, value) in [("lock", lock), ("kind", kind)] {
                    if let Some(value) = value {
                        query.push(format!("{key}={}", encode(&value)));
                    }
                }
                "/history".into()
            };
            println!("{}", get(&format!("{path}?{}", query.join("&"))));
        }
        Cmd::Mark { ids: list, mark } => {
            post(
                "/marks",
                json!({ "agent": me(), "ids": ids(&list), "mark": mark }),
            );
            println!("marked {list} {mark}");
        }
        Cmd::Locks => {
            for l in get(&format!("/locks?{}", scope()))
                .as_array()
                .into_iter()
                .flatten()
            {
                println!(
                    "{} · {}",
                    l["name"].as_str().unwrap_or(""),
                    l["about"].as_str().unwrap_or("")
                );
                match l["holder"].as_i64() {
                    None => println!("    free"),
                    Some(h) => {
                        let mut s = format!(
                            "    held by agent {h} \"{}\" since {}",
                            l["holder_name"].as_str().unwrap_or(""),
                            t(&l["acquired_at"])
                        );
                        if l["frozen"] == 1 {
                            s += &match l["frozen_left"].as_i64() {
                                Some(left) => format!(", frozen with {}s left", left),
                                None => ", frozen".into(),
                            };
                        } else if l["expires_at"].is_i64() {
                            s += &format!(", expires {}", t(&l["expires_at"]));
                        }
                        println!("{s}");
                    }
                }
                let q: Vec<String> = l["queue"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|x| x.to_string())
                    .collect();
                if !q.is_empty() {
                    println!("    queue: {}", q.join(", "));
                }
            }
        }
        Cmd::Lock { cmd } => match cmd {
            LockCmd::New { name, about } => {
                let mut b = json!({ "name": name, "about": about });
                match my_id() {
                    Some(id) => b["agent"] = json!(id),
                    None => b["project"] = json!(user_project()),
                }
                post("/locks", b);
                println!("created lock {name}");
            }
            LockCmd::Acquire { name, wait, ttl } => {
                let b = json!({
                    "agent": me(), "name": name,
                    "wait": wait.as_deref().map(duration).unwrap_or(0),
                    "ttl": ttl.as_deref().map(duration),
                });
                println!(
                    "{}",
                    post("/locks/acquire", b)["result"].as_str().unwrap_or("")
                );
            }
            LockCmd::Release { name } => {
                post("/locks/release", json!({ "agent": me(), "name": name }));
                println!("released {name}");
            }
            LockCmd::Free { name } => {
                post(
                    "/locks/free",
                    user_body(json!({ "project": user_project(), "name": name })),
                );
                println!("freed {name}");
            }
        },
        Cmd::Pause {
            id,
            release_locks,
            keep_locks,
        } => {
            let locks = if release_locks {
                json!("release")
            } else if keep_locks {
                json!("keep")
            } else {
                Value::Null
            };
            post(
                &format!("/agents/{id}/pause"),
                user_body(json!({ "locks": locks })),
            );
            println!("paused agent {id}");
        }
        Cmd::PauseAll => {
            let v = post("/pause-all", user_body(json!({})));
            println!(
                "paused {} agent(s); their locks are frozen",
                v["ids"].as_array().map(|a| a.len()).unwrap_or(0)
            );
        }
        Cmd::ResumeAll => {
            let v = post("/resume-all", user_body(json!({})));
            println!(
                "resumed {} agent(s)",
                v["ids"].as_array().map(|a| a.len()).unwrap_or(0)
            );
        }
        Cmd::Resume { ids: list } => {
            for id in ids(&list) {
                let v = post(&format!("/agents/{id}/resume"), user_body(json!({})));
                println!("resumed agent {id}");
                for w in v["warnings"].as_array().into_iter().flatten() {
                    println!("warning: {}", w.as_str().unwrap_or(""));
                }
            }
        }
        Cmd::Close { id } => {
            post(&format!("/agents/{id}/close"), user_body(json!({})));
            println!("closed agent {id}");
        }
        Cmd::Reopen { id } => {
            post(&format!("/agents/{id}/reopen"), user_body(json!({})));
            println!("reopened agent {id}");
        }
        Cmd::Projects => {
            for p in get("/projects").as_array().into_iter().flatten() {
                println!(
                    "{:>3}  {} · {} · {} agents, {} active",
                    p["id"],
                    p["name"].as_str().unwrap_or(""),
                    p["path"].as_str().unwrap_or(""),
                    p["agents"],
                    p["active"]
                );
            }
        }
        Cmd::Project { cmd } => match cmd {
            ProjectCmd::Add { path } => {
                let path = path.unwrap_or_else(cwd);
                let p = post("/projects", user_body(json!({ "path": path })));
                let (id, path) = (&p["id"], p["path"].as_str().unwrap_or(""));
                if p["added"] == true {
                    println!("added project {id} ({path})");
                } else {
                    println!("project {id} already exists ({path})");
                }
            }
            ProjectCmd::Remove { id } => {
                post(&format!("/projects/{id}/remove"), user_body(json!({})));
                println!("removed project {id}");
            }
        },
    }
}
