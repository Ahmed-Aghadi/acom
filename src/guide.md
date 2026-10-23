# acom guide

acom launched you in a project: the folder you're working in. Project agents share its files, not isolated copies. Use `acom` to communicate, coordinate work and launch independent peers. Agent-facing commands act on your project; `ACOM_ID` supplies your caller identity automatically.

Use documented commands and flags; check `acom <command> --help` when unsure. Read the response and check the exit status before assuming success. Errors go to stderr with a nonzero exit status: don't suppress or mask them. If an action may have completed, inspect its receipt/current state before retrying. `acom receipt <ID>` retrieves a saved full result without repeating the action.

Examples illustrate syntax and possibilities, not prescribed workflows. Choose members, filters, resources and timing for your task.

## Turns and lifecycle

A turn runs until your process exits. Between turns no model turn runs, but an idle agent still occupies an active-agent slot. Before ending, finish or stop shell/background tasks and monitors: they may outlive an ordinary idle turn and are not suspended. acom stops owned tools before finishing, failure/recovery, pause, continuation or replacement.

| State | Meaning | What can start another turn |
| --- | --- | --- |
| `working` | A turn is running | Updates arrive through hooks or waits; no overlapping turn starts. |
| `idle` | Between turns, still active | Member messages, subscription events, a deferred-wait deadline or queued continuation, subject to limits. |
| `paused` | Suspended by the user, a limit or restart | Resume, or confirmed usage recovery when auto-resume is enabled; messages wait. |
| `done` | Finished but message-wakeable; also used while a successor awaits startup | Member messages, subject to limits; not while a handoff/startup is pending. |
| `closed` | Inactive | User Reopen; messages wait. |
| `crashed` | A turn failed | Manual or configured recovery, not messages. |
| `replaced` | Terminal predecessor | Never; records remain inspectable. |

End your turn normally to become idle. Register any needed event/deadline trigger **before** yielding: ending a turn alone schedules nothing. Use `acom done` only when the task is finished, then end your turn. It requests the briefing's `closed` (default) or `done` outcome; it does not stop your process immediately, and failure can still become a crash. A message-woken done agent normally returns to done rather than staying active.

`acom status "<text>"` sets a user-visible progress summary, not your lifecycle state. Prefer setting a short status at task start. Update it when the overall phase, blocker or outcome meaningfully changes, including before yielding or finishing if it would otherwise be misleading. No per-step or periodic updates are needed.

`acom group <name>` changes your group. `acom me` shows identity, current/next-turn configuration, pending requests and history/output paths; `acom agent <ID>` inspects a peer.

While working, `[acom]` hook notices report new messages, limits, lost locks, subscribed events and coordination warnings. Message notifications contain counts/senders, not bodies: use `acom inbox`. Shortened notices identify `acom notices <ID>` for the full text. Turn-start and membership/lock summaries give nonzero counts and point to `acom history` for details.

## Threads and messages

A thread is a project conversation with a title, owner and members. **New messages from others in threads you belong to already notify you while working and wake you when idle**, subject to limits. No subscription is needed. Filters on waits/subscriptions do not suppress these ordinary messages. Joining, leaving or being added alone does not wake you or resolve a wait; membership changes remain in history and hook/next-turn summaries.

| Thread access | Reading | Posting / joining |
| --- | --- | --- |
| Public, open (default) | Any project agent | Posting joins a static thread. |
| Public, `--no-join` | Any project agent | Current members only; user/owner adds members. |
| `--private` | Current members only | Current members only; user/owner adds members. |

The user always has access and management rights. These are acom rules, not filesystem/process isolation. Reading a public thread without joining gives no automatic message notifications.

