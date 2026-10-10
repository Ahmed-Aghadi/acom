mod app;
mod harness;
mod paging;
mod run;
mod server;
mod usage;

use app::{GUIDE, MODELS, hhmm, who};
use clap::{Args, Parser, Subcommand};
use serde_json::{Value, json};
use std::io::{Read, Write};
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
  wait [--timeout duration | --ack ID]     Wait for hook updates (default 60s, maximum 1h)
  agents [--group <name>]                 List agents
  agent <ID>                              One agent's details
  launch --task <text> [--harness h] [--model m] [--effort e] [--name n] [--group g] [--done|--replace] [--ack-crashes]
                                          Launch a helper agent; --done also marks you done,
                                          so you hand over without needing a second slot
                                          --replace queues a terminal cross-provider handoff
  threads                                 List threads
  thread new --title <text> [--members <ID or selector,...> | --watch <states,group:name,...>] [--include-user]
  thread read <TID>                       A bounded page of thread messages
  thread details <TID>                   Thread metadata, without message bodies
  thread add <TID> <ID or selector,...>   Add members
  thread remove <TID> <IDs,user>          Remove members from a static thread
  history [ID] [--agent ID | --all-agents] [--thread TID] [--lock name] [--kind kind]
          [--before ID | --after ID] [--limit N] [--max-bytes N]
                                          Bounded coordination events; ID reads one event
  send --thread <TID> [text]              Post in a thread (stdin if text is left out)
  inbox [--mark new|in-progress|handled]  Your messages with that mark (default new)
  notices [ID]                            Retained notices / one full notice
  read <msg ID>                           One bounded message record
  mark <msg ID,...> new|in-progress|handled
  locks                                   List locks
  lock read <ID>                          One lock's details
  lock new <name> --about <text>          Create a lock
  lock acquire <name> [--wait <dur>] [--ttl <dur>]
                                          TTL defaults to the project's maximum; larger TTLs fail
  lock release <name>

User commands (they act on the project the current folder is in):
  serve [--port N]                        Run the server (default port 7400; data in ~/.acom)
  projects                                List projects
  project read <ID>                       One project's details
  receipt <ID>                            Full saved command result; never repeats the action
  activity [ID]                           Recent activity / one full activity record
  configs / config <ID>                  Config summaries / one config's details
  log <ID> [--before BYTE | --after BYTE] [--through BYTE] [--version V] [--since R]
           [--lines N] [--max-bytes N]    Lossless bounded agent log chunks (JSON)
  project add [path]                      Add a folder as a project (default: this folder)
  project remove <ID>                     Remove a project that has no agents
  launch ... [--force]                    Launch an agent in this folder's project (added if
                                          needed); --force confirms past a hard limit
  send --thread <TID> [text]              Post as user
  pause <ID> [--release-locks|--keep-locks]
  pause-all / resume-all
  resume-restart                          Resume restart-paused agents across all projects
  resume <ID,...>
  close <ID> / reopen <ID>
  lock free <name>                        Release a lock whoever holds it

Selectors: active, working, idle, paused, done, closed, crashed, replaced, group:<name>.
Durations: 30s, 5m, 1h.

Lists (agents, threads, inbox, notices, locks, projects, activity, configs, thread read):
  [--before ID | --after ID] [--through ID] [--revision R] [--since R]
  [--limit N] [--max-bytes N]            Defaults: 50 items, 16000 JSON bytes.
  Continue with the printed cursor, through and revision; changed snapshots fail visibly.
Details (me, agent, read, notice ID, config, project read, lock read, receipt, limits, history ID):
  [--offset BYTE] [--version V] [--max-bytes N]
  Oversized records print a stub. Offset mode returns JSON chunks; retain the version.
