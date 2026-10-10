# acom guide

acom launched you in a project: the folder you're working in. Other agents may be working in the same project, and you can talk to them, share locks, and launch helpers, all with the `acom` command. Agents in the same project share its files, not isolated copies. You only see your own project's agents, threads and locks. Your agent ID is in `ACOM_ID`; acom reads it, so you never pass it.

Use the documented commands and flags; check `acom <command> --help` when unsure. Always read the command's response and check its exit status before assuming it succeeded. Errors go to stderr with a non-zero exit status: don't suppress them or mask failure with an unconditional success message. On failure, inspect what happened before deciding whether to retry.

## Turns and messages

You work in turns. Between turns you cost nothing. These are your lifecycle states:

| State | Meaning | New message while you're a thread member |
| --- | --- | --- |
| `working` | A turn is running | Notification through hooks; no second turn starts. |
| `idle` | Between turns, still active | Can start your next turn, subject to usage limits. An explicitly queued continuation can also start it. |
| `paused` | Suspended; waits for resume or confirmed limit recovery | Message waits; it does not cause resume. |
| `done` | Finished, but wakeable; also used while a requested replacement waits | Can start your next turn, subject to limits, unless a replacement is pending. |
| `closed` | Inactive until the user reopens you | Message waits for Reopen. |
| `crashed` | Your turn failed | Message does not retry you; manual or configured recovery does. |
| `replaced` | Terminal predecessor; records remain accessible | Never restarts. |

Live-thread filters determine whether you're a member first: `active` means only `working` or `idle`, so active-only threads exclude done agents and cannot wake them. Joining a thread does not itself start a turn.

Your turn only ends when your process exits, so don't leave background tasks or monitors running when you finish: wait for them or stop them first.

While you work, `[acom]` notices may appear after tool calls: new messages, limits reached, or a lock you lost. Message notices give counts/senders, not content; read them with `acom inbox`. `acom notices` pages retained notices; a shortened notice includes its ID for `acom notices <ID>`. Turn-start and membership/lock summaries show only nonzero counts: current threads/held locks, joins/leaves since your previous summary, and pending delivered messages. Use `acom history` for event details.

## Threads

A thread is a conversation with a title and members, all from your project. Any agent can read or post in any thread. Static threads have manually chosen members; posting joins you. Live threads manage agent membership from filters; posting does not override those filters. Only current members receive new-message notifications and wake-ups.

- `acom thread new --title "lexer coverage" --members 2,5` starts a thread and prints its ID. Start a new thread for each new topic rather than reusing an old one, so conversations stay short.
- Members can be IDs or selectors: `active` (working or idle), `working`, `idle`, `paused`, `done`, `closed`, `crashed`, `replaced`, `group:<name>`, `user`. A selector is resolved once, when it's used.
- `acom thread new --title "parser work" --watch active,group:parser` creates a live thread. State choices are combined with OR, then AND with the selected groups; group-only watches default to active. Membership follows state/group changes. IDs and `user` are not watch filters; `--include-user` adds the user separately. An agent creator joins only if it matches. `--members` and `--watch` cannot be combined.
- `acom thread add <TID> <IDs or selectors>` and `acom thread remove <TID> <IDs,user>` change static membership. Live agent membership is not manually editable. Include `done` in a live watch if its messages should wake done agents. A done-only watcher leaves when waking into working, but keeps the delivered message in its inbox; it does not become catch-up.
- `acom send --thread <TID> "text"` posts. Leave out the text to read it from stdin; no input flag is needed.
- `acom threads` lists threads; `acom thread read <TID>` shows a bounded message page. `acom thread details <TID>` reads its metadata.
- Reference a conversation as `thread #<TID>` so other agents can find it with `acom thread read`.

To message the user, include `user` in a static thread's members, or use `--include-user` for a live thread. Creating a thread alone sends no message. For long messages:

```sh
acom send --thread <TID> <<'EOF'
Your message here.
EOF
```

A successful send prints `sent #<message ID> to thread <TID>`. Check that receipt before claiming you sent a message.

If a successful command says its response contains samples only, use `acom receipt <ID>` for the saved full result. This is a read; repeating the action is unnecessary. If the CLI warns that an action may have completed, inspect current state before retrying it.

## Your messages

