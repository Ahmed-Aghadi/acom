mod app;
mod archive;
mod harness;
mod metrics;
mod paging;
mod run;
mod server;
mod storage;
mod usage;
mod workspace;

use app::{GUIDE, MODELS, hhmm, who};
use clap::{Args, Parser, Subcommand};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::process::exit;

const LICENSES: &str = concat!(
    include_str!("../LICENSE"),
    "\n",
    include_str!("../THIRD_PARTY_NOTICES.txt")
);
static PROJECT_CONTEXT: std::sync::OnceLock<String> = std::sync::OnceLock::new();

// CLI output may be piped to a reader that exits early. Server logging is separate.
macro_rules! print {
    ($($args:tt)*) => { write_stdout(format_args!($($args)*)) };
}

macro_rules! println {
    () => { write_stdout(format_args!("\n")) };
    ($($args:tt)*) => { write_stdout(format_args!("{}\n", format_args!($($args)*))) };
}

fn check_stdout(result: std::io::Result<()>, context: &str, exit_status: i32) {
    if let Err(error) = result {
        if error.kind() == std::io::ErrorKind::BrokenPipe {
            exit(exit_status);
        }
        die(&format!("{context}: {error}"));
    }
}

fn write_stdout(args: std::fmt::Arguments<'_>) {
    write_stdout_status(args, 0);
}

fn write_stdout_status(args: std::fmt::Arguments<'_>, exit_status: i32) {
    let mut stdout = std::io::stdout().lock();
    check_stdout(
        stdout.write_fmt(args).and_then(|_| stdout.flush()),
        "can't write stdout",
        exit_status,
    );
}

const HELP: &str = "\
acom: launch coding agents and let them talk and share locks.

One server runs every project: start it once with `acom serve`. A project is a folder;
agents run in their project's folder and only see that project's agents, threads and locks.
Numeric agent/thread/message IDs are project-local. Owner commands use the current folder's
project; launched agents receive a project-scoped ACOM_URL. Project/config IDs are strings.

Owner controls may require delegated permission when used by agents.

Offline command (no server or project needed):
  licenses                                Print the project and third-party license notices

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
  permissions [ID]                       Inspect delegated lifecycle permissions (default: yourself)
  control pause|resume|close|reopen --agents IDs|all|launched [--if-state STATES]
                                          Apply owner-granted controls without waking agents to ask them
  wait [--timeout duration | --ack ID] [--idle] [watch flags]
                                          Wait now, or register a one-shot wake and end your turn
  subscribe [watch flags]                 Persistently wake on matching events; end your turn normally
  subscriptions [--agent ID]             List your or a peer's subscriptions and deferred waits
  subscription <ID> / unsubscribe <ID>    Read one subscription / cancel your own (user may cancel any)
  agents [--search QUERY] [--group NAME] [--provider claude|codex] [--model ID] [--effort EFFORT]
         [--state STATE] [--pause-reason manual|limit|restart] [--event-cursor]
                                          Query: AND/OR/NOT, parentheses; spaces AND, field commas OR; quote literals
  agent <ID>                              One agent's details
  launch --task <text> [--harness h] [--model m] [--effort e] [--name n] [--group g] [--done|--replace] [--ack-crashes]
                                          Launch a helper agent; --done also marks you done,
                                          so you hand over without needing a second slot
                                          --replace queues a terminal cross-provider handoff
  threads [--search TEXT | --id TID] [--members IDs] [--member-match all|any]
          [--category all|mine|unread|agents] List matching project threads
  thread new --title <text> [--members <ID or selector,...> | --watch <states,group:name,...>] [--include-user] [--private|--no-join]
  thread read <TID>                       A bounded page of thread messages
  thread details <TID>                   Thread metadata, without message bodies
  thread add <TID> <ID or selector,...>   Add members
  thread remove <TID> <IDs,user>          Leave (your own ID); the user may remove others
  thread transfer-owner <TID> <AGENT_ID>  Transfer ownership; membership stays unchanged
  history [ID] [--agent ID | --all-agents] [--thread TID] [--lock name] [--kind kind]
          [--before ID | --after ID] [--limit N] [--max-bytes N]
                                          Bounded coordination events; ID reads one event
  send --thread <TID> [text]              Post in a thread (stdin if text is left out)
  inbox [--mark new|in-progress|handled]  Your messages with that mark (default new)
  notices [ID]                            Retained notices / one full notice
  receipt <ID> [--global]                 Full saved command result; never repeats the action
  activity [ID]                           Project activity / one full activity record
  log <ID> [--before BYTE | --after BYTE] [--through BYTE] [--version V] [--since R]
           [--lines N] [--max-bytes N]    Bounded captured-activity chunks (JSON); agents only their own
  messages (--search TEXT | --id ID) [--thread TID | --threads IDs]
           [--sender ID] [--from UNIX] [--to UNIX]
                                          Search complete accessible message history (snippets)
  read <msg ID> [--thread TID]            One bounded message record; optionally verify its thread
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
  configs / config <ID|default>          Config summaries / one config's details
  project add [path]                      Add a folder as a project (default: this folder)
  project remove <ID>                     Remove a project that has no agents
  project export <UUID> <destination> [--logs] [--native]
                                          Export a private project snapshot without overwrite
  project inspect-archive <source>        Inspect a project archive without importing it
  project import <source> --path <folder> [--accept-default-change]
                                          Restore an archived project into a folder, workers stopped
  launch ... [--force]                    Launch an agent in this folder's project (added if
                                          needed); --force confirms past a hard limit
  send --thread <TID> [text]              Post as user
  pause <ID>                              Stop the worker, then release its locks
  pause-all / resume-all
  resume-restart                          Resume restart-paused agents across all projects
  resume <ID,...>
  close <ID> / reopen <ID>
  lock free <name>                        Release a lock whoever holds it

Selectors: active, working, idle, paused, done, closed, crashed, replaced, group:<name>.
Durations: 30s, 5m, 1h.
Watch flags (wait and subscribe; agent and usage conditions combine with OR):
  --agents all|IDs [--states states] [--status-text] [--after EVENT_ID]
  --usage provider --window name (--above PERCENT | --below PERCENT | --reset-due)
  Peer watches report transitions, not current states. Member messages already notify/wake you;
  joining/leaving alone does not resolve waits or wake idle agents.
  Usage is polled; --reset-due reports only the estimated deadline, not confirmed recovery.
  Use window IDs from limits; Claude display aliases are accepted and normalized in receipts.
  --idle returns a wait ID immediately; finish the turn without `acom done`. It does not stop tools.

Lists (agents, inbox, messages, notices, locks, activity, subscriptions, thread read):
  [--before ID | --after ID] [--through ID] [--revision R] [--since R]
  [--limit N] [--max-bytes N]            Defaults: 50 items, 16000 JSON bytes.
  Continue with the printed cursor, through and revision; changed snapshots fail visibly.
Threads: [--sort latest_message|newest|oldest|title] [--cursor C] [--revision R | --since R]
  [--limit N] [--max-bytes N]            Continue with the printed opaque cursor and same sort.