- `acom thread new --title "<topic>" --members 2,5,user` creates a static thread. Members accept IDs, lifecycle states, `active` (working or idle), `group:<name>` and `user`; selectors resolve once. A new topic usually deserves its own thread. Creation alone sends no message.
- `--watch active,group:<name>` instead makes a live public/open thread: any selected state AND any selected group. Group-only watches default to active; IDs and `user` are not watch filters. Use `--include-user` separately. `--watch` cannot combine with `--members`, `--private` or `--no-join`. Membership follows state/group changes atomically; the creator joins only if it matches.
- `acom thread add <TID> <IDs or selectors>` adds immediately, without acceptance. Any project agent may add to open static threads; only the user/current owner may add to restricted/live threads. `acom thread remove <TID> <your ID>` leaves; only the user removes others. Live removal persists as an exclusion until explicitly restored by the user/owner while the agent matches.
- Live `active` threads exclude done agents and cannot wake them. Include `done` if that is intended. A done-only member leaves on waking but retains the delivered message, not relabelled as catch-up.
- The creator initially owns the thread. Leaving retains ownership, not private read/post access; an owner can add itself again (live filters still apply). `acom thread transfer-owner <TID> <AGENT_ID>` transfers exclusive ownership to a non-replaced project agent without changing memberships. The previous owner's special rights end; metadata distinguishes current `owner` from original `created_by`.

`acom threads` lists threads; `acom thread details <TID>` shows metadata; `acom thread read <TID>` reads messages. Refer peers to `thread #<TID>`. To message the user, include `user` in static members or `--include-user` in a live thread, then post:

```sh
acom send --thread <TID> <<'EOF'
Your message here.
EOF
```

Omitted text is read from stdin; no input flag is needed. Success prints `sent #<message ID> to thread <TID>`; inspect that receipt and any members not woken before claiming delivery.

Notification delivery, reading and work completion are separate:

| Operation | Meaning |
| --- | --- |
| Hook / successful wait delivery | acom has notified you; it does not deliver message bodies or finish their work. |
| `acom inbox` / `acom read <ID>` / thread read | Read accessible content; does not mark it handled. |
| `acom mark <IDs> new\|in-progress\|handled` | Explicitly track work: not dealt with, acting on it, or finished. |

`acom inbox` defaults to your `new` messages; `--mark in-progress` or `--mark handled` selects others. A notification need not repeat just because a message remains new. Messages sent while you were not a member appear as catch-up labelled `[sent while you were not a member]`, independently of marks; rejoining preserves earlier membership periods. Catch-up itself does not wake you. Leaving retains marks and public-thread inbox bookkeeping, but private messages/history become inaccessible until you rejoin. Thread reads include recent membership/ownership events.

## Waiting and subscriptions

| Command | Lifetime and effect |
| --- | --- |
| `acom wait --timeout 10m [filters]` | Foreground: waits for ordinary notifications, selected events or timeout. You remain working. |
| `acom wait --idle --timeout 10m [filters]` | Returns immediately with a one-shot deferred-wait ID. Register, read the response, then end your turn normally without `acom done`. |
| `acom subscribe <filters>` | Persistent selected-event subscription until canceled; updates reach working hooks or wake you when idle. |

Wait timeouts default to 60s and allow 1s–1h. Foreground wait is **not a fixed sleep**: its timeout is an upper bound and notifications return early. Keep it below your shell tool's timeout, read every return, and inspect relevant inbox/notices before waiting again—even in timer loops. It still occupies an active slot and held lock TTLs continue.

A deferred wait resolves once on an ordinary notification, selected event or deadline. Ordinary notifications include member messages, notices, lock updates and pending event deliveries, **not membership changes alone**. An early-resolution notice names the wait ID/cause and cancels its timeout. Registration can already be resolved: read its response and immediate updates before yielding. It does not make you idle or suspend commands; your process must exit. Updates consumed while working do not start another turn. Subscription events/deadlines only wake idle agents, never done/paused/crashed/closed/replaced ones. Registrations, pending updates and IDs survive restart and true replacement.

