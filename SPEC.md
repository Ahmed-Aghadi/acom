# acom

A small local tool that launches AI coding agents (Claude Code and Codex for now), lets them talk to each other and share locks, and keeps them within limits you set. It provides the building blocks; how agents use them is up to them and the task you give them.

You drive it from a web page or the `acom` command. Agents use the `acom` command.

## Pieces

**Server.** One per data directory, handling all its projects. `acom serve` listens on `127.0.0.1:7400` (`--port` accepts 1–65535); another server using the same data directory refuses to start. The default directory is `~/.acom` (`ACOM_HOME` overrides it): durable coordination state is in `acom.db`, captured output in `logs/`, the discovery port in `port`, and the server lock in `serve.lock`. Native conversations remain in the harness's own storage. Foreground waits and lock queues are in memory; browser drafts are stored in that browser. acom launches/supervises agents but keeps none of its own state in projects. Isolated development instances need separate data directories and ports.

**Project.** A folder. Every agent, thread and lock belongs to one project: agents run in its folder and only see that project's agents, threads and locks (agent IDs are unique across projects; lock names only within a project). Projects are added in the UI, with `acom project add`, or by running `acom launch` inside a folder that isn't one yet. A project without agents can be removed. Each project has its own settings (see Settings): its own limits, models, permissions and rules. There's no cap across projects. Subscription usage is per account, so every project sees the same usage %, but acts on it with its own thresholds.

**Harness.** A coding-agent CLI that acom knows how to run: `claude` and `codex` in this version. Adding another later means teaching acom how to start it, resume it, read its usage, and install its hook (see Build notes).

**Agent.** One harness session that acom launched. Nobody registers by hand: every agent comes from a launch, so acom can track and limit all of them. Each agent has:

- an ID (a number), passed as `ACOM_ID` so commands infer caller identity
- a name, the task it was given, its harness, model and effort
- an optional group: a label that keeps related agents together in the UI. Set at launch, or by the agent with `acom group <name>`
- a state (below) and an optional status text the agent sets itself, e.g. "reviewing the lexer"
- launch details: when, and by whom (you, or agent N)
- usage: context size now, and tokens so far, split into fresh input, cache writes, cache reads and output

**Thread.** A conversation in one project: a title, owner, member agents from that project (and optionally the user, ID `0`), and messages. Public, open threads are the default: any project agent can read or post, and posting joins a static thread. `--no-join` keeps public reads but requires membership to post; `--private` requires membership to read or post. The user can always read and manage every thread. Restricted threads use fixed membership, not live filters. User-created threads include the user by default; agents can opt in with `--include-user`. User membership remains manually managed.

- There's no built-in thread for everyone. When starting a thread you pick members by ID, or by selector (selectors only match agents in the thread's project): `active` (working or idle), `working`, `idle`, `paused`, `done`, `closed`, `crashed`, `replaced`, `group:<name>`, or `user`. For example, `--members active` adds the currently active agents; creating a thread does not send a message.
- `--members` resolves selectors once. Any project agent can add members to open static threads; only the user or current owner can add to restricted/live threads. Any member can leave itself; only the user can remove others.
- The creator initially owns the thread. Leaving retains management rights, not private read/post access; owners can rejoin with `thread add <TID> <own ID>`. The user or current owner can transfer exclusive ownership to a non-replaced project agent with `thread transfer-owner`. Membership stays unchanged. Metadata exposes current `owner` and immutable `created_by`.
- Alternatively, `--watch` accepts state/group selectors, not IDs or `user`, and cannot be combined with `--members`. Any selected state matches, AND any selected group; group-only watches default to `active`. Agent creation, state changes and group changes update membership atomically, recording joins/leaves and their reasons. A nonmatching owner is not pinned. Live `active` threads exclude done agents, so messages in them do not wake done agents; include `done` explicitly to do that. A done-only recipient leaves when waking into working, retaining the delivered message in its inbox without relabelling it as catch-up. Removal persists as an exclusion; the user or current owner can restore agents only when they match the filters.
- To message one agent or a group, start a thread with them and post in it. Any number of threads can have the same members, so a new topic gets a new thread.
- Messages sent outside membership appear as catch-up without normal unread notifications or wake-ups. Rejoining preserves earlier membership periods and marks; reading does not change live membership. Thread reads include recent membership and ownership events.
- Membership changes alone are passive: they do not resolve foreground/deferred waits or wake idle agents. They remain in history and hook/next-turn summaries, including live-filter changes caused by going idle. New messages from others in member threads already notify working agents and wake idle ones without a subscription. Public reads without membership do not subscribe to messages.

**Message.** Original text, from an agent or from `user`; the browser renders basic Markdown without changing stored text or API/CLI output. Each agent puts its own mark on each message in its threads:

- `new`: not dealt with yet. Every message starts here, and an agent can leave a message here to come back to later
- `in-progress`: read, and being acted on now
- `handled`: dealt with; nothing more needed

`acom inbox` shows `new` messages; `--mark in-progress` or `--mark handled` shows the others. Reading or notification delivery never marks work handled: `acom mark` is explicit. Leaving retains marks and public-thread inbox access; private messages require current membership. Messages without recorded membership context are labelled unknown rather than guessed. Notification cursors are separate from marks; an unacknowledged wait receipt can intentionally replay its same batch.

**Coordination history.** Durable structured events have monotonic IDs, timestamps, kind, actor, relevant agent/thread/lock and details. `agent.created` records a retained agent identity; `agent.turn-started` records a successfully started process, not a successful turn. `acom history` returns bounded JSON; agents default to their own events, `--all-agents` requests their project. Filters combine by agent/thread/lock/kind. Exclusive `before` or `after` event-ID cursors are positive and mutually exclusive. Defaults: 50 events / 16000 bytes; accepted limits: 1–200 events / 512–65536 bytes. One event is available with `acom history <ID>`. This is separate from provider conversation history. Lifecycle summaries at turn start and after membership/lock changes show only nonzero counts and point to history instead of repeating the log.

**Lock.** A named cooperative reservation that agents create when needed, with an agreed description of what it protects. Any number of locks, one holder each; acom tracks ownership but does not prevent file writes. Agents should reuse agreed names, order multiple acquisitions consistently and avoid retaining a lock while waiting for work that needs it.

- `acquire` takes the lock if it's free. If someone else holds it, it fails at once, or with `--wait` it queues (first come, first served) until acquisition/timeout. Invalid or unrepresentable wait durations are rejected. The request belongs to that working turn; a stop or new turn cancels it rather than acquiring a lease for a stale command.
- Every acquisition or renewal has a positive TTL, at most the project's `max_lock_ttl_secs` (default 900s). Omitted or null TTL uses that maximum; zero, negative, fractional or larger values are rejected. Acquiring a lock you already hold succeeds and restarts its TTL. Lowering the maximum shortens existing oversized or untimed leases to at most that much time remaining and notifies their holders. Increasing it never extends existing leases. This is a per-lease ceiling, not a total holding-time limit across renewals. Legacy held locks are bounded on the next tick.
- `release` frees a lock you hold, and fails if you don't hold it (e.g. its TTL ran out and someone else has it now).
- You can free any lock from the UI or with `acom lock free`.
- Pausing or explicitly closing an agent releases held locks after its commands and background tools stop. A lock held by a stopping agent remains reserved until cleanup finishes; it cannot expire or be freed during that cleanup.

## Agent states

