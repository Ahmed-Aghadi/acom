# acom

A small local tool that launches AI coding agents (Claude Code and Codex for now), lets them talk to each other and share locks, and keeps them within limits you set. It provides the building blocks; how agents use them is up to them and the task you give them.

You drive it from a web page or the `acom` command. Agents use the `acom` command.

## Pieces

**Server.** One per machine, for all your projects. `acom serve` runs it on `127.0.0.1:7400` (`--port` to change it); a second `acom serve` refuses to start. All state is kept in `~/.acom/acom.db` (SQLite; `ACOM_HOME` moves the folder), so a restart loses nothing; the server also writes its port to `~/.acom/port`, which is how `acom` commands find it. acom keeps none of its own state in projects. The server is also what launches and supervises agents.

**Project.** A folder. Every agent, thread and lock belongs to one project: agents run in its folder and only see that project's agents, threads and locks (agent IDs are unique across projects; lock names only within a project). Projects are added in the UI, with `acom project add`, or by running `acom launch` inside a folder that isn't one yet. A project without agents can be removed. Each project has its own settings (see Settings): its own limits, models, permissions and rules. There's no cap across projects. Subscription usage is per account, so every project sees the same usage %, but acts on it with its own thresholds.

**Harness.** A coding-agent CLI that acom knows how to run: `claude` and `codex` in this version. Adding another later means teaching acom how to start it, resume it, read its usage, and install its hook (see Build notes).

**Agent.** One harness session that acom launched. Nobody registers by hand: every agent comes from a launch, so acom can track and limit all of them. Each agent has:

- an ID (a number), which acom passes to it in the `ACOM_ID` environment variable, so agents never type it
- a name, the task it was given, its harness, model and effort
- an optional group: a label that keeps related agents together in the UI. Set at launch, or by the agent with `acom group <name>`
- a state (below) and an optional status text the agent sets itself, e.g. "reviewing the lexer"
- launch details: when, and by whom (you, or agent N)
- usage: context size now, and tokens so far, split into fresh input, cache writes, cache reads and output

**Thread.** A conversation in one project: a title, owner, member agents from that project (and optionally the user, ID `0`), and messages. Public, open threads are the default: any project agent can read or post, and posting joins a static thread. `--no-join` keeps public reads but requires membership to post; `--private` requires membership to read or post. The user can always read and manage every thread. Restricted threads use fixed membership, not live filters. User-created threads include the user by default; agents can opt in with `--include-user`. User membership remains manually managed.

- There's no built-in thread for everyone. When starting a thread you pick members by ID, or by selector (selectors only match agents in the thread's project): `active` (working or idle), `working`, `idle`, `paused`, `done`, `closed`, `crashed`, `replaced`, `group:<name>`, or `user`. For example, `--members active` messages every active agent, and `--members active,done` adds the finished ones too.
- `--members` resolves selectors once. Any project agent can add members to open static threads; only the user or current owner can add to restricted/live threads. Any member can leave itself; only the user can remove others.
- The creator initially owns the thread. Leaving retains management rights, not private read/post access; owners can rejoin with `thread add <TID> <own ID>`. The user or current owner can transfer exclusive ownership to a non-replaced project agent with `thread transfer-owner`. Membership stays unchanged. Metadata exposes current `owner` and immutable `created_by`.
- Alternatively, `--watch` accepts state/group selectors, not IDs or `user`, and cannot be combined with `--members`. Any selected state matches, AND any selected group; group-only watches default to `active`. Agent creation, state changes and group changes update membership atomically, recording joins/leaves and their reasons. A nonmatching owner is not pinned. Live `active` threads exclude done agents, so messages in them do not wake done agents; include `done` explicitly to do that. A done-only recipient leaves when waking into working, retaining the delivered message in its inbox without relabelling it as catch-up. Removal persists as an exclusion; the user or current owner can restore agents only when they match the filters.
- To message one agent or a group, start a thread with them and post in it. Any number of threads can have the same members, so a new topic gets a new thread.
- Joining/rejoining exposes earlier messages as catch-up without normal unread notifications or wake-ups. Personalized reads identify messages sent outside membership separately from their marks; reading does not change live membership. Thread reads include recent membership and ownership events.

**Message.** Plain text, from an agent or from `user`. Each agent puts its own mark on each message in its threads:

- `new`: not dealt with yet. Every message starts here, and an agent can leave a message here to come back to later
- `in-progress`: read, and being acted on now
- `handled`: dealt with; nothing more needed

`acom inbox` shows `new` messages; `--mark in-progress` or `--mark handled` shows the others. Leaving retains marks and public-thread inbox access; private messages require current membership. Previously stored messages without membership tracking have explicit unknown context rather than an inferred delivery claim. Separately, acom tracks which messages it has told each agent about, so nothing is announced twice.

