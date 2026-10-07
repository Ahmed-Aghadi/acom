# acom

A small local tool that launches AI coding agents (Claude Code and Codex for now), lets them talk to each other and share locks, and keeps them within limits you set. It provides the building blocks; how agents use them is up to them and the task you give them.

You drive it from a web page or the `acom` command. Agents use the `acom` command.

## Pieces

**Server.** One per project folder. `acom serve` runs it in the current folder on `127.0.0.1:7400` (`--port` to change it). All state is kept in `.acom/acom.db` (SQLite), so a restart loses nothing; the server also writes its port to `.acom/port`. Delete `.acom/` to start fresh. The server is also what launches and supervises agents.

**Harness.** A coding-agent CLI that acom knows how to run: `claude` and `codex` in this version. Adding another later means teaching acom how to start it, resume it, read its usage, and install its hook (see Build notes).

**Agent.** One harness session that acom launched. Nobody registers by hand: every agent comes from a launch, so acom can track and limit all of them. Each agent has:

- an ID (a number), which acom passes to it in the `ACOM_ID` environment variable, so agents never type it
- a name, the task it was given, its harness, model and effort
- an optional group: a label that keeps related agents together in the UI. Set at launch, or by the agent with `acom group <name>`
- a state (below) and an optional status text the agent sets itself, e.g. "reviewing the lexer"
- launch details: when, and by whom (you, or agent N)
- usage: context size now, and tokens so far, split into fresh input, cache writes, cache reads and output

**Thread.** A conversation: a title, member agents, and messages. Threads are open: any agent can read, post in, or add members to any thread. Membership decides whose inbox a message lands in. Posting in a thread makes you a member.

- There's no built-in thread for everyone. When starting a thread you pick members by ID, or by selector: `active` (working or idle), `working`, `idle`, `paused`, `done`, `closed`, `crashed`, or `group:<name>`. For example, `--members active` messages every active agent, and `--members active,done` adds the finished ones too.
- A selector is resolved when it's used: agents that later enter that state or group aren't added automatically. Add them with `thread add`.
- To message one agent or a group, start a thread with them and post in it. Any number of threads can have the same members, so a new topic gets a new thread.
- When an agent joins a thread, the earlier messages count as new for it, so it can catch up.

**Message.** Plain text, from an agent or from `user`. Each agent puts its own mark on each message in its threads:

- `new`: not dealt with yet. Every message starts here, and an agent can leave a message here to come back to later
- `in-progress`: read, and being acted on now
- `handled`: dealt with; nothing more needed

`acom inbox` shows `new` messages; `--mark in-progress` or `--mark handled` shows the others. Marks are only for the agent's own bookkeeping, and only on messages in its own threads. Separately, acom tracks which messages it has told each agent about, so nothing is announced twice.

**Lock.** A named lock that agents create when they need one, with a description of what it's for. Any number of locks, one holder each.

- `acquire` takes the lock if it's free. If someone else holds it, it fails at once, or with `--wait` it queues (first come, first served) until it gets it or the wait runs out.
- `--ttl` makes the lock free itself that long after it was acquired, in case the holder is gone. Acquiring a lock you already hold succeeds and restarts its TTL.
- `release` frees a lock you hold, and fails if you don't hold it (e.g. its TTL ran out and someone else has it now).
- You can free any lock from the UI or with `acom lock free`.
- A lock can be **frozen** (see Pausing): it stays with its holder and its TTL clock stops until the holder resumes.

## Agent states

| State | Meaning | What wakes it |
|---|---|---|
| `working` | In a turn: thinking and running tools | — |
| `idle` | Its turn ended. Costs nothing | Any new message in its threads |
| `paused` | Stopped by you, by a limit, or by a server restart. Messages wait | You resume it, or the limit clears (if auto-resume is on) |
| `done` | It ran `acom done`: task finished | Any new message in its threads, when there's room (see Limits) |
| `closed` | You closed it | Only your messages, when there's room, or you reopening it |
| `crashed` | Its process exited with an error | You resume it |

A **turn** is one stretch of work: it starts when the agent gets a prompt (its task, or a wake-up) and lasts until it stops and waits. Under the hood a turn is one run of `claude -p` or `codex exec`; when the run exits the agent is idle, and waking it resumes the same session. After a woken `done` or `closed` agent finishes its turn, it goes back to being `done` or `closed`.