Foreground deliveries have their own receipt IDs. Printed notifications are automatically acknowledged even if redirected; message marks are unchanged. If acknowledgement fails after complete text was received, follow the printed `acom wait --ack <delivery ID>` instruction. Otherwise repeat wait to replay the same delivery before changed filters apply; do not repeat the underlying action.

### Event filters

- `--agents all` or `--agents 2,5` watches **peer lifecycle transitions**, not messages or current-state snapshots. `all` includes future project agents, excluding you; explicit IDs do not follow replacements. `--states crashed,done,replaced` selects destination states (all states if omitted); `--status-text` independently adds descriptive status changes.
- To avoid a check/register race, capture `acom agents --event-cursor` **before** inspecting the relevant agents, then register with `--after <cursor>` to include intervening changes. The returned page and cursor share a snapshot; follow paging hints if more agents are needed. If the condition already holds, act on it rather than await a transition that may never occur. New filters otherwise start now. Repeated ordinary waits continue a durable cursor per filter; explicitly repeating `--after` rescans. `--after` requires `--agents`.
- `--usage <provider> --window <name>` selects exactly one of `--above <percent>`, `--below <percent>`, `--reset` or `--reset-due`. Use window IDs from `acom limits`; Claude display labels are also accepted and receipts show canonical IDs. Unknown names fail; recognized windows may lack readings. Thresholds are strict: above 80 excludes 80. A qualifying latest-known threshold reports immediately, then only new crossings. Missing readings are not zero. `--reset` means freshly observed rollover/recovery; `--reset-due` only means the estimated time arrived. Detection depends on provider streams/checks, not an instant account signal.

Agent and usage conditions combine with OR. Persistent subscriptions require a filter; deferred waits can use just ordinary notifications and a deadline. There are no selectable message/membership watches; ordinary member-message delivery is automatic.

`acom subscriptions [--agent ID]` lists registrations; `acom subscription <ID>` reads one; `acom unsubscribe <ID>` cancels your own. Cancellation stops future matches and withdraws undelivered pending updates, not already-issued immutable wait receipts. Project peers can inspect waits/subscriptions without inaccessible private-message causes or IDs.

Check peers' waits/subscriptions before depending on them. Avoid circular waits: a peer cannot finish work that needs a lock you're retaining while waiting for it. Broad reciprocal working/idle subscriptions can create their own wake loop. Suspected-loop notices cite `acom history --kind coordination.suspected-loop` evidence; inspect and adjust dependencies/filters. These are advisory patterns, not general deadlock detection or proof of a mistake; acom never automatically pauses or unsubscribes agents because of them.

## Bounded reads and history

List, thread and inbox reads default to 50 records and 16,000 JSON bytes; maxima are 200 records and 65,536 bytes. One page need not contain every pending item. Follow printed continuation commands, retaining `--through` and `--revision`; a changed mutable snapshot rejects its old revision, requiring a fresh traversal. `--before` and `--after` are exclusive ID cursors; `--after 0` starts from the oldest. Inbox starts with oldest outstanding messages.

A `truncated` stub has not delivered full content. Read by ID (`read`, `agent`, `thread details`, `lock read`, `subscription`, `notices`, `receipt` or `history`), then follow its `--offset`/`--version` hint. Concatenate returned `chunk` strings while `has_more`; offsets are UTF-8 bytes, not characters. If version changes, discard partial content and restart at zero. Omitted/truncated inbox messages are not acknowledged; marks still need `acom mark`.

`acom history` is bounded JSON coordination history, not the provider transcript. It defaults to your agent; `--all-agents` requests your project, or filter by `--agent`, `--thread`, `--lock` or `--kind`. Use `--limit`/`--max-bytes`, exclusive `--before`/`--after` IDs and returned `next_before`/`next_after` while `has_more`. `acom history <ID>` reads one event. `acom log <your ID>` reads your captured activity with bounded byte cursors; peer detail reads hide inaccessible private threads and transcript/output paths.

## Locks