Limits: 1–200 items (log lines), 512–65536 JSON bytes; no automatic all-page drain.
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
    fn wait_flags_and_response_validation_do_not_ack_incomplete_delivery() {
        assert!(Cli::try_parse_from(["acom", "wait"]).is_ok());
        assert!(Cli::try_parse_from(["acom", "wait", "--ack", "1"]).is_ok());
        assert!(Cli::try_parse_from(["acom", "wait", "--ack", "0"]).is_err());
        assert!(Cli::try_parse_from(["acom", "wait", "--ack", "1", "--timeout", "1s"]).is_err());
        assert!(Cli::try_parse_from(["acom", "resume-restart"]).is_ok());
        assert_eq!(
            wait_output(&json!({"delivery_id":1,"text":"notice","timed_out":false}))
                .unwrap()
                .1,
            Some(1)
        );
        assert_eq!(
            wait_output(&json!({"delivery_id":null,"text":"","timed_out":true}))
                .unwrap()
                .1,
            None
        );
        for v in [
            json!({"delivery_id":1,"text":null,"timed_out":false}),
            json!({"delivery_id":0,"text":"notice","timed_out":false}),
            json!({"delivery_id":1,"text":"","timed_out":false}),
            json!({"delivery_id":1,"text":"notice","timed_out":true}),
            json!({"text":"","timed_out":true}),
            json!({"delivery_id":null,"text":"notice","timed_out":true}),
        ] {
            assert!(wait_output(&v).is_err());
        }
    }

    #[test]
    fn help_lists_all_thread_state_selectors() {
        let selectors = HELP
            .lines()
            .find(|line| line.starts_with("Selectors:"))
            .unwrap();
        for state in app::STATES {
            assert!(selectors.split([',', ' ', '.']).any(|word| word == state));
        }
    }

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

    #[test]
    fn growing_read_commands_share_explicit_page_and_chunk_options() {
        for command in [
            "agents", "threads", "inbox", "notices", "locks", "projects", "activity", "configs",
        ] {
            assert!(
                Cli::try_parse_from([
                    "acom",
                    command,
                    "--after",
                    "0",
                    "--through",
                    "130",
                    "--revision",
                    "snapshot",
                    "--limit",
                    "3",
                    "--max-bytes",
                    "2048"
                ])
                .is_ok()
            );
            for (flag, value) in [
                ("--limit", "0"),
                ("--limit", "201"),
                ("--max-bytes", "511"),
                ("--max-bytes", "65537"),
            ] {
                assert!(Cli::try_parse_from(["acom", command, flag, value]).is_err());
            }
            assert!(
                Cli::try_parse_from(["acom", command, "--before", "4", "--after", "1"]).is_err()
            );
        }
        for args in [
            vec!["acom", "read", "1", "--offset", "0", "--max-bytes", "512"],
            vec!["acom", "agent", "1", "--offset", "4", "--version", "v"],
            vec![
                "acom",
                "history",
                "1",
                "--offset",
                "0",
                "--max-bytes",
                "2048",
            ],
            vec!["acom", "activity", "1", "--offset", "0"],
            vec![
                "acom", "thread", "read", "1", "--after", "0", "--offset", "0",
            ],
            vec!["acom", "thread", "details", "1", "--offset", "0"],
            vec!["acom", "project", "read", "1", "--offset", "0"],
            vec!["acom", "lock", "read", "1", "--offset", "0"],
            vec!["acom", "log", "1", "--after", "0", "--lines", "200"],
        ] {
            assert!(Cli::try_parse_from(args).is_ok());
        }
    }
}

#[derive(Args)]
struct PageArgs {
    #[arg(long, conflicts_with = "after", value_parser = clap::value_parser!(i64).range(1..))]
    before: Option<i64>,
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    after: Option<i64>,
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    through: Option<i64>,
    #[arg(long)]
    revision: Option<String>,
    #[arg(long)]
    since: Option<String>,
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(i64).range(1..=200))]
    limit: i64,
    #[arg(long, default_value_t = 16000, value_parser = clap::value_parser!(i64).range(512..=65536))]
    max_bytes: i64,
}

impl PageArgs {
    fn query(&self) -> String {
        let mut query = vec![format!("limit={}&max_bytes={}", self.limit, self.max_bytes)];
        for (key, value) in [
            ("before", self.before),
            ("after", self.after),
            ("through", self.through),
        ] {
            if let Some(value) = value {
                query.push(format!("{key}={value}"));
            }
        }
        for (key, value) in [("revision", &self.revision), ("since", &self.since)] {
            if let Some(value) = value {
                query.push(format!("{key}={}", encode(value)));
            }
        }
        query.join("&")
    }