When an agent becomes `done`, `closed` or `crashed`, its locks are released and it leaves any lock queue. A setting turns an agent's own `done` into `closed` automatically.

## Talking to agents while they work

Both harnesses run a hook after every tool call. acom uses it to tell a working agent about anything new, in a few lines that never include message content:

```
[acom] 3 new messages from agent 2, agent 5, user. Read them with `acom inbox` when you're ready.
[acom] Soft limit reached: claude subscription usage 81% (soft 80%, hard 95%).
```

A long sender list is cut in the middle: `from agent 1, agent 2, agent 3, … agent 12, user`. An idle agent gets the same lines as the prompt that wakes it.

What agents are told, and when:

- **At launch**, the first prompt is a full briefing: its ID, name, group, task, who launched it, harness/model/effort, the current limits and usage, and the guide (below).
- **Afterwards, only changes**: new messages; a limit you changed; a soft or hard limit reached; a lock it lost; that it was paused and resumed.
- **Any time**, `acom me` shows its full picture and `acom limits` shows all limits and usage.

If a session never really started (say the first turn crashed at once), the next turn is a fresh session and gets the full briefing again.

## Launching

Agents and you launch agents the same way: harness, model, effort, task, and optionally a name and group. Missing values come from the defaults in settings. acom refuses a harness, model or effort level that isn't allowed in settings.

- An **agent's** launch goes ahead at once if it's allowed and no hard limit is reached. Past a soft limit it still goes ahead, and the agent is told the soft limit is reached and what the hard limit is. At a hard limit it's refused, with the same details.
- **You** see the same warnings. At a hard limit you're asked to confirm, and if you do, the agent launches anyway.
- **Handing over:** `acom launch --done` marks the launching agent done and launches the new one in one step. A done agent doesn't count toward the active-agent limits, so this works even when there's only room for one of them. It's all or nothing: if the launch fails, the caller stays as it was.

Every launched agent has subagents turned off (Claude Code: no `Agent`, `Workflow`, `SendMessage` or `ListAgents` tools; Codex: `--disable multi_agent`), so every agent working on the project is one acom knows about. Agents that need help launch another agent through acom instead.

## Limits

Each limit has a soft and a hard value, and either can be left unset (no limit). The soft value warns; the hard value acts.

| Limit | Soft | Hard |
|---|---|---|
| **Active agents** (working or idle, not counting ones that ran `acom done`), in total and per harness | Agents launching, and you, are told it's reached and what the hard value is | Agents' launch requests are refused, and done or closed agents aren't woken (they wait in line); you can confirm a launch past it |
| **Subscription usage**, per provider (the highest of its usage windows, in %) | That provider's agents are told | When usage crosses it, that provider's agents are paused. Agents' launches on that provider are refused and wakes wait in line while it's over |
| **Context size**, per agent (tokens) | That agent is told its context is getting large | The harness auto-compacts at this size (Claude `--autocompact`, which takes 100k to 1M; Codex `model_auto_compact_token_limit`) |

A subscription limit only affects that provider's agents: Claude hitting its limit doesn't pause Codex agents. The hard usage action happens when usage crosses the limit, so an agent you launch or resume past it afterwards keeps running: you've seen the warning and chosen to.

Agents paused by a limit resume by themselves when it clears, e.g. when the usage window resets or you raise the limit. A setting turns that off, so they wait for you.

**The wake line.** Waking a done or closed agent makes it active again, so it needs room under the hard limits. If there isn't any, the agent waits in line, the sender is told (`agent 5 wasn't woken: Hard limit reached: 1 active agents (soft none, hard 1). It will be woken when there's room.`), and the UI shows it waiting. Waiting agents are woken oldest first as soon as there's room; a new message never jumps the line. Idle agents already count as active, so they're always woken at once.

## Pausing

Pausing stops the agent's process. The conversation is saved by the harness, so resuming continues the same conversation. Anything it was running at that moment is killed; its resume prompt says it was paused, so it can redo that step. A resume waits a few seconds for the old process to exit, so two turns of one agent never overlap.

**Pause one agent** (you, from the UI or `acom pause`). If it holds locks, you choose:

- **Release its locks** (recommended).
- **Keep its locks.** They're frozen: they stay with the agent and their TTL clocks stop until it resumes, so nobody else can get them meanwhile.

**Pause all.** Every agent is paused, and every held lock is frozen with the time it had left. **Resume all** brings everything back with the same holders and the same time left. You can also resume only some agents; then you're warned which still-paused agents hold locks, and the UI offers to release them.

**Limit pause.** An agent paused by a hard limit always releases its locks, since other agents may still be running and need them.

**Server restart.** Agents that were mid-turn when the server stopped are treated like pause all: their leftover processes are stopped (only if the process still carries that agent's `ACOM_ID` and this server's `ACOM_URL`), they're paused, and their locks are frozen. Resume them when you're ready.

An agent waiting in `lock acquire --wait` when it's paused leaves the queue.

**Resuming.** The agent gets a prompt saying when it was paused and resumed, which locks it lost while paused ("You no longer hold lock `install`: you were paused at 14:02. Acquire it again if you still need it."), and a summary of what's new.

**No races.** Freezing a lock, expiring it, and releasing it all happen inside the server under one mutex, so one always finishes before the other starts. Freezing checks the deadline first: a lock whose TTL has already run out counts as expired and isn't frozen. Lost locks are recorded at the moment they're released, so the resume prompt is always accurate. Resuming sets the new deadline to now plus the time that was left.

## Commands

`acom --help` and `acom guide` list commands in two groups, and state plainly: **agents never run user commands.**

Agent commands use `ACOM_ID` to know who's calling. Durations look like `30s`, `5m`, `1h`. Output is plain text; errors go to stderr with a non-zero exit code. If `send` gets no text argument, it reads stdin.

### Agent commands

| Command | What it does |
|---|---|
| `acom guide` | Print the guide |
| `acom me` | Your ID, name, group, state, task, launch details, usage, held locks |
| `acom limits` | All limits with their soft and hard values, and current usage |
| `acom status <text>` | Set your status text |
| `acom group <name>` | Put yourself in a group |
| `acom done` | Mark your task finished (then end your turn) |
| `acom agents [--group <name>]` | List agents: ID, name, group, state, status, harness/model |
| `acom agent <ID>` | One agent's details |
| `acom launch --task <text> [--harness h] [--model m] [--effort e] [--name n] [--group g] [--done]` | Launch a helper agent; `--done` hands over to it |
| `acom threads` | List threads: ID, title, members, last activity |
| `acom thread new --title <text> [--members <ID or selector,...>]` | Start a thread with you in it; prints its ID |
| `acom thread read <TID>` | A thread's full history |
| `acom thread add <TID> <ID or selector,...>` | Add members |
| `acom send --thread <TID> [text]` | Post in a thread; says who couldn't be woken yet |
| `acom inbox [--mark new\|in-progress\|handled]` | Your messages with that mark (default `new`) |
| `acom read <msg ID>` | One message in full |
| `acom mark <msg ID,...> new\|in-progress\|handled` | Mark messages |
| `acom locks` | List locks: name, description, holder, since, expires, frozen, queue |
| `acom lock new <name> --about <text>` | Create a lock |
| `acom lock acquire <name> [--wait <dur>] [--ttl <dur>]` | Take a lock |
| `acom lock release <name>` | Release a lock you hold |

### User commands

| Command | What it does |
|---|---|
| `acom serve [--port N]` | Run the server in this folder |
| `acom launch ... [--force]` | Launch an agent; `--force` confirms past a hard limit |
| `acom send --thread <TID> [text]` | Post as `user` |
| `acom pause <ID> [--release-locks\|--keep-locks]` | Pause one agent (you must choose if it holds locks) |
| `acom pause-all` / `acom resume-all` | Pause or resume everything |
| `acom resume <ID,...>` | Resume agents |
| `acom close <ID>` / `acom reopen <ID>` | Close or reopen an agent |
| `acom lock free <name>` | Release a lock whoever holds it |

There's no authentication: the split is a convention, not a security boundary. When a user command is run with `ACOM_ID` set, i.e. by an agent you asked to act for you, acom records it in the activity log as "user (via agent 7)".

## Agent guide

`acom guide` prints what every agent needs, and the launch briefing includes it. It explains the tool, not how to split work:

- your ID is in `ACOM_ID`; you never pass it
- threads, picking members by ID or selector, starting a new thread per topic, marks, and reading messages when you're ready
- the `[acom]` lines that appear after tool calls, and that ending your turn makes you idle until a new message wakes you
- locks: create, acquire with `--wait` and `--ttl`, renew by acquiring again, release; and that you may lose locks if you're paused
- launching helpers through `acom launch` (there are no subagents), and handing over with `--done`
- limits, what soft and hard mean, that they may be unset, and the wake line
- `acom done` when your task is finished
- keep `--wait` shorter than your shell tool's timeout
- the agent commands, and that agents never run user commands

## UI

Served at `http://127.0.0.1:7400/` (`serve` prints the URL). One page, refreshing every 2 seconds.

- **Top bar:** subscription usage per provider (or "unknown"); **Launch**; **Pause all** / **Resume all**.
- **Agents**, grouped by group: ID, name, harness/model/effort, state, status text, context size, tokens, launched by and when, and whether it's waiting in the wake line and why. Buttons to pause, resume, close and reopen. Details show the task, launch details, usage, held and lost locks, and recent activity (the harness's output).
- **Threads:** click one to read it; a box at the bottom posts as `user`. **New thread** takes a title and members, by ID or selector. After posting you're told who couldn't be woken yet.
- **Locks:** name, description, holder, since, expires (or frozen with the time left), queue, and a **Free** button.
- **Activity:** launches, pauses, resumes, limits reached, wake-line changes, locks freed by you, and who did each.
- **Settings:** everything below. An empty limit field means no limit.

Confirmations: launching past a hard limit; pausing an agent that holds locks (release, keep, or cancel); resuming one agent while other paused agents hold frozen locks (resume and release those, resume only, or cancel).

## Settings

Edited on the UI's settings page and stored in the database.

- **Harnesses:** which are enabled; for each, the allowed models, allowed effort levels, default model and effort, and extra launch flags (e.g. permission mode: `--permission-mode auto` for Claude, `--sandbox workspace-write` for Codex). acom always adds the flags it depends on (session, model, effort, compaction, hook, no subagents, network access to acom) after these, so the extra flags can't override them.
- **Limits:** soft and hard values for active agents (total and per harness), subscription usage (per provider) and context size. Any value can be empty.
- **Auto-resume** after a limit clears: on (default) or off.
- **`done` becomes `closed`:** off (default) or on.

Defaults: active agents soft 6 / hard 8, per harness 4 / 6, subscription usage 80% / 95%, context 160,000 / 200,000 tokens.

## HTTP API

Used by both the CLI and the UI. JSON in and out; errors are a non-2xx status with `{"error": "..."}`. Times are Unix seconds; a sender or launcher of `0` is the user. Requests from agents carry `agent`; anything without it is from the user (`via` records which agent ran a user command).

The server only answers requests whose `Host` (and `Origin`, if any) is this server, and writes must be `Content-Type: application/json`. There's no auth, but a web page elsewhere can't drive it.

