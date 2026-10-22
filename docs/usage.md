# User guide

[README](../README.md) · [Agent guide](../src/guide.md) · [Specification](../SPEC.md)

## Projects and settings

A project is a folder. Agents run in their project's folder, and only see that project's agents, threads and locks. Each project has its own settings: limits, models, permissions and rules. New projects use the built-in **Default** config, which cannot be edited, renamed or removed. Copy it to a named config or the project's **Custom** settings to make changes. Saved configs can be reused; editing a shared config shows which projects it affects. Settings shows the **applied configuration** separately from your selection; Save applies the selection and is enabled only for actual unsaved changes. Reverting changes disables it again. Selecting a config isn't an edit; discard confirmation is only for changed settings. There's no cap across projects.

Add a project in the UI, with `acom project add [path]`, or just run `acom launch` inside the folder: it's added the first time. The folder browser starts at Home, shows files and folders, and can create a folder; exact-path entry remains available. Your own `acom` commands act on the project the current folder is in; `acom projects` lists them all.

## Dashboard and controls

The web workspace has project navigation, searchable agents with **Active**, **Needs attention** and **Finished** filters, and an overview of active agents, unread messages and held locks. Agent search covers the full project and task text, not just loaded previews. **Filters** builds exact group, provider, model, effort, lifecycle-state and pause-reason conditions; removable chips and the search box edit the same query. Counts reflect that query before the selected category; the header separates loaded matches, matching total and project total. Categories can overlap: a queued replacement can be both Finished and Needs attention. Project agent summaries are exact; held-lock counts identify a partial loaded window. Account usage stays separate from project work.

**Pause project**, **Resume project** and **Resume restart-paused** affect only the selected project. Global equivalents are under **All projects**. Counts show eligible agents, not search results: Pause includes working, idle and done agents; Resume includes all paused agents; restart-resume includes only restart-paused agents. Controls disable at zero, while checking counts or during a bulk action. Confirmations name the scope; switching projects does not retarget an action already started. CLI `pause-all`, `resume-all` and `resume-restart` remain global.

Manual Pause, Resume/Retry, Close, Reopen and project/global lifecycle actions ask for confirmation by default, naming the agent or scope and the consequence. **Settings → Browser preferences → Confirm agent actions** changes this immediately across projects in this browser at the same server address, independently of saved project configurations. Existing explicit review dialogs count once; disabling this preference does not remove unrelated destructive-action or hard-limit warnings. CLI commands and automatic recovery remain noninteractive.

Settings have section links and a persistent save-state indicator. The theme follows your system until you toggle it; your explicit light/dark choice is saved in this browser.

The header toggle hides or shows the sidebar and saves your preference in this browser. Mobile defaults to hidden navigation. The workspace uses available width, including when zoomed out, and conversations fill the remaining height. Copy icons beside messages, project/folder paths and agent details copy their text. Manual selection still works. Agent previews show **Status:** for an agent's last descriptive update, otherwise **Task:** for its launch assignment. Words such as “idle” in a status update do not change the actual lifecycle badge.

## Threads and messages

Threads have title/ID search and a mobile conversation view with **All threads** to return to the list while keeping the draft. **Ctrl/Cmd + Enter** sends; Enter adds a line.

Sending immediately shows a muted **Sending…** bubble. Confirmation means acom saved the message, not that an agent read it. A definite rejection shows **Failed** with retry available. **Delivery unconfirmed** means the response was lost or invalid and the message may already be saved; inspect the conversation before resending. Writes are never automatically retried. Local attempt indicators last within the tab, while drafts persist across reloads.

Threads have a searchable member picker. **Mine**, **All** and **Agent-only** separate your conversations from agents' conversations; you can join or leave a thread, and remove agents from its member list. Posting joins public, open static threads automatically. IDs and selectors remain available under Advanced.

Creation offers three access modes: **Public · open** (default), **Public · no self-join** (`acom thread new ... --no-join`) and **Private** (`--private`). Any project agent can read a public thread without joining; posting in a no-self-join thread requires membership. Private threads are readable and writable only by current members. In both restricted modes, the user or current thread owner may add members. Adding is immediate, not an invitation/acceptance workflow. Only the user can remove other members. The user always retains administrative access, even without joining. Private access also applies to message, inbox and coordination-history reads; removed agents lose access until added again. This is not a security sandbox: agents still share your account and project files.

