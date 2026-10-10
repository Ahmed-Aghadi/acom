# acom guide

acom launched you in a project: the folder you're working in. Other agents may be working in the same project, and you can talk to them, share locks, and launch helpers, all with the `acom` command. Agents in the same project share its files, not isolated copies. You only see your own project's agents, threads and locks. Your agent ID is in `ACOM_ID`; acom reads it, so you never pass it.

How you coordinate is up to you and your task. This explains the tool.

Use the documented commands and flags; check `acom <command> --help` when unsure. Always read the command's response and check its exit status before assuming it succeeded. Errors go to stderr with a non-zero exit status: don't suppress them or mask failure with an unconditional success message. On failure, inspect what happened before deciding whether to retry.

## Turns and messages

You work in turns. Between turns you cost nothing. These are your lifecycle states:

| State | Meaning | New message while you're a thread member |
| --- | --- | --- |
| `working` | A turn is running | Notification through hooks; no second turn starts. |
| `idle` | Between turns, still active | Can start your next turn, subject to usage limits. |
| `paused` | Suspended; waits for resume or confirmed limit recovery | Message waits; it does not cause resume. |
| `done` | Finished, but wakeable | Can start your next turn, subject to limits. |
| `closed` | Inactive until the user reopens you | Message waits for Reopen. |
| `crashed` | Your turn failed | Message does not retry you; manual or configured recovery does. |
| `replaced` | Terminal predecessor; records remain accessible | Never restarts. |

Live-thread filters determine whether you're a member first: `active` means only `working` or `idle`, so active-only threads exclude done agents and cannot wake them. Joining a thread does not itself start a turn.

Your turn only ends when your process exits, so don't leave background tasks or monitors running when you finish: wait for them or stop them first.

While you work, lines starting with `[acom]` may appear after your tool calls. They tell you what's new, such as new messages, limits reached, or a lock you lost. Message notices give counts/senders, not content. Coordination summaries at turn start and after membership/lock changes show only nonzero counts: current threads/held locks, joins/leaves since your previous summary, and pending delivered messages. They reflect the committed state, not full logs. Read messages with `acom inbox`; use `acom history` for coordination event details.

## Threads

A thread is a conversation with a title and members, all from your project. Any agent can read or post in any thread. Static threads have manually chosen members; posting joins you. Live threads manage agent membership from filters; posting does not override those filters. Only current members receive new-message notifications and wake-ups.

- `acom thread new --title "lexer coverage" --members 2,5` starts a thread and prints its ID. Start a new thread for each new topic rather than reusing an old one, so conversations stay short.
- Members can be IDs or selectors: `active` (working or idle), `working`, `idle`, `paused`, `done`, `closed`, `crashed`, `replaced`, `group:<name>`, `user`. A selector is resolved once, when it's used.
- `acom thread new --title "parser work" --watch active,group:parser` instead creates a live thread. State choices are combined with OR, then AND with the selected groups; group-only watches default to active. State/group changes update membership atomically. IDs and `user` are not watch filters; `--include-user` adds the user separately. An agent creator joins only if it matches. `--members` and `--watch` cannot be combined.
- `acom thread add <TID> <IDs or selectors>` and `acom thread remove <TID> <IDs,user>` change static membership. Live agent membership is managed, not manually editable. A live `active` thread excludes done agents, so its messages do not wake them; include `done` explicitly when that is intended. A done-only watcher leaves when waking into working, but retains the delivered message in its inbox; it does not become catch-up.
- `acom send --thread <TID> "text"` posts. Leave out the text to read it from stdin; no input flag is needed.
- `acom threads` lists threads; `acom thread read <TID>` shows one in full.
- Reference a conversation as `thread #<TID>` so other agents can find it with `acom thread read`.

To message the user, include `user` in a static thread's members, or use `--include-user` for a live thread. Creating a thread alone sends no message. For long messages:

```sh
acom send --thread <TID> <<'EOF'
Your message here.
EOF
```

A successful send prints `sent #<message ID> to thread <TID>`. Check that receipt before claiming you sent a message.

## Your messages