Projects/configs: [--cursor C] [--revision R | --since R] [--limit N] [--max-bytes N]
Details (me, agent, read, notice ID, config, project read, lock read, receipt, limits, history ID, subscription):
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
    fn agents_accept_field_queries_and_exact_literal_flags() {
        let cli = Cli::try_parse_from([
            "acom",
            "agents",
            "--search",
            "state:crashed,paused needle",
            "--group",
            "Security review",
            "--provider",
            "codex",
            "--model",
            "custom:model",
            "--effort",
            "high",
            "--event-cursor",
        ])
        .unwrap();
        let Cmd::Agents {
            search,
            group,
            provider,
            model,
            effort,
            state,
            pause_reason,
            event_cursor,
            ..
        } = cli.cmd
        else {
            panic!("wrong command")
        };
        assert!(event_cursor);
        let query = app::AgentFilter {
            search: search.as_deref().unwrap(),
            group: group.as_deref(),
            provider: provider.as_deref(),
            model: model.as_deref(),
            effort: effort.as_deref(),
            state: state.as_deref(),
            pause_reason: pause_reason.as_deref(),
            ..app::AgentFilter::default()
        }
        .normalized()
        .unwrap();
        assert!(query.text().contains("group:\"Security review\""));
        assert!(Cli::try_parse_from(["acom", "agents", "--provider", "other"]).is_err());
        for (search, group) in [
            ("group:crew", Some("crew")),
            ("unknown_field:x", None),
            ("state:active", None),
        ] {
            assert!(
                app::AgentFilter {
                    search,
                    group,
                    ..app::AgentFilter::default()
                }
                .normalized()
                .is_err()
            );
        }
    }

    #[test]
    fn agents_accept_boolean_queries_and_reject_incomplete_operators() {
        for search in [
            "state:idle OR pause_reason:limit",
            "group:\"Security review\" (state:idle OR pause_reason:limit)",
            "state:paused NOT pause_reason:limit",
            "NOT (state:closed OR state:replaced)",
        ] {
            let cli = Cli::try_parse_from(["acom", "agents", "--search", search]).unwrap();
            let Cmd::Agents { search, .. } = cli.cmd else {
                panic!("wrong command")
            };
            app::AgentFilter {
                search: search.as_deref().unwrap(),
                ..app::AgentFilter::default()
            }
            .normalized()
            .unwrap();
        }
        for search in ["OR state:idle", "state:idle OR", "NOT", "()"] {
            assert!(
                app::AgentFilter {
                    search,
                    ..app::AgentFilter::default()
                }
                .normalized()
                .is_err(),
                "{search}"
            );
        }
    }

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
    fn wait_watch_flags_require_a_watch_and_cannot_mix_with_ack() {
        assert!(
            Cli::try_parse_from([
                "acom",
                "wait",
                "--agents",
                "all",
                "--states",
                "crashed,done",
                "--status-text",
                "--after",
                "0"
            ])
            .is_ok()
        );
        assert!(Cli::try_parse_from(["acom", "agents", "--event-cursor"]).is_ok());
        for args in [
            vec!["acom", "wait", "--states", "crashed"],
            vec!["acom", "wait", "--status-text"],
            vec!["acom", "wait", "--after", "0"],
            vec!["acom", "wait", "--agents", "all", "--after", "-1"],
            vec!["acom", "wait", "--ack", "1", "--agents", "all"],
        ] {
            assert!(Cli::try_parse_from(args).is_err());
        }
    }

    #[test]
    fn subscriptions_share_typed_watch_flags_and_ack_is_exclusive() {
        for command in ["wait", "subscribe"] {
            for condition in [
                vec!["--above", "80"],
                vec!["--below", "30.5"],
                vec!["--reset-due"],
            ] {
                let mut args = vec![
                    "acom",
                    command,
                    "--usage",
                    "claude",
                    "--window",
                    "five_hour",
                ];
                args.extend(condition);
                assert!(Cli::try_parse_from(args).is_ok());
            }
            for suffix in [
                vec!["--usage", "claude"],
                vec!["--usage", "claude", "--window", "five_hour"],
                vec!["--window", "five_hour"],
                vec!["--usage", "claude", "--window", "five_hour", "--reset"],
                vec!["--above", "80"],
                vec![
                    "--usage",
                    "claude",
                    "--window",
                    "five_hour",
                    "--above",
                    "80",
                    "--reset",
                ],
                vec![
                    "--usage",
                    "claude",
                    "--window",
                    "five_hour",
                    "--above",
                    "NaN",
                ],
                vec![
                    "--usage",
                    "claude",
                    "--window",
                    "five_hour",
                    "--below",
                    "101",
                ],
            ] {
                let mut args = vec!["acom", command];
                args.extend(suffix);
                assert!(Cli::try_parse_from(args).is_err());
            }
        }
        assert!(Cli::try_parse_from(["acom", "wait", "--idle"]).is_ok());
        assert!(Cli::try_parse_from(["acom", "wait", "--idle", "--timeout", "5m"]).is_ok());
        assert!(Cli::try_parse_from(["acom", "wait", "--ack", "1", "--idle"]).is_err());
        assert!(
            Cli::try_parse_from([
                "acom",
                "wait",
                "--ack",
                "1",
                "--usage",
                "claude",
                "--window",
                "five_hour",
                "--reset-due"
            ])
            .is_err()
        );
        assert!(Cli::try_parse_from(["acom", "subscribe", "--timeout", "5m"]).is_err());
        for command in ["subscription", "unsubscribe"] {
            assert!(Cli::try_parse_from(["acom", command, "1"]).is_ok());
            assert!(Cli::try_parse_from(["acom", command, "0"]).is_err());
        }
    }

    #[test]
    fn watch_body_preserves_combined_filters_and_usage_boundaries() {
        let Cli {
            cmd: Cmd::Subscribe { watch },
        } = Cli::try_parse_from([
            "acom",
            "subscribe",
            "--agents",
            "2, 3",
            "--states",
            "crashed, done",
            "--status-text",
            "--after",
            "7",
            "--usage",
            "codex",
            "--window",
            "primary",
            "--above",
            "80.5",
        ])
        .unwrap()
        else {
            panic!("expected subscribe")
        };
        assert_eq!(
            watch.body().unwrap(),
            json!({
                "agents":[2,3],"states":["crashed","done"],"status_text":true,"after":7,
                "usage":{"provider":"codex","window":"primary","condition":"above","percent":80.5}
            })
        );
        for ids in ["", "1,", "0", "all,2", "1.5"] {
            let Cli {
                cmd: Cmd::Subscribe { watch },
            } = Cli::try_parse_from(["acom", "subscribe", "--agents", ids]).unwrap()
            else {
                panic!("expected subscribe")
            };
            assert!(watch.body().is_err());
        }
        assert!(percentage("0").is_ok());
        assert!(percentage("100").is_ok());
        for value in ["-1", "101", "inf", "-inf", "NaN", "word"] {
            assert!(percentage(value).is_err());
        }
    }

    #[test]
    fn subscription_registration_requires_a_real_id_and_deferred_deadline() {
        assert!(
            subscription_registration_output(&json!({"id":7,"deadline":null}), false)
                .unwrap()
                .contains("without `acom done`")
        );
        assert!(
            subscription_registration_output(&json!({"id":7,"deadline":123}), true)
                .unwrap()
                .contains("Deferred wait #7")
        );
        for value in [
            json!({}),
            json!({"id":0,"deadline":123}),
            json!({"id":7}),
            json!({"id":7,"deadline":"123"}),
            json!({"id":7,"deadline":null}),
        ] {
            assert!(subscription_registration_output(&value, true).is_err());
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
    fn restricted_threads_have_explicit_flags_and_no_live_audience() {
        for flag in ["--private", "--no-join"] {
            assert!(
                Cli::try_parse_from(["acom", "thread", "new", "--title", "team", flag]).is_ok()
            );
            assert!(
                Cli::try_parse_from([
                    "acom", "thread", "new", "--title", "team", flag, "--watch", "active"
                ])
                .is_err()
            );
        }
        assert!(
            Cli::try_parse_from([
                "acom",
                "thread",
                "new",
                "--title",
                "team",
                "--private",
                "--no-join"
            ])
            .is_err()
        );
    }

    #[test]
    fn ownership_transfer_targets_a_positive_agent_id() {
        assert!(Cli::try_parse_from(["acom", "thread", "transfer-owner", "4", "2"]).is_ok());
        for owner in ["0", "-1", "user", "2.0"] {
            assert!(Cli::try_parse_from(["acom", "thread", "transfer-owner", "4", owner]).is_err());
        }
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
        assert_eq!(message_context(&json!({"outside_membership":false})), "");
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
            "agents",
            "inbox",
            "messages",
            "notices",
            "locks",
            "activity",
            "subscriptions",
        ] {
            let mut args = vec!["acom", command];
            if command == "messages" {
                args.extend(["--search", "needle"]);
            }
            args.extend([
                "--after",
                "0",
                "--through",
                "130",
                "--revision",
                "snapshot",
                "--limit",
                "3",
                "--max-bytes",
                "2048",
            ]);
            assert!(Cli::try_parse_from(args).is_ok());
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
            vec![
                "acom",
                "project",
                "read",
                "11111111-1111-4111-8111-111111111111",
                "--offset",
                "0",
            ],
            vec!["acom", "lock", "read", "1", "--offset", "0"],
            vec!["acom", "subscription", "1", "--offset", "0"],
            vec!["acom", "log", "1", "--after", "0", "--lines", "200"],
        ] {
            assert!(Cli::try_parse_from(args).is_ok());
        }
    }

    #[test]
    fn thread_lists_use_sorted_opaque_cursors_not_numeric_id_ranges() {
        let Cli {
            cmd: Cmd::Threads { page, .. },
        } = Cli::try_parse_from(["acom", "threads"]).unwrap()
        else {
            panic!("wrong command")
        };
        assert_eq!(page.sort, "latest_message");
        for sort in ["latest_message", "newest", "oldest", "title"] {
            let Cli {
                cmd: Cmd::Threads { page, .. },
            } = Cli::try_parse_from([
                "acom",
                "threads",
                "--sort",
                sort,
                "--cursor",
                "0123456789abcdef.2",
                "--limit",
                "1",
                "--max-bytes",
                "512",
            ])
            .unwrap()
            else {
                panic!("wrong command")
            };
            assert!(page.query().contains(&format!("sort={sort}")));
            assert!(page.query().contains("cursor=0123456789abcdef.2"));
        }
        for suffix in [
            vec!["--sort", "latest"],
            vec!["--cursor", ""],
            vec!["--before", "2"],
            vec!["--after", "0"],
            vec!["--through", "2"],
            vec!["--cursor", "0123456789abcdef.2", "--since", "r"],
            vec!["--revision", "r", "--since", "r"],
            vec!["--limit", "0"],
            vec!["--max-bytes", "511"],
        ] {
            let mut args = vec!["acom", "threads"];
            args.extend(suffix);
            assert!(Cli::try_parse_from(args).is_err());
        }
    }

    #[test]
    fn thread_search_flags_validate_and_survive_continuation_commands() {
        let Cli {
            cmd: Cmd::Threads { search, .. },
        } = Cli::try_parse_from([
            "acom",
            "threads",
            "--search",
            "A & B",
            "--members",
            "0,2,2",
            "--member-match",
            "any",
            "--category",
            "mine",
        ])
        .unwrap()
        else {
            panic!("wrong command")
        };
        let (query, command) = search_options(search.options(), "acom threads --sort title");
        assert!(query.contains("search=A%20%26%20B"));
        assert!(query.contains("members=0%2C2%2C2"));
        assert!(query.contains("member_match=any"));
        assert!(command.contains("--member-match 'any'"));
        assert!(command.contains("--category 'mine'"));
        assert!(Cli::try_parse_from(["acom", "threads", "--id", "42"]).is_ok());
        for suffix in [
            vec!["--search", ""],
            vec!["--id", "0"],
            vec!["--search", "x", "--id", "1"],
            vec!["--members", ""],
            vec!["--members", "1,"],
            vec!["--members", "-1"],
            vec!["--members", "user"],
            vec!["--member-match", "all"],
            vec!["--members", "1", "--member-match", "both"],
            vec!["--category", "closed"],
        ] {
            let mut args = vec!["acom", "threads"];
            args.extend(suffix);
            assert!(Cli::try_parse_from(args).is_err());
        }
        assert!(search_text(&"é".repeat(2049)).is_err());
        assert!(search_text("   ").is_ok());
        assert!(member_search_ids(&vec!["1"; 65].join(",")).is_err());
    }

    #[test]
    fn message_search_is_explicit_bounded_and_preserves_literal_filters() {
        let Cli {
            cmd: Cmd::Messages { search, page },
        } = Cli::try_parse_from([
            "acom",
            "messages",
            "--search",
            "a'b & 83%",
            "--threads",
            "1,2",
            "--sender",
            "0",
            "--from",
            "0",
            "--to",
            "200",
            "--after",
            "0",
            "--limit",
            "2",
        ])
        .unwrap()
        else {
            panic!("wrong command")
        };
        assert!(search.validate().is_ok());
        let (query, command) = search_options(search.options(), "acom messages");
        assert!(query.contains("text=a%27b%20%26%2083%25"));
        assert!(query.contains("sender=0"));
        assert!(command.contains("--search 'a'\\''b & 83%'"));
        assert!(command.contains("--threads '1,2'"));
        assert!(page.query().contains("after=0"));
        assert!(Cli::try_parse_from(["acom", "messages", "--id", "83", "--thread", "2"]).is_ok());
        assert!(Cli::try_parse_from(["acom", "read", "83", "--thread", "2"]).is_ok());
        for suffix in [
            vec![],
            vec!["--id", "0"],
            vec!["--search", "x", "--id", "1"],
            vec!["--id", "1", "--thread", "0"],
            vec!["--id", "1", "--threads", "0,1"],
            vec!["--id", "1", "--threads", "1", "--thread", "1"],
            vec!["--search", "x", "--sender", "-1"],
            vec!["--search", "x", "--from", "-1"],
            vec!["--search", "x", "--to", "tomorrow"],
            vec!["--id", "1", "--limit", "201"],
        ] {
            let mut args = vec!["acom", "messages"];
            args.extend(suffix);
            assert!(Cli::try_parse_from(args).is_err());
        }
        let Cli {
            cmd: Cmd::Messages { search, .. },
        } = Cli::try_parse_from([
            "acom", "messages", "--search", "x", "--from", "2", "--to", "1",
        ])
        .unwrap()
        else {
            panic!("wrong command")
        };
        assert!(search.validate().is_err());
    }

    #[test]
    fn project_and_configuration_lists_use_string_ids_and_opaque_cursors() {
        for command in ["projects", "configs"] {
            assert!(
                Cli::try_parse_from([
                    "acom",
                    command,
                    "--cursor",
                    "opaque",
                    "--revision",
                    "r",
                    "--limit",
                    "1",
                    "--max-bytes",
                    "512"
                ])
                .is_ok()
            );
            for suffix in [
                vec!["--before", "2"],
                vec!["--after", "0"],
                vec!["--through", "2"],
                vec!["--limit", "0"],
                vec!["--cursor", ""],
                vec!["--since", "r", "--cursor", "opaque"],
            ] {
                let mut args = vec!["acom", command];
                args.extend(suffix);
                assert!(Cli::try_parse_from(args).is_err());
            }
        }
        let project = "11111111-1111-4111-8111-111111111111";
        for command in ["read", "remove"] {
            assert!(Cli::try_parse_from(["acom", "project", command, project]).is_ok());
            for invalid in ["1", "../sample", "11111111-1111-4111-8111-11111111111Z"] {
                assert!(Cli::try_parse_from(["acom", "project", command, invalid]).is_err());
            }
        }
        for id in ["default", "0123456789abcdef0123456789abcdef"] {
            assert!(Cli::try_parse_from(["acom", "config", id]).is_ok());
        }
        for id in [
            "1",
            "Default",
            "../sample",
            "0123456789ABCDEF0123456789ABCDEF",
        ] {
            assert!(Cli::try_parse_from(["acom", "config", id]).is_err());
        }
    }

    #[test]
    fn project_url_context_and_global_routes_do_not_depend_on_numeric_agent_ids() {
        let project = "11111111-1111-4111-8111-111111111111";
        let base = format!("http://127.0.0.1:7400/p/{project}");
        assert_eq!(
            project_url_parts(&base).unwrap(),
            ("http://127.0.0.1:7400", Some(project))
        );
        assert_eq!(
            project_url_parts("http://127.0.0.1:7400").unwrap(),
            ("http://127.0.0.1:7400", None)
        );
        assert!(project_url_parts("http://127.0.0.1:7400/p/1").is_err());
        for path in [
            "/projects?path=sample",
            "/projects/id",
            "/configs/default",
            "/global-settings",
            "/catalog",
            "/overview",
            "/usage/check",
            "/pause-all",
            "/resume-all",
            "/resume-restart",
            "/agent-query?search=x",
        ] {
            assert!(global_route(path), "{path}");
        }
        for path in [
            "/agents",
            "/agents/1",
            "/threads/1",
            "/messages/1",
            "/history",
            "/locks",
            "/subscriptions",
            "/receipts/1",
            "/limits",
            "/settings",
            "/activity/1",
        ] {
            assert!(!global_route(path), "{path}");
        }
    }
    #[test]
    fn id_lists_reject_empty_or_invalid_entries_before_any_action() {
        assert_eq!(ids("1, 2").unwrap(), vec![1, 2]);
        for input in ["", ",", "1,", ",1", "1,,2", "0", "1,0", "-1", "not-an-id"] {
            assert!(ids(input).is_err(), "invalid ID list {input:?}");
        }
    }

    #[test]
    fn record_version_is_not_silently_ignored_without_an_offset() {
        for command in [
            "agent",
            "read",
            "config",
            "history",
            "activity",
            "notices",
            "subscription",
        ] {
            assert!(Cli::try_parse_from(["acom", command, "1", "--version", "v"]).is_err());
        }
        assert!(Cli::try_parse_from(["acom", "thread", "read", "1", "--version", "v"]).is_err());
        assert!(Cli::try_parse_from(["acom", "log", "1", "--version", "v"]).is_ok());
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
struct ThreadPageArgs {
    #[arg(long, default_value = "latest_message", value_parser = ["latest_message", "newest", "oldest", "title"])]
    sort: String,
    #[command(flatten)]
    page: CursorPageArgs,
}

impl ThreadPageArgs {
    fn query(&self) -> String {
        format!("sort={}&{}", encode(&self.sort), self.page.query())
    }
}

fn search_text(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 4096 {
        return Err("search text must be nonempty and at most 4096 UTF-8 bytes".into());
    }
    Ok(value.to_owned())
}

fn search_ids(value: &str, minimum: i64) -> Result<String, String> {
    let ids: Vec<_> = value.split(',').collect();
    if ids.len() > 64
        || ids.iter().any(|id| {
            id.is_empty()
                || !id.bytes().all(|byte| byte.is_ascii_digit())
                || !id.parse::<i64>().is_ok_and(|id| id >= minimum)
        })
    {
        return Err(format!(
            "expected 1–64 comma-separated integer IDs, each at least {minimum}"
        ));
    }
    Ok(value.to_owned())
}

fn member_search_ids(value: &str) -> Result<String, String> {
    search_ids(value, 0)
}

fn thread_search_ids(value: &str) -> Result<String, String> {
    search_ids(value, 1)
}

fn search_options(options: Vec<(&str, String)>, command: &str) -> (String, String) {
    let mut query = String::new();
    let mut command = command.to_owned();
    for (key, value) in options {
        query += &format!("&{key}={}", encode(&value));
        command += &format!(
            " --{} {}",
            if key == "text" {
                "search".into()
            } else {
                key.replace('_', "-")
            },
            shell_word(&value)
        );
    }
    (query, command)
}

#[derive(Args)]
struct ThreadSearchArgs {
    #[arg(long, conflicts_with = "id", value_parser = search_text)]
    search: Option<String>,
    #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
    id: Option<i64>,
    #[arg(long, value_parser = member_search_ids)]
    members: Option<String>,
    #[arg(long, requires = "members", value_parser = ["all", "any"])]
    member_match: Option<String>,
    #[arg(long, value_parser = ["all", "mine", "unread", "agents"])]
    category: Option<String>,
}

impl ThreadSearchArgs {
    fn options(&self) -> Vec<(&str, String)> {
        let mut options = Vec::new();
        for (key, value) in [
            ("search", &self.search),
            ("members", &self.members),
            ("member_match", &self.member_match),
            ("category", &self.category),
        ] {
            if let Some(value) = value {
                options.push((key, value.clone()));
            }
        }
        if let Some(id) = self.id {
            options.push(("id", id.to_string()));
        }
        options
    }
}

#[derive(Args)]
struct MessageSearchArgs {
    #[arg(long, required_unless_present = "id", conflicts_with = "id", value_parser = search_text)]
    search: Option<String>,
    #[arg(long, required_unless_present = "search", value_parser = clap::value_parser!(i64).range(1..))]
    id: Option<i64>,
    #[arg(long, conflicts_with = "threads", value_parser = clap::value_parser!(i64).range(1..))]
    thread: Option<i64>,
    #[arg(long, value_parser = thread_search_ids)]
    threads: Option<String>,
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    sender: Option<i64>,
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    from: Option<i64>,
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    to: Option<i64>,
}

impl MessageSearchArgs {
    fn validate(&self) -> Result<(), &'static str> {
        if self.from.zip(self.to).is_some_and(|(from, to)| from > to) {
            return Err("--from must not be later than --to (inclusive Unix seconds)");
        }
        Ok(())
    }

    fn options(&self) -> Vec<(&str, String)> {
        let mut options = Vec::new();
        if let Some(text) = &self.search {
            options.push(("text", text.clone()));
        }
        if let Some(threads) = &self.threads {
            options.push(("threads", threads.clone()));
        }
        for (key, value) in [
            ("id", self.id),
            ("thread", self.thread),
            ("sender", self.sender),
            ("from", self.from),
            ("to", self.to),
        ] {
            if let Some(value) = value {
                options.push((key, value.to_string()));
            }
        }
        options
    }
}

#[derive(Args)]
struct CursorPageArgs {
    #[arg(long, conflicts_with = "since", value_parser = clap::builder::NonEmptyStringValueParser::new())]
    cursor: Option<String>,
    #[arg(long, conflicts_with = "since")]
    revision: Option<String>,
    #[arg(long)]
    since: Option<String>,
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(i64).range(1..=200))]
    limit: i64,
    #[arg(long, default_value_t = 16000, value_parser = clap::value_parser!(i64).range(512..=65536))]
    max_bytes: i64,
}