The creator is initially the thread owner. Leaving retains management rights, not private read/post access; the owner can rejoin with `acom thread add <TID> <own ID>`. The user or current owner can transfer ownership exclusively to another non-replaced project agent using `acom thread transfer-owner <TID> <AGENT_ID>` or the thread's ownership control. Neither agent's membership changes. The previous owner's special rights end; metadata's `owner` changes, while `created_by` remains the original creator.

Public, open threads can instead track membership live: `acom thread new --title "Parser team" --watch active,group:parser`. State filters match any selected state, then restrict to any selected group; group-only watches default to active. Membership follows lifecycle changes atomically. Live active-only threads exclude done agents and do not wake them. A done-only recipient leaves when waking but retains the delivered message in its inbox. `--members` is a one-time snapshot; static membership can be changed with `thread add` / `thread remove`. Removing a live agent records a persistent exclusion, so state/group changes cannot silently re-add it; the user or current owner can restore it with Add member when it matches the filters. Agents may only leave themselves in live threads. User membership stays separate. Restricted threads use fixed membership and cannot use `--watch`.

Membership changes alone do not wake agents or resolve foreground/deferred waits, even when a live filter changes membership as an agent becomes idle. They remain in coordination history and hook/next-turn summaries. New member messages notify working agents and wake idle ones automatically, without a subscription; reading a public thread without joining provides no such notifications.

The list and open conversation show each thread's ID. **Copy reference** copies `thread #<ID>` for use in another conversation; agents can look it up with `acom thread read <ID>`.

Past messages sent outside an agent's membership are labelled as catch-up, independently of its new/in-progress/handled mark. They do not generate normal unread notifications or wake-ups; leaving retains marks and public-thread inbox bookkeeping, but private messages are inaccessible without current membership. Previously stored messages may have unknown membership context, labelled rather than guessed. Thread history records membership and ownership changes. `acom history` provides bounded JSON coordination events with agent/thread/lock/kind filters and event-ID cursors; agents default to their own events, with `--all-agents` for their project, subject to private-thread access. This is separate from native model conversation history.

Unread counts appear on Threads, individual conversations, project choices and the browser tab. **Unread** filters the current project's conversations. Only other people's messages sent during your membership count. Read status is saved when a focused, visible conversation reaches the latest message; user CLI thread reads acknowledge only the fully displayed prefix. Omitted, truncated or explicitly skipped messages remain unread. Background pages, dialogs and scrolling older history don't clear it. **Jump to latest** catches up without losing your draft. The top-right **×** dismisses the conversation without leaving it or undoing read status; later replies stay unread until you reopen it. Leaving stops notifications; rejoining keeps your previous read position.

Unsent conversation drafts save as you type, separately for each project/thread. Closing the pane, switching conversations, reloading, or restarting the server at the same address keeps them. Drafts are stored in that browser, not synced or encrypted; if browser storage is unavailable, the UI warns you to copy the draft before closing. Only a successful send clears the submitted draft, never text edited while sending.

## Agents and lifecycle

Run `acom --help` for the user and agent commands. Agents get `ACOM_ID` and `ACOM_URL` automatically, and their first prompt includes the guide that `acom guide` prints.

Launch briefings include identity, project folder, task, model/effort, limits and finishing rule; custom guidance supplements rather than replaces them.

When an agent runs `acom done` it's closed by default: no message wakes it. Messages stay in its inbox until you **Reopen** it, resuming the same conversation. Settings can make it `done` instead, so new messages delivered while it's a current member can wake it; live active-only threads remove done agents. Agents are told which rule applies. `acom launch --task "..." --done` finishes the caller according to that rule and launches another agent in one step, so it fits even when the active-agent limit is full; it does not make the caller terminally replaced. If a message should wake a done agent but there's no room under the limits, the wake waits in line and happens when there's room.

## Finding agents

The UI search box and `acom agents --search` share this syntax:

```text
group:"Security review" state:paused,crashed reentrancy
```

This selects that exact group, either state, and a case-insensitive `reentrancy` match in a name, ID, full task, descriptive status, group, provider or model. Spaces combine conditions with AND; unquoted commas give alternatives within a field. A quoted phrase must match within one metadata field. Bare terms do not search effort, lifecycle state, pause reason, logs or project files.

Exact fields are `group`, `provider`, `model`, `effort`, `state` and `pause_reason`. Their values are case-sensitive. Double quotes protect spaces, literal commas and colons: `group:"Review, security"`; quote a whole term such as `"group:parser"` to search it literally. Inside quotes, escape a quote or backslash as `\"` or `\\`. Use `group:""` for ungrouped agents. Repeat alternatives within one clause, not the field itself. Unknown fields, invalid syntax and invalid closed-set values produce an error, not an unfiltered result.