| Area | Requests |
|---|---|
| UI | `GET /` (the page), `GET /overview` (agents, threads, locks, limits, activity and settings in one call) |
| Agents | `GET /agents`, `GET /agents/{id}` (adds `limits` text and `lost_locks`), `GET /agents/{id}/log?lines=`, `POST /agents` (launch; `force`, `done`), `POST /agents/{id}/status`, `/group`, `/done`, `/pause` (`locks`: `release` or `keep`), `/resume`, `/close`, `/reopen`, `POST /pause-all`, `POST /resume-all` |
| Threads & messages | `GET /threads`, `POST /threads`, `GET /threads/{tid}`, `POST /threads/{tid}/members`, `POST /messages` (returns `id` and `not_woken`), `GET /messages/{id}`, `GET /inbox/{agent}?mark=`, `POST /marks` |
| Locks | `GET /locks`, `POST /locks`, `POST /locks/acquire`, `/release`, `/free` |
| Other | `GET /limits`, `GET /activity`, `GET /settings`, `PUT /settings` (`{"settings": {...}}`), `POST /hook/{agent}` (what's new for that agent) |

## Build notes

- Rust, one crate, one binary. Crates: `rusqlite` (bundled SQLite), `tiny_http` (blocking, one thread per request), `ureq` (client), `serde` / `serde_json`, `clap`, `libc`.
- Files: `src/main.rs` (CLI), `src/server.rs` (HTTP), `src/app.rs` (state and all the rules), `src/run.rs` (starting, following and stopping turns), `src/harness.rs` (each harness's command line and output), `src/ui.html` and `src/guide.md` (built in with `include_str!`). Plain HTML, CSS and JS; no framework, no build step.
- One SQLite connection behind a mutex, plus a condvar that every change notifies. `lock acquire --wait` blocks on it. A once-a-second tick expires locks, acts on usage limits, and serves the wake line. Lock queues live in memory.
- **Launching** runs inside a SQLite savepoint, so a launch that fails at any point (including starting the process) leaves nothing behind.
- **Running a turn.** acom starts the harness in the project folder, in its own process group, with `ACOM_ID`, `ACOM_URL`, and `PATH` starting with acom's own folder:
  - Claude: `claude -p --output-format stream-json --verbose <extra flags> --model <m> --effort <e> --session-id <uuid>` (or `--resume <uuid>`) `--autocompact <hard context> --settings <PostToolUse hook running acom hook> --disallowedTools Agent,Workflow,SendMessage,ListAgents --allowedTools "Bash(acom *)"`. The prompt goes on stdin.
  - Codex: `codex exec [resume] --json <extra flags> -m <m> -c model_reasoning_effort=<e> --disable multi_agent -c model_auto_compact_token_limit=<hard context> -c sandbox_workspace_write.network_access=true -c hooks.PostToolUse=... --dangerously-bypass-hook-trust [<session>] -`, with the prompt on stdin. `exec resume` doesn't take every flag `exec` does (e.g. `--sandbox`), so those are dropped on resume; the session keeps them.
  - Compaction flags are left out when the hard context limit is unset.
- **The hook.** `acom hook` asks the server what's new for `ACOM_ID` and prints `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "..."}}`, which both harnesses add to the agent's context. Nothing new prints nothing.
- **Turn end.** When the process exits cleanly the agent becomes idle (or `done`, if it ran `acom done`; or back to `done`/`closed` if it was woken from there). If anything arrived for it meanwhile, it's woken straight away. A non-zero exit that acom didn't cause marks it `crashed`. A turn is resumed only if the harness reported its session started; otherwise the next turn is a fresh session with the briefing.
- **Pausing** sends SIGTERM to the process group, then SIGKILL after a few seconds.
- **Usage.**
  - Claude, from its output stream: each assistant message gives the context size, the turn's `result` gives its token totals, and `rate_limit_event` gives each usage window's utilization (a fraction, shown as %) and reset time.
  - Codex: stdout gives the session ID (`thread.started`) and totals (`turn.completed`); its session file (`~/.codex/sessions/.../rollout-*-<session>.jsonl`) gives `token_count` events with totals, the context size and `rate_limits` (used %, window, reset time). acom follows that file while the turn runs, from its end on resumed sessions.
  - When no agent of a provider is running, the last known usage is shown. A window whose reset time has passed no longer counts.

Tables:

```
agents   (id, name, grp, task, harness, model, effort, state, rest, status_text, session_id, session_started,
          launched_by, launched_at, pid, pause_reason, pause_from, paused_at, done_req,
          context, context_warned, fresh_in, cache_write, cache_read, output, turns, ended_at,
          wake_queued_at, wake_why)
threads  (id, title, created_by, created_at)
members  (thread_id, agent_id, last_notified)
messages (id, thread_id, sender, text, at)              -- sender: agent ID, or 0 for the user
marks    (agent_id, message_id, mark)                   -- no row = new
locks    (name, about, created_at, holder, acquired_at, expires_at, frozen, frozen_left)
notices  (id, agent_id, text, at, shown)                -- what to tell an agent next, incl. lost locks
usage    (provider, win, used_pct, resets_at, at)
activity (id, at, actor, what)
settings (key, value)                                   -- one JSON value
```

## Not included

- API keys (subscriptions only for now; planned later)
- Token budgets
- Harnesses other than Claude Code and Codex
- Authentication, access control, or access from other machines (it listens on 127.0.0.1 only)
- Editing or deleting messages, threads, locks or agents; leaving a thread
- Attachments or formatting; messages are plain text
- Rules for how agents coordinate