**Coordination history.** Durable structured events have monotonic IDs, timestamps, kind, actor, relevant agent/thread/lock and details. `agent.created` records a retained agent identity; `agent.turn-started` records a successfully started process, not a successful turn. `acom history` returns bounded JSON; agents default to their own events, `--all-agents` requests their project. Filters combine by agent/thread/lock/kind. Exclusive `before` or `after` event-ID cursors are positive and mutually exclusive. Defaults: 50 events / 16000 bytes; accepted limits: 1–200 events / 512–65536 bytes. One event is available with `acom history <ID>`. This is separate from provider conversation history. Lifecycle summaries at turn start and after membership/lock changes show only nonzero counts and point to history instead of repeating the log.

**Lock.** A named lock that agents create when they need one, with a description of what it's for. Any number of locks, one holder each.

- `acquire` takes the lock if it's free. If someone else holds it, it fails at once, or with `--wait` it queues (first come, first served) until it gets it or the wait runs out.
- Every acquisition or renewal has a positive TTL, at most the project's `max_lock_ttl_secs` (default 900s). Omitted or null TTL uses that maximum; zero, negative, fractional or larger values are rejected. Acquiring a lock you already hold succeeds and restarts its TTL. Lowering the maximum shortens existing oversized or untimed leases to at most that much time remaining and notifies their holders. Increasing it never extends existing leases. This is a per-lease ceiling, not a total holding-time limit across renewals. Legacy held locks are bounded on the next tick.
- `release` frees a lock you hold, and fails if you don't hold it (e.g. its TTL ran out and someone else has it now).
- You can free any lock from the UI or with `acom lock free`.
- Pausing or explicitly closing an agent releases held locks after its commands and background tools stop. A lock held by a stopping agent remains reserved until cleanup finishes; it cannot expire or be freed during that cleanup.

## Agent states

| State | Meaning | What wakes it |
|---|---|---|
| `working` | In a turn: thinking and running tools | — |
| `idle` | Its turn ended. Costs nothing | Any new message in its threads |
| `paused` | Stopped by you, by a limit, or by a server restart. Messages wait | You resume it, or the limit clears (if auto-resume is on) |
| `done` | It ran `acom done`: task finished | Any new message in its threads, when there's room (see Limits) |
| `closed` | You closed it, or it marked done under the default setting | Only you explicitly reopening it; messages wait |
| `crashed` | Its process exited with an error or reported a failed turn (the error is shown) | Manual retry, or a configured crash-recovery rule |
| `replaced` | Ownership of its work committed to its successor before startup | Never; terminal and inspectable |

A **turn** is one stretch of work: it starts when the agent gets a prompt (its task, or a wake-up) and lasts until it stops and waits. Under the hood a turn is one run of `claude -p` or `codex exec`; waking a done agent or explicitly reopening a closed one resumes the same session. A woken done agent returns to done when its turn finishes; an explicitly reopened agent is idle unless it marks done again.

When an agent becomes `done`, `closed` or `crashed`, its locks are released and it leaves any lock queue. An explicit Close first reserves held locks until the agent's commands and background tools have stopped. By default an agent's own `acom done` makes it `closed`, so no message wakes it; a setting makes it `done` instead. Agents are told which rule applies, in their briefing, in `acom limits`, and again if you change it. When anyone posts in a thread, they're told which members weren't woken and why (closed, paused, crashed, replaced, or waiting for room). Replaced agents retain their records but reject resume, reopen, configure, pause, close, status, group and done mutations; use the successor instead.

## Talking to agents while they work

Both harnesses run a hook after every tool call. acom uses it to tell a working agent about anything new, in a few lines that never include message content:

```
[acom] 3 new messages from agent 2, agent 5, user. Read them with `acom inbox` when you're ready.
[acom] Soft limit reached: claude five-hour subscription usage 81% (soft 80%, hard 95%).
```

A long sender list is cut in the middle: `from agent 1, agent 2, agent 3, … agent 12, user`. An idle agent gets the same lines as the prompt that wakes it.

What agents are told, and when:

- **At launch**, the first prompt is a full briefing: its ID, name, group, project (name and folder), task, who launched it, harness/model/effort, the current limits and usage, what happens when it runs `acom done`, and the guide (below).
- **During a turn**, pending changes: new messages; a limit or rule you changed; a soft or hard limit reached; a lock it lost.
- **At each continued turn**, pending updates and wake or resume guidance, followed by fresh limits, usage and finishing rules. Interrupted work also gets a warning about partial commands and stopped background tasks. This includes explicit Reopen and crash recovery, even if the agent missed rule-change notices.
- **Any time**, `acom me` shows its full picture and `acom limits` shows all limits and usage.

If a session never really started (say the first turn crashed at once), the next turn is a fresh session and gets the full briefing again.

## Launching

Agents and you launch agents the same way: harness, model, effort, task, and optionally a name and group. Missing values come from the defaults in settings. An agent's helpers join its project; you choose the project. The allowed models and efforts in settings restrict agents' launches; yours can use any model ID, including one acom doesn't know yet. If the model is in acom's catalog, an effort it doesn't support is refused (e.g. `gpt-6-luna` with `ultra`).