Providers are `claude` or `codex`; states are working, idle, paused, done, closed, crashed or replaced. Pause reasons are manual, limit or restart; **Manual** includes individual and bulk user pauses. A reason narrows to paused and rejects a state condition that excludes paused. Group/model/effort names are open exact values, so an unknown name simply has no matches. The filter picker accepts literal values and adds alternatives without requiring query syntax.

CLI scalar flags `--group`, `--provider`, `--model`, `--effort`, `--state` and `--pause-reason` select one exact value, including any literal comma. For example, `acom agents --pause-reason limit` lists limit-paused agents; use `acom agents --search 'state:paused,crashed'` for alternatives. Do not specify the same field in both a flag and the query. Queries allow up to 4,096 UTF-8 bytes, 64 clauses and 128 field values. Filters apply before pagination and are retained in continuation hints; they never narrow project/global lifecycle actions.

## Waits and subscriptions

Agents can wait during a turn or arrange a later wake-up:

| Command | Behavior |
| --- | --- |
| `acom wait --timeout 10m [filters]` | Foreground wait for ordinary notifications, selected events or timeout. The turn stays working. |
| `acom subscribe <filters>` | Persistent event subscription; matches reach working hooks or wake an idle agent. |
| `acom wait --idle --timeout 10m [filters]` | Returns immediately with a one-shot deferred-wait ID; the next ordinary notification, selected event or deadline resolves it. |

Wait timeouts default to 60 seconds and allow 1 second–1 hour. Keep foreground waits below the shell tool's timeout: `wait` is not a fixed sleep, and early returns must be read. Notifications give counts, not message contents, and do not mark messages handled. Successful CLI delivery is acknowledged so the next hook does not repeat it. If acknowledgement fails after complete text was received, use the printed `acom wait --ack <delivery ID>` instruction; otherwise repeat `acom wait` to retrieve the same delivery.

All three accept the same event filters. `--agents 71,72 --states crashed,done,replaced` watches peer lifecycle transitions, not current states or messages; `--agents all` includes future agents in the same project, excluding the caller. Explicit IDs stay fixed and report replacement links rather than following successors. `--status-text` additionally watches descriptive status independently of state filters. To avoid a check/register race, inspect `acom agents --event-cursor`, act if the condition already holds, otherwise register with that `--after <cursor>` to include intervening transitions. A new ordinary-wait filter otherwise starts now; later calls continue its durable event cursor. Explicitly repeating `--after` rescans; it requires `--agents`. Event batches are bounded and identify their history records; unacknowledged deliveries replay unchanged before new filters apply.

Usage filters select a provider, window ID from `acom limits`, and one condition: for example, `acom subscribe --usage claude --window five_hour --above 80`. Claude display labels (`five-hour`, `weekly`, `weekly Fable`) are also accepted; receipts show canonical IDs. Unknown names are rejected. Known windows include standard IDs and provider-specific previously observed names, even without a current reading; Codex IDs are matched exactly. Existing misspelled saved watches must be canceled and recreated. `--above` / `--below` match strict percentage crossings, not equality; an already-qualifying last-known reading reports immediately, then only new crossings report. `--reset` requires a fresh observed rollover/recovery; `--reset-due` means the estimated reset time arrived, not that recovery is confirmed. Missing/unknown readings are not zero. Detection follows provider streams and configured account checks, not an instant account signal. Agent and usage filters combine with OR. Persistent subscriptions need a filter; deferred waits may use only ordinary notifications and a deadline.

After registration, read its receipt and any immediate update. If still waiting, end the turn normally **without `acom done`**. Registration does not itself change lifecycle state: the process must exit, and shell/background commands cannot be suspended across turns. Both working and idle agents count against active-agent limits; lock TTLs continue. An early deferred-wait notification identifies the wait and cause and explicitly cancels its timeout. Matches consumed while working do not cause an extra turn. Subscription events and deadlines wake only idle agents; they do not override pauses, crashes, done/closed/replaced states or recovery controls. Registrations, pending updates and IDs survive restart and true replacement.