    fn selection_flags(&self) -> String {
        let mut flags = String::new();
        for (key, value) in [
            ("before", self.before),
            ("after", self.after),
            ("through", self.through),
        ] {
            if let Some(value) = value {
                flags += &format!(" --{key} {value}");
            }
        }
        for (key, value) in [("revision", &self.revision), ("since", &self.since)] {
            if let Some(value) = value {
                flags += &format!(" --{key} {}", shell_word(value));
            }
        }
        flags += &format!(" --limit {}", self.limit);
        flags
    }
}

#[derive(Args)]
struct RecordArgs {
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    offset: Option<i64>,
    #[arg(long)]
    version: Option<String>,
    #[arg(long, default_value_t = 16000, value_parser = clap::value_parser!(i64).range(512..=65536))]
    max_bytes: i64,
}

impl RecordArgs {
    fn query(&self) -> String {
        let mut query = format!("max_bytes={}", self.max_bytes);
        if let Some(offset) = self.offset {
            query += &format!("&offset={offset}");
        }
        if let Some(version) = &self.version {
            query += &format!("&version={}", encode(version));
        }
        query
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
    Me {
        #[command(flatten)]
        record: RecordArgs,
    },
    Limits {
        #[command(flatten)]
        record: RecordArgs,
    },
    Status {
        text: Vec<String>,
    },
    Group {
        name: String,
    },
    Done,
    Wait {
        #[arg(long, default_value = "60s")]
        timeout: String,
        #[arg(long, conflicts_with = "timeout", value_parser = clap::value_parser!(i64).range(1..))]
        ack: Option<i64>,
    },
    Agents {
        #[arg(long)]
        group: Option<String>,
        #[command(flatten)]
        page: PageArgs,
    },
    Agent {
        id: i64,
        #[command(flatten)]
        record: RecordArgs,
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
    Threads {
        #[command(flatten)]
        page: PageArgs,
    },
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
        #[command(flatten)]
        page: PageArgs,
    },
    Read {
        id: i64,
        #[command(flatten)]
        record: RecordArgs,
    },
    History {
        #[arg(conflicts_with_all = ["agent", "all_agents", "thread", "lock", "kind", "before", "after", "limit"])]
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
        #[arg(long, requires = "id", value_parser = clap::value_parser!(i64).range(0..))]
        offset: Option<i64>,
        #[arg(long, requires = "id")]
        version: Option<String>,
    },
    Mark {
        ids: String,
        mark: String,
    },
    Locks {
        #[command(flatten)]
        page: PageArgs,
    },
    Activity {
        #[arg(conflicts_with_all = ["before","after","through","revision","since","limit"])]
        id: Option<i64>,
        #[command(flatten)]
        page: PageArgs,
        #[arg(long, requires = "id", value_parser = clap::value_parser!(i64).range(0..))]
        offset: Option<i64>,
        #[arg(long, requires = "id")]
        version: Option<String>,
    },
    Configs {
        #[command(flatten)]
        page: PageArgs,
    },
    Config {
        id: i64,
        #[command(flatten)]
        record: RecordArgs,
    },
    Receipt {
        id: i64,
        #[command(flatten)]
        record: RecordArgs,
    },
    Notices {
        #[arg(conflicts_with_all = ["before","after","through","revision","since","limit"])]
        id: Option<i64>,
        #[command(flatten)]
        page: PageArgs,
        #[arg(long, requires = "id", value_parser = clap::value_parser!(i64).range(0..))]
        offset: Option<i64>,
        #[arg(long, requires = "id")]
        version: Option<String>,
    },
    Log {
        id: i64,
        #[arg(long, conflicts_with = "after", value_parser = clap::value_parser!(i64).range(0..))]
        before: Option<i64>,
        #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
        after: Option<i64>,
        #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
        through: Option<i64>,
        #[arg(long)]
        version: Option<String>,
        #[arg(long)]
        since: Option<String>,
        #[arg(long, default_value_t = 200, value_parser = clap::value_parser!(i64).range(1..=200))]
        lines: i64,
        #[arg(long, default_value_t = 16000, value_parser = clap::value_parser!(i64).range(512..=65536))]
        max_bytes: i64,
    },
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
    ResumeRestart,
    Resume {
        ids: String,
    },
    Close {
        id: i64,
    },
    Reopen {
        id: i64,
    },
    Projects {
        #[command(flatten)]
        page: PageArgs,
    },
    Project {
        #[command(subcommand)]
        cmd: ProjectCmd,
    },
    #[command(hide = true)]
    Hook,
}

#[derive(Subcommand)]
enum ProjectCmd {
    Add {
        path: Option<String>,
    },
    Remove {
        id: i64,
    },
    Read {
        id: i64,
        #[command(flatten)]
        record: RecordArgs,
    },
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
        #[command(flatten)]
        page: PageArgs,
        #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
        offset: Option<i64>,
        #[arg(long)]
        version: Option<String>,
    },
    Details {
        id: i64,
        #[command(flatten)]
        record: RecordArgs,
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
    Read {
        id: i64,
        #[command(flatten)]
        record: RecordArgs,
    },
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
    let value = request(method, path, body).unwrap_or_else(|(status, msg)| {
        if method != "GET" && status == 0 {
            die(&format!(
                "{msg}. The action may have completed. Inspect current state before retrying."
            ));
        }
        die(&msg)
    });
    if value["result_truncated"] == true {
        if let Some(id) = value["receipt_event"].as_i64() {
            eprintln!(
                "Action completed; response contains samples only. Full result: acom receipt {id}"
            );
        }
        if let Some(error) = value["receipt_error"].as_str() {
            eprintln!("{error}");
        }
    }
    value
}

/// One API call; an error status comes back as (status, message).
fn request(method: &str, path: &str, body: Option<Value>) -> Result<Value, (u16, String)> {
    request_with_timeout(method, path, body, None)
}

fn request_with_timeout(
    method: &str,
    path: &str,
    body: Option<Value>,
    timeout: Option<std::time::Duration>,
) -> Result<Value, (u16, String)> {
    let url = format!("{}{path}", base_url());
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(timeout)
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
    let mut res = res.map_err(|e| {
        (
            0,
            format!("can't reach the acom server at {}: {e}", base_url()),
        )
    })?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().map_err(|e| {
        (
            0,
            format!("can't read the acom response (HTTP {status}): {e}"),
        )
    })?;
    let v: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) if status >= 400 => return Err((status, text)),
        Err(e) => {
            return Err((
                0,
                format!("invalid JSON in the acom response (HTTP {status}): {e}"),
            ));
        }
    };
    if status >= 400 {
        return Err((status, v["error"].as_str().unwrap_or(&text).to_string()));
    }
    if !v.is_object() {
        return Err((0, "invalid acom response: expected a JSON object".into()));
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
    match request("GET", &format!("/projects?path={}", encode(&cwd())), None) {
        Ok(project) => {
            if project["truncated"] == true {
                die(
                    "project lookup exceeds the response budget; read its details with `acom project read <ID>`",
                );
            }
            Some(
                project["id"]
                    .as_i64()
                    .unwrap_or_else(|| die("invalid project lookup response")),
            )
        }
        Err((404, _)) => None,
        Err((_, message)) => die(&message),
    }
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
        Some(id) => Some(
            get(&format!("/agents/{id}/project"))["project"]
                .as_i64()
                .unwrap_or_else(|| die("invalid agent project response")),
        ),
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

fn wait_output(v: &Value) -> Result<(String, Option<i64>), &'static str> {
    match (
        v["delivery_id"].as_i64(),
        v["text"].as_str(),
        v["timed_out"].as_bool(),
    ) {
        (Some(id), Some(text), Some(false)) if id > 0 && !text.is_empty() => {
            Ok((format!("[acom] Delivery #{id}\n{text}\n"), Some(id)))
        }
        (None, Some(""), Some(true)) if v.get("delivery_id").is_some_and(Value::is_null) => {
            Ok(("[acom] Wait timed out; no new updates.\n".into(), None))
        }
        _ => Err("invalid wait response; no delivery was acknowledged"),
    }
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

fn shell_word(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn short_label(s: &str) -> String {
    let mut chars = s.chars();
    let mut label: String = chars.by_ref().take(200).collect();
    if chars.next().is_some() {
        label.push_str("… [label truncated]");
    }
    label
}

fn page_items(v: &Value) -> &[Value] {
    if v["unchanged"] == true {
        return &[];
    }
    v["items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_else(|| die("invalid page response: missing items"))
}

fn result_count(v: &Value, key: &str) -> usize {
    v["counts"][key]
        .as_u64()
        .map(|n| n as usize)
        .unwrap_or_else(|| v[key].as_array().map_or(0, Vec::len))
}

fn page_hint(v: &Value, args: &PageArgs, command: &str) {
    if v["unchanged"] == true {
        println!("unchanged");
    }
    if v["has_more"] != true {
        return;
    }
    let (key, cursor) = if let Some(n) = v["next_after"].as_i64() {
        ("after", n)
    } else if let Some(n) = v["next_before"].as_i64() {
        ("before", n)
    } else {
        die("invalid page response: missing continuation cursor")
    };
    let mut next = format!(
        "{command} --{key} {cursor} --limit {} --max-bytes {}",
        args.limit, args.max_bytes
    );
    if let Some(n) = v["through"].as_i64() {
        next += &format!(" --through {n}");
    }
    if let Some(revision) = v["revision"].as_str() {
        next += &format!(" --revision {}", shell_word(revision));
    }
    println!("More available: {next}");
}

fn record_output(v: &Value, args: &RecordArgs, command: &str) -> bool {
    if args.offset.is_some() || v["truncated"] == true {
        println!("{v}");
        if args.offset.is_none()
            && let Some(next) = v["next_offset"].as_i64()
        {
            let mut hint = format!("{command} --offset {next} --max-bytes {}", args.max_bytes);
            if let Some(version) = v["version"].as_str() {
                hint += &format!(" --version {}", shell_word(version));
            }
            println!("Continue record: {hint}");
        }
        true
    } else {
        false
    }
}

fn item_truncated(v: &Value, command: &str) -> bool {
    if v["truncated"] != true {
        return false;
    }
    println!(
        "#{}, record exceeds this page's byte budget; details: {command}",
        v["id"]
    );
    true
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
    if let Some(predecessor) = a["replacement_start"]["predecessor"].as_i64() {
        println!("Replacement of agent {predecessor}: waiting for first startup");
        if let Some(why) = a["replacement_start"]["blocked"].as_str() {
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
        Cmd::Me { record } => {
            let a = get(&format!("/agents/{}?{}", me(), record.query()));
            if !record_output(&a, &record, "acom me") {
                print_agent(&a);
            }
        }
        Cmd::Limits { record } => {
            let value = get(&format!("/limits?{}&{}", scope(), record.query()));
            if !record_output(&value, &record, "acom limits") {
                println!("{}", value["text"].as_str().unwrap_or(""));
            }
        }
        Cmd::Status { text } => {
            post(
                &format!("/agents/{}/status", me()),
                json!({ "text": text.join(" ") }),
            );
            println!("status set");
        }
        Cmd::Group { name } => {
            post(&format!("/agents/{}/group", me()), json!({ "group": name }));
            println!("group set to {}", short_label(&name));
        }
        Cmd::Done => {
            post(&format!("/agents/{}/done", me()), json!({}));
            println!("marked done; end your turn now");
        }
        Cmd::Wait { timeout, ack } => {
            let id = me();
            let acknowledge = |delivery: i64| {
                let recover = |error: &str| {
                    die(&format!(
                        "{error}. Delivery #{delivery} may still be pending. If you received its text, run `acom wait --ack {delivery}`; otherwise run `acom wait` to retrieve it again by the same ID."
                    ))
                };
                let value = request_with_timeout(
                    "POST",
                    &format!("/wait/{id}/ack"),
                    Some(json!({"delivery_id":delivery})),
                    Some(std::time::Duration::from_secs(5)),
                )
                .unwrap_or_else(|(_, error)| recover(&error));
                if value["acknowledged"] != true {
                    recover("invalid acknowledgement response");
                }
                value
            };
            if let Some(delivery) = ack {
                acknowledge(delivery);
                println!("acknowledged delivery #{delivery}");
                return;
            }
            let secs = duration(&timeout);
            if !(1..=3600).contains(&secs) {
                die("wait timeout must be between 1s and 1h");
            }
            let v = request_with_timeout("POST", &format!("/wait/{id}"), Some(json!({"timeout":secs})), Some(std::time::Duration::from_secs(secs+5)))
                .unwrap_or_else(|(_, error)| die(&format!("{error}. No delivery was acknowledged. Retry `acom wait` to retrieve any pending delivery.")));
            let (output, delivery) = wait_output(&v).unwrap_or_else(|e| die(e));
            let mut stdout = std::io::stdout().lock();
            if let Err(e) = stdout
                .write_all(output.as_bytes())
                .and_then(|_| stdout.flush())
            {
                die(&format!(
                    "can't write wait response: {e}; delivery was not acknowledged"
                ));
            }
            drop(stdout);
            if let Some(n) = delivery {
                acknowledge(n);
            }
        }
        Cmd::Agents { group, page } => {
            let mut path = format!("/agents?{}&{}", scope(), page.query());
            let mut command = "acom agents".to_string();
            if let Some(g) = group {
                path += &format!("&group={}", encode(&g));
                command += &format!(" --group {}", shell_word(&g));
            }
            let result = get(&path);
            for a in page_items(&result) {
                if !item_truncated(a, &format!("acom agent {}", a["id"])) {
                    print_agent_line(a);
                }
            }
            page_hint(&result, &page, &command);
        }
        Cmd::Agent { id, record } => {
            let context = my_id().map(|a| format!("agent={a}&")).unwrap_or_default();
            let result = get(&format!("/agents/{id}?{context}{}", record.query()));
            if !record_output(&result, &record, &format!("acom agent {id}")) {
                print_agent(&result);
            }
        }
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
                    "Replacement queued; end this turn without acom done. After your successful exit, ownership transfers permanently to the successor, even if its startup waits or fails."
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
        Cmd::Threads { page } => {
            let result = get(&format!("/threads?{}&{}", scope(), page.query()));
            for th in page_items(&result) {
                if item_truncated(th, &format!("acom thread read {}", th["id"])) {
                    continue;
                }
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
            page_hint(&result, &page, "acom threads");
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
                if v["result_truncated"] == true {
                    println!(
                        "thread {} ({} members; sample {})",
                        v["id"],
                        result_count(&v, "members"),
                        m.join(", ")
                    );
                } else {
                    println!("thread {} (members {})", v["id"], m.join(", "));
                }
            }
            ThreadCmd::Details { id, record } => {
                let context = my_id().map(|a| format!("agent={a}&")).unwrap_or_default();
                let result = get(&format!(
                    "/threads/{id}/metadata?{context}{}",
                    record.query()
                ));
                if !record_output(&result, &record, &format!("acom thread details {id}")) {
                    println!("{result}");
                }
            }
            ThreadCmd::Read {
                id,
                page,
                offset,
                version,
            } => {
                let context = my_id().map(|a| format!("agent={a}&")).unwrap_or_default();
                let mut query = page.query();
                if let Some(offset) = offset {
                    query += &format!("&offset={offset}");
                }
                if let Some(version) = &version {
                    query += &format!("&version={}", encode(version));
                }
                let th = get(&format!("/threads/{id}?{context}{query}"));
                if record_output(
                    &th,
                    &RecordArgs {
                        offset,
                        version,
                        max_bytes: page.max_bytes,
                    },
                    &format!("acom thread read {id}{}", page.selection_flags()),
                ) {
                    return;
                }
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
                let mut messages = page_items(&th["messages"]).to_vec();
                messages.sort_by_key(|m| m["id"].as_i64());
                for msg in &messages {
                    if item_truncated(msg, &format!("acom read {}", msg["id"])) {
                        continue;
                    }
                    println!(
                        "#{} · {} · {}{}\n{}\n",
                        msg["id"],
                        sender(&msg["sender"]),
                        t(&msg["at"]),
                        message_context(msg),
                        msg["text"].as_str().unwrap_or("")
                    );
                }
                page_hint(&th["messages"], &page, &format!("acom thread read {id}"));
                if my_id().unwrap_or(0) == 0
                    && page.before.is_none()
                    && page.after.is_none_or(|after| {
                        th["last_read"].as_i64().is_some_and(|read| after <= read)
                    })
                    && let Some(last) = messages
                        .iter()
                        .take_while(|m| m["truncated"] != true)
                        .last()
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
                if v["result_truncated"] == true {
                    println!(
                        "added {} members to thread {id}; sample {}",
                        result_count(&v, "members"),
                        m.join(", ")
                    );
                } else {
                    println!("added {} to thread {id}", m.join(", "));
                }
            }
            ThreadCmd::Remove { id, members } => {
                let members: Vec<String> =
                    members.split(',').map(|s| s.trim().to_string()).collect();
                let v = post(
                    &format!("/threads/{id}/members/remove"),
                    json!({ "members": members }),
                );
                if v["result_truncated"] == true {
                    println!(
                        "removed {} members from thread {id}; sample {}",
                        result_count(&v, "members"),
                        v["members"]
                    );
                } else {
                    println!("removed {} from thread {id}", v["members"]);
                }
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
        Cmd::Inbox { mark, page } => {
            let result = get(&format!(
                "/inbox/{}?mark={}&{}",
                me(),
                encode(&mark),
                page.query()
            ));
            let msgs = page_items(&result);
            if msgs.is_empty() && result["unchanged"] != true {
                println!("no {mark} messages");
            }
            for m in msgs {
                if !item_truncated(m, &format!("acom read {}", m["id"])) {
                    print_message(m);
                }
            }
            page_hint(
                &result,
                &page,
                &format!("acom inbox --mark {}", shell_word(&mark)),
            );
            if !msgs.is_empty() && mark == "new" {
                println!(
                    "Mark them with `acom mark <IDs> in-progress` or `handled` once you've dealt with them."
                );
            }
        }
        Cmd::Read { id, record } => {
            let context = my_id().map(|a| format!("agent={a}&")).unwrap_or_default();
            let result = get(&format!("/messages/{id}?{context}{}", record.query()));
            if !record_output(&result, &record, &format!("acom read {id}")) {
                print_message(&result);
            }
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
            offset,
            version,
        } => {
            let mut query = vec![scope()];
            let path = if let Some(id) = id {
                query.push(format!("max_bytes={max_bytes}"));
                if let Some(offset) = offset {
                    query.push(format!("offset={offset}"));
                }
                if let Some(version) = &version {
                    query.push(format!("version={}", encode(version)));
                }
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
            let result = get(&format!("{path}?{}", query.join("&")));
            if let Some(id) = id {
                if !record_output(
                    &result,
                    &RecordArgs {
                        offset,
                        version,
                        max_bytes,
                    },
                    &format!("acom history {id}"),
                ) {
                    println!("{result}");
                }
            } else {
                println!("{result}");
            }
        }
        Cmd::Mark { ids: list, mark } => {
            let selected = ids(&list);
            post(
                "/marks",
                json!({ "agent": me(), "ids": selected, "mark": mark }),
            );
            println!("marked {} message(s) {mark}", selected.len());
        }
        Cmd::Locks { page } => {
            let result = get(&format!("/locks?{}&{}", scope(), page.query()));
            for l in page_items(&result) {
                if item_truncated(l, &format!("acom lock read {}", l["id"])) {
                    continue;
                }
                println!(
                    "#{} {} · {}",
                    l["id"],
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
            page_hint(&result, &page, "acom locks");
        }
        Cmd::Activity {
            id,
            page,
            offset,
            version,
        } => {
            if let Some(id) = id {
                let args = RecordArgs {
                    offset,
                    version,
                    max_bytes: page.max_bytes,
                };
                let result = get(&format!("/activity/{id}?{}&{}", scope(), args.query()));
                if !record_output(&result, &args, &format!("acom activity {id}")) {
                    println!("{result}");
                }
            } else {
                let result = get(&format!("/activity?{}&{}", scope(), page.query()));
                println!("{result}");
                page_hint(&result, &page, "acom activity");
            }
        }
        Cmd::Configs { page } => {
            let result = get(&format!("/configs?{}", page.query()));
            println!("{result}");
            page_hint(&result, &page, "acom configs");
        }
        Cmd::Config { id, record } => {
            let result = get(&format!("/configs/{id}?{}", record.query()));
            if !record_output(&result, &record, &format!("acom config {id}")) {
                println!("{result}");
            }
        }
        Cmd::Receipt { id, record } => {
            let context = my_id().map(|a| format!("agent={a}&")).unwrap_or_default();
            let result = get(&format!("/receipts/{id}?{context}{}", record.query()));
            if !record_output(&result, &record, &format!("acom receipt {id}")) {
                println!("{result}");
            }
        }
        Cmd::Notices {
            id,
            page,
            offset,
            version,
        } => {
            let agent = me();
            if let Some(id) = id {
                let args = RecordArgs {
                    offset,
                    version,
                    max_bytes: page.max_bytes,
                };
                let result = get(&format!("/notices/{agent}/{id}?{}", args.query()));
                if !record_output(&result, &args, &format!("acom notices {id}")) {
                    println!("{result}");
                }
            } else {
                let result = get(&format!("/notices/{agent}?{}", page.query()));
                println!("{result}");
                page_hint(&result, &page, "acom notices");
            }
        }
        Cmd::Log {
            id,
            before,
            after,
            through,
            version,
            since,
            lines,
            max_bytes,
        } => {
            let mut query = format!("lines={lines}&max_bytes={max_bytes}");
            for (key, value) in [("before", before), ("after", after), ("through", through)] {
                if let Some(value) = value {
                    query += &format!("&{key}={value}");
                }
            }
            for (key, value) in [("version", version), ("since", since)] {
                if let Some(value) = value {
                    query += &format!("&{key}={}", encode(&value));
                }
            }
            if let Some(actor) = my_id() {
                query += &format!("&agent={actor}");
            }
            // JSON preserves every byte of a partial line and all continuation metadata.
            println!("{}", get(&format!("/agents/{id}/log?{query}")));
        }
        Cmd::Lock { cmd } => match cmd {
            LockCmd::Read { id, record } => {
                let result = get(&format!("/locks/{id}?{}&{}", scope(), record.query()));
                if !record_output(&result, &record, &format!("acom lock read {id}")) {
                    println!("{result}");
                }
            }
            LockCmd::New { name, about } => {
                let mut b = json!({ "name": name, "about": about });
                match my_id() {
                    Some(id) => b["agent"] = json!(id),
                    None => b["project"] = json!(user_project()),
                }
                post("/locks", b);
                println!("created lock {}", short_label(&name));
            }
            LockCmd::Acquire { name, wait, ttl } => {
                let b = json!({
                    "agent": me(), "name": name,
                    "wait": wait.as_deref().map(duration).unwrap_or(0),
                    "ttl": ttl.as_deref().map(duration),
                });
                let result = post("/locks/acquire", b);
                println!(
                    "{}",
                    result["result"]
                        .as_str()
                        .unwrap_or("lock operation completed; see the full saved receipt")
                );
            }
            LockCmd::Release { name } => {
                post("/locks/release", json!({ "agent": me(), "name": name }));
                println!("released {}", short_label(&name));
            }
            LockCmd::Free { name } => {
                post(
                    "/locks/free",
                    user_body(json!({ "project": user_project(), "name": name })),
                );
                println!("freed {}", short_label(&name));
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
                result_count(&v, "ids")
            );
        }
        Cmd::ResumeAll => {
            let v = post("/resume-all", user_body(json!({})));
            println!("resumed {} agent(s)", result_count(&v, "ids"));
        }
        Cmd::ResumeRestart => {
            let v = post("/resume-restart", user_body(json!({})));
            println!(
                "resumed {} restart-paused agent(s) across all projects",
                result_count(&v, "ids")
            );
            for key in ["warnings", "errors"] {
                for message in v[key].as_array().into_iter().flatten() {
                    eprintln!(
                        "{}: {}",
                        if key == "errors" { "error" } else { "warning" },
                        message.as_str().unwrap_or("")
                    );
                }
            }
            if result_count(&v, "errors") > 0 {
                exit(1);
            }
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
        Cmd::Projects { page } => {
            let result = get(&format!("/projects?{}", page.query()));
            for p in page_items(&result) {
                if item_truncated(p, &format!("acom project read {}", p["id"])) {
                    continue;
                }
                println!(
                    "{:>3}  {} · {} · {} agents, {} active",
                    p["id"],
                    p["name"].as_str().unwrap_or(""),
                    p["path"].as_str().unwrap_or(""),
                    p["agents"],
                    p["active"]
                );
            }
            page_hint(&result, &page, "acom projects");
        }
        Cmd::Project { cmd } => match cmd {
            ProjectCmd::Read { id, record } => {
                let result = get(&format!("/projects/{id}?{}", record.query()));
                if !record_output(&result, &record, &format!("acom project read {id}")) {
                    println!("{result}");
                }
            }
            ProjectCmd::Add { path } => {
                let path = path.unwrap_or_else(cwd);
                let path = std::path::Path::new(&path);
                let path = if path.is_relative() {
                    std::path::Path::new(&cwd()).join(path)
                } else {
                    path.to_path_buf()
                };
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