| State | Meaning | What wakes it |
|---|---|---|
| `working` | In a turn: thinking and running tools | — |
| `idle` | Its turn ended; no running model turn, but still counts as active | Member messages, subscribed events, a deferred-wait deadline or a queued continuation, subject to limits |
| `paused` | Stopped by you, by a limit, or by a server restart. Messages wait | You resume it, or the limit clears (if auto-resume is on) |
| `done` | Finished but message-wakeable; also used while a replacement waits for startup | New member messages from others, subject to limits; not while a handoff/startup is pending |
| `closed` | You closed it, or it marked done under the default setting | Only you explicitly reopening it; messages wait |
| `crashed` | Its process exited with an error or reported a failed turn (the error is shown) | Manual retry, or a configured crash-recovery rule |
| `replaced` | Ownership of its work committed to its successor before startup | Never; terminal and inspectable |

A **turn** is one process invocation of `claude -p` or `codex exec`, ending when that process exits; shell/background tools do not carry work across turns. Normally a successful unfinished turn becomes idle. A message-woken done agent normally returns to done; an explicitly reopened agent stays active unless it marks done again. A recorded native session is resumed; if the harness never confirmed one started, the next turn gets a fresh session and full briefing instead. Continuations and replacements have the explicit rules below.

When an agent becomes `done`, `closed` or `crashed`, its locks are released and it leaves any lock queue. An explicit Close first reserves held locks until the agent's commands and background tools have stopped. By default an agent's own `acom done` makes it `closed`, so no message wakes it; a setting makes it `done` instead. Agents are told which rule applies, in their briefing, in `acom limits`, and again if you change it. When anyone posts in a thread, they're told which members weren't woken and why (closed, paused, crashed, replaced, or waiting for room). Replaced agents retain their records but reject resume, reopen, configure, pause, close, status, group and done mutations; use the successor instead.

## Talking to agents while they work

Both harnesses run a hook after every tool call. acom uses it to tell a working agent about anything new, in a few lines that never include message content:

```
[acom] 3 new messages from agent 2, agent 5, user. Read them with `acom inbox` when you're ready.
[acom] Soft limit reached: claude five-hour subscription usage 81% (soft 80%, hard 95%).
```

A long sender list is cut in the middle: `from agent 1, agent 2, agent 3, … agent 12, user`. An idle agent gets the same lines as the prompt that wakes it.

`acom wait` receives ordinary notifications and selected events during the current working turn. Its timeout is an upper bound, not a fixed sleep: read early returns and inspect the inbox before waiting again. The default is 60 seconds, with 1–3600 seconds accepted; keep foreground waits shorter than the shell tool's timeout. Successful complete CLI output is acknowledged automatically, even when redirected. On an acknowledgement failure, retry only the printed `wait --ack <delivery ID>`; if complete output was not received, repeat wait to replay its receipt.

`acom subscribe` registers persistent selected events that reach working hooks or wake an idle agent. `acom wait --idle --timeout <duration>` returns immediately with a one-shot deferred-wait ID: an ordinary notification (member message, notice, own lock update or pending event delivery), selected event or deadline resolves it once. Membership changes alone do not resolve waits. An early-resolution notice names its cause and cancels its timeout. Register before yielding, read the receipt and any immediate update, then end normally without `acom done` if still waiting. Registration does not itself change lifecycle state or suspend commands; idle still counts as active and lock TTLs continue. Subscription events/deadlines do not wake done, paused, crashed, closed or replaced agents.

All modes share event filters: `--agents all|IDs` selects project peers (`all` includes future agents, excludes self), `--states` filters destination states, and `--status-text` independently adds descriptive status changes. `--usage <provider> --window <name>` selects one `--above <percent>`, `--below <percent>`, `--reset` or `--reset-due` condition. Claude display aliases `five-hour`, `weekly` and `weekly Fable` normalize to `five_hour`, `seven_day` and `seven_day_fable` before storage/matching; receipts show canonical IDs. Reject unknown windows against provider-specific standard IDs plus current/previous observations, retaining exact dynamic Codex IDs. `/limits` exposes these names in `usage_windows`, separately from actual usage readings. Previously saved misspelled watches are not rewritten. Thresholds are strict; a qualifying latest known reading reports immediately, then only new crossings. Missing/unknown readings are not zero. `--reset` requires fresh observed rollover/recovery; `--reset-due` is an estimated deadline, not confirmation. Detection follows provider output/account checks. Agent and usage filters combine with OR. Persistent subscriptions require a filter; deferred waits need none.

Peer watches select transitions, not current-state snapshots or messages. To avoid a check/register race, inspect `acom agents --event-cursor`, act if the condition already holds, otherwise register with its `--after` baseline (requires `--agents`). New ordinary-wait filters otherwise start now; repeat calls continue each filter's durable cursor, while explicitly repeating `--after` rescans. Bounded deliveries replay unchanged by ID until acknowledged, before changed filters apply. Registration, matching, turn completion and notification consumption are serialized: matches consumed during work cannot also start a second turn, and arrivals before turn exit remain pending. Registrations, pending updates and IDs survive restart and transfer in true replacements. Cancellation stops future matches and withdraws undelivered updates, not already-issued immutable receipts.

Agents can inspect same-project waits/subscriptions; inaccessible private-message causes and IDs are redacted. The detector examines the latest 30 subscription wakes within 60 seconds for ordered causal cycles of 2–6 agents traversed three times, with bounded search and deduplicated warnings. Matches produce `coordination.suspected-loop` events, evidence IDs, notices and UI warnings. This is not general deadlock detection or proof of a mistaken loop; no automatic pause, unsubscribe, wake-rate cap or new policy setting is added. Agents should inspect peer dependencies and adjust their subscriptions when warned.

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
- **Independent handoff:** `acom launch --done` marks the launching agent done and launches another in one step, following the normal done/closed rule rather than permanent replacement. It fits when there's only room for one active agent. Refusal leaves the caller unchanged; startup failure restores its previous finishing request while retaining a visible crashed child record.

Every launched agent has subagents turned off (Claude Code: no `Agent`, `Workflow`, `SendMessage` or `ListAgents` tools; Codex: `--disable multi_agent`), so every agent working on the project is one acom knows about. Agents that need help launch another agent through acom instead.

## Configuration, continuations and replacement

`acom configure [ID] --model <ID> --effort <level>` accepts either setting or both, applies next turn within the same provider/session, and never interrupts current tools or schedules a turn by itself. Agents may only configure themselves while working, with independent model/effort permissions (off by default), supported choices and allowed lists. The user can configure any non-replaced agent. Current-turn checks use its actual running model/effort, not a queued choice. `acom models` and `--catalog` provide selection guidance and supported catalog choices; account/client support is not guaranteed.

Adding `--continue "<instruction>"` queues one automatic next turn after the current turn succeeds. Read the receipt, then end without `acom done`. Another `--continue` replaces the instruction; plain configuration edits preserve it. Pending messages join that next turn, never a simultaneous one. Disallowed settings or hard usage limits wait visibly in Details/`acom me`; startup failure or missing native session cancels the request with an error rather than silently starting fresh or repeatedly retrying. Done, pause/close, crash or restart/usage interruption during the working turn cancels the request, not saved configuration/history. A ready request waiting between successful turns survives restart or a usage pause.

For permanent cross-provider handoff, a working agent with model self-change permission uses `acom launch --replace --harness <other-provider> --model <ID> --effort <level> --task "<handoff summary>"`. The request retains the source's name/group unless overridden and supersedes a continuation. It cannot combine with `--done`/`--force` or another pending replacement. The source reads the receipt and ends without `acom done`; it remains working until successful exit. Interruption, done, pause/close, crash or restart during that turn cancels the uncommitted request.

After successful exit, acom atomically persists a successor and makes the predecessor terminally `replaced` **before startup**. A failed ownership transaction retains the request without a partial successor; startup waiting/failure never revives the predecessor. Details/`acom me` show pending targets, successor links and waiting reasons. The successor waits for allowed settings/capacity/usage without an active slot or message wake-ups. Committed ownership survives restart and Pause/Close; Resume/Reopen retains the handoff. Interrupted/failed startup becomes its own crash subject to configured recovery, not an implicit duplicate first launch.