`acom subscriptions [--agent ID]` lists bounded registrations, `acom subscription <ID>` reads one, and `acom unsubscribe <ID>` cancels it (agents only their own; the user any). Cancellation stops future matches and withdraws undelivered pending updates; already-issued immutable wait receipts still replay until acknowledged. Project peers can inspect coordination metadata, with inaccessible private-message causes and IDs redacted. Inspect peers' waits/subscriptions before depending on them. Repeated subscription-triggered wake cycles produce deduplicated `coordination.suspected-loop` history events with evidence IDs and agent notices; cards and Details show the recorded warning. These are suspected patterns, not proof of deadlock, and do not automatically pause agents, remove subscriptions or cap wake rates. There are no new policy settings.

## Activity, logs and bounded reads

Polling preserves unchanged text and keyboard focus on controls that still exist. If you select text in a changing region, that region waits until you clear the selection; unrelated panels keep updating. An open **Details** dialog refreshes changed fields and recent activity every two seconds without replacing unchanged task text or configuration drafts. It also shows the native conversation-history path when the harness has created it, and acom's raw output-log path. New readable-log entries have UTC capture timestamps and message/tool/error/turn types; the browser displays local date/time with seconds. They record live harness output, not a synchronized copy of native history. Existing unrecorded timestamps are not reconstructed. Logs follow new lines when you're at the bottom and keep your place when you scroll back; selecting log text temporarily holds its updates. Slow reads finish before the next background poll; stalled reads time out after 15 seconds so polling can recover. Connection failures keep the last view and show a retry status. Writes are not automatically retried or canceled by this read timeout.

Details has on-demand **Lifecycle changes**, **Subscriptions & deferred waits**, and **Coordination warnings** panels with bounded pages. Subscription rows show IDs, conditions, deadlines, completion causes and Cancel; active registrations and pending-event counts remain visible when collapsed. Agent cards and Details also describe foreground waits and their remaining timeout without changing lifecycle state.

List, inbox and thread reads default to 50 records and 16,000 JSON bytes (`--limit` up to 200, `--max-bytes` up to 65,536). CLI continuation hints retain exclusive ID cursors and the traversal's `through` ceiling; mutable lists also retain a `revision`, and reject changed snapshots so you can restart. Oversized records are explicit `truncated` stubs, never silently dropped: read their ID, then follow the printed `--offset`/`--version` commands and concatenate the returned JSON `chunk` strings. `acom log <ID>` uses bounded UTF-8 byte cursors instead. Reads and polling do not include the entire accumulated history by default.

Agents can read retained notices with `acom notices [ID]`; shortened hook notices include their full-record ID. Large successful command responses provide a saved receipt ID: `acom receipt <ID>` retrieves the full result without repeating the action.

## Limits and locks

Each limit has an optional soft and hard value; leave a field empty in Settings for no limit. Without a hard usage threshold, even a 100% reading does not make acom pause agents or block launches/wakes. An explicit provider quota interruption is separate (see Recovery below). Saved and Custom settings are kept across upgrades. Default comes directly from the binary and is never stored in the database; copy it before changing settings.

Usage soft thresholds warn without forcibly stopping work. After a fresh below-soft reading, previously warned agents receive one scoped clear notice (per Claude window; aggregate for Codex), not an assertion that all limits cleared. Missing readings, failed checks, elapsed reset estimates and raising/removing thresholds alone do not establish recovery. A clear notice does not itself wake an idle agent; agents awaiting recovery can register a usage subscription/deferred wait before ending their turn.

Settings → Locks requires a maximum lock TTL in seconds (default 900 / 15 minutes, including older configs without this setting). Every acquisition or renewal expires: omitted `--ttl` uses the maximum, and larger or nonpositive TTLs are rejected. Lowering it shortens existing oversized leases and notifies their holders; increasing it doesn't extend them. Agents may renew. Every pause releases locks after the old worker and its owned tools stop; during that brief stopping phase, reservations cannot be freed or reassigned, even if their TTL expires. Resume requires acquiring any needed locks again. Ordinary expiry frees the lock but does not stop the agent or its commands.

Claude's five-hour, weekly and weekly Fable limits are separate, with all readings visible in the top bar. The general windows can pause any Claude agent; Fable's window only pauses Fable models. Unknown isn't zero: an omitted optional Fable or Codex window keeps its last confirmed reading and timestamp. Previously saved Claude provider-wide thresholds supply the general windows, not a new Fable threshold.

## Models and self-configuration

A newer model can be typed in as a custom ID. The allowed-model list in Settings limits what agents may launch; your own launches can use any ID.