impl CursorPageArgs {
    fn query(&self) -> String {
        let mut query = format!("limit={}&max_bytes={}", self.limit, self.max_bytes);
        for (name, value) in [
            ("cursor", &self.cursor),
            ("revision", &self.revision),
            ("since", &self.since),
        ] {
            if let Some(value) = value {
                query += &format!("&{name}={}", encode(value));
            }
        }
        query
    }
}

#[derive(Args)]
struct RecordArgs {
    #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
    offset: Option<i64>,
    #[arg(long, requires = "offset")]
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

#[derive(Args)]
struct WatchArgs {
    #[arg(long, help = "Watch project peers: all or comma-separated IDs")]
    agents: Option<String>,
    #[arg(
        long,
        requires = "agents",
        help = "Match transitions into these comma-separated lifecycle states"
    )]
    states: Option<String>,
    #[arg(
        long,
        requires = "agents",
        help = "Also match peer status-text changes"
    )]
    status_text: bool,
    #[arg(long, requires = "agents", value_parser = clap::value_parser!(i64).range(0..), help = "Start the peer watch after this coordination event ID")]
    after: Option<i64>,
    #[arg(long, requires_all = ["window", "usage_condition"], help = "Watch this provider's subscription usage")]
    usage: Option<String>,
    #[arg(long, requires = "usage", help = "Usage window name from acom limits")]
    window: Option<String>,
    #[arg(long, requires = "usage", group = "usage_condition", value_parser = percentage, help = "Match usage crossing strictly above this percentage")]
    above: Option<f64>,
    #[arg(long, requires = "usage", group = "usage_condition", value_parser = percentage, help = "Match usage crossing strictly below this percentage")]
    below: Option<f64>,
    #[arg(
        long,
        requires = "usage",
        group = "usage_condition",
        help = "Match the estimated reset deadline, not confirmed recovery"
    )]
    reset_due: bool,
}