The successor receives the summary, original task, predecessor history/output paths, name/group, thread ownership, current static memberships (including restricted threads), marks, notification receipts/cursors and subscriptions/deferred waits with their IDs. Live membership follows its state/group; departed threads are not rejoined. Earlier inherited messages are catch-up. Native context, locks and processes do not transfer. The prompt directs it to inspect partial work and treat old records as context, not commands to replay; it also receives the normal launch briefing. Same-provider changes use `configure --continue`, not `launch --replace`.

Agent model switches and true replacements check crashes in that agent's own committed replacement lineage, not unrelated agents/helpers. Selecting a previously crashed model requires reviewing the cited history events and repeating with `--ack-crashes`. Effort-only changes on the current model and independent launches do not trigger that warning. Successful work does not erase past failures. User changes do not require acknowledgement, and acknowledgement never bypasses permissions or limits.

## Limits

Limits are part of each project's settings (see Settings) and apply to that project's agents. Each limit has a soft and a hard value, and either can be left unset (no limit). The soft value warns; the hard value acts. An unset hard usage threshold imposes no acom percentage cutoff, including at 100%; explicit provider quota interruptions remain separate.

| Limit | Soft | Hard |
|---|---|---|
| **Active agents** in the project (working or idle, not counting ones that ran `acom done`), in total and per harness | Agents launching, and you, are told it's reached and what the hard value is | Agents' launch requests are refused, and done agents aren't woken (they wait in line); you can confirm a launch past it |
| **Subscription usage**, separate Claude five-hour/weekly/weekly Fable thresholds and Codex's highest window (in %) | Affected agents are told which window crossed its threshold | When any applicable window crosses its hard threshold, affected agents are paused. Their launches are refused and wakes wait in line while it's over; Fable's window doesn't block other Claude models |
| **Context size**, per agent (tokens) | That agent is told its context is getting large | The harness auto-compacts at this size (Claude `--autocompact`, which takes 100k to 1M; Codex `model_auto_compact_token_limit`) |

A subscription limit only affects that provider's agents: Claude hitting its limit doesn't pause Codex agents. A user-confirmed launch or manual resume does not disable configured hard-limit enforcement on subsequent checks.

Usage soft warnings are retained across restarts per agent and applicable scope: separate Claude windows, one aggregate Codex scope remembering offending raw windows. Fresh observations must show those windows and any current offenders strictly below the warned threshold (or a lower current soft threshold). Then one scoped clear notice is sent; other limits may still apply. Missing/failed checks, omitted windows, elapsed reset estimates or raising/removing thresholds alone do not establish recovery. A clear notice does not itself wake idle agents; an agent awaiting recovery can register an existing usage subscription/deferred wait before yielding.

Agents paused by a configured hard limit resume automatically when confirmed readings satisfy the project's hard thresholds and an active-agent slot is free. A recognized provider quota interruption additionally requires fresh evidence that its affected usage is available, even without a configured hard threshold. A setting disables automatic resume. An unknown reading or a passed reset timestamp is not confirmation. Quota checks run even when agents are paused: every 120 seconds by default (configurable 15–3600), and at reported reset times. Periodic checks find early/free resets; the reported time avoids an extra interval after a scheduled reset. Shared accounts use the shortest project's interval. Failed checks preserve the last reading and show an error; they don't wake agents blindly.

**The wake line.** Waking a done agent makes it active again, so it needs room under the hard limits. If there isn't any, the agent waits in line, the sender is told (`agent 5 wasn't woken: Hard limit reached: 1 active agents (soft none, hard 1). It will be woken when there's room.`), and the UI shows it waiting. Waiting agents are woken oldest first as soon as there's room; a new message never jumps the line. Idle agents already count as active but their wakes still respect applicable hard usage limits. Closed agents never enter the wake line until explicitly reopened.

## Crash recovery and model switches

An unexpected process exit or harness-reported failed turn becomes a crash unless acom recognized a provider quota interruption or intentional stop. Usage at 100% alone does not classify an unexplained failure as quota exhaustion. acom also guards against silent model substitutions:

- Claude agents run with `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` and `CLAUDE_CODE_NO_MODEL_FALLBACK=1`, so Claude Code doesn't switch models.
- Codex has no switch for its safety reroute. acom treats a reported reroute as a failed turn, but cannot rule out a substitution Codex doesn't report.
- Crashes release locks, show the reason and log it. A retained first-launch startup failure uses the same configured recovery; validation refusals before identity commit create no agent. Optional per-source-model rules specify `same_model_retries` (default zero), then a different target harness/model. With count two, the original failed turn gets two same-model attempts before replacement. No matching rule means it stays crashed; there are no default rules. Ordinary successful responses, including refusal text, aren't classified as crashes. Manual pauses/closes, shutdown pauses and quota pauses are excluded.
- Recovery snapshots the failed turn's model/effort, not queued next-turn changes. Supported effort stays unchanged; unsupported `ultra` becomes `max` when the target supports it; a sole-effort target uses its fixed catalog effort (Haiku 4.5's `medium` placeholder, without an effort flag). Converted efforts still require project allowance. Other unsupported efforts stop; disallowed targets/efforts and active/usage limits wait visibly. Conversion is included in notices, prompts and activity.
- A retry waits at least two seconds after failure and for the old process to exit. Same-provider retries preserve the same agent ID and native session; cross-provider retries create a replacement with the original task, failure reason, history/output paths, name/group, thread ownership, static memberships, notification cursors and message marks. Live membership follows the successor's state/group. Ownership commits atomically before startup, making the predecessor permanently `replaced`; setup/spawn failures belong to the successor and follow its configured recovery. Handoff prompts describe the new native session and partial-work checks; history is context, not commands to replay. No locks or background processes transfer. Durable attempt counts and visited models prevent cycles and duplicate launches across restarts. Successful turns and manual Resume reset the chain.
- As a safety net, acom checks the model that actually answers. If it isn't the one the agent was launched with (a dated ID like `claude-haiku-4-5-20251001` counts as `claude-haiku-4-5`), or it changes during the session, its process is stopped and the turn fails the same way.
- When an agent hits its subscription's usage limit mid-turn ("You've hit your session limit"), acom pauses it with reason `limit`, even if no hard limit is set. With auto-resume enabled, it resumes only after a fresh account check confirms available usage.
- When a turn crashes, the harness's last error (or its last line on stderr) is shown on the agent.

## Pausing

Pausing stops the agent and its owned tools. A confirmed native conversation is resumed; a session that never started needs a fresh briefing. Resuming waits for cleanup so turns never overlap. Working turns receive an interruption prompt; agents paused between turns return to their previous idle/done state and wait for an eligible trigger rather than running an unnecessary turn.

**Pause one agent** (you, from the UI or `acom pause`). Held locks are released automatically after its commands and background tools have stopped. The UI shows the agent and its locks as stopping until cleanup finishes; keeping or freezing locks is not supported.

**Close one agent** uses the same cleanup and lock reservation. Its state becomes closed immediately; it can be reopened after cleanup finishes, and messages remain pending until then.

**Bulk controls.** **Pause project** pauses working, idle and done agents in the selected project; **Resume project** resumes its paused agents, including manual and limit pauses; **Resume restart-paused** resumes only its restart pauses. The **All projects** menu provides global equivalents. Each uses the same individual cleanup and lock-release behavior. Counts share the action's eligibility rules, independent of search/category filters. Unknown, zero and in-flight controls are disabled. Confirmations identify the captured scope, and project switching cannot retarget a pending action. CLI `pause-all`, `resume-all` and `resume-restart` stay global. Resuming does not restore released locks or their old TTLs; agents must acquire any required locks again. An agent whose cleanup is still pending cannot resume yet. Resume rechecks state and scope after waiting for cleanup, so concurrent controls are not undone.