- An **agent's** launch goes ahead at once if it's allowed and no hard limit is reached. Past a soft limit it still goes ahead, and the agent is told the soft limit is reached and what the hard limit is. At a hard limit it's refused, with the same details.
- **You** see the same warnings. At a hard limit you're asked to confirm, and if you do, the agent launches anyway.
- **Handing over:** `acom launch --done` marks the launching agent done and launches the new one in one step. A done agent doesn't count toward the active-agent limits, so this works even when there's only room for one of them. It's all or nothing: if the launch fails, the caller stays as it was.

Every launched agent has subagents turned off (Claude Code: no `Agent`, `Workflow`, `SendMessage` or `ListAgents` tools; Codex: `--disable multi_agent`), so every agent working on the project is one acom knows about. Agents that need help launch another agent through acom instead.

## Limits

Limits are part of each project's settings (see Settings) and apply to that project's agents. Each limit has a soft and a hard value, and either can be left unset (no limit). The soft value warns; the hard value acts.

| Limit | Soft | Hard |
|---|---|---|
| **Active agents** in the project (working or idle, not counting ones that ran `acom done`), in total and per harness | Agents launching, and you, are told it's reached and what the hard value is | Agents' launch requests are refused, and done agents aren't woken (they wait in line); you can confirm a launch past it |
| **Subscription usage**, separate Claude five-hour/weekly/weekly Fable thresholds and Codex's highest window (in %) | Affected agents are told which window crossed its threshold | When any applicable window crosses its hard threshold, affected agents are paused. Their launches are refused and wakes wait in line while it's over; Fable's window doesn't block other Claude models |
| **Context size**, per agent (tokens) | That agent is told its context is getting large | The harness auto-compacts at this size (Claude `--autocompact`, which takes 100k to 1M; Codex `model_auto_compact_token_limit`) |

A subscription limit only affects that provider's agents: Claude hitting its limit doesn't pause Codex agents. The hard usage action happens when usage crosses the limit, so an agent you launch or resume past it afterwards keeps running: you've seen the warning and chosen to.

Agents paused by a limit resume by themselves when usage is confirmed below the project's hard threshold and below 100%, and an active-agent slot is free. A setting turns that off, so they wait for you. An unknown reading or a passed reset timestamp is not confirmation. Quota checks run even when agents are paused: every 120 seconds by default (configurable 15–3600), and at reported reset times. Periodic checks find early/free resets; the reported time avoids an extra interval after a scheduled reset. Shared accounts use the shortest project's interval. Failed checks preserve the last reading and show an error; they don't wake agents blindly.

**The wake line.** Waking a done agent makes it active again, so it needs room under the hard limits. If there isn't any, the agent waits in line, the sender is told (`agent 5 wasn't woken: Hard limit reached: 1 active agents (soft none, hard 1). It will be woken when there's room.`), and the UI shows it waiting. Waiting agents are woken oldest first as soon as there's room; a new message never jumps the line. Idle agents already count as active, so they're always woken at once. Closed agents never enter the wake line until explicitly reopened.

## Crash recovery and model switches

An unexpected process exit or harness-reported failed turn becomes a crash regardless of error wording. acom also guards against silent model substitutions:

- Claude agents run with `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` and `CLAUDE_CODE_NO_MODEL_FALLBACK=1`, so Claude Code doesn't switch models.
- Codex has no switch for its safety reroute. acom treats a reported reroute as a failed turn, but cannot rule out a substitution Codex doesn't report.
- Crashes release locks, show the reason and log it. Optional per-source-model rules specify `same_model_retries` (default zero), then a different target harness/model. With count two, the original failed turn gets two same-model attempts before replacement. No matching rule means it stays crashed; there are no default rules. Ordinary successful responses, including refusal text, aren't classified as crashes. Manual pauses/closes, shutdown pauses and quota pauses are excluded.
- Recovery snapshots the failed turn's model/effort, not queued next-turn changes. Supported effort stays unchanged; unsupported `ultra` becomes `max` when the target supports it; a sole-effort target uses its fixed catalog effort (Haiku 4.5's `medium` placeholder, without an effort flag). Converted efforts still require project allowance. Other unsupported efforts stop; disallowed targets/efforts and active/usage limits wait visibly. Conversion is included in notices, prompts and activity.
- A retry waits at least two seconds after failure and for the old process to exit. Same-provider retries preserve the same agent ID and native session; cross-provider retries create a replacement with the original task, failure reason, history/output paths, name/group, thread ownership, static memberships, notification cursors and message marks. Live membership follows the successor's state/group. Ownership commits atomically before startup, making the predecessor permanently `replaced`; setup/spawn failures belong to the successor and follow its configured recovery. Handoff prompts describe the new native session and partial-work checks; history is context, not commands to replay. No locks or background processes transfer. Durable attempt counts and visited models prevent cycles and duplicate launches across restarts. Successful turns and manual Resume reset the chain.
- As a safety net, acom checks the model that actually answers. If it isn't the one the agent was launched with (a dated ID like `claude-haiku-4-5-20251001` counts as `claude-haiku-4-5`), or it changes during the session, its process is stopped and the turn fails the same way.
- When an agent hits its subscription's usage limit mid-turn ("You've hit your session limit"), acom pauses it with reason `limit`, even if no hard limit is set. With auto-resume enabled, it resumes only after a fresh account check confirms available usage.
- When a turn crashes, the harness's last error (or its last line on stderr) is shown on the agent.