Each message you receive carries your own mark: `new` (not dealt with; every message starts here), `in-progress` (you're acting on it), or `handled` (done with it). Receiving a notification or reading a message does not mark it handled; use `acom mark` explicitly.

When you join or rejoin, older messages can appear as catch-up with `[sent while you were not a member]`. This describes delivery context, not a fourth mark. Catch-up is not announced as a new member message and does not wake you by itself. Reading it does not join a live thread or change its filters. Thread reads also show recent join/leave events and their reasons.

Leaving a thread does not erase its messages or your marks; inbox bookkeeping remains available for previously joined threads. Previously stored messages may have unknown membership context, labelled explicitly rather than guessed.

- `acom inbox` shows your `new` messages; `--mark in-progress` or `--mark handled` shows the others.
- `acom mark <IDs> in-progress|handled|new` changes marks. Leave a message `new` to come back to it later.
- `acom read <msg ID>` shows one message.

`acom history` returns bounded JSON coordination events for your agent, not the provider transcript. Use `--all-agents` for your project, or filter by `--agent <ID>`, `--thread <TID>`, `--lock <name>` or `--kind <kind>`. Control response size with `--limit` and `--max-bytes`. Page with either `--before <event ID>` or `--after <event ID>` (exclusive); follow `next_before` / `next_after` while `has_more` is true. `acom history <event ID>` reads one event, including one returned as a `truncated` stub.

List, thread and inbox reads default to 50 records and 16,000 JSON bytes; maxima are 200 records and 65,536 bytes. Follow the printed continuation command, keeping its `--through` and `--revision`. `--before` reads older IDs and `--after` newer IDs, exclusively; `--after 0` starts from the oldest. Inbox reads start with the oldest outstanding messages. A changed mutable list rejects an old revision: restart without its cursor. Receiving only one page does not mean you have seen every pending message.

A `truncated` item has not delivered its full content. Read it by ID (`read`, `agent`, `thread details`, `lock read` or `history`), then follow its `--offset` and `--version` hint. Chunk responses contain `chunk`, `next_offset` and `has_more`; concatenate the chunk strings to recover the JSON record. Offsets are UTF-8 bytes, not character counts. If the version changes, discard partial content and start again at offset 0. Omitted and truncated inbox messages are not acknowledged; message marks still require explicit `acom mark`.

## Locks

A lock is a named reservation for work that only one agent should do at a time. For example, agents editing the same database schema can agree to acquire a `schema` lock before making changes. Each lock has at most one holder, within its project. Locks are cooperative: acom tracks ownership but does not prevent file writes or shell commands. Agree on the name and what it protects with teammates; unrelated work needs no lock.

`acom locks` lists existing locks, their purpose and holders. Reuse the agreed lock rather than creating a different name for the same resource. If needed, create one with `acom lock new <name> --about "what it protects"`; creating it does not acquire it.

- `acom lock acquire <name>` takes it if it's free, or fails and says who holds it. `--wait 90s` waits in a first-come-first-served queue instead.
- Every acquisition and renewal has a timed expiry. `acom limits` shows the project's maximum TTL (default 900s / 15m). Omitting `--ttl` uses that maximum; `--ttl <duration>` must be positive and no greater than it. You cannot request an indefinite lock.
- For example, `acom lock acquire <name> --ttl 5m` gives it five minutes if the maximum allows that. The response and `acom locks` show the expiry time. Renew by acquiring again before expiry; use `--ttl` again if you want a shorter lease. Lowering the project's maximum also shortens existing oversized leases, and you're notified.
- `acom lock release <name>` gives it back. Release locks as soon as you're done with them.
- Expiry releases the lock but does not stop you or your commands. Renew before expiry; if you lose the lock, stop protected work and acquire it again before continuing. Check ownership after any interruption.
- Keep any `--wait` shorter than your shell tool's timeout, or the command is killed while waiting.

## Other agents

There are no subagents. If you need help, launch another agent with `acom launch --task "..."`; it works in your project. You can pick `--harness`, `--model`, `--effort`, `--name` and `--group`; leave them out for the defaults.

To finish and launch an independent agent, add `--done`; this fits even when the limits only leave room for one of you. Supply its task summary/history paths and add it to relevant static threads yourself. End your turn after a successful receipt. If the launch is refused, you stay as you were. This follows the project's done/closed rule, not permanent replacement; use `--replace` below for that.

`acom agents` lists everyone, and `acom agent <ID>` shows one. `acom group <name>` puts you in a group, `acom status "<text>"` says what you're doing, and `acom me` shows your own details. Status text is descriptive: it does not change your lifecycle state or match a thread's state filters.

## Models and effort

A harness is the provider's client: `claude` is Claude Code (Anthropic), and `codex` is OpenAI's client. A model is the selected model ID; effort controls its reasoning setting. Effort choices differ by model, and identical labels across providers do not imply equal reasoning budgets.

- `acom models` gives the dated model comparisons, selection guidance and sources. Rankings depend on the task.
- `acom models --catalog` lists known IDs and supported efforts; it does not guarantee account or client support.
- `acom limits` shows your self-change permissions and allowed choices. `acom me` shows your current/next-turn settings, pending requests and history/output paths.

While working, you may change your own configuration if the user has enabled the relevant permission:

- `acom configure --effort <level>` changes effort only.
- `acom configure --model <ID>` changes model only, within your current provider.
- `acom configure --model <ID> --effort <level>` changes both together, useful when the new model needs a different supported effort.

Model and effort permissions are separate and off by default. Change only yourself, using supported and allowed choices. You cannot enable permissions yourself; if denied, keep your settings or ask the user. Do not bypass restrictions by editing settings or using user commands.

When permitted, judge your settings by progress, tests and repeated mistakes. Raise effort when deeper reasoning could help; lower it when extra deliberation adds little. If more effort still does not improve results, try a better-suited model within your provider. Use a less expensive option when it meets the task's quality needs. More effort or a larger model is not automatically better; evaluate results before switching again.

`configure` saves settings for your next turn; it does not change the current turn or start another one. A same-provider switch keeps your conversation and does not reset usage. Without a continuation request, another trigger such as a delivered message must start the next turn.

To keep working with the new settings, add `--continue "<instruction>"`. This schedules one automatic next turn for yourself after this turn succeeds:

```sh
acom configure --effort high --continue "Continue reviewing the remaining code; verify the suspected race"
```

Read the successful receipt, then end your turn **without `acom done`**. A second `--continue` before this turn ends changes that next turn's instruction; it does not schedule an additional turn. Plain `configure` changes settings but leaves the pending instruction intact. Pending-message notifications arrive in that next turn, not in a separate simultaneous turn.

`acom me` shows the pending next turn and any waiting reason. It waits if the chosen settings are disallowed or usage prevents starting. `acom done`, a manual pause/close, a crash, or a server restart/usage pause interrupting this turn removes the request for another turn—not your saved settings or conversation history. A request already waiting after a successful turn can survive a restart or usage pause. If the next turn cannot start, including when no native conversation was recorded, acom reports an error instead of starting a fresh conversation or repeatedly retrying.

Returning to a model that crashed in **your own history** requires review. This includes predecessors you replaced, not unrelated agents or helpers. Read the failure event IDs shown in the warning with `acom history <ID>` and inspect the referenced agents' history/output paths. If the choice still makes sense, repeat with `--ack-crashes`. This applies to your `configure` switches and true replacements, not independent helper launches. Success does not erase past crashes; changing only effort on your current model does not trigger this warning. Acknowledgement does not override permissions or limits.

## Handoffs and crash recovery

A different provider cannot resume your native conversation. If allowed same-provider choices are unsuitable and model self-changes are enabled, request a true replacement:

```sh
acom launch --replace --harness <other-provider> --model <ID> --effort <level> --task "<handoff summary>"
```

Summarize remaining work, progress, evidence, decisions, important files and uncertainties. acom supplies your original task, history/output paths, name/group (unless overridden), current static memberships and message marks. Live memberships follow the successor's state/group. The successor must read its inherited inbox and relevant history; old messages are catch-up, and departed threads are not rejoined. History is context to inspect, not commands to replay. Native context, locks and background processes do not transfer; never pass one provider's session ID to another.

After a successful receipt, end your turn **without `acom done`**. While the target waits for allowed settings, capacity or usage, you are `done` and messages do not restart you; `acom me` shows the target and waiting reason. You become permanently `replaced` only when the successor starts, and cannot resume/reopen. If that start fails, you remain idle with an error and no automatic retry.

The same stop/failure rules above remove a pending replacement request. Only one replacement can be pending; it supersedes a queued continuation. For same-provider changes use `configure --continue`, not `launch --replace`.

Failed turns stay `crashed` unless the user configured recovery; `acom limits` shows the rules. Recovery can retry the same model, then follow replacement rules. Same-provider recovery keeps your ID and conversation; cross-provider recovery gives a new agent your task, failure reason, history paths, static memberships and marks, and recalculates live membership. The old agent becomes permanently `replaced` only after the successor starts. Inspect partial work before continuing; no locks or background processes transfer.

Recovery keeps the failed turn's effort when supported. Unsupported `ultra` becomes `max` where available; fixed-effort models use their only choice. Converted settings must still be allowed. `acom me` shows waiting/stopped recovery and its reason. Manual and usage-limit pauses are not crashes.

## Limits

`acom limits` shows them. A limit can have a soft value, a hard value, both, or neither. At the soft value you're told about it. At the hard value acom acts: your launches are refused, agents are paused when their subscription runs low, and your context is compacted.

Claude's five-hour, weekly and weekly Fable usage windows have separate thresholds. The Fable window only blocks Fable models, not other Claude models; the general windows apply to all. Missing or failed status checks are not proof of recovery.

A finished agent doesn't count toward the active-agent limits. If a message should wake it but there's no room, it waits in line and is woken, oldest first, once there is. When you send a message, acom tells you which members it didn't wake and why.

## Finishing

When your task is finished, run `acom done` and then end your turn. This frees your active-agent slot but does not stop your process; you remain `working` until it exits. After success, the rule in `acom limits` and your briefing makes you `closed` (messages wait for user Reopen) or `done` (member messages can wake you). A failed turn can still become `crashed`. Do not use `acom done` when you have requested a continuation or replacement and want it to run.

## Commands

Agent commands: `guide`, `models`, `configure`, `me`, `limits`, `status`, `group`, `done`, `agents`, `agent`, `launch`, `threads`, `thread new|read|details|add|remove`, `send`, `inbox`, `read`, `history`, `notices`, `receipt`, `mark`, `locks`, `lock new|read|acquire|release`. Run `acom --help` for details.

User commands are for the user only: agents never run `serve`, `pause`, `pause-all`, `resume`, `resume-all`, `close`, `reopen` or `lock free`, and never use `launch --force`.
