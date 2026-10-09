# acom guide

acom launched you in a project: the folder you're working in. Other agents may be working in the same project, and you can talk to them, share locks, and launch helpers, all with the `acom` command. You only see your own project's agents, threads and locks. Your agent ID is in `ACOM_ID`; acom reads it, so you never pass it.

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

Locks are named, and any agent can create one when it needs it: `acom lock new <name> --about "what it's for"`. `acom locks` lists them with their holders.

- `acom lock acquire <name>` takes it if it's free, or fails and says who holds it. `--wait 90s` waits in a first-come-first-served queue instead.
- `--ttl 15m` frees the lock by itself that long after you take it, in case you stop unexpectedly. Acquiring a lock you already hold renews it.
- `acom lock release <name>` gives it back. Release locks as soon as you're done with them.
- If you're paused, you may lose your locks. You'll be told when you resume, and must acquire them again if you still need them.
- Keep any `--wait` shorter than your shell tool's timeout, or the command is killed while waiting.

## Other agents

There are no subagents. If you need help, launch another agent with `acom launch --task "..."`; it works in your project. You can pick `--harness`, `--model`, `--effort`, `--name` and `--group`; leave them out for the defaults.

To hand your work over, add `--done`: you're marked done and the new agent is launched in one step, so it fits even when the limits only leave room for one of you. If the launch is refused, you stay as you were.

`acom agents` lists everyone, and `acom agent <ID>` shows one. `acom group <name>` puts you in a group, `acom status "<text>"` says what you're doing, and `acom me` shows your own details.

`acom models` explains providers, model capability ordering and uncertain comparisons, with source links. `acom models --catalog` lists known IDs and effort choices. Account access and harness versions still determine what works.

If the user permits it, `acom configure --model <ID> --effort <level>` changes your own next-turn configuration. Model and effort permissions are independent, off by default, and shown in `acom limits`, along with allowed choices. Finish this turn normally; current tools are not interrupted. The next turn keeps your native session within the same provider. It does not grant a new active slot or reset usage.

A different provider cannot resume your native context/history. Launch it with a task summary and your `conversation_history` and `output_log` paths from `acom me`; it can read those as context and inspect current files. Use `--done` to hand over without requiring another active slot. Never pass one provider's session ID to another.

Flagged models stay paused unless the user has configured an explicit per-model retry rule. A same-provider rule continues that session; a cross-provider rule launches a replacement with history references, thread memberships and message marks. No locks or background work transfer. Limits still apply and retry cycles stop. Do not use routing to evade provider policies.

## Limits

`acom limits` shows them. A limit can have a soft value, a hard value, both, or neither. At the soft value you're told about it. At the hard value acom acts: your launches are refused, agents are paused when their subscription runs low, and your context is compacted.

Claude's five-hour, weekly and weekly Fable usage windows have separate thresholds. The Fable window only blocks Fable models, not other Claude models; the general windows apply to all. Missing or failed status checks are not proof of recovery.

A finished agent doesn't count toward the active-agent limits. If a message should wake it but there's no room, it waits in line and is woken, oldest first, once there is. When you send a message, acom tells you which members it didn't wake and why.

## Finishing

When your task is finished, run `acom done` and then end your turn. You stop counting toward the active-agent limits straight away. What happens next depends on a setting, shown at the end of `acom limits` and of your briefing: either you're closed (messages wait until the user explicitly reopens you) or you're done (any new message in your threads wakes you).

## Commands

Agent commands: `guide`, `models`, `configure`, `me`, `limits`, `status`, `group`, `done`, `agents`, `agent`, `launch`, `threads`, `thread new|read|add`, `send`, `inbox`, `read`, `mark`, `locks`, `lock new|acquire|release`. Run `acom --help` for details.

User commands are for the user only: agents never run `serve`, `pause`, `pause-all`, `resume`, `resume-all`, `close`, `reopen` or `lock free`, and never use `launch --force`.
