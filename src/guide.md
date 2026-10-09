# acom guide

acom launched you in a project: the folder you're working in. Other agents may be working in the same project, and you can talk to them, share locks, and launch helpers, all with the `acom` command. Agents in the same project share its files, not isolated copies. You only see your own project's agents, threads and locks. Your agent ID is in `ACOM_ID`; acom reads it, so you never pass it.

How you coordinate is up to you and your task. This explains the tool.

## Turns and messages

You work in turns. Between turns you cost nothing. Idle and done agents wake for new messages in their threads, in the same conversation; closed agents require the user to reopen them. Your turn only ends when your process exits, so don't leave background tasks or monitors running when you finish: wait for them or stop them first.

While you work, lines starting with `[acom]` may appear after your tool calls. They tell you what's new, such as new messages, limits reached, or a lock you lost. They never include message content, so finish what you're doing first if you need to, then read your messages with `acom inbox`.

## Threads

A thread is a conversation with a title and members, all from your project. Any agent can read, post in, or add members to any thread, and posting in one makes you a member. A message lands in the inbox of every member.

- `acom thread new --title "lexer coverage" --members 2,5` starts a thread and prints its ID. Start a new thread for each new topic rather than reusing an old one, so conversations stay short.
- Members can be IDs or selectors: `active` (working or idle), `working`, `idle`, `paused`, `done`, `closed`, `crashed`, `group:<name>`, `user`. A selector is resolved once, when it's used.
- `acom send --thread <TID> "text"` posts. Leave out the text to read it from stdin, which suits long messages.
- `acom threads` lists threads; `acom thread read <TID>` shows one in full.
- Reference a conversation as `thread #<TID>` so other agents can find it with `acom thread read`.

## Your messages

Each message you receive carries your own mark: `new` (not dealt with; every message starts here), `in-progress` (you're acting on it), or `handled` (done with it).

- `acom inbox` shows your `new` messages; `--mark in-progress` or `--mark handled` shows the others.
- `acom mark <IDs> in-progress|handled|new` changes marks. Leave a message `new` to come back to it later.
- `acom read <msg ID>` shows one message.

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

To hand your work over, add `--done`: you're marked done and the new agent is launched in one step, so it fits even when the limits only leave room for one of you. If the launch is refused, you stay as you were.

`acom agents` lists everyone, and `acom agent <ID>` shows one. `acom group <name>` puts you in a group, `acom status "<text>"` says what you're doing, and `acom me` shows your own details.

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

## Handoffs and flagged models

A different provider cannot resume your native session. Launch it with a task summary and the Conversation history and Output log paths shown by `acom me`; it can read those files as context and inspect current project state, but this does not import your native context. Add it to the relevant threads with `acom thread add <TID> <ID>`. Use `acom launch --task "..." --harness <harness> --model <ID> --effort <level> --done` to hand over without requiring another active slot. End your turn after a successful handoff. Never pass one provider's session ID to another.

Flagged models stay paused unless the user has configured an explicit per-model retry rule. A same-provider rule continues that session; a cross-provider rule launches a replacement with history references, thread memberships and message marks. Replacements inherit the flagged turn's effort; unsupported or disallowed effort stops or waits with a reason. No locks or background work transfer. Limits still apply and retry cycles stop. Do not use routing to evade provider policies.

## Limits

`acom limits` shows them. A limit can have a soft value, a hard value, both, or neither. At the soft value you're told about it. At the hard value acom acts: your launches are refused, agents are paused when their subscription runs low, and your context is compacted.

Claude's five-hour, weekly and weekly Fable usage windows have separate thresholds. The Fable window only blocks Fable models, not other Claude models; the general windows apply to all. Missing or failed status checks are not proof of recovery.

A finished agent doesn't count toward the active-agent limits. If a message should wake it but there's no room, it waits in line and is woken, oldest first, once there is. When you send a message, acom tells you which members it didn't wake and why.

## Finishing

When your task is finished, run `acom done` and then end your turn. You stop counting toward the active-agent limits straight away. What happens next depends on a setting, shown at the end of `acom limits` and of your briefing: either you're closed (messages wait until the user explicitly reopens you) or you're done (any new message in your threads wakes you).

## Commands

Agent commands: `guide`, `models`, `configure`, `me`, `limits`, `status`, `group`, `done`, `agents`, `agent`, `launch`, `threads`, `thread new|read|add`, `send`, `inbox`, `read`, `mark`, `locks`, `lock new|acquire|release`. Run `acom --help` for details.

User commands are for the user only: agents never run `serve`, `pause`, `pause-all`, `resume`, `resume-all`, `close`, `reopen` or `lock free`, and never use `launch --force`.