impl WatchArgs {
    fn body(self) -> Result<Value, &'static str> {
        let mut body = json!({});
        if let Some(agents) = self.agents {
            body["agents"] =
                if agents == "all" {
                    json!("all")
                } else {
                    let ids =
                        agents
                            .split(',')
                            .map(|value| {
                                value.trim().parse::<i64>().ok().filter(|id| *id > 0).ok_or(
                                    "watched agents must be all or comma-separated positive IDs",
                                )
                            })
                            .collect::<Result<Vec<_>, _>>()?;
                    json!(ids)
                };
            if let Some(states) = self.states {
                body["states"] = json!(states.split(',').map(str::trim).collect::<Vec<_>>());
            }
            body["status_text"] = json!(self.status_text);
            if let Some(after) = self.after {
                body["after"] = json!(after);
            }
        }
        if let Some(provider) = self.usage {
            let (condition, percent) = if let Some(value) = self.above {
                ("above", Some(value))
            } else if let Some(value) = self.below {
                ("below", Some(value))
            } else if self.reset_due {
                ("reset-due", None)
            } else {
                return Err("usage watch requires --above, --below, or --reset-due");
            };
            let window = self.window.ok_or("usage watch requires --window")?;
            let mut usage = json!({"provider":provider,"window":window,"condition":condition});
            if let Some(percent) = percent {
                usage["percent"] = json!(percent);
            }
            body["usage"] = usage;
        }
        Ok(body)
    }
}