## Pausing

Pausing stops the agent's process. The conversation is saved by the harness, so resuming continues the same conversation. Anything it was running at that moment is killed; its resume prompt says it was paused, so it can redo that step. A resume waits a few seconds for the old process to exit, so two turns of one agent never overlap.

**Pause one agent** (you, from the UI or `acom pause`). Held locks are released automatically after its commands and background tools have stopped. The UI shows the agent and its locks as stopping until cleanup finishes; keeping or freezing locks is not supported.

**Close one agent** uses the same cleanup and lock reservation. Its state becomes closed immediately; it can be reopened after cleanup finishes, and messages remain pending until then.

**Pause all.** Working, idle and done agents in every project are paused, with the same cleanup and lock-release behavior. **Resume all** resumes paused agents across every project, including manual and limit pauses. Resuming does not restore released locks or their old TTLs; agents must acquire any required locks again. An agent whose cleanup is still pending cannot resume yet.

**Limit pause.** An agent paused by a hard limit always releases its locks, since other agents may still be running and need them.

**Server restart.** Agents that were mid-turn when the server stopped become restart-paused, their owned leftover processes and tools are stopped, and their locks are released after cleanup. Linux process identity, `ACOM_ID`, the saved server address and data-home markers prevent unrelated processes from being stopped. Idle agents and existing manual or limit pauses stay unchanged. Starting the server does not resume interrupted turns automatically; `acom resume-restart` resumes only restart-paused agents across all projects and reports any failures.

An agent waiting in `lock acquire --wait` when it's paused leaves the queue.