**Limit pause.** An agent paused by a hard limit always releases its locks, since other agents may still be running and need them.

**Server restart.** Agents that were mid-turn when the server stopped become restart-paused, their owned leftover processes and tools are stopped, and their locks are released after cleanup. Linux process identity, `ACOM_ID`, the saved server address and data-home markers prevent unrelated processes from being stopped. Idle agents and existing manual or limit pauses stay unchanged. Starting the server does not resume interrupted turns automatically; `acom resume-restart` resumes only restart-paused agents across all projects and reports any failures.

An agent waiting in `lock acquire --wait` when it's paused leaves the queue.

**Resuming.** The agent gets a prompt saying when it was interrupted and resumed, that commands may have only partially executed and unsaved work may be lost, that its old commands, background tasks and monitors are gone (so it doesn't wait for them), which locks it lost while paused ("You no longer hold lock `install`: you were paused at 14:02. Acquire it again if you still need it."), and a summary of what's new.

**Cleanup and locks.** Lock expiry, acquisition and release are serialized under the server mutex. A stopping agent's locks remain reserved while cleanup runs, including after their TTL passes; manual Free is refused until its tools stop. Cleanup failures remain visible and are retried, without allowing another agent to enter protected work. Lost locks are recorded when they are released, and resuming tells the agent to acquire required locks again.

## Commands

`acom --help` indexes agent commands and user controls; `acom guide` explains their boundaries: **agents never run user commands.**

Agent commands use positive `ACOM_ID` caller identity and act on the agent's project. An unset ID denotes the user; a defined malformed/nonpositive ID fails rather than silently issuing a user request. User commands act on the project the current folder is in (the closest project folder at or above it); applicable listings are global outside a project. Durations look like `30s`, `5m`, `1h`. CLI output is text or JSON; errors go to stderr with a nonzero exit code. If `send` gets no text argument, it reads stdin.

`acom licenses` is a shared offline command: print the embedded project LICENSE followed by THIRD_PARTY_NOTICES.txt without contacting a server, resolving caller identity, reading provider credentials or creating state. It accepts no options other than help and preserves complete notice text, including when run outside a project; early pipe closure exits quietly. The reviewed inventory and generation/check workflow are in [licenses and releases](docs/development.md#licenses-and-releases); toolchain/platform-specific distribution notices require a separate release review.

### Agent commands

| Command | What it does |
|---|---|
| `acom guide` | Print the guide |
| `acom me` | Your ID, name, group, state, task, launch details, usage, locks, wait/subscription counts and warnings |
| `acom limits` | All limits with their soft and hard values, and current usage |
| `acom status <text>` | Set your status text |
| `acom group <name>` | Put yourself in a group |
| `acom done` | Mark your task finished (then end your turn) |
| `acom agents [--search query] [--group name] [--provider provider] [--model model] [--effort effort] [--state state] [--pause-reason reason] [--event-cursor]` | List matching agents; optionally print a baseline for watched events |
| `acom agent <ID>` | One agent's details |
| `acom models [--catalog]` | Model/provider guidance or catalog IDs/efforts |
| `acom configure [ID] [--model m] [--effort e] [--continue text] [--ack-crashes]` | Next-turn same-provider configuration; optionally queue one continuation |
| `acom launch --task <text> [--harness h] [--model m] [--effort e] [--name n] [--group g] [--done\|--replace] [--ack-crashes]` | Independent helper/handoff, or permanent cross-provider replacement |
| `acom threads` | List threads: ID, title, members, last activity |
| `acom thread new --title <text> [--members <IDs or selectors> \| --watch <states,group:name>] [--include-user] [--private \| --no-join]` | Start a static or live thread; restricted modes cannot be live |
| `acom thread read <TID>` | A bounded message page |
| `acom thread details <TID>` | Metadata without message bodies |
| `acom thread add <TID> <ID or selector,...>` | Add members |
| `acom thread remove <TID> <IDs,user>` | Leave yourself; the user may remove others |
| `acom thread transfer-owner <TID> <AGENT_ID>` | Transfer exclusive ownership without changing membership |
| `acom history [ID] [--agent ID \| --all-agents] [--thread TID] [--lock name] [--kind kind] [--before ID \| --after ID] [--limit N] [--max-bytes N]` | Read bounded coordination events or one event |
| `acom send --thread <TID> [text]` | Post in a thread; says who couldn't be woken yet |
| `acom wait [--idle] [--timeout <duration>] [event filters]` | Foreground wait, or register a one-shot deferred wait; `--ack delivery-ID` only retries acknowledgement |
| `acom subscribe <event filters>` | Register a persistent event subscription |
| `acom subscriptions [--agent ID]` / `acom subscription <ID>` | Bounded registration list or one record; same-project peer inspection is allowed |
| `acom unsubscribe <ID>` | Cancel your own registration; the user can cancel any |
| `acom inbox [--mark new\|in-progress\|handled]` | Your messages with that mark (default `new`) |
| `acom read <msg ID>` | One bounded message record |
| `acom notices [ID]` / `acom receipt <ID>` | Retained notices or a saved full command result, without repeating an action |
| `acom activity [ID]` | Project-scoped activity or one record |
| `acom log <own ID>` | Bounded readable-output byte chunks; peer logs are user-only |
| `acom mark <msg ID,...> new\|in-progress\|handled` | Mark messages |
| `acom locks` | List locks: name, description, holder, since, expires, stopping, queue |
| `acom lock read <ID>` | One bounded lock record |
| `acom lock new <name> --about <text>` | Create a lock |
| `acom lock acquire <name> [--wait <dur>] [--ttl <dur>]` | Take a lock |
| `acom lock release <name>` | Release a lock you hold |

### User commands

| Command | What it does |
|---|---|
| `acom serve [--port N]` | Run the server (one per data directory) |
| `acom projects` | List projects |
| `acom project read <ID>` | One bounded project record |
| `acom configs` / `acom config <ID>` | Saved/default configurations or one record |
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

The guide explains shared files/turns/states, automatic member messages, thread access, notification versus work marks, bounded reads, cooperative lock leases, waits/subscriptions, continuations and replacement. Local safeguards cover check/register races, circular lock/peer dependencies, stale receipts and wake loops. Examples are illustrative, not prescribed coordination workflows; the command index and model reference keep detailed options out of every launch prompt.

## UI

Served at `http://127.0.0.1:7400/` (`serve` prints the URL). One page, refreshing every 2 seconds.

The sidebar can be hidden with the header toggle, with the preference saved in this browser. Mobile defaults to hidden and closes navigation after choosing a page. Compact chrome and an uncapped workspace use available viewport width; conversations fill the remaining height. Copy icons copy message text, project/folder paths and displayed agent-detail values without requiring selection. Clipboard failures retain the text and explain manual copying. Agent previews label custom descriptive status as **Status**, otherwise the launch task as **Task**; neither replaces the lifecycle badge.

Outgoing messages appear immediately with a **Sending…** label. The POST receipt confirms persistence, not recipient read status, and makes the message visible without waiting for a general refresh. Pending/confirmed overlays do not advance canonical message cursors; receipt and polling reconciliation uses server IDs, never text, preserving intervening and identical messages. Definite rejection retains the draft with a failure label for explicit retry through the composer. A missing or invalid receipt is **Delivery unconfirmed**, not a definite failure, and is never automatically retried. Local attempt indicators last within the tab; drafts persist as described below. In-flight polling may defer newly observed user bubbles until their receipt arrives so a pending attempt is not shown twice.

Message bodies render basic Markdown (headings, emphasis, lists, quotes, links, code and tables) for both agents and users; ordinary line breaks remain visible. The locally bundled, pinned parser permits no raw HTML, image loading, plugins or automatic bare-URL linkification. Links require explicit HTTP, HTTPS or mailto schemes and open with no opener/referrer. Code info strings do not create attributes. Copy returns the exact original text. Only new message bodies are rendered; polling and sending confirmations preserve existing body nodes. Unavailable/failed parsing, over 65,536 UTF-16 code units, over 8,192 tokens (including inline children), or nesting near the parser limit displays the full escaped source instead, never truncated. Code blocks and tables scroll within their bubbles. See [dependency review and notices](src/vendor/README.md) for bundled components, provenance and upgrade checks.

Conversation headers show a single-line title and compact ID/access/member-count/participation summary, with a live-filter marker where applicable. Native **Details** is collapsed on opening another conversation, expands long titles in place and adds the owner/member list, filters, management actions, copy reference and history without repeating the summary. Polling preserves the disclosure, selections, drafts and reading position. Expanded metadata remains height-bounded; unread navigation and read-status errors stay outside the disclosure. Mobile Back shares the title row rather than taking another line.

- **Project picker:** every project with its folder, plus adding and removing projects. The folder browser starts at Home, shows files and folders, navigates up and into folders, and creates new folders; exact-path entry remains available. Agents, threads, locks and activity below are for the selected project.
- **Workspace:** project navigation in a sidebar, clear page headings, light/dark themes, and project summary cards for active agents, unread messages, attention states and held locks. Agent counts are exact; held-lock counts label partial loaded windows. **Launch** stays in the workspace header. Project bulk controls are primary; global equivalents stay in a collapsed **All projects** menu. The theme follows the system until the user saves an explicit browser preference. Connection failures retain the last view and show an error banner with Retry now.
- **Account usage:** a separate overview strip shows Claude five-hour, weekly and weekly Fable subscription usage, plus Codex (or "unknown"); click for reset/check times, errors and **Check now**. Each Claude window has its own soft/hard config fields. General windows block all Claude models; Fable's only blocks Fable. Resetting one doesn't clear another.
- **Agents**, grouped by group: ID, name, harness/model/effort, state, status text, context size, tokens, launched by and when, whether it's waiting in the wake line and why, and any problem with its reason. Buttons to pause, resume, close and reopen; crashed agents offer Retry same model and Launch another model. Replaced agents are inspectable without ordinary control buttons. Details show the task, launch details, usage, held and lost locks, native conversation-history path (when created), raw output-log path, crash-recovery state and live recent activity. Polling updates changed fields without replacing unchanged task text or drafts; selected log text defers log updates.
- **Threads:** **Mine**, **All**, **Unread** and **Agent-only** filters, membership labels, and join/leave controls distinguish user participation. List rows and the open thread show its ID; **Copy reference** copies `thread #<ID>` for another conversation. Click one to read it; a box at the bottom posts as `user`. A top-right **×** dismisses the pane without leaving or undoing read status; later replies stay unread until reopened. Drafts save per project/thread in browser storage as you type and survive pane switches, reloads and same-address server restarts; unavailable storage shows a warning. Successful sends clear only the submitted, unchanged draft. **New thread** chooses access mode and fixed members (searchable checkboxes and advanced selectors) or live state/group filters, with separate user membership. Add/remove controls manage members and live exclusions. The header shows the current owner; **Change owner** transfers ownership without changing membership. Recent bounded membership/ownership history and outside-membership/unknown-context labels are visible. After posting you're told who couldn't be woken yet; a failed wake never turns a persisted message into a failed-send receipt.
- **Locks:** name, description, holder, since, expires, queue, and a **Free** button. Locks held by stopping agents remain reserved and cannot be freed until cleanup finishes.
- **Activity:** launches, pauses, resumes, limits reached, wake-line changes, locks freed by you, and who did each.
- **Settings:** for the selected project: which config it uses (Default, a saved config, or Custom), and the editor for it, saying which projects a saved config affects; "Save as new config". Models are chosen from acom's catalog (full IDs) with a custom option for newer ones; efforts follow what the chosen model supports. An empty limit field means no limit.

Agent search uses the shared query contract below over the whole project, not just loaded previews. A Filters disclosure builds exact field clauses with literal-value alternatives; chips expose editable/removable clauses and Clear filters. The search box and picker have one query state, parsed on the server rather than by a second UI grammar. Syntax errors stay inline without displaying stale matches as current or reporting a connection failure. All/Active/Needs attention/Finished facets count matching agents before category selection; the header separates loaded matches, matching total and unfiltered project total. Categories can overlap. Pages and counts share parameterized predicates and a read snapshot; cursors bind every normalized filter. Filter changes reset paging and reject stale responses. Project/global lifecycle actions and summary counts stay unfiltered. Thread search still covers loaded titles and IDs. Search/filter choices and input focus survive polling. Settings have section links and a persistent saved/unsaved/read-only/pending-selection indicator.

Readable agent-output entries capture UTC date/time and a message/tool/error/turn type; Details displays local date/time with seconds. They are abbreviated live-output captures, not a mirror of native conversation history; raw stdout remains separate and missing historical timestamps are not fabricated. On-demand panels page lifecycle changes, subscriptions/deferred waits and coordination warnings. Subscription rows show IDs, conditions, deadlines, completion causes and Cancel; collapsed details retain active/pending counts. Cards identify recorded loop warnings, not a claim that a loop is still running. Foreground wait descriptors expose watched targets/usage conditions and a monotonic remaining timeout while the agent remains working.

On mobile, opening a conversation shows a single pane and scrolls it into view. All threads returns to the list without losing the selected conversation or draft, and hidden conversations never acknowledge unread arrivals. Ctrl/Cmd + Enter submits a validated message; Enter adds a new line. Pending sends are tracked per project/thread, so reopening a pane cannot submit the same in-flight draft twice. Activity, messages and logs have named keyboard-scrollable regions, and the workspace provides a skip link, focus indicators and reduced-motion styling.

Every dialog can be cancelled without filling it in.

Manual Pause, Resume/Retry, Close, Reopen and all project/global lifecycle actions require one confirmation by default, identifying the agent name/ID or scope and consequences. Existing explicit review dialogs suffice; no duplicate confirmation follows. Settings has a separate Browser preferences panel, usable even with read-only Default: Confirm agent actions applies immediately across projects in this browser at the same server address, independent of project config and its Save/dirty state. Missing or invalid stored preferences default on; storage failures warn rather than claiming persistence. Disabling it skips only these lifecycle confirmations, not unrelated destructive or hard-limit checks. CLI commands and automatic recovery remain noninteractive. Pausing releases locks automatically after cleanup and does not offer a keep-locks option.

### Agent query

- `search`/CLI `--search` combines whitespace-separated clauses with AND. Exact fields are `group`, `provider`, `model`, `effort`, `state`, `pause_reason`; unquoted commas within a field mean OR. Example: `group:"Security review" state:paused,crashed reentrancy`. Field values are case-sensitive. Double quotes protect spaces, commas and literal colons; `\"` and `\\` escape quotes/backslashes. Quoting a whole token (`"group:x"`) makes it a literal free term. Bare commas outside field clauses are literal.
- Free terms are case-insensitive substrings of individual name, ID, full task, descriptive status, group, provider or model fields. All terms must match, possibly in different fields; one phrase cannot span fields. Effort, lifecycle state, pause reason, logs and files are not free-term search targets.
- Providers are `claude|codex`, states are the seven lifecycle states, and pause reasons are `manual|limit|restart`. Manual maps to stored `user` or `all` pauses. A reason implies paused; an explicit state list must include paused. Group/model/effort are open exact names, including custom IDs; unknown names yield zero matches. `group:""` selects null/empty groups; other empty values are invalid.
- Scalar API parameters/CLI flags for these fields remain one literal exact value, including commas. Reject repeated fields, including scalar-plus-query duplicates; use one comma-alternative clause instead. Reject unknown field prefixes, malformed quotes/escapes, missing values, invalid enums and incompatible conditions. Queries, including canonical form, are limited to 4,096 UTF-8 bytes, 64 clauses and 128 supplied field values. Validation precedes scope discovery/changes in the CLI and data access in the API.
- `GET /agent-query?search=` is a bounded, read-only parsed view: `{text, clauses:[{field, values, text}]}`. Free clauses have `field:null`. Fields appear in group/provider/model/effort/state/pause_reason order, then free terms. This powers picker/chip editing without expanding every agent-list page. Equivalent reordered/quoted filters and duplicate alternatives share a normalized cursor scope; a changed predicate rejects continuation.

## Settings

Edited on the UI's settings page, per project, and stored in the database. A **config** is a full set of settings:

- **Default** (virtual ID `1`) comes from the binary, not a database row. New projects use it; it cannot be edited, renamed or removed. Copy its settings to a saved config or Custom to make changes. Its name and ID are reserved; saved config IDs start at `2`.
- **Saved configs** have names. You save one from the settings page ("Save as new config"), and any project can use it. Editing a saved config changes every project using it, and the page says which. A saved config no project uses can be removed.
- **Custom**: a project can have its own settings instead, starting as a copy of Default.

Selecting a config only changes the pending project assignment; Save applies it. The applied configuration is displayed separately. Save is enabled only when the assignment, settings or name actually differ; reverting all edits disables it. A discard confirmation is needed for actual settings edits, not merely choosing another config.

Every rule reads the settings of the agent's project. Active-agent limits count only that project's agents, and a project's usage thresholds pause only that project's agents. When a change alters a project's rules, that project's agents are told.

A config holds:

- **Harnesses:** which are enabled; for each, the allowed models, allowed effort levels, default model and effort, and extra launch flags. Defaults: every catalog model allowed; Claude `claude-opus-5-5` / medium with `--dangerously-skip-permissions`; Codex `gpt-6-sol` / medium with `--dangerously-bypass-approvals-and-sandbox`. Agents run unattended and nobody can answer a permission prompt, so they get full permissions by default; restrict them here (e.g. `--permission-mode acceptEdits`, `--sandbox workspace-write`) and anything the harness would ask about is denied. acom always adds the flags it depends on (session, model, effort, compaction, hook, no subagents, network access to acom) after these, so the extra flags can't override them.
- **Limits:** soft and hard values for active agents (total and per harness), Claude five-hour, weekly and weekly Fable subscription usage, Codex usage and context size. Usage keys are `claude_five_hour`, `claude_seven_day`, `claude_seven_day_fable` and `codex`; percentages must be 0–100. Any value can be empty. Fable thresholds and exhaustion only affect Fable models; no quota relationship with Mythos is assumed. Missing optional Fable or known Codex windows retain their last observed values/timestamps, never imply zero or recovery. A check begun before an explicit exhaustion event cannot clear its interruption marker. Saved provider-wide Claude thresholds supply general windows only.
- **Lock TTL:** `max_lock_ttl_secs`, a positive whole number of seconds (1–4294967295), default 900s, also when absent from older configs. Required in Settings; there is no unlimited option. Acquisition/renewal and queued requests check their project's current ceiling.
- **Agent self-changes:** independent `allow_agent_model_change` and `allow_agent_effort_change` permissions, false by default. Model permission also permits true cross-provider replacement within agent launch rules; effort-only permission does not.
- **Crash recovery:** `crash_retries`, an empty mapping by default, from source model ID to `{harness, model, same_model_retries}`; the count is a whole number 0–4294967295, missing means zero. Targets must be different, enabled and allowed. Recovery uses the failed turn's recorded effort; missing recorded effort stops for manual Resume rather than guessing.
- **Auto-resume** after a limit clears: on (default) or off.
- **Usage check interval:** 120 seconds by default; reported reset times also trigger checks.
- **Prompt guidance:** literal launch, wake and resume text, without placeholders. Generated identity, task, guide, limits, updates and interruption warnings cannot be removed by editing guidance.
- **`done` becomes `closed`:** on (default) or off.

Defaults: active agents soft 6 / hard 8, per harness 4 / 6, subscription usage 80% / 95%, context 160,000 / 200,000 tokens.

**Model catalog.** Claude: `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-mythos-5-1` (efforts low to max, except fixed-effort Haiku 4.5). Codex: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` (efforts low to ultra; the Luna models stop at max). The catalog is built into the binary; newer models are typed in as custom IDs until it's updated.

## HTTP API

Used by the CLI and UI. Bodies/results are JSON except `GET /` (HTML), `GET /models` (plain text), and fixed `GET /assets/markdown-it-15.0.3.min.js` / `GET /assets/markdown-NOTICES.txt` (JavaScript / plain text). Static assets are compiled into the binary, accept no body/query parameters, and use `nosniff`; there is no general filesystem asset route. Errors have a non-2xx status and `{"error":"..."}` (oversized errors are explicitly shortened). Times in JSON are Unix seconds. User identity is `0`; caller/viewer identity is carried by `agent` or `viewer`, or the agent ID in a route such as `/wait/{id}`. Missing caller/viewer defaults to the user where supported. `via` records a user control run through an agent; none of these fields authenticate a process.

The server only answers requests whose `Host` (and `Origin`, if any) is this server, and writes must be `Content-Type: application/json`. There's no auth, but a web page elsewhere can't drive it.

`GET /?project=<ID>` loads the UI shell with a browser selection hint, including stale bookmarks; API resource reads reject unknown project IDs instead of silently selecting another project.

| Area | Requests |
|---|---|
| UI & references | `GET /`; `GET /overview?project=&since=` (project, agent counts, global `pause_eligible`/`resume_eligible`/`restart_paused` and matching selected-project counts in `project_actions`, unread totals, usage/checks and revisions); `GET /settings?project=`; `GET /catalog`; `GET /models` |
| Projects & folders | `GET /projects` (or `?path=` to find the containing project); `GET /projects/{id}`; `POST /projects` (`path`); `POST /projects/{id}/remove`; `GET /folders?path=&hidden=1` (defaults to Home); `POST /folders` (`parent`, single-folder `name`) |
| Agents | `GET /agents?project=&group=&provider=&model=&effort=&category=&search=&state=&pause_reason=` (bounded items, filtered facets, unfiltered project total, event cursor); `GET /agent-query?search=` (bounded parsed query); `GET /agents/{id}?agent=` (personalized details, paths, limits, locks, wait/subscription/recovery summaries); `GET /agents/{id}/project`; `GET /agents/{id}/log?agent=&lines=` |
| Launch & configuration | `POST /agents` (`task`, optional harness/model/effort/name/group, caller `agent` or user `project`, `force`, `done`, `ack_crashes`); `POST /agents/{id}/replacement` (handoff task/target, `ack_crashes`); `POST /agent-config` (`id`, optional caller `agent`, `model`, `effort`, `continuation`, `ack_crashes`) |
| Lifecycle & waits | `POST /agents/{id}/status` (`text`), `/group` (`group`), `/done`, `/pause`, `/resume`, `/close`, `/reopen`; `POST /pause-all`, `POST /resume-all`, `POST /resume-restart` (optional positive `project` ID scopes the action; omitted means all projects); `POST /hook/{id}`; `POST /wait/{id}` (`timeout`, optional `agents`, `states`, `status_text`, `after`, `usage`); `POST /wait/{id}/ack` (`delivery_id`) |
| Event subscriptions | `POST /subscriptions` (`agent`, optional `timeout` for one-shot; same event filters as wait), `GET /subscriptions?agent=&viewer=` (bounded pages), `GET /subscriptions/{id}?viewer=` (bounded record), `POST /subscriptions/{id}/cancel` (`agent`, default user). `usage` is `{provider, window, condition, percent?}`; `condition` is `above`, `below`, `reset` or `reset-due`. Rows include ID, owner agent, mode, state, watch, created/deadline/completed times and completion cause. |
| Threads | `GET /threads?project=&agent=&viewer=` (`agent` filters members, `viewer` controls access); `POST /threads` (`title`, `members` snapshot or `watch`, optional `private`, `joinable`, `include_user`); `GET /threads/{tid}?agent=` (metadata, message page, recent events); `GET /threads/{tid}/metadata?agent=`; `GET /threads/{tid}/messages?agent=` (message page only); `POST /threads/{tid}/read` (`message`: user read-through ID); `POST /threads/{tid}/members` or `/members/remove` (`members`); `POST /threads/{tid}/owner` (`owner` agent ID); `POST /threads/{tid}/user` (`joined`: boolean) |
| Messages | `POST /messages` (`thread`, `text`, optional sender `agent`; returns `id`, `not_woken`); `GET /messages/{id}?agent=`; `GET /inbox/{agent}?mark=`; `POST /marks` (`agent`, `ids`, `mark`) |
| Locks | `GET /locks?project=`; `GET /locks/{id}?project=`; `POST /locks` (`name`, `about`, caller `agent` or user `project`); `POST /locks/acquire` (`agent`, `name`, optional `wait`, `ttl`); `POST /locks/release` (`agent`, `name`); `POST /locks/free` (`project`, `name`) |
| Configs | `GET /configs` (virtual Default and saved configs with settings/project IDs); `GET /configs/{id}`; `POST /configs` (`name`, `settings`); `PUT /configs/{id}` (`settings`, optional `name`); `POST /configs/{id}/remove`; `PUT /projects/{id}/config` (`config` ID, or `custom` settings) |
| History & notices | `GET /history?project=&viewer=&agent=&thread=&lock=&kind=`; `GET /history/{id}?project=&viewer=`; `GET /activity?project=&agent=`; `GET /activity/{id}?project=&agent=`; `GET /notices/{agent}`; `GET /notices/{agent}/{id}`; `GET /receipts/{id}?agent=` |
| Usage | `GET /limits?project=` (includes usage/check status); `POST /usage/check` (`provider`) |

This inventory shows route-specific parameters, not every optional response field. Shared read protocols:

- **Collections** accept `limit` (default 50, 1–200), `max_bytes` (default 16000, 512–65536), exclusive `before`/`after` IDs, a fixed `through` ceiling and a `revision`. Responses contain `items`, `has_more`, continuation cursors, `through`, `revision` and `total`. Default direction is newest-first; `after=0` starts oldest-first, and inbox defaults oldest-first. Continue using the returned ceiling/revision; a changed mutable snapshot gives 409, not a mixed traversal. Fresh `since=<revision>` polling returns `unchanged:true` when unchanged. Oversized records become explicit ID stubs, so cursors advance without silently losing records.
- **Record reads** return a full JSON value when it fits; otherwise `truncated:true`, `total_bytes`, `next_offset:0` and `version`. Request `offset=0`, then retain `version` with `next_offset`. Concatenate JSON `chunk` strings; offsets are UTF-8 byte boundaries. Changed versions give 409 and require restarting. Thread reads nest a message page in their metadata, which can itself need record chunks. Successful oversized mutation responses retain a `command.receipt` ID; read `/receipts/{id}` instead of repeating the action.
- **History** uses `events`, `has_more` and exclusive positive `next_before`/`next_after` event IDs, with the same count/byte bounds; it does not use collection revisions or `through`. Full stub records are available at `/history/{id}`.
- **Logs** return bounded readable `text` with byte `start`/`end`, `through`, `version`, `revision`, `next_before`/`next_after`, `has_more` and partial-line flags. Default is the latest 200 lines, still byte-bounded. Continue with the returned version/ceiling and concatenate partial chunks; a changed file identity or incompatible ceiling gives 409. **Folders** instead return `entries` and opaque `d:`/`f:` name cursors tied to a required revision on continuation.

Private-thread access and project scoping apply to agent-personalized reads; log reads are limited to that agent or the user. Reading/acknowledging content remains separate from work marks.

### Request validation and outcomes

This contract applies to every command/endpoint, including future additions:

- Validate request shape, field names, types, ranges, closed-set values, referenced resources, option combinations, permissions and lifecycle eligibility before changing business state. Reject unknown fields/flags/query parameters rather than ignoring a typo. Document deliberately open-ended values, such as user-supplied custom model IDs; do not incorrectly restrict them to a built-in catalog.
- Only an omitted optional field receives its documented default. Supplied null, empty, malformed or out-of-range values require explicit semantics or an error; they must not silently become a default, the user identity or a broader filter.
- Canonical identifiers are separate from display labels. Accepted aliases must normalize to one canonical value in shared server/application validation, before storage and matching. Usage-window validation must distinguish unknown names from recognized windows with missing readings; include previously observed dynamic/optional windows, not just the latest response.
- Rejected validation creates no business state or worker and consumes no delivery/cursor. Return a useful error naming the field/problem and valid choices or a bounded discovery command. CLI failures use nonzero exit codes; HTTP failures use an appropriate error status and JSON error body.
- A success result identifies the operation's actual stage and relevant IDs: a registration or queued start is not a completed event or successful provider turn. Expose later failures/waiting reasons. If a write's response is lost, report uncertainty and how to inspect the result before retrying; do not claim rejection or automatically repeat the mutation.
- A CLI stdout broken pipe (for example, a consumer such as `head` exiting early) exits quietly without a panic/backtrace, with status zero for an otherwise successful command. Known command failures, including partial bulk-resume failures, retain nonzero status; other output errors also remain failures. An interrupted wait write is not acknowledged; successfully writing and flushing the full receipt is still required before ACK. This CLI behavior does not change server supervision or signal handling.

The HTTP boundary declares allowed fields for each route and rejects unknown/duplicate JSON keys (including nested keys), unknown/repeated query parameters, malformed encoding and invalid supplied types/ranges. Bodyless calls use an empty object; explicit non-object JSON is rejected. Documented normalization remains valid: private threads always return `joinable:false`, even if `joinable:true` was supplied. Settings reject unknown nested fields, and startup rejects invalid stored settings before changing saved state rather than falling back to Default. Regression coverage includes rejected calls leaving state, registrations and pending deliveries unchanged. This is not a guarantee that providers support every otherwise valid custom model or that every possible semantic bug has been ruled out.

## Build notes

- Rust, one crate, one binary. Crates: `rusqlite` (bundled SQLite), `tiny_http` (blocking, one thread per request), `ureq` (HTTPS client), `chrono` (provider reset timestamps), `serde` / `serde_json`, `clap`, `libc`.
- Files: `src/main.rs` (CLI), `src/server.rs` (HTTP), `src/app.rs` (state and rules), `src/app/agent_query.rs` (shared agent filtering), `src/app/subscriptions.rs` (event matching and durable deliveries), `src/app/diagnostics.rs` (advisory wake-loop detection), `src/run.rs` (starting, following and stopping turns), `src/harness.rs` (each harness's command line and output), `src/usage.rs` (account checks and scheduling), `src/ui.html`, `src/guide.md` and `src/models.md` (built in with `include_str!`). Plain HTML, CSS and JS; no framework, no build step.
- One SQLite connection behind a mutex, plus a condvar that every change notifies. `lock acquire --wait` blocks on it. A once-a-second tick expires locks, acts on usage limits, processes subscriptions/diagnostics, and serves the wake line. Lock queues live in memory; event registrations and their deliveries persist in SQLite.
- **Launching** validates and commits identity before startup. Refusal records no child; failed startup leaves a visible crashed child and restores a `--done` caller's finishing request. Each turn's state, live memberships, prompt summary and notification cursors are prepared under one savepoint/mutex. A child receives no task until that transaction commits; failure rolls it back and stops/reaps the child. True replacement commits successor ownership separately before startup and never restores the predecessor after that commit.
- **Running a turn.** acom starts the harness in the agent's project folder, in its own process group, with `ACOM_ID`, `ACOM_URL`, `ACOM_HOME` and `PATH` starting with acom's own folder:
  - Claude: `claude -p --output-format stream-json --verbose <extra flags> --model <m> --effort <e> --session-id <uuid>` (or `--resume <uuid>`) `--autocompact <hard context> --settings <PostToolUse hook running acom hook> --disallowedTools Agent,Workflow,SendMessage,ListAgents --allowedTools "Bash(acom *)"`. The prompt goes on stdin.
  - Codex: `codex exec [resume] --json --skip-git-repo-check <extra flags> -m <m> -c model=<m> -c model_reasoning_effort=<e> --disable multi_agent -c model_auto_compact_token_limit=<hard context> -c sandbox_workspace_write.network_access=true -c hooks.PostToolUse=... --dangerously-bypass-hook-trust [<session>] -`, with the prompt on stdin. `exec resume` doesn't take every flag `exec` does (e.g. `--sandbox`), so those are dropped on resume; the session keeps them.
  - Compaction flags are left out when the hard context limit is unset.
- **The hook.** `acom hook` asks the server what's new for `ACOM_ID` and prints `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "..."}}`, which both harnesses add to the agent's context. Nothing new prints nothing.
- **Turn end.** Success follows the finishing/rest/continuation/replacement rules above. Eligible pending messages/events can start a next turn once the old turn and required cleanup finish, subject to limits. Unexpected nonzero exit or explicit harness failure becomes a crash even after a zero exit, except recognized quota or intentional-stop paths. Buffered stdout/side-file events are drained before final classification. Failed/stopped process groups and owned tools are cleaned before recovery; an unconfirmed native session is not resumed.
- **Pausing** sends SIGTERM to the process group, then SIGKILL after a few seconds.
- **Usage.**
  - Claude, from its output stream: each assistant message gives the context size, the turn's `result` gives its token totals, and `rate_limit_event` gives each usage window's utilization (a fraction, shown as %) and reset time.
  - Codex: stdout gives the session ID (`thread.started`) and totals (`turn.completed`); its session file (`~/.codex/sessions/.../rollout-*-<session>.jsonl`) gives `token_count` events with totals, the context size and `rate_limits` (used %, window, reset time). acom follows that file while the turn runs, from its end on resumed sessions.
  - Background checks read Claude's OAuth usage endpoint using the local `.credentials.json` login (renewed by the CLI when expired), or `CLAUDE_CODE_OAUTH_TOKEN`; Codex uses `account/rateLimits/read` over app-server stdio. No model turns or reset credits are spent. Provider interfaces can change, and missing/expired credentials or network errors keep the last reading. A reset time never clears a window without confirmation. Each provider has at most one check in flight; a check started before a new harness limit cannot clear that interruption's marker.

Storage schema summary (columns; constraints/indexes/triggers are defined in the source):

```
projects (id, path, name, created_at, config, custom)  -- id never reused; custom JSON overrides config
agents   (id, project, name, grp, task, problem, seen_model, harness, model, effort, state, rest, status_text, session_id, session_started,
          launched_by, launched_at, pid, pause_reason, pause_from, paused_at, done_req,
          context, context_warned, fresh_in, cache_write, cache_read, output, turns, ended_at,
          wake_queued_at, wake_why)