fn percentage(value: &str) -> Result<f64, String> {
    value
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && (0.0..=100.0).contains(n))
        .ok_or_else(|| "percentage must be a finite number between 0 and 100".into())
}

#[derive(Subcommand)]
enum Cmd {
    /// Print the project and third-party license notices without contacting a server.
    Licenses,
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
    /// Apply only the lifecycle controls granted to this agent by the owner.
    Control {
        #[arg(value_parser = ["pause", "resume", "close", "reopen"])]
        action: String,
        #[arg(long, value_parser = control_targets)]
        agents: String,
        #[arg(long = "if-state", value_delimiter = ',', value_parser = app::STATES)]
        if_states: Option<Vec<String>>,
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(i64).range(1..=200))]
        limit: i64,
        #[arg(long, requires = "through", value_parser = clap::value_parser!(i64).range(0..))]
        after: Option<i64>,
        #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
        through: Option<i64>,
    },
    /// Inspect the owner-assigned lifecycle grants for an agent.
    Permissions {
        #[arg(value_parser = clap::value_parser!(i64).range(1..))]
        id: Option<i64>,
        #[command(flatten)]
        record: RecordArgs,
    },
    Wait {
        #[arg(long, default_value = "60s")]
        timeout: String,
        #[arg(long, conflicts_with_all = ["timeout", "idle", "agents", "states", "status_text", "after", "usage", "window", "above", "below", "reset_due"], value_parser = clap::value_parser!(i64).range(1..))]
        ack: Option<i64>,
        #[arg(
            long,
            help = "Register a one-shot wake immediately; then end your turn without acom done"
        )]
        idle: bool,
        #[command(flatten)]
        watch: WatchArgs,
    },
    Subscribe {
        #[command(flatten)]
        watch: WatchArgs,
    },
    Subscriptions {
        #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
        agent: Option<i64>,
        #[command(flatten)]
        page: PageArgs,
    },
    Subscription {
        #[arg(value_parser = clap::value_parser!(i64).range(1..))]
        id: i64,
        #[command(flatten)]
        record: RecordArgs,
    },
    Unsubscribe {
        #[arg(value_parser = clap::value_parser!(i64).range(1..))]
        id: i64,
    },
    Agents {
        #[arg(
            long,
            help = "Field-aware query: NOT > AND > OR; parentheses group, spaces mean AND, field commas give alternatives; double quotes protect literals"
        )]
        search: Option<String>,
        #[arg(long)]
        group: Option<String>,
        #[arg(long, value_parser = ["claude", "codex"])]
        provider: Option<String>,
        #[arg(long, help = "Exact model ID (including custom IDs)")]
        model: Option<String>,
        #[arg(long, help = "Exact effort value")]
        effort: Option<String>,
        #[arg(long, value_parser = app::STATES)]
        state: Option<String>,
        #[arg(long, value_parser = ["manual", "limit", "restart"], help = "Filter paused agents (manual includes individual and bulk pauses)")]
        pause_reason: Option<String>,
        #[arg(long)]
        event_cursor: bool,
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
        search: ThreadSearchArgs,
        #[command(flatten)]
        page: ThreadPageArgs,
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
    Messages {
        #[command(flatten)]
        search: MessageSearchArgs,
        #[command(flatten)]
        page: PageArgs,
    },
    Read {
        #[arg(value_parser = clap::value_parser!(i64).range(1..))]
        id: i64,
        #[arg(long, value_parser = clap::value_parser!(i64).range(1..))]
        thread: Option<i64>,
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
        #[arg(long, requires_all = ["id", "offset"])]
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
        #[arg(long, requires_all = ["id", "offset"])]
        version: Option<String>,
    },
    Configs {
        #[command(flatten)]
        page: CursorPageArgs,
    },
    Config {
        #[arg(value_parser = config_key)]
        id: String,
        #[command(flatten)]
        record: RecordArgs,
    },
    Receipt {
        id: i64,
        #[arg(long)]
        global: bool,
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
        #[arg(long, requires_all = ["id", "offset"])]
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
        #[arg(long, default_value_t = 7400, value_parser = clap::value_parser!(u16).range(1..))]
        port: u16,
    },
    Pause {
        id: i64,
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
        page: CursorPageArgs,
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
    /// Save an uncompressed project archive. Existing files are never overwritten.
    Export {
        #[arg(value_parser = project_uuid)]
        id: String,
        destination: String,
        #[arg(long)]
        logs: bool,
        #[arg(long)]
        native: bool,
    },
    InspectArchive {
        source: String,
    },
    /// Restore into an existing folder without starting any workers.
    Import {
        source: String,
        #[arg(long)]
        path: String,
        #[arg(long)]
        accept_default_change: bool,
    },
    Add {
        path: Option<String>,
    },
    Remove {
        #[arg(value_parser = project_uuid)]
        id: String,
    },
    Read {
        #[arg(value_parser = project_uuid)]
        id: String,
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
        #[arg(long, conflicts_with_all = ["watch", "no_join"])]
        private: bool,
        #[arg(long, conflicts_with = "watch")]
        no_join: bool,
    },
    Read {
        id: i64,
        #[command(flatten)]
        page: PageArgs,
        #[arg(long, value_parser = clap::value_parser!(i64).range(0..))]
        offset: Option<i64>,
        #[arg(long, requires = "offset")]
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
    TransferOwner {
        id: i64,
        #[arg(value_name = "AGENT_ID", value_parser = clap::value_parser!(i64).range(1..))]
        owner: i64,
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

fn project_uuid(value: &str) -> Result<String, String> {
    workspace::validate_uuid(value).map_err(|error| error.1)?;
    Ok(value.into())
}

fn config_key(value: &str) -> Result<String, String> {
    if value == "default"
        || (value.len() == 32
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    {
        Ok(value.into())
    } else {
        Err("configuration must be default or a saved configuration's 32-character ID".into())
    }
}

fn project_url_parts(base: &str) -> Result<(&str, Option<&str>), String> {
    match base.rsplit_once("/p/") {
        Some((root, project)) => {
            workspace::validate_uuid(project).map_err(|error| error.1)?;
            Ok((root, Some(project)))
        }
        None => Ok((base, None)),
    }
}

fn global_route(path: &str) -> bool {
    let route = path.split('?').next().unwrap_or(path);
    matches!(
        route.split('/').nth(1).unwrap_or(""),
        "projects"
            | "configs"
            | "global-settings"
            | "catalog"
            | "models"
            | "folders"
            | "overview"
            | "usage"
            | "pause-all"
            | "resume-all"
            | "resume-restart"
            | "agent-query"
    )
}

fn root_base() -> String {
    let base = base_url();
    project_url_parts(&base)
        .unwrap_or_else(|error| die(&error))
        .0
        .to_string()
}

fn request_base(path: &str) -> String {
    let base = base_url();
    let (root, project) = project_url_parts(&base).unwrap_or_else(|error| die(&error));
    if global_route(path) {
        return root.to_string();
    }
    if project.is_some() {
        return base;
    }
    if my_id().is_some() {
        die("agent commands require the project-scoped ACOM_URL supplied at launch");
    }
    match project_here() {
        Some(project) => format!("{root}/p/{project}"),
        None if path.split('?').next() == Some("/limits") => root.to_string(),
        None => die(
            "this folder isn't in an acom project. Run the command inside one, or add it with `acom project add`.",
        ),
    }
}

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
    std::env::var_os("ACOM_ID").map(|value| {
        value
            .to_str()
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|id| *id > 0)
            .unwrap_or_else(|| die("ACOM_ID must be a positive integer when set"))
    })
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
            let scope = if value["receipt_path"]
                .as_str()
                .is_some_and(|path| path.starts_with("/global-receipts/"))
            {
                " --global"
            } else {
                ""
            };
            eprintln!(
                "Action completed; response contains samples only. Full result: acom receipt {id}{scope}"
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
    request_at(&request_base(path), method, path, body, timeout)
}

fn request_at(
    base: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    timeout: Option<std::time::Duration>,
) -> Result<Value, (u16, String)> {
    let url = format!("{base}{path}");
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
    let mut res = res.map_err(|e| (0, format!("can't reach the acom server at {base}: {e}")))?;
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
fn project_here() -> Option<String> {
    let base = base_url();
    if let Some(project) = project_url_parts(&base)
        .unwrap_or_else(|error| die(&error))
        .1
    {
        return Some(project.into());
    }
    if let Some(project) = PROJECT_CONTEXT.get() {
        return Some(project.clone());
    }
    match request_at(
        &root_base(),
        "GET",
        &format!("/projects?path={}", encode(&cwd())),
        None,
        None,
    ) {
        Ok(project) => {
            if project["truncated"] == true {
                die(
                    "project lookup exceeds the response budget; read its details with `acom project read <ID>`",
                );
            }
            let id = project["id"]
                .as_str()
                .and_then(|id| project_uuid(id).ok())
                .unwrap_or_else(|| die("invalid project lookup response: missing project UUID"));
            let _ = PROJECT_CONTEXT.set(id.clone());
            Some(id)
        }
        Err((404, _)) => None,
        Err((_, message)) => die(&message),
    }
}

fn viewer_query(key: &str) -> String {
    my_id().map(|id| format!("&{key}={id}")).unwrap_or_default()
}

fn thread_access(thread: &Value) -> &'static str {
    if thread["private"] == true {
        "private"
    } else if thread["joinable"] == false {
        "public · no self-join"
    } else {
        "public · open"
    }
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
        let base = base_url();
        if let Some(project) = project_url_parts(&base)
            .unwrap_or_else(|error| die(&error))
            .1
        {
            b["via_project"] = json!(project);
        }
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

fn subscription_registration_output(v: &Value, deferred: bool) -> Result<String, &'static str> {
    let id = v["id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or("invalid subscription response; inspect `acom subscriptions` before retrying")?;
    let deadline = v
        .get("deadline")
        .filter(|value| value.is_null() || value.as_i64().is_some_and(|n| n > 0))
        .ok_or("invalid subscription deadline; inspect `acom subscriptions` before retrying")?;
    if deferred && deadline.is_null() {
        return Err(
            "deferred wait response has no deadline; inspect `acom subscriptions` before retrying",
        );
    }
    let label = if deferred {
        "Deferred wait"
    } else {
        "Subscription"
    };
    Ok(format!(
        "{v}\n{label} #{id} registered. End this turn without `acom done` to become idle; matching updates will wake you. Current tools are unchanged.\n"
    ))
}

fn print_subscription_registration(v: &Value, deferred: bool) {
    print!(
        "{}",
        subscription_registration_output(v, deferred).unwrap_or_else(|error| die(error))
    );
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

fn ids(s: &str) -> Result<Vec<i64>, String> {
    s.split(',')
        .map(str::trim)
        .map(|x| {
            x.parse::<i64>().ok().filter(|id| *id > 0).ok_or_else(|| {
                format!("{x:?} isn't a positive ID; use a comma-separated list of IDs")
            })
        })
        .collect()
}

fn control_targets(value: &str) -> Result<String, String> {
    if !matches!(value, "all" | "launched") {
        let values = ids(value)?;
        if values.len() > 200 {
            return Err("at most 200 selected agent IDs are allowed".into());
        }
    }
    Ok(value.into())
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
        .unwrap_or_else(|| {
            v[key].as_array().map_or(0, Vec::len)
                + v["results"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|result| result_count(result, key))
                    .sum::<usize>()
        })
}

fn print_bulk_messages(value: &Value, project: Option<&str>) {
    let project = value["project"].as_str().or(project);
    for key in ["warnings", "errors"] {
        for message in value[key].as_array().into_iter().flatten() {
            let scope = message["project"]
                .as_str()
                .or(project)
                .map(|p| format!("project {p}: "))
                .unwrap_or_default();
            let text = message
                .as_str()
                .or_else(|| message["error"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| message.to_string());
            eprintln!(
                "{}: {scope}{text}",
                if key == "errors" { "error" } else { "warning" }
            );
        }
    }
    for result in value["results"].as_array().into_iter().flatten() {
        print_bulk_messages(result, project);
    }
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

fn cursor_page_hint(v: &Value, args: &CursorPageArgs, command: &str) {
    if v["unchanged"] == true {
        println!("unchanged");
    }
    if v["has_more"] != true {
        return;
    }
    let cursor = v["next_cursor"]
        .as_str()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| die("invalid page response: missing continuation cursor"));
    println!(
        "More available: {command} --cursor {} --limit {} --max-bytes {}",
        shell_word(cursor),
        args.limit,
        args.max_bytes
    );
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
    if m["outside_membership"].as_bool() == Some(true) {
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
    let count = |key: &str| {
        a[key]
            .as_u64()
            .map(|n| n.to_string())
            .unwrap_or_else(|| "not reported".into())
    };
    let reporting = match a["token_usage_state"].as_str() {
        Some("provisional") => "in progress (provisional)",
        Some("final") => "finalised",
        Some("partial") => "partial (incomplete)",
        _ => "not reported",
    };
    println!(
        "Context: {} tokens. Tokens so far ({reporting}): total {}, fresh input {}, cache writes {}, cache reads {}, output {}",
        a["context"],
        count("total_tokens"),
        count("fresh_in"),
        count("cache_write"),
        count("cache_read"),
        count("output")
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
    if let Some(threads) = a["threads"].as_array() {
        let memberships: Vec<String> = threads
            .iter()
            .map(|thread| {
                format!(
                    "#{} \"{}\"",
                    thread["id"],
                    thread["title"].as_str().unwrap_or("")
                )
            })
            .collect();
        println!(
            "Threads ({} visible): {}",
            memberships.len(),
            if memberships.is_empty() {
                "none".into()
            } else {
                memberships.join(", ")
            }
        );
        println!("Thread list: acom threads --members {}", a["id"]);
    }
    if a["waiting"].is_object() {
        println!("Foreground wait: {}", a["waiting"]);
    }
    let active = a["subscriptions"]["active"].as_u64().unwrap_or(0);
    let pending = a["subscriptions"]["pending"].as_u64().unwrap_or(0);
    if active > 0 || pending > 0 {
        println!(
            "Subscriptions/deferred waits: {active} active; {pending} pending updates. Inspect: acom subscriptions --agent {}",
            a["id"]
        );
    }
    if a["diagnostics"]["suspected_loop"] == true {
        println!(
            "Suspected wake loop: inspect acom history --agent {} --kind coordination.suspected-loop",
            a["id"]
        );
    }
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
        Cmd::Licenses => print!("{LICENSES}"),
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
            let value = get(&format!("/limits?{}", record.query()));
            if !record_output(&value, &record, "acom limits") {
                println!("{}", value["text"].as_str().unwrap_or(""));
                let choices = value["usage_windows"]
                    .as_object()
                    .unwrap_or_else(|| die("invalid limits response: missing usage window IDs"));
                let mut windows = Vec::new();
                for (provider, names) in choices {
                    let names = names.as_array().unwrap_or_else(|| {
                        die("invalid limits response: usage window IDs must be a list")
                    });
                    for name in names {
                        let name = name.as_str().unwrap_or_else(|| {
                            die("invalid limits response: usage window ID must be text")
                        });
                        windows.push(format!(
                            "--usage {} --window {}",
                            shell_word(provider),
                            shell_word(name)
                        ));
                    }
                }
                if !windows.is_empty() {
                    println!("Available usage watches:\n  {}", windows.join("\n  "));
                }
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
        Cmd::Permissions { id, record } => {
            let id = id.or_else(my_id).unwrap_or_else(|| die("give an agent ID"));
            let result = get(&format!(
                "/agents/{id}/permissions?{}{}",
                record.query(),
                viewer_query("viewer")
            ));
            if !record_output(&result, &record, &format!("acom permissions {id}")) {
                println!("{}", serde_json::to_string_pretty(&result).unwrap());
            }
        }
        Cmd::Control {
            action,
            agents,
            if_states,
            limit,
            after,
            through,
        } => {
            let targets = if matches!(agents.as_str(), "all" | "launched") {
                app::ControlTargets::Selector(agents.clone())
            } else {
                app::ControlTargets::Selected(ids(&agents).unwrap_or_else(|error| die(&error)))
            };
            let result = post(
                "/controls",
                json!({"agent":my_id().unwrap_or(0),"action":action,"agents":targets,
                "if_states":if_states,"limit":limit,"after":after,"through":through}),
            );
            println!("{}", serde_json::to_string_pretty(&result).unwrap());
            if result["has_more"] == true {
                let states = if_states
                    .as_ref()
                    .map(|values| format!(" --if-state {}", values.join(",")))
                    .unwrap_or_default();
                eprintln!(
                    "more: acom control {action} --agents {}{states} --limit {limit} --after {} --through {}",
                    shell_word(&agents),
                    result["next_after"],
                    result["through"]
                );
            }
        }
        Cmd::Done => {
            post(&format!("/agents/{}/done", me()), json!({}));
            println!("marked done; end your turn now");
        }
        Cmd::Wait {
            timeout,
            ack,
            idle,
            watch,
        } => {
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
            let mut body = watch.body().unwrap_or_else(|error| die(error));
            body["timeout"] = json!(secs);
            if idle {
                body["agent"] = json!(id);
                let value = post("/subscriptions", body);
                print_subscription_registration(&value, true);
                return;
            }
            let v = request_with_timeout("POST", &format!("/wait/{id}"), Some(body), Some(std::time::Duration::from_secs(secs+5)))
                .unwrap_or_else(|(_, error)| die(&format!("{error}. No delivery was acknowledged. Retry `acom wait` to retrieve any pending delivery.")));
            let (output, delivery) = wait_output(&v).unwrap_or_else(|e| die(e));
            let mut stdout = std::io::stdout().lock();
            check_stdout(
                stdout
                    .write_all(output.as_bytes())
                    .and_then(|_| stdout.flush()),
                "can't write wait response; delivery was not acknowledged",
                0,
            );
            drop(stdout);
            if let Some(n) = delivery {
                acknowledge(n);
            }
        }
        Cmd::Subscribe { watch } => {
            let mut body = watch.body().unwrap_or_else(|error| die(error));
            body["agent"] = json!(me());
            let value = post("/subscriptions", body);
            print_subscription_registration(&value, false);
        }
        Cmd::Subscriptions { agent, page } => {
            let id = agent
                .or_else(my_id)
                .unwrap_or_else(|| die("give --agent ID to inspect an agent's subscriptions"));
            let value = get(&format!(
                "/subscriptions?agent={id}{}&{}",
                viewer_query("viewer"),
                page.query()
            ));
            for item in page_items(&value) {
                if !item_truncated(item, &format!("acom subscription {}", item["id"])) {
                    println!("{item}");
                }
            }
            if value["total"] == 0 {
                println!("no subscriptions or deferred waits");
            }
            page_hint(&value, &page, &format!("acom subscriptions --agent {id}"));
        }
        Cmd::Subscription { id, record } => {
            let value = get(&format!(
                "/subscriptions/{id}?{}{}",
                record.query(),
                viewer_query("viewer")
            ));
            if !record_output(&value, &record, &format!("acom subscription {id}")) {
                println!("{value}");
            }
        }
        Cmd::Unsubscribe { id } => {
            let value = post(
                &format!("/subscriptions/{id}/cancel"),
                json!({"agent":my_id().unwrap_or(0)}),
            );
            println!("{value}");
        }
        Cmd::Agents {
            search,
            group,
            provider,
            model,
            effort,
            state,
            pause_reason,
            event_cursor,
            page,
        } => {
            app::AgentFilter {
                group: group.as_deref(),
                search: search.as_deref().unwrap_or(""),
                provider: provider.as_deref(),
                model: model.as_deref(),
                effort: effort.as_deref(),
                state: state.as_deref(),
                pause_reason: pause_reason.as_deref(),
                ..app::AgentFilter::default()
            }
            .normalized()
            .unwrap_or_else(|error| die(&error.1));
            let mut path = format!("/agents?{}", page.query());
            let mut command = "acom agents".to_string();
            for (key, value) in [
                ("search", search),
                ("provider", provider),
                ("model", model),
                ("effort", effort),
            ] {
                if let Some(value) = value {
                    path += &format!("&{key}={}", encode(&value));
                    command += &format!(" --{key} {}", shell_word(&value));
                }
            }
            if let Some(g) = group {
                path += &format!("&group={}", encode(&g));
                command += &format!(" --group {}", shell_word(&g));
            }
            if let Some(state) = state {
                path += &format!("&state={}", encode(&state));
                command += &format!(" --state {}", shell_word(&state));
            }
            if let Some(reason) = pause_reason {
                path += &format!("&pause_reason={}", encode(&reason));
                command += &format!(" --pause-reason {}", shell_word(&reason));
            }
            if event_cursor {
                command += " --event-cursor";
            }
            let result = get(&path);
            for a in page_items(&result) {
                if !item_truncated(a, &format!("acom agent {}", a["id"])) {
                    print_agent_line(a);
                }
            }
            if event_cursor {
                let cursor = result["event_cursor"]
                    .as_i64()
                    .filter(|id| *id >= 0)
                    .unwrap_or_else(|| {
                        die("agent response has no event cursor; request a fresh snapshot")
                    });
                println!("Event cursor: {cursor}");
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
                    if project_here().is_none() {
                        let p = post("/projects", user_body(json!({ "path": cwd() })));
                        let id=p["id"].as_str().unwrap_or_else(||die("project may have been added, but its UUID was not returned; inspect acom projects before retrying"));
                        project_uuid(id).unwrap_or_else(|_|die("project may have been added, but its UUID was invalid; inspect acom projects before retrying"));
                        let _ = PROJECT_CONTEXT.set(id.to_string());
                        println!("added project {}", p["path"].as_str().unwrap_or(""));
                    }
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
        Cmd::Threads { search, page } => {
            let (filters, command) = search_options(
                search.options(),
                &format!("acom threads --sort {}", page.sort),
            );
            let result = get(&format!(
                "/threads?{}{filters}{}",
                page.query(),
                viewer_query("viewer")
            ));
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
                    "{:>3}  \"{}\" · {} · members {} · {} messages · last {}",
                    th["id"],
                    th["title"].as_str().unwrap_or(""),
                    thread_access(th),
                    members.join(","),
                    th["messages"],
                    t(&th["last_at"])
                );
            }
            cursor_page_hint(&result, &page.page, &command);
        }
        Cmd::Thread { cmd } => match cmd {
            ThreadCmd::New {
                title,
                members,
                watch,
                include_user,
                private,
                no_join,
            } => {
                let members: Vec<String> = members
                    .map(|m| m.split(',').map(|s| s.trim().to_string()).collect())
                    .unwrap_or_default();
                let watch: Vec<String> = watch
                    .map(|w| w.split(',').map(|s| s.trim().to_string()).collect())
                    .unwrap_or_default();
                let mut b = json!({ "title": title, "members": members, "watch": watch, "private": private, "joinable": !private && !no_join });
                match my_id() {
                    Some(id) => {
                        b["agent"] = json!(id);
                        b["include_user"] = json!(include_user);
                    }
                    None => {
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
                    "Thread {} \"{}\" · {} · members {}\n",
                    th["id"],
                    th["title"].as_str().unwrap_or(""),
                    thread_access(&th),
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
                    json!({ "agent": my_id().unwrap_or(0), "members": members }),
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
                    json!({ "agent": my_id().unwrap_or(0), "members": members }),
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
            ThreadCmd::TransferOwner { id, owner } => {
                let response = post(
                    &format!("/threads/{id}/owner"),
                    json!({"agent":my_id().unwrap_or(0), "owner":owner}),
                );
                let saved_owner = response["owner"].as_i64().filter(|id| *id > 0).unwrap_or_else(|| {
                    die("invalid ownership response; inspect the thread before retrying the transfer")
                });
                println!("thread {id} ownership transferred to agent {saved_owner}");
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
        Cmd::Messages { search, page } => {
            search.validate().unwrap_or_else(|error| die(error));
            let (filters, command) = search_options(search.options(), "acom messages");
            let result = get(&format!(
                "/messages/search?{}{filters}{}",
                page.query(),
                viewer_query("viewer")
            ));
            for message in page_items(&result) {
                if item_truncated(message, &format!("acom read {}", message["id"])) {
                    continue;
                }
                println!(
                    "#{} · thread {} \"{}\" · {} · {}{}\n{}\n",
                    message["id"],
                    message["thread"],
                    message["title"].as_str().unwrap_or(""),
                    sender(&message["sender"]),
                    t(&message["at"]),
                    message_context(message),
                    message["snippet"].as_str().unwrap_or("")
                );
            }
            if let Some(total) = result["total"].as_u64() {
                println!(
                    "{total} matching messages (snippets); use acom read <ID> for full content."
                );
            }
            page_hint(&result, &page, &command);
        }
        Cmd::Read { id, thread, record } => {
            let context = my_id().map(|a| format!("agent={a}&")).unwrap_or_default();
            let thread_query = thread
                .map(|thread| format!("&thread={thread}"))
                .unwrap_or_default();
            let command = format!(
                "acom read {id}{}",
                thread
                    .map(|thread| format!(" --thread {thread}"))
                    .unwrap_or_default()
            );
            let result = get(&format!(
                "/messages/{id}?{context}{}{thread_query}",
                record.query()
            ));
            if !record_output(&result, &record, &command) {
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
            let mut query = Vec::new();
            if let Some(viewer) = my_id() {
                query.push(format!("viewer={viewer}"));
            }
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
            let selected = ids(&list).unwrap_or_else(|error| die(&error));
            post(
                "/marks",
                json!({ "agent": me(), "ids": selected, "mark": mark }),
            );
            println!("marked {} message(s) {mark}", selected.len());
        }
        Cmd::Locks { page } => {
            let result = get(&format!("/locks?{}", page.query()));
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
                        if l["holder_stopping"] == true {
                            s += ", releasing after worker stops";
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
                let result = get(&format!(
                    "/activity/{id}?{}{}",
                    args.query(),
                    viewer_query("agent")
                ));
                if !record_output(&result, &args, &format!("acom activity {id}")) {
                    println!("{result}");
                }
            } else {
                let result = get(&format!(
                    "/activity?{}{}",
                    page.query(),
                    viewer_query("agent")
                ));
                println!("{result}");
                page_hint(&result, &page, "acom activity");
            }
        }
        Cmd::Configs { page } => {
            let result = get(&format!("/configs?{}", page.query()));
            println!("{result}");
            cursor_page_hint(&result, &page, "acom configs");
        }
        Cmd::Config { id, record } => {
            let result = get(&format!("/configs/{id}?{}", record.query()));
            if !record_output(&result, &record, &format!("acom config {id}")) {
                println!("{result}");
            }
        }
        Cmd::Receipt { id, global, record } => {
            let context = if global {
                String::new()
            } else {
                my_id().map(|a| format!("agent={a}&")).unwrap_or_default()
            };
            let endpoint = if global {
                "global-receipts"
            } else {
                "receipts"
            };
            let command = format!("acom receipt {id}{}", if global { " --global" } else { "" });
            let result = get(&format!("/{endpoint}/{id}?{context}{}", record.query()));
            if !record_output(&result, &record, &command) {
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
                let result = get(&format!("/locks/{id}?{}", record.query()));
                if !record_output(&result, &record, &format!("acom lock read {id}")) {
                    println!("{result}");
                }
            }
            LockCmd::New { name, about } => {
                let mut b = json!({ "name": name, "about": about });
                if let Some(id) = my_id() {
                    b["agent"] = json!(id);
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
                post("/locks/free", user_body(json!({ "name": name })));
                println!("freed {}", short_label(&name));
            }
        },
        Cmd::Pause { id } => {
            post(&format!("/agents/{id}/pause"), user_body(json!({})));
            println!("paused agent {id}; locks release after its old worker stops");
        }
        Cmd::PauseAll => {
            let v = post("/pause-all", user_body(json!({})));
            print_bulk_messages(&v, None);
            println!(
                "paused {} agent(s); locks release after their old workers stop",
                result_count(&v, "ids")
            );
            if result_count(&v, "errors") > 0 {
                exit(1);
            }
        }
        Cmd::ResumeAll => {
            let v = post("/resume-all", user_body(json!({})));
            print_bulk_messages(&v, None);
            println!("resumed {} agent(s)", result_count(&v, "ids"));
            if result_count(&v, "errors") > 0 {
                exit(1);
            }
        }
        Cmd::ResumeRestart => {
            let v = post("/resume-restart", user_body(json!({})));
            let failed = result_count(&v, "errors") > 0;
            print_bulk_messages(&v, None);
            write_stdout_status(
                format_args!(
                    "resumed {} restart-paused agent(s) across all projects\n",
                    result_count(&v, "ids")
                ),
                i32::from(failed),
            );
            if failed {
                exit(1);
            }
        }
        Cmd::Resume { ids: list } => {
            for id in ids(&list).unwrap_or_else(|error| die(&error)) {
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
                    p["id"].as_str().unwrap_or(""),
                    p["name"].as_str().unwrap_or(""),
                    p["path"].as_str().unwrap_or(""),
                    p["agents"],
                    p["active"]
                );
            }
            cursor_page_hint(&result, &page, "acom projects");
        }
        Cmd::Project { cmd } => match cmd {
            ProjectCmd::Export {
                id,
                destination,
                logs,
                native,
            } => {
                let result = post(
                    &format!("/projects/{id}/export"),
                    user_body(
                        json!({"destination":absolute_path(&destination),"logs":logs,"native":native}),
                    ),
                );
                println!("{result}");
            }
            ProjectCmd::InspectArchive { source } => {
                let result = post(
                    "/projects/inspect-archive",
                    user_body(json!({"source":absolute_path(&source)})),
                );
                println!("{result}");
            }
            ProjectCmd::Import {
                source,
                path,
                accept_default_change,
            } => {
                let source = absolute_path(&source);
                let inspected = post(
                    "/projects/inspect-archive",
                    user_body(json!({"source":source})),
                );
                let version = inspected["version"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| {
                        die("archive inspection returned no version; nothing was imported")
                    });
                let result = post(
                    "/projects/import",
                    user_body(
                        json!({"source":source,"path":absolute_path(&path),"accept_default_change":accept_default_change,"version":version}),
                    ),
                );
                println!("{result}");
            }
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

fn absolute_path(value: &str) -> std::path::PathBuf {
    let path = std::path::Path::new(value);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::path::Path::new(&cwd()).join(path)
    }
}