**Resuming.** The agent gets a prompt saying when it was interrupted and resumed, that commands may have only partially executed and unsaved work may be lost, that its old commands, background tasks and monitors are gone (so it doesn't wait for them), which locks it lost while paused ("You no longer hold lock `install`: you were paused at 14:02. Acquire it again if you still need it."), and a summary of what's new.

**Cleanup and locks.** Lock expiry, acquisition and release are serialized under the server mutex. A stopping agent's locks remain reserved while cleanup runs, including after their TTL passes; manual Free is refused until its tools stop. Cleanup failures remain visible and are retried, without allowing another agent to enter protected work. Lost locks are recorded when they are released, and resuming tells the agent to acquire required locks again.

## Commands

`acom --help` and `acom guide` list commands in two groups, and state plainly: **agents never run user commands.**

Agent commands use `ACOM_ID` to know who's calling, and act on the agent's project. User commands act on the project the current folder is in (the closest project folder at or above it); listings show every project when the folder isn't in one. Durations look like `30s`, `5m`, `1h`. Output is plain text; errors go to stderr with a non-zero exit code. If `send` gets no text argument, it reads stdin.

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
| `acom thread new --title <text> [--members <IDs or selectors> \| --watch <states,group:name>] [--include-user] [--private \| --no-join]` | Start a static or live thread; restricted modes cannot be live |
| `acom thread read <TID>` | A bounded message page |
| `acom thread add <TID> <ID or selector,...>` | Add members |
| `acom thread remove <TID> <IDs,user>` | Leave yourself; the user may remove others |
| `acom thread transfer-owner <TID> <AGENT_ID>` | Transfer exclusive ownership without changing membership |
| `acom history [ID] [--agent ID \| --all-agents] [--thread TID] [--lock name] [--kind kind] [--before ID \| --after ID] [--limit N] [--max-bytes N]` | Read bounded coordination events or one event |
| `acom send --thread <TID> [text]` | Post in a thread; says who couldn't be woken yet |
| `acom inbox [--mark new\|in-progress\|handled]` | Your messages with that mark (default `new`) |
| `acom read <msg ID>` | One message in full |
| `acom mark <msg ID,...> new\|in-progress\|handled` | Mark messages |
| `acom locks` | List locks: name, description, holder, since, expires, stopping, queue |
| `acom lock new <name> --about <text>` | Create a lock |
| `acom lock acquire <name> [--wait <dur>] [--ttl <dur>]` | Take a lock |
| `acom lock release <name>` | Release a lock you hold |

### User commands

| Command | What it does |
|---|---|
| `acom serve [--port N]` | Run the server (once per machine) |
| `acom projects` | List projects |
| `acom project add [path]` / `acom project remove <ID>` | Add a folder as a project (default: this folder), or remove one without agents |
| `acom launch ... [--force]` | Launch an agent in this folder's project (added if needed); `--force` confirms past a hard limit |
| `acom send --thread <TID> [text]` | Post as `user` |
| `acom pause <ID>` | Pause one agent and release its locks after cleanup |
| `acom pause-all` / `acom resume-all` | Pause or resume everything |
| `acom resume-restart` | Resume only restart-paused agents across all projects |
| `acom resume <ID,...>` | Resume agents |
| `acom close <ID>` / `acom reopen <ID>` | Close or reopen an agent |
| `acom lock free <name>` | Release a lock whoever holds it |

There's no authentication: the split is a convention, not a security boundary. When a user command is run with `ACOM_ID` set, i.e. by an agent you asked to act for you, acom records it in the activity log as "user (via agent 7)".

## Agent guide

`acom guide` prints what every agent needs, and the launch briefing includes it. It explains the tool, not how to split work.

`acom models` prints the embedded, dated [model and provider reference](src/models.md); `acom models --catalog` lists current IDs and effort choices. The guide points agents to these details without copying the entire reference into every prompt. The catalog includes Haiku 5.5. Haiku 4.5's `medium` entry denotes fixed effort; no effort flag is sent for that model.

`acom configure [ID] --model <ID> --effort <level>` sets next-turn configuration. Agents may only configure themselves while working, with independent project opt-ins for model and effort changes (both default false), within allowed lists. The user can configure any agent except a replaced predecessor through CLI or Details. Current tools are not interrupted. The next turn retains the same provider/session and refreshes the model/effort and rules in its prompt; models from a different provider require a new launch with a summary and history/output references, not a native resume. Mid-turn model checks and quota enforcement use the running turn's original model, not a queued change.

The launch guide covers:

- your ID is in `ACOM_ID`; you never pass it; you only see your own project
- your turn only ends when your process exits, so don't leave background tasks or monitors running
- threads, picking members by ID or selector, starting a new thread per topic, marks, and reading messages when you're ready
- the `[acom]` lines that appear after tool calls, and that ending your turn makes you idle until a new message wakes you
- locks: create, acquire with `--wait` and `--ttl`, renew by acquiring again, release; and that you may lose locks if you're paused
- launching helpers through `acom launch` (there are no subagents), and handing over with `--done`
- limits, what soft and hard mean, that they may be unset, and the wake line
- `acom done` when your task is finished, and that what happens next (closed or done) is in your briefing and `acom limits`
- keep `--wait` shorter than your shell tool's timeout
- the agent commands, and that agents never run user commands

## UI

Served at `http://127.0.0.1:7400/` (`serve` prints the URL). One page, refreshing every 2 seconds.

- **Project picker:** every project with its folder, plus adding and removing projects. The folder browser starts at Home, shows files and folders, navigates up and into folders, and creates new folders; exact-path entry remains available. Agents, threads, locks and activity below are for the selected project.
- **Workspace:** project navigation in a sidebar, clear page headings, light/dark themes, and project summary cards for active agents, unread messages, attention states and held locks. Attention and held-lock counts label partial loaded windows. **Launch** stays in the workspace header. **Pause all** / **Resume all** act on every project; smaller screens group them under **All projects**. The theme follows the system until the user saves an explicit browser preference. Connection failures retain the last view and show an error banner with Retry now.
- **Account usage:** a separate overview strip shows Claude five-hour, weekly and weekly Fable subscription usage, plus Codex (or "unknown"); click for reset/check times, errors and **Check now**. Each Claude window has its own soft/hard config fields. General windows block all Claude models; Fable's only blocks Fable. Resetting one doesn't clear another.
- **Agents**, grouped by group: ID, name, harness/model/effort, state, status text, context size, tokens, launched by and when, whether it's waiting in the wake line and why, and any problem with its reason. Buttons to pause, resume, close and reopen; crashed agents offer Retry same model and Launch another model. Replaced agents are inspectable without ordinary control buttons. Details show the task, launch details, usage, held and lost locks, native conversation-history path (when created), raw output-log path, crash-recovery state and live recent activity. Polling updates changed fields without replacing unchanged task text or drafts; selected log text defers log updates.
- **Threads:** **Mine**, **All**, **Unread** and **Agent-only** filters, membership labels, and join/leave controls distinguish user participation. List rows and the open thread show its ID; **Copy reference** copies `thread #<ID>` for another conversation. Click one to read it; a box at the bottom posts as `user`. A top-right **×** dismisses the pane without leaving or undoing read status; later replies stay unread until reopened. Drafts save per project/thread in browser storage as you type and survive pane switches, reloads and same-address server restarts; unavailable storage shows a warning. Successful sends clear only the submitted, unchanged draft. **New thread** chooses access mode and fixed members (searchable checkboxes and advanced selectors) or live state/group filters, with separate user membership. Add/remove controls manage members and live exclusions. The header shows the current owner; **Change owner** transfers ownership without changing membership. Recent bounded membership/ownership history and outside-membership/unknown-context labels are visible. After posting you're told who couldn't be woken yet; a failed wake never turns a persisted message into a failed-send receipt.
- **Locks:** name, description, holder, since, expires, queue, and a **Free** button. Locks held by stopping agents remain reserved and cannot be freed until cleanup finishes.
- **Activity:** launches, pauses, resumes, limits reached, wake-line changes, locks freed by you, and who did each.
- **Settings:** for the selected project: which config it uses (Default, a saved config, or Custom), and the editor for it, saying which projects a saved config affects; "Save as new config". Models are chosen from acom's catalog (full IDs) with a custom option for newer ones; efforts follow what the chosen model supports. An empty limit field means no limit.

Agent search covers loaded names, IDs, tasks, status, provider, model and groups, with All/Active/Needs attention/Finished filters. Thread search covers loaded titles and IDs. Load more explicitly expands either search's scope. Search and filter choices survive polling. Settings have section links and a persistent saved/unsaved/read-only/pending-selection indicator.

On mobile, opening a conversation shows a single pane and scrolls it into view. All threads returns to the list without losing the selected conversation or draft, and hidden conversations never acknowledge unread arrivals. Ctrl/Cmd + Enter submits a validated message; Enter adds a new line. Pending sends are tracked per project/thread, so reopening a pane cannot submit the same in-flight draft twice. Activity, messages and logs have named keyboard-scrollable regions, and the workspace provides a skip link, focus indicators and reduced-motion styling.

Every dialog can be cancelled without filling it in.

Confirmations explain actions such as launching past a hard limit or closing an agent. Pausing releases locks automatically after cleanup and does not offer a keep-locks option.

## Settings

Edited on the UI's settings page, per project, and stored in the database. A **config** is a full set of settings:

- **Default** (virtual ID `1`) comes from the binary, not a database row. New projects use it; it cannot be edited, renamed or removed. Copy its settings to a saved config or Custom to make changes. Its name and ID are reserved; saved config IDs start at `2`.
- **Saved configs** have names. You save one from the settings page ("Save as new config"), and any project can use it. Editing a saved config changes every project using it, and the page says which. A saved config no project uses can be removed.
- **Custom**: a project can have its own settings instead, starting as a copy of Default.

Selecting a config only changes the pending project assignment; Save applies it. The applied configuration is displayed separately. Save is enabled only when the assignment, settings or name actually differ; reverting all edits disables it. A discard confirmation is needed for actual settings edits, not merely choosing another config.

Every rule reads the settings of the agent's project. Active-agent limits count only that project's agents, and a project's usage thresholds pause only that project's agents. When a change alters a project's rules, that project's agents are told.

A config holds:

- **Harnesses:** which are enabled; for each, the allowed models, allowed effort levels, default model and effort, and extra launch flags. Defaults: every catalog model allowed; Claude `claude-opus-5-5` / medium with `--dangerously-skip-permissions`; Codex `gpt-6-sol` / medium with `--dangerously-bypass-approvals-and-sandbox`. Agents run unattended and nobody can answer a permission prompt, so they get full permissions by default; restrict them here (e.g. `--permission-mode acceptEdits`, `--sandbox workspace-write`) and anything the harness would ask about is denied. acom always adds the flags it depends on (session, model, effort, compaction, hook, no subagents, network access to acom) after these, so the extra flags can't override them.
- **Limits:** soft and hard values for active agents (total and per harness), Claude five-hour, weekly and weekly Fable subscription usage, Codex usage and context size. Usage keys are `claude_five_hour`, `claude_seven_day`, `claude_seven_day_fable` and `codex`; percentages must be 0–100. Any value can be empty. Fable thresholds and exhaustion only affect Fable models; no quota relationship with Mythos is assumed. Missing optional Fable readings preserve the last reading and timestamp, never imply zero or recovery. A check begun before an exhaustion event cannot clear it. Older saved provider-wide limits supply the general windows only.
- **Lock TTL:** `max_lock_ttl_secs`, a positive whole number of seconds (1–4294967295), default 900s, also when absent from older configs. Required in Settings; there is no unlimited option. Acquisition/renewal and queued requests check their project's current ceiling.
- **Agent self-changes:** independent `allow_agent_model_change` and `allow_agent_effort_change` permissions, false by default and when missing from older settings.
- **Crash recovery:** `crash_retries`, an empty mapping by default, from source model ID to `{harness, model, same_model_retries}`; the count is a whole number 0–4294967295, missing means zero. Targets must be different, enabled and allowed. Recovery uses the failed turn's recorded effort; missing recorded effort stops for manual Resume rather than guessing.
- **Auto-resume** after a limit clears: on (default) or off.
- **Usage check interval:** 120 seconds by default; reported reset times also trigger checks.
- **Prompt guidance:** literal launch, wake and resume text, without placeholders. Generated identity, task, guide, limits, updates and interruption warnings cannot be removed by editing guidance.
- **`done` becomes `closed`:** on (default) or off.

Defaults: active agents soft 6 / hard 8, per harness 4 / 6, subscription usage 80% / 95%, context 160,000 / 200,000 tokens.

**Model catalog.** Claude: `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-mythos-5-1` (efforts low to max, except fixed-effort Haiku 4.5). Codex: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` (efforts low to ultra; the Luna models stop at max). The catalog is built into the binary; newer models are typed in as custom IDs until it's updated.

## HTTP API

Used by both the CLI and the UI. JSON in and out; errors are a non-2xx status with `{"error": "..."}`. Times are Unix seconds; a sender or launcher of `0` is the user. Requests from agents carry `agent`; anything without it is from the user (`via` records which agent ran a user command).

The server only answers requests whose `Host` (and `Origin`, if any) is this server, and writes must be `Content-Type: application/json`. There's no auth, but a web page elsewhere can't drive it.

| Area | Requests |
|---|---|
| UI | `GET /` (the page), `GET /overview?project=&since=` (selected project, limits, subscription usage/checks, unread totals, restart-paused count and collection revisions); settings, catalog and collections are fetched separately |
| Projects | `GET /projects`, `GET /projects?path=` (the project a folder is in), `POST /projects` (`path`), `POST /projects/{id}/remove`, `GET /folders?path=&hidden=1` (defaults to Home), `POST /folders` (`parent`, single-folder `name`) |
| Agents | `GET /agents?project=`, `GET /agents/{id}` (adds the project's name and path, `limits` text and `lost_locks`), `GET /agents/{id}/log?lines=`, `POST /agents` (launch; `project`, `force`, `done`), `POST /agents/{id}/status`, `/group`, `/done`, `/pause` (automatically releases locks after cleanup), `/resume`, `/close`, `/reopen`, `POST /pause-all`, `POST /resume-all`, `POST /resume-restart` |
| Threads & messages | `GET /threads?project=&viewer=`, `POST /threads` (`members` snapshot or `watch` live selectors; optional `private`, `joinable`; `include_user` defaults true for users, false for agents), `GET /threads/{tid}?agent=` (personalized context, recent thread events), `GET /threads/{tid}/metadata?agent=` (includes `owner`, `created_by`, access and members), `POST /threads/{tid}/members`, `POST /threads/{tid}/members/remove` (`members`: IDs/user), `POST /threads/{tid}/owner` (`owner`: positive same-project non-replaced agent ID; caller `agent`, default user), `POST /threads/{tid}/user` (`joined`: boolean), `POST /messages` (returns `id` and `not_woken`), `GET /messages/{id}?agent=`, `GET /inbox/{agent}?mark=`, `POST /marks` |
| Locks | `GET /locks?project=`, `POST /locks`, `POST /locks/acquire`, `/release`, `/free` (`project`, `name`) |
| Configs | `GET /configs` (virtual Default plus saved configs, each with settings and the projects using it), `POST /configs` (`name`, `settings`), `PUT /configs/{id}`, `POST /configs/{id}/remove`, `PUT /projects/{id}/config` (`config`: `1` for Default or a saved config's id, or `custom`: settings) |
| Other | `GET /limits?project=` (includes usage and check status), `POST /usage/check` (`provider`), `GET /activity?project=`, `GET /history?project=&agent=&thread=&lock=&kind=&before=&after=&limit=&max_bytes=`, `GET /history/{id}?project=`, `POST /hook/{agent}` (what's new for that agent), `GET /models` (plain-text reference), `POST /agent-config` (`id`, optional `agent`, `model`, `effort`; next-turn configuration) |

## Build notes

- Rust, one crate, one binary. Crates: `rusqlite` (bundled SQLite), `tiny_http` (blocking, one thread per request), `ureq` (HTTPS client), `chrono` (provider reset timestamps), `serde` / `serde_json`, `clap`, `libc`.
- Files: `src/main.rs` (CLI), `src/server.rs` (HTTP), `src/app.rs` (state and all the rules), `src/run.rs` (starting, following and stopping turns), `src/harness.rs` (each harness's command line and output), `src/usage.rs` (account checks and scheduling), `src/ui.html`, `src/guide.md` and `src/models.md` (built in with `include_str!`). Plain HTML, CSS and JS; no framework, no build step.
- One SQLite connection behind a mutex, plus a condvar that every change notifies. `lock acquire --wait` blocks on it. A once-a-second tick expires locks, acts on usage limits, and serves the wake line. Lock queues live in memory.
- **Launching** validates and records identity inside a SQLite savepoint, committed before spawning. A refused launch leaves nothing behind; a failed spawn leaves a visible crashed record and restores a caller's handoff state. A DB failure immediately after spawning kills and reaps the child before feeding it a task.
- **Running a turn.** acom starts the harness in the agent's project folder, in its own process group, with `ACOM_ID`, `ACOM_URL`, and `PATH` starting with acom's own folder:
  - Claude: `claude -p --output-format stream-json --verbose <extra flags> --model <m> --effort <e> --session-id <uuid>` (or `--resume <uuid>`) `--autocompact <hard context> --settings <PostToolUse hook running acom hook> --disallowedTools Agent,Workflow,SendMessage,ListAgents --allowedTools "Bash(acom *)"`. The prompt goes on stdin.
  - Codex: `codex exec [resume] --json --skip-git-repo-check <extra flags> -m <m> -c model=<m> -c model_reasoning_effort=<e> --disable multi_agent -c model_auto_compact_token_limit=<hard context> -c sandbox_workspace_write.network_access=true -c hooks.PostToolUse=... --dangerously-bypass-hook-trust [<session>] -`, with the prompt on stdin. `exec resume` doesn't take every flag `exec` does (e.g. `--sandbox`), so those are dropped on resume; the session keeps them.
  - Compaction flags are left out when the hard context limit is unset.
- **The hook.** `acom hook` asks the server what's new for `ACOM_ID` and prints `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "..."}}`, which both harnesses add to the agent's context. Nothing new prints nothing.
- **Turn end.** A successful turn becomes idle (or `done`/`closed`, if it ran `acom done`; or back to `done` if it was woken from there). If anything arrived for it meanwhile, it's woken straight away. An unexpected non-zero exit or explicit harness failure marks it `crashed`, even if the process exits zero. Failed/stopped process groups are cleaned before recovery. A turn is resumed only if the harness reported its session started; otherwise the next turn is a fresh session with the briefing.
- **Pausing** sends SIGTERM to the process group, then SIGKILL after a few seconds.
- **Usage.**
  - Claude, from its output stream: each assistant message gives the context size, the turn's `result` gives its token totals, and `rate_limit_event` gives each usage window's utilization (a fraction, shown as %) and reset time.
  - Codex: stdout gives the session ID (`thread.started`) and totals (`turn.completed`); its session file (`~/.codex/sessions/.../rollout-*-<session>.jsonl`) gives `token_count` events with totals, the context size and `rate_limits` (used %, window, reset time). acom follows that file while the turn runs, from its end on resumed sessions.
  - Background checks read Claude's OAuth usage endpoint using the local `.credentials.json` login (renewed by the CLI when expired), or `CLAUDE_CODE_OAUTH_TOKEN`; Codex uses `account/rateLimits/read` over app-server stdio. No model turns or reset credits are spent. Provider interfaces can change, and missing/expired credentials or network errors keep the last reading. A reset time never clears a window without confirmation. Each provider has at most one check in flight; a check started before a new harness limit cannot clear that interruption's marker.

Tables:

```
projects (id, path, name, created_at, config, custom)  -- id never reused; custom JSON overrides config
agents   (id, project, name, grp, task, problem, seen_model, harness, model, effort, state, rest, status_text, session_id, session_started,
          launched_by, launched_at, pid, pause_reason, pause_from, paused_at, done_req,
          context, context_warned, fresh_in, cache_write, cache_read, output, turns, ended_at,
          wake_queued_at, wake_why)