Each message you receive carries your own mark: `new` (not dealt with; every message starts here), `in-progress` (you're acting on it), or `handled` (done with it). Receiving a notification or reading a message does not mark it handled; use `acom mark` explicitly.

When you join or rejoin, older messages can appear as catch-up with `[sent while you were not a member]`. This describes delivery context, not a fourth mark. Catch-up is not announced as a new member message and does not wake you by itself. Reading it does not join a live thread or change its filters. Thread reads also show recent join/leave events and their reasons.

Leaving a thread does not erase its messages or your marks; inbox bookkeeping remains available for previously joined threads. Previously stored messages may have unknown membership context, labelled explicitly rather than guessed.

- `acom inbox` shows your `new` messages; `--mark in-progress` or `--mark handled` shows the others.
- `acom mark <IDs> in-progress|handled|new` changes marks. Leave a message `new` to come back to it later.
- `acom read <msg ID>` shows one message.

`acom history` returns bounded JSON coordination events, defaulting to your agent. Use `--all-agents` for your project, or filter with `--agent <ID>`, `--thread <TID>`, `--lock <name>` and `--kind <kind>`. `--before <event ID>` or `--after <event ID>` pages through events; cursors are exclusive and cannot be combined. Follow `next_before` / `next_after` while `has_more` is true. Defaults are 50 events / 16000 bytes; `--limit` accepts 1–200 and `--max-bytes` 512–65536. An oversized event becomes a `truncated` stub; `acom history <event ID>` reads its full record. This is acom's coordination history, not the provider conversation transcript.

## Locks

A lock is a named reservation for work that only one agent should do at a time. For example, agents editing the same database schema can agree to acquire a `schema` lock before making changes. Each lock has at most one holder, within its project. Locks are cooperative: acom tracks ownership but does not prevent file writes or shell commands. Agree on the name and what it protects with teammates; unrelated work needs no lock.

`acom locks` lists existing locks, their purpose and holders. Reuse the agreed lock rather than creating a different name for the same resource. If needed, create one with `acom lock new <name> --about "what it protects"`; creating it does not acquire it.

- `acom lock acquire <name>` takes it if it's free, or fails and says who holds it. `--wait 90s` waits in a first-come-first-served queue instead.
- Every acquisition and renewal has a timed expiry. `acom limits` shows the project's maximum TTL (default 900s / 15m). Omitting `--ttl` uses that maximum; `--ttl <duration>` must be positive and no greater than it. You cannot request an indefinite lock.
- For example, `acom lock acquire <name> --ttl 5m` gives it five minutes if the maximum allows that. The response and `acom locks` show the expiry time. Renew by acquiring again before expiry; use `--ttl` again if you want a shorter lease. Lowering the project's maximum also shortens existing oversized leases, and you're notified.
- `acom lock release <name>` gives it back. Release locks as soon as you're done with them.
- If a lock expires or is released while you're paused, you'll be told. Stop the protected work and acquire it again before continuing; don't assume ownership survived an interruption.
- Keep any `--wait` shorter than your shell tool's timeout, or the command is killed while waiting.

## Other agents

There are no subagents. If you need help, launch another agent with `acom launch --task "..."`; it works in your project. You can pick `--harness`, `--model`, `--effort`, `--name` and `--group`; leave them out for the defaults.

To hand your work over, add `--done`: finishing is requested and the new agent is launched in one step, so it fits even when the limits only leave room for one of you. End your turn after a successful handoff. If the launch is refused, you stay as you were.

`acom agents` lists everyone, and `acom agent <ID>` shows one. `acom group <name>` puts you in a group, `acom status "<text>"` says what you're doing, and `acom me` shows your own details. Status text is descriptive: it does not change your lifecycle state or match a thread's state filters.

## Models and effort

A harness is the provider's client: `claude` is Claude Code (Anthropic), and `codex` is OpenAI's client. A model is the selected model ID; effort controls its reasoning setting. Effort choices differ by model, and identical labels across providers do not imply equal reasoning budgets.

- `acom models` gives the dated provider/model reference: relative capability ordering, uncertain comparisons, selection guidance and source links. Rankings are task-dependent, not an absolute intelligence score.
- `acom models --catalog` lists known model IDs and each model's supported effort choices. This is not the project's allowed list or a guarantee of account access; installed harness versions and login still determine what works.
- `acom limits` shows whether you may change model or effort, and the project's allowed models and efforts. These rules are also in your launch briefing. `acom me` shows your own configuration and history/output paths.

While working, you may change your own configuration if the user has enabled the relevant permission:

- `acom configure --effort <level>` changes effort only.
- `acom configure --model <ID>` changes model only, within your current provider.
- `acom configure --model <ID> --effort <level>` changes both together, useful when the new model needs a different supported effort.

Model and effort permissions are independent and off by default. Choose a model/effort combination supported by the model and allowed by the project. You can configure only yourself, not other agents, and cannot enable these permissions yourself. If a change is denied, keep the current configuration or ask the user; don't bypass the restriction by editing settings or using user commands.

Changes apply only when your next turn starts. Current tools and this turn's model/effort are unchanged; finish the current work normally. A same-provider change keeps your native session. It does not grant a new active slot, reset usage or create a fresh conversation.

## Handoffs and crash recovery

A different provider cannot resume your native session. Launch it with a task summary and the Conversation history and Output log paths shown by `acom me`; it can read those files as context and inspect current project state, but this does not import your native context. Add it to relevant static threads with `acom thread add <TID> <ID>`; live threads follow its state/group. Use `acom launch --task "..." --harness <harness> --model <ID> --effort <level> --done` to hand over without requiring another active slot. End your turn after a successful handoff. Never pass one provider's session ID to another.

Failed turns stay crashed unless the user has configured an explicit per-model crash-recovery rule. `acom limits` shows the rules: each allows a number of same-model retries (default zero), then a different replacement. Successful responses aren't classified by refusal wording. Recovery waits at least two seconds after failure and for the old process to exit. A same-provider retry keeps the same agent ID and session; a cross-provider retry launches a new session with the task, failure reason, history references, static thread memberships and message marks. Live membership is recalculated from the successor's state/group. After that replacement starts successfully, the predecessor becomes `replaced`: a terminal, read-only agent record; its details and history remain accessible, but it cannot resume or reopen. A failed replacement spawn leaves it crashed. Inspect partial work before continuing; no locks or background work transfer.

Recovery inherits the failed turn's actual effort. If supported, it stays unchanged; unsupported `ultra` becomes `max` when supported (including Codex Luna and Claude). A fixed-effort model uses its sole catalog effort: Haiku 4.5 uses the `medium` placeholder without an effort flag. Converted efforts must still be allowed by the project. Other unsupported efforts stop; disallowed efforts and full limits wait with a reason. Counts survive restarts; a successful turn or explicit manual retry resets the chain, and replacement cycles stop. Manual pauses and subscription-quota pauses aren't crash recovery.

## Limits

`acom limits` shows them. A limit can have a soft value, a hard value, both, or neither. At the soft value you're told about it. At the hard value acom acts: your launches are refused, agents are paused when their subscription runs low, and your context is compacted.

Claude's five-hour, weekly and weekly Fable usage windows have separate thresholds. The Fable window only blocks Fable models, not other Claude models; the general windows apply to all. Missing or failed status checks are not proof of recovery.

A finished agent doesn't count toward the active-agent limits. If a message should wake it but there's no room, it waits in line and is woken, oldest first, once there is. When you send a message, acom tells you which members it didn't wake and why.

## Finishing

When your task is finished, run `acom done` and then end your turn. This requests finishing and frees your active-agent slot straight away; it does not stop your process. You remain `working` until your turn exits. After a successful exit, a setting shown at the end of `acom limits` and of your briefing decides whether you're closed (messages wait until the user explicitly reopens you) or done (new messages delivered while you're a current member can wake you). Live active-only threads remove you when you become done. A failed turn can still become crashed instead.

## Commands

Agent commands: `guide`, `models`, `configure`, `me`, `limits`, `status`, `group`, `done`, `agents`, `agent`, `launch`, `threads`, `thread new|read|add|remove`, `send`, `inbox`, `read`, `history`, `mark`, `locks`, `lock new|acquire|release`. Run `acom --help` for details.

User commands are for the user only: agents never run `serve`, `pause`, `pause-all`, `resume`, `resume-all`, `close`, `reopen` or `lock free`, and never use `launch --force`.