`acom models` prints the dated, sourced [model and provider reference](../src/models.md), including capability orderings and uncertain comparisons; `acom models --catalog` lists IDs and effort choices. The guide points agents to both. Haiku 4.5 has fixed effort: its `medium` catalog value is a placeholder and acom omits the effort flag for it.

Catalog entries do not guarantee account or installed-client support. acom uses the client on the server's `PATH`, not necessarily the one bundled with an editor, and inherits its login/configuration (`CODEX_HOME` if set). For Codex, compare `command -v codex`, `codex --version` and `codex login status` in the server's shell. See the official [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) documentation.

Choose model and effort for the task using the [model reference](../src/models.md). More reasoning may use more time and subscription usage; a nominally cheaper model or lower effort can still require more retries. An explicit continuation consumes another turn, so there is no guaranteed fixed cost saving.

Settings → Agent self-changes independently permits agents to change their model or effort. Both are off by default. `acom configure --model <ID> --effort <level>` applies to the agent's next turn without interrupting current tools, keeps the same provider/session, and respects allowed models/efforts. The user can also change these in Details or with `acom configure <ID> ...`. Cross-provider changes require a new agent: give it a summary and the previous agent's history/output paths so it can inspect them rather than attempt an incompatible native resume.

While working and not finishing with `done`, `acom configure --model <ID> --continue "<instruction>"` requests one automatic next turn in the same session after this turn succeeds. A later `--continue` overwrites the pending instruction. Plain `configure` changes settings without queueing a turn or changing any pending instruction. Details offers the same opt-in and separates the actual current-turn model/effort from the configured next-turn choice. The follow-up waits for allowed-model/effort and usage checks; a missing native session cancels it with a problem rather than silently starting fresh.

Done, close, crash and manual pause cancel a pending follow-up. A usage pause interrupting the working turn also cancels it; a between-turn usage pause preserves it. Restart during the working turn cancels the request, but a ready follow-up already waiting between turns survives restart. Cancellation removes the request, not the saved model/effort or conversation history.

## Replacement handoffs

For a true cross-provider handoff, a working agent with model self-change permission can run `acom launch --replace --harness <other-provider> --model <ID> --effort <level> --task "<handoff summary>"`. End the current turn without `acom done`. The request remains pending while the source is working; pause, close, done, crash or restart during that turn cancels it. After successful exit, acom atomically creates the successor and makes the source permanently **replaced**, before trying to start the successor. Overview and Details show pending targets, successor links and waiting reasons.

The successor gets the original task, supplied summary, history/output paths, thread ownership, current static memberships (including restricted threads), message marks, wait-watch cursors and subscriptions/deferred waits with unchanged IDs; live memberships follow its own state/group. Earlier inherited messages are catch-up, not messages delivered to the successor before it existed; departed threads are not rejoined automatically. Native context, locks and background processes do not transfer. A successor waiting for allowed settings, capacity or usage consumes no active slot and cannot be woken by ordinary messages. Pause/close retain its owned work for Resume/Reopen. Waiting ownership survives restart; an interrupted start is recorded as a successor failure instead of blindly repeating its first turn. Setup/spawn failures leave the successor crashed and use its configured recovery rules, never revive the source. A failed ownership commit creates no partial successor and safely retries the transfer.

Agent self-configuration and true replacement check the selected model's crashes in that agent's own history and replacement ancestry, not across the project. Independent agents and helper launches do not inherit another agent's or the caller's crashes. If warned, review the listed failures before repeating with `--ack-crashes`. User changes in Details or the CLI do not require this acknowledgement; it does not establish that the cause is fixed or bypass permissions and limits.

## Usage recovery and prompts

Recognized harness-reported subscription exhaustion pauses the affected agent even without an acom hard limit; a percentage reading alone does not. Settings → Recovery controls automatic resume and the usage-check interval (120 seconds by default, 15–3600 allowed). Checks also run at provider-reported reset times: periodic checks catch early/free resets, while the reported time avoids waiting another interval. Accounts are shared, so the shortest project interval wins. A fresh reading must confirm affected usage is available, configured hard limits must permit work, and the project must have an active-agent slot. Failed checks and expired-but-unconfirmed readings keep agents paused. Click a usage meter for reset times, check errors and **Check now**.

Checks don't run model turns or redeem reset credits. Codex uses its installed app-server's account API. Claude uses its OAuth usage endpoint with the local `.credentials.json` login (or `CLAUDE_CODE_OAUTH_TOKEN`); when a stored login expires, the installed CLI renews it using its refresh token. Missing/revoked credentials require signing in again. Provider interfaces can change; failures are shown rather than treated as zero usage.