threads  (id, project, title, created_by, created_at)
members  (thread_id, agent_id, last_notified)
thread_filters (thread_id, states, groups, watch)      -- live selectors, JSON arrays
member_intervals (id, thread_id, agent_id, start_after, end_after) -- message-ID boundaries
messages (id, thread_id, sender, text, at)              -- sender: agent ID, or 0 for the user
marks    (agent_id, message_id, mark)                   -- no row = new
locks    (project, name, about, created_at, holder, acquired_at, expires_at, frozen, frozen_left)
notices  (id, agent_id, text, at, shown)                -- what to tell an agent next, incl. lost locks
usage    (provider, win, used_pct, resets_at, at)
usage_checks (provider, checked_at, attempted_at, next_check, error, in_flight)
activity (id, project, at, actor, what)                -- project NULL: about all projects
events   (id, project, at, kind, actor, agent, thread, lock, details) -- coordination history
summary_cursors (agent_id, event_id)                   -- lifecycle summary position
history_origin (id, message_id)                       -- messages before tracking have unknown context
configs  (id, name, settings)                          -- saved configs only, IDs >= 2; settings is JSON
```

The lock table retains `frozen` and `frozen_left` as legacy storage fields; current controls never freeze a lease.

## Not included

- Approving agents' permission requests from the UI, or a terminal in the UI that you can attach to any agent (planned: agents would then not need full permissions)
- API keys (subscriptions only for now; planned later)
- Token budgets
- Harnesses other than Claude Code and Codex
- Authentication, access control, or access from other machines (it listens on 127.0.0.1 only)
- Editing or deleting messages, threads, locks or agents
- Attachments or formatting; messages are plain text
- Rules for how agents coordinate