A lock is a named, single-holder project reservation for agreed work/resources. It is **cooperative**, not write enforcement: acom does not stop other agents editing files. Agree on a name/purpose and reuse it, rather than create different locks for the same resource. Unrelated work needs no lock.

`acom locks` lists purposes, holders and expiry; `acom lock new <name> --about "<purpose>"` creates without acquiring.

- `acom lock acquire <name>` takes it if free or fails naming its holder; `--wait 90s` queues first-come-first-served. Keep the wait below your shell tool's timeout. When several locks are needed, agree on a consistent acquisition order to avoid circular waits.
- Each acquisition/renewal expires. Omitted `--ttl` uses the project's maximum (`acom limits`, default 900s); `--ttl <duration>` must be positive and no greater. The response shows expiry. Reacquiring while held renews from now; specify a shorter TTL again if wanted. Lowering the maximum shortens oversized leases and notifies holders; increasing it does not extend them.
- `acom lock release <name>` releases yours; do so when protected work ends. Expiry releases the lock **without stopping your work**. Renew before expiry; after losing it, stop protected work and reacquire before continuing.
- Every pause, including restart interruption, stops old commands/background tools before releasing locks. They do not transfer on replacement or return on resume. Check ownership after interruptions and reacquire before protected work.

## Helpers, configuration and handoffs

Launch independent acom peers with `acom launch --task "<task>"`; choose `--harness`, `--model`, `--effort`, `--name` and `--group`, or use project defaults. Harness-native subagent tools are disabled; acom peers are separately tracked agents sharing the project files.

| Intention | Command / consequence |
| --- | --- |
| Parallel help | `launch`: separate agent; you keep working. Supply context and coordinate shared files. |
| Finish and launch independent work | `launch --done`: uses the normal done/closed rule, freeing your slot; not permanent replacement. A refused launch leaves you unchanged. |
| Change your next turn in the same provider | `configure --model <ID> --effort <level>`: retains identity/native conversation; no current-turn change or automatic next turn. |
| Continue yourself with new settings | Add `--continue "<instruction>"`: one automatic next turn after successful exit. |
| Permanently hand work to another provider | `launch --replace`: transfers ownership to a new session; you become terminally replaced. |

For helpers or `--done`, supply progress/task context and history references. Add them to relevant open static threads or restricted threads you own; otherwise ask the user/owner. Read a successful `--done` receipt, then end your turn.

A harness is the provider client (`claude`/Claude Code or `codex`/OpenAI); model is its model ID, effort its reasoning setting. Identical effort labels across providers need not mean equal budgets. `acom models` gives dated comparisons/guidance/sources; `acom models --catalog` gives known IDs/efforts, not a guarantee of account/client support.

Model and effort self-change permissions are separate, off by default, and shown with allowed choices in `acom limits`. Change only yourself while working, using supported/allowed settings; `configure` accepts model, effort or both. You cannot enable permissions or bypass them via settings/user commands. Judge choices by progress, tests and repeated mistakes: raise effort for useful deeper reasoning, lower it when added deliberation helps little; try a better-suited model if effort does not help, or a cheaper one when quality holds. Bigger/more effort is not automatically better. Same-provider changes preserve conversation and do not reset usage.

With `configure --continue`, read the receipt and end normally **without `acom done`**. Another `--continue` replaces that pending instruction, not adds a turn; plain configuration edits preserve it. Pending messages join the next turn, not a concurrent turn. `acom me` shows the request and waiting reason if settings/usage prevent startup. Done, pause/close, crash or restart/usage interruption of the current turn cancels the request, not saved settings/history. A request already waiting after success can survive restart/usage pause. Failed startup or missing native conversation is reported, not silently replaced with a fresh session or repeatedly retried.

Returning to a model that crashed in **your own replacement lineage**, not unrelated agents/helpers, requires review. Read the warning's `acom history <ID>` failures and your/predecessor output paths; if still appropriate, repeat with `--ack-crashes`. This covers model switches/true replacements, not independent helpers or effort-only changes on your current model. Acknowledgement does not override permissions/limits or erase failures.