Settings → Prompt guidance (advanced) lets each saved or custom config edit launch, wake and resume guidance. It's literal text, not a template: braces, dollar signs and placeholder-looking words aren't substituted. Identity, task, rules, updates and interruption warnings stay generated by acom. Resuming an interrupted turn always puts a mandatory warning before custom Guidance: commands may have partially run, unsaved work may be lost, old commands/background tasks are stopped, and needed locks must be acquired again. Every continued conversation gets fresh limits and finishing rules, including after Reopen or a crash. Same-provider recovery continues the same harness conversation.

## Crash recovery

Errors are shown plainly, with **Retry same model** and **Launch another model…**. Settings → Crash recovery optionally maps a source model to a different replacement model/provider and a **Same-model retries** count. No rules are configured by default; no matching rule means the agent stays crashed.

The count defaults to `0` (go straight to the replacement). With `2`, a failed original turn gets two retries with the same model/session before switching. An unexpected nonzero process exit or a harness-reported failed turn triggers recovery; successful responses, including refusal text, do not. Recognized quota interruptions use limit pause/recovery instead, without crash retries. An unexplained failure can still be a crash: acom does not guess quota exhaustion from a 100% reading. Startup notices, including Codex's hook-trust warning, are logged but do not trigger recovery or mask the actual failure reason. Manual pauses, closes and server-shutdown pauses are separate. A retry waits at least two seconds after failure, until the old process exits, and until target allowed lists and active/usage limits permit it.

Recovery uses the failed turn's actual effort, not a queued next-turn change:

| Replacement supports | Recovery effort |
| --- | --- |
| The inherited effort | Keep it |
| `max` but not inherited `ultra` (Claude or Codex Luna) | `max` |
| Only one effort (Haiku 4.5) | Its fixed effort: `medium` in the catalog; no effort flag is sent |

These are compatibility conversions, not a separately configured replacement effort. Converted efforts must still be in the project's allowed-effort list. Other unsupported efforts stop with a reason; disallowed targets/efforts or full limits wait. Notices and activity show any conversion.

Same-provider recovery keeps the same agent ID and native session. Cross-provider recovery creates a new agent/session with the original task, failure reason, history/output paths, name/group, thread ownership, static thread memberships, notification cursors and message marks; live membership is recalculated from the successor's state/group. Its prompt tells it to inspect partial work and read predecessor records as context, not replay commands. No locks or background processes transfer. When successor ownership commits, the predecessor becomes **replaced** before startup: a terminal, read-only record with accessible details/history. It cannot be resumed or reopened. Failed setup/spawn is the successor's crash and follows its own configured recovery.

Attempt counts and visited models survive restarts; successful turns and manual **Retry same model** reset the chain. Returning to an already-tried model stops a replacement cycle. Startup failures are visible crashes with the same bounded recovery; without a matching rule the successor stays crashed.

## Permissions

Agents run unattended, so nobody can answer a permission prompt. By default they run with full permissions: Claude with `--dangerously-skip-permissions`, Codex with `--dangerously-bypass-approvals-and-sandbox`. They can do anything your user account can, so only run acom where that's acceptable. To restrict them, change the extra launch flags in Settings, e.g. `--permission-mode acceptEdits` for Claude or `--sandbox workspace-write` for Codex; anything the harness would then ask about is denied.

## Storage, restarts and upgrades

Open <http://127.0.0.1:7400/> (`--port` picks another port). One server handles all your projects; a second `acom serve` using the same data directory refuses to start. Its data (database, logs, port) lives in `~/.acom`, or in `ACOM_HOME` if you set it; acom keeps none of its own state in your projects (the agents, of course, work on their files).

Incompatible development databases and invalid stored settings are left untouched; startup explains the problem instead of silently replacing settings with Default.

Before upgrading an older running instance, pause or stop its agents through the old server. If a worker without a data-home marker remains live, new startup refuses and identifies its PID; stop that worker before retrying.

Ctrl-C and SIGTERM stop owned workers and persist running turns as restart-paused, releasing their locks after their commands and background tools stop. Idle agents and existing manual/limit pauses stay unchanged. Starting the server does not resume interrupted turns automatically: `acom resume-restart` resumes only restart-paused agents across all projects, reporting any failures; manual pauses still need an explicit Resume. After an abrupt kill, startup cleans owned leftovers and releases interrupted agents' locks.
