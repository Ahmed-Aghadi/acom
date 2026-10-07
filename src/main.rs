mod app;
mod harness;
mod run;
mod server;

use app::{GUIDE, hhmm, who};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use std::io::Read;
use std::path::PathBuf;
use std::process::exit;

const HELP: &str = "\
acom: launch coding agents and let them talk and share locks.

Agents never run user commands.

Agent commands (your ID comes from ACOM_ID):
  guide                                   Print the guide for agents
  me                                      Your details, usage and locks
  limits                                  Limits and current usage
  status <text>                           Set your status text
  group <name>                            Put yourself in a group
  done                                    Mark your task finished, then end your turn
  agents [--group <name>]                 List agents
  agent <ID>                              One agent's details
  launch --task <text> [--harness h] [--model m] [--effort e] [--name n] [--group g] [--done]
                                          Launch a helper agent; --done also marks you done,
                                          so you hand over without needing a second slot
  threads                                 List threads
  thread new --title <text> [--members <ID or selector,...>]
  thread read <TID>                       A thread's full history
  thread add <TID> <ID or selector,...>   Add members
  send --thread <TID> [text]              Post in a thread (text from stdin if left out)
  inbox [--mark new|in-progress|handled]  Your messages with that mark (default new)
  read <msg ID>                           One message in full
  mark <msg ID,...> new|in-progress|handled
  locks                                   List locks
  lock new <name> --about <text>          Create a lock
  lock acquire <name> [--wait <dur>] [--ttl <dur>]
  lock release <name>

User commands:
  serve [--port N]                        Run the server in this folder (default port 7400)
  launch ... [--force]                    Launch an agent; --force confirms past a hard limit
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

#[derive(Subcommand)]
enum Cmd {
    Guide,
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
    #[command(hide = true)]
    Hook,
}

#[derive(Subcommand)]
enum ThreadCmd {
    New {
        #[arg(long)]
        title: String,
        #[arg(long)]
        members: Option<String>,
    },
    Read {
        id: i64,
    },
    Add {
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
fn base_url() -> String {
    if let Ok(u) = std::env::var("ACOM_URL") {
        return u.trim_end_matches('/').to_string();
    }
    let mut dir: Option<PathBuf> = std::env::current_dir().ok();
    while let Some(d) = dir {
        if let Ok(p) = std::fs::read_to_string(d.join(".acom/port")) {
            return format!("http://127.0.0.1:{}", p.trim());
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }
    die(
        "can't find the acom server: no .acom/port here or in a parent folder, and ACOM_URL isn't set. Start it with `acom serve`.",
    )
}

fn my_id() -> Option<i64> {
    std::env::var("ACOM_ID").ok().and_then(|s| s.parse().ok())
}

fn me() -> i64 {
    my_id().unwrap_or_else(|| die("ACOM_ID isn't set. This is an agent command; acom sets ACOM_ID for the agents it launches."))
}

fn call(method: &str, path: &str, body: Option<Value>) -> Value {
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
        die(v["error"].as_str().unwrap_or(&text));
    }
    v
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
        .map(|n| n * mult)
        .unwrap_or_else(|_| die(&format!("bad duration {s:?}: use e.g. 30s, 5m, 1h")))
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

fn print_message(m: &Value) {
    let mark = m["mark"]
        .as_str()
        .map(|k| format!(" · {k}"))
        .unwrap_or_default();
    println!(
        "#{} · thread {} \"{}\" · {} · {}{mark}",
        m["id"],
        m["thread"],
        m["title"].as_str().unwrap_or(""),
        sender(&m["sender"]),
        t(&m["at"])
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
    println!(
        "Running: {} / {} / effort {}",
        a["harness"].as_str().unwrap_or(""),
        a["model"].as_str().unwrap_or(""),
        a["effort"].as_str().unwrap_or("")
    );
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
        Cmd::Me => print_agent(&get(&format!("/agents/{}", me()))),
        Cmd::Limits => println!("{}", get("/limits")["text"].as_str().unwrap_or("")),
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
            let path = match group {
                Some(g) => format!(
                    "/agents?group={}",
                    g.replace('%', "%25")
                        .replace('&', "%26")
                        .replace(' ', "%20")
                ),
                None => "/agents".into(),
            };
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
        } => {
            let task = task.unwrap_or_else(|| text_or_stdin(vec![]));
            let mut b = json!({ "task": task, "harness": harness, "model": model, "effort": effort, "name": name, "group": group, "force": force, "done": done });
            match my_id() {
                Some(id) => b["agent"] = json!(id),
                None => b = user_body(b),
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
            for th in get("/threads").as_array().into_iter().flatten() {
                let members: Vec<String> = th["members"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|m| m.to_string())
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
            ThreadCmd::New { title, members } => {
                let members: Vec<String> = members
                    .map(|m| m.split(',').map(|s| s.trim().to_string()).collect())
                    .unwrap_or_default();
                let mut b = json!({ "title": title, "members": members });
                if let Some(id) = my_id() {
                    b["agent"] = json!(id);
                }
                let v = post("/threads", b);
                let m: Vec<String> = v["members"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|x| x.to_string())
                    .collect();
                println!("thread {} (members {})", v["id"], m.join(", "));
            }
            ThreadCmd::Read { id } => {
                let th = get(&format!("/threads/{id}"));
                let m: Vec<String> = th["members"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|x| x.to_string())
                    .collect();
                println!(
                    "Thread {} \"{}\" · members {}\n",
                    th["id"],
                    th["title"].as_str().unwrap_or(""),
                    m.join(", ")
                );
                for msg in th["messages"].as_array().into_iter().flatten() {
                    println!(
                        "#{} · {} · {}\n{}\n",
                        msg["id"],
                        sender(&msg["sender"]),
                        t(&msg["at"]),
                        msg["text"].as_str().unwrap_or("")
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
                    .map(|x| x.to_string())
                    .collect();
                println!("added {} to thread {id}", m.join(", "));
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
                    "agent {} wasn't woken: {}. It will be woken when there's room.",
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
        Cmd::Read { id } => print_message(&get(&format!("/messages/{id}"))),
        Cmd::Mark { ids: list, mark } => {
            post(
                "/marks",
                json!({ "agent": me(), "ids": ids(&list), "mark": mark }),
            );
            println!("marked {list} {mark}");
        }
        Cmd::Locks => {
            for l in get("/locks").as_array().into_iter().flatten() {
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
                post("/locks", json!({ "name": name, "about": about }));
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
                post("/locks/free", user_body(json!({ "name": name })));
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
    }
}