threads  (id, project, title, created_by, created_at)
thread_access (thread_id, private, joinable)
thread_owners (thread_id, agent_id)                  -- override; creator owns when absent
thread_exclusions (thread_id, agent_id)             -- persistent live-roster removals
members  (thread_id, agent_id, last_notified)
thread_filters (thread_id, states, groups, watch)      -- live selectors, JSON arrays
member_intervals (id, thread_id, agent_id, start_after, end_after) -- message-ID boundaries
messages (id, thread_id, sender, text, at)              -- sender: agent ID, or 0 for the user
marks    (agent_id, message_id, mark)                   -- no row = new
user_reads (thread_id, message_id)
locks    (project, name, about, created_at, holder, acquired_at, expires_at, frozen, frozen_left)
notices  (id, agent_id, text, at, shown)                -- what to tell an agent next, incl. lost locks
update_deliveries (id, agent_id, text)                 -- immutable unacknowledged wait batch
wait_watch_cursors (agent_id, filter, event_id)
agent_retries (agent_id, source, effort, tried, handled, replacement, blocked, same_model_attempts, eligible_at)
agent_continuations (agent_id, text, blocked, attempted)
agent_handoffs (agent_id, request, blocked, attempted)
agent_starts (agent_id, predecessor, blocked, attempted)
usage    (provider, win, used_pct, resets_at, at)
usage_checks (provider, checked_at, attempted_at, next_check, error, in_flight)
usage_soft_warnings (agent_id, provider, scope, threshold, windows) -- warned usage scopes awaiting observed recovery
agent_quota_blocks (agent_id, provider, win)          -- explicit provider interruption, not percentage enforcement
activity (id, project, at, actor, what)                -- project NULL: about all projects
events   (id, project, at, kind, actor, agent, thread, lock, details) -- coordination history
summary_cursors (agent_id, event_id)                   -- lifecycle summary position
subscriptions (id, agent, project, mode, state, watch, created_at, deadline, cursor, completed_at, completion)
subscription_updates (id, subscription, agent, at, event_key, cause, delivered, delivery_id)
subscription_starts (agent, at, error)                -- durable event-wake startup attempt/error
usage_reset_notices (provider, win, resets_at)         -- estimated reset notification deduplication
usage_observations (provider, win, used_pct, resets_at, at) -- last observation across omitted windows
diagnostic_patterns (project, pattern, last_event, last_at) -- suspected-loop warning deduplication
history_origin (id, message_id)                       -- messages before tracking have unknown context
configs  (id, name, settings)                          -- saved configs only, IDs >= 2; settings is JSON
view_revisions (name, value)                          -- collection change counters
view_ids (name, id)                                   -- retained ID high-water marks
```

The lock table retains `frozen` and `frozen_left` storage fields; current controls never freeze a lease. Incompatible schemas are rejected without clearing saved data; startup explains using a separate data directory. SQLite also creates its own transaction/index metadata.

`logs/<agent ID>.jsonl` captures harness stdout, `.err` appends stderr, and `.txt` contains readable event captures with UTC timestamp/type headers. Native JSONL truncation/rewriting does not rewrite these captured output files. Native transcript paths are resolved by the harness; resumptions use only confirmed sessions. Browser drafts/theme preferences are not in SQLite.

## Not included

- Approving agents' permission requests from the UI, or a terminal in the UI that you can attach to any agent (planned: agents would then not need full permissions)
- API keys (subscriptions only for now; planned later)
- Token budgets
- Harnesses other than Claude Code and Codex
- Authentication or a security sandbox between local processes; remote listening (loopback only). Private-thread rules are coordination access rules, not OS isolation
- Editing or deleting messages, threads, locks or agents
- Attachments, raw HTML or rich-text editing; messages retain their original text
- Rules for how agents coordinate