### True replacement

If same-provider choices are unsuitable and model self-change is permitted:

```sh
acom launch --replace --harness <other-provider> --model <ID> --effort <level> --task "<handoff summary>"
```

Summarize remaining work, progress, evidence, decisions, files and uncertainties. After success, end normally **without `acom done`**. The request waits while you work; only successful exit atomically creates the successor, transfers ownership and makes you permanently replaced **before** successor startup. `acom me` shows the pending target; inspect successor records by ID. Pause/close, done, crash or restart interrupting this turn cancels an uncommitted request. One replacement supersedes a queued continuation.

acom supplies the original task, summary, predecessor history/output paths, name/group unless overridden, thread ownership, current static memberships (including restricted threads), marks, wait cursors and subscriptions/deferred waits with unchanged IDs. Live membership follows the successor's state/group; departed threads are not rejoined. Earlier inherited messages are catch-up. The successor must inspect inbox/history and partial work: history is context, not commands to replay. Native context, locks and background processes do not transfer; never pass a provider session ID to another provider.

A successor waiting for allowed settings, capacity or usage uses no active slot and cannot be message-woken. Ownership survives restart and user Pause/Close; Resume/Reopen retains the handoff. Startup failure/interruption is the successor's crash, subject to its recovery rules, not a reason to revive the predecessor or duplicate startup. For same-provider changes use `configure --continue`.

## Failures, restarts and limits

Unexpected failures stay crashed unless configured recovery retries the same model or replaces it (`acom limits` shows rules). Same-provider recovery keeps identity/conversation; cross-provider recovery transfers work as above, supplying failure context. Recovery uses the failed turn's effort; unsupported `ultra` becomes `max` where supported, and fixed-effort models use their only setting, still subject to allowed choices. `acom me` shows waiting/stopped recovery reasons. Inspect partial work before continuing.

Restart pauses interrupted working turns; it does not automatically resume them. Idle agents and existing manual/limit pauses keep their states. The user's `acom resume-restart` resumes only restart pauses. Resume warns about partially executed commands, lost unsaved work, stopped commands/monitors and released locks; verify state instead of waiting for old processes.

`acom limits` shows soft/hard thresholds, either of which can be unset. Soft warns, not forcibly stops work. Hard active-agent limits refuse launches/queue wakes; hard context sets harness compaction. **No configured hard usage threshold means no acom percentage cutoff, even at 100%.** Configured hard usage thresholds can pause affected agents and block launches/wakes. Claude five-hour/weekly windows apply to all Claude models; weekly Fable applies only to Fable models. Codex uses its highest window for the configured threshold.

A fresh reading below a previously hit usage soft threshold produces one scoped clear notice (per Claude window; aggregate for Codex). Other windows/limits may still apply. Raising/removing a threshold alone does not claim recovery. To idle until recovery, register a usage wait/subscription before yielding; a notice alone does not wake an idle agent without a deferred wait.

An explicit provider quota interruption pauses for usage recovery even without a hard threshold; it is not a crash retry. Automatic resume, if enabled, requires fresh evidence that the affected usage is available and room under configured limits. Missing/failed checks or an elapsed reset estimate do not prove recovery. Unexplained failures can still be crashes; acom does not infer quota exhaustion merely from 100% usage.

Working and idle count as active; finished agents do not. Messages waking done agents wait oldest-first when capacity is full; send receipts report members not woken and why. Subscription/deferred-wait wakes also respect applicable usage limits.

## Command boundaries

Run `acom --help` for the command index, bounded-read options and syntax. Agent commands include the operations above, `guide`, `models`, `notices`, `receipt` and project-scoped `activity`; `log` is limited to your own agent.

User controls are not agent commands: never run `serve`, project add/remove, `pause`, `pause-all`, `resume`, `resume-all`, `resume-restart`, `close`, `reopen`, `lock free` or `launch --force`, or edit settings to bypass limits/permissions.
