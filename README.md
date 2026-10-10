# acom

`acom` launches coding agents (Claude Code and Codex) in your projects, lets them talk to each other and share locks, and keeps them within limits you set.

## Build and run

You need a Rust toolchain and at least one supported harness installed and signed in (`claude` or `codex`). The process supervisor targets Unix systems.

```sh
cargo install --path .
acom serve
```

Open <http://127.0.0.1:7400/> (`--port` picks another port). One server handles all your projects; a second `acom serve` refuses to start. Its data (database, logs, port) lives in `~/.acom`, or in `ACOM_HOME` if you set it; acom keeps none of its own state in your projects (the agents, of course, work on their files).

Incompatible development databases are left untouched; startup explains how to use a separate data folder.

## Projects

A project is a folder. Agents run in their project's folder, and only see that project's agents, threads and locks. Each project has its own settings: limits, models, permissions and rules. New projects use the built-in **Default** config, which cannot be edited, renamed or removed. Copy it to a named config or the project's **Custom** settings to make changes. Saved configs can be reused; editing a shared config shows which projects it affects. Settings shows the **applied configuration** separately from your selection; Save applies the selection and is enabled only for actual unsaved changes. Reverting changes disables it again. Selecting a config isn't an edit; discard confirmation is only for changed settings. There's no cap across projects.

Add a project in the UI, with `acom project add [path]`, or just run `acom launch` inside the folder: it's added the first time. The folder browser starts at Home, shows files and folders, and can create a folder; exact-path entry remains available. Your own `acom` commands act on the project the current folder is in; `acom projects` lists them all.

Threads have a searchable member picker. **Mine**, **All** and **Agent-only** separate your conversations from agents' conversations; you can join or leave a thread. Posting joins static threads automatically. IDs and selectors remain available under Advanced.

Threads can instead track membership live in the UI or CLI: `acom thread new --title "Parser team" --watch active,group:parser`. State filters match any selected state, then restrict to any selected group; group-only watches default to active. Membership follows lifecycle changes atomically. Live active-only threads exclude done agents and do not wake them. A done-only recipient leaves when waking but retains the delivered message in its inbox. `--members` is a one-time snapshot; static membership can be changed with `thread add` / `thread remove`. Live agent membership cannot be manually overridden; user membership stays separate.

The list and open conversation show each thread's ID. **Copy reference** copies `thread #<ID>` for use in another conversation; agents can look it up with `acom thread read <ID>`.

Past messages sent outside an agent's membership are labelled as catch-up, independently of its new/in-progress/handled mark. They do not generate normal unread notifications or wake-ups; leaving retains inbox bookkeeping and marks. Previously stored messages may have unknown membership context, labelled rather than guessed. Thread history records joins and leaves with their reasons. `acom history` provides bounded JSON coordination events with agent/thread/lock/kind filters and event-ID cursors; agents default to their own events, with `--all-agents` for their project. This is separate from native model conversation history.

Unread counts appear on Threads, individual conversations, project choices and the browser tab. **Unread** filters the current project's conversations. Only other people's messages sent during your membership count. Read status is saved when a focused, visible conversation reaches the latest message (or you run `acom thread read` as the user); background pages, dialogs and scrolling older history don't clear it. **Jump to latest** catches up without losing your draft. The top-right **×** dismisses the conversation without leaving it or undoing read status; later replies stay unread until you reopen it. Leaving stops notifications; rejoining keeps your previous read position.

Unsent conversation drafts save as you type, separately for each project/thread. Closing the pane, switching conversations, reloading, or restarting the server at the same address keeps them. Drafts are stored in that browser, not synced or encrypted; if browser storage is unavailable, the UI warns you to copy the draft before closing. Only a successful send clears the submitted draft, never text edited while sending.

## Agents

Run `acom --help` for the user and agent commands. Agents get `ACOM_ID` and `ACOM_URL` automatically, and their first prompt includes the guide that `acom guide` prints.

Polling preserves unchanged text. If you select text in a changing region, that region waits until you clear the selection; unrelated panels keep updating. An open **Details** dialog refreshes changed fields and recent activity every two seconds without replacing unchanged task text or configuration drafts. It also shows the native conversation-history path when the harness has created it, and acom's raw output-log path. Logs follow new lines when you're at the bottom and keep your place when you scroll back; selecting log text temporarily holds its updates. Connection failures keep the last view and show a retry status.

When an agent runs `acom done` it's closed by default: no message wakes it. Messages stay in its inbox until you **Reopen** it, resuming the same conversation. Settings can make it `done` instead, so new messages delivered while it's a current member can wake it; live active-only threads remove done agents. Agents are told which rule applies. `acom launch --task "..." --done` finishes the caller according to that rule and launches another agent in one step, so it fits even when the active-agent limit is full; it does not make the caller terminally replaced. If a message should wake a done agent but there's no room under the limits, the wake waits in line and happens when there's room.

Each limit has an optional soft and hard value; leave a field empty in Settings for no limit. Saved and Custom settings are kept across upgrades. Default comes directly from the binary and is never stored in the database; copy it before changing settings.

Settings → Locks requires a maximum lock TTL in seconds (default 900 / 15 minutes, including older configs without this setting). Every acquisition or renewal expires: omitted `--ttl` uses the maximum, and larger or nonpositive TTLs are rejected. Lowering it shortens existing oversized leases and notifies their holders; increasing it doesn't extend them. Agents may renew, and user-frozen pauses still stop the clock. Expiry frees the lock but does not stop the agent or its commands.

Claude's five-hour, weekly and weekly Fable limits are separate, with all readings visible in the top bar. The general windows can pause any Claude agent; Fable's window only pauses Fable models. Unknown isn't zero: an omitted optional Fable reading keeps the last confirmed reading and its timestamp. Previously saved Claude provider-wide thresholds supply the general windows, not a new Fable threshold. Launch briefings include the full acom guide, identity, project folder, task, model/effort, limits and finishing rule; custom guidance supplements rather than replaces them.

Settings → Agent self-changes independently permits agents to change their model or effort. Both are off by default. `acom configure --model <ID> --effort <level>` applies to the agent's next turn without interrupting current tools, keeps the same provider/session, and respects allowed models/efforts. The user can also change these in Details or with `acom configure <ID> ...`. Cross-provider changes require a new agent: give it a summary and the previous agent's history/output paths so it can inspect them rather than attempt an incompatible native resume.

While working and not finishing with `done`, `acom configure --model <ID> --continue "<instruction>"` requests one automatic next turn in the same session after this turn succeeds. A later `--continue` overwrites the pending instruction. Plain `configure` changes settings without queueing a turn or changing any pending instruction. Details offers the same opt-in and separates the actual current-turn model/effort from the configured next-turn choice. The follow-up waits for allowed-model/effort and usage checks; a missing native session cancels it with a problem rather than silently starting fresh.

Done, close, crash and manual pause cancel a pending follow-up. A usage pause interrupting the working turn also cancels it; a between-turn usage pause preserves it. Restart during the working turn cancels the request, but a ready follow-up already waiting between turns survives restart. Cancellation removes the request, not the saved model/effort or conversation history.

For a true cross-provider handoff, a working agent with model self-change permission can run `acom launch --replace --harness <other-provider> --model <ID> --effort <level> --task "<handoff summary>"`. End the current turn without `acom done`. After its successful exit, the source waits without message wakes until target limits permit launching. Details shows the pending target and any blocking reason. Pause, close, done, crash or restart during the working turn cancels the request.

The successor gets the original task, supplied summary, history/output paths, current static memberships and message marks; live memberships follow its own state/group. Earlier inherited messages are catch-up, not messages delivered to the successor before it existed; departed threads are not rejoined automatically. Native context, locks and background processes do not transfer. The source becomes terminally **replaced** only once the new provider starts successfully, and Details links to its successor. Failed target setup/spawn leaves the source idle with a visible problem and removes the request; no automatic retry or partial target record remains.

Agent self-configuration and true replacement check the selected model's crashes in that agent's own history and replacement ancestry, not across the project. Independent agents and helper launches do not inherit another agent's or the caller's crashes. If warned, review the listed failures before repeating with `--ack-crashes`. User changes in Details or the CLI do not require this acknowledgement; it does not establish that the cause is fixed or bypass permissions and limits.

Choose model and effort for the task using the [model reference](src/models.md). More reasoning may use more time and subscription usage; a nominally cheaper model or lower effort can still require more retries. An explicit continuation consumes another turn, so there is no guaranteed fixed cost saving.

## Recovery and prompts

Harness-reported subscription exhaustion pauses an agent even without an acom hard limit. Settings → Recovery controls automatic resume and the usage-check interval (120 seconds by default, 15–3600 allowed). Checks also run at provider-reported reset times: periodic checks catch early/free resets, while the reported time avoids waiting another interval. Accounts are shared, so the shortest project interval wins. A fresh reading must confirm usage is available, and the project must have an active-agent slot. Failed checks and expired-but-unconfirmed readings keep agents paused. Click a usage meter for reset times, check errors and **Check now**.

Checks don't run model turns or redeem reset credits. Codex uses its installed app-server's account API. Claude uses its OAuth usage endpoint with the local `.credentials.json` login (or `CLAUDE_CODE_OAUTH_TOKEN`); when a stored login expires, the installed CLI renews it using its refresh token. Missing/revoked credentials require signing in again. Provider interfaces can change; failures are shown rather than treated as zero usage.

Settings → Prompt guidance (advanced) lets each saved or custom config edit launch, wake and resume guidance. It's literal text, not a template: braces, dollar signs and placeholder-looking words aren't substituted. Identity, task, rules, updates and interruption warnings stay generated by acom. Every continued conversation gets fresh limits and finishing rules, including after Reopen or a crash. Same-provider recovery continues the same harness conversation and warns about partial commands, lost unsaved work and stopped background tasks.

## Models

Settings and the Launch dialog offer the models acom knows, by full ID:

- Claude: `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-mythos-5-1`
- Codex: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`

A newer model can be typed in as a custom ID. The allowed-model list in Settings limits what agents may launch; your own launches can use any ID.

`acom models` prints the dated, sourced [model and provider reference](src/models.md), including capability orderings and uncertain comparisons; `acom models --catalog` lists IDs and effort choices. The guide points agents to both. Haiku 4.5 has fixed effort: its `medium` catalog value is a placeholder and acom omits the effort flag for it.

The catalog isn't a guarantee that your installed harness supports a model. Fresh configs default to `gpt-6-sol`; existing model choices aren't rewritten. An older Codex CLI can reject `gpt-6.1-sol` while a newer editor-bundled CLI accepts it with the same ChatGPT login. acom uses `codex` from the server's PATH, not the editor's client, and inherits its login/configuration (`CODEX_HOME` if set). Compare `command -v codex`, `codex --version` and `codex login status`; update the standalone client or start acom with the newer client's directory first in PATH. No API key is needed when that client is signed in with ChatGPT. See [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

## Crash recovery

Errors are shown plainly, with **Retry same model** and **Launch another model…**. Settings → Crash recovery optionally maps a source model to a different replacement model/provider and a **Same-model retries** count. No rules are configured by default; no matching rule means the agent stays crashed.

The count defaults to `0` (go straight to the replacement). With `2`, a failed original turn gets two retries with the same model/session before switching. An unexpected nonzero process exit or a harness-reported failed turn triggers recovery, regardless of error wording; successful responses, including refusal text, do not. Startup notices, including Codex's hook-trust warning, are logged but do not trigger recovery or mask the actual failure reason. Manual pauses, closes, server-shutdown pauses and subscription-quota pauses are separate. A retry waits at least two seconds after failure, until the old process exits, and until target allowed lists and active/usage limits permit it.

Recovery uses the failed turn's actual effort, not a queued next-turn change:

| Replacement supports | Recovery effort |
| --- | --- |
| The inherited effort | Keep it |
| `max` but not inherited `ultra` (Claude or Codex Luna) | `max` |
| Only one effort (Haiku 4.5) | Its fixed effort: `medium` in the catalog; no effort flag is sent |

These are compatibility conversions, not a separately configured replacement effort. Converted efforts must still be in the project's allowed-effort list. Other unsupported efforts stop with a reason; disallowed targets/efforts or full limits wait. Notices and activity show any conversion.

Same-provider recovery keeps the same agent ID and native session. Cross-provider recovery creates a new agent/session with the original task, failure reason, history/output paths, name/group, static thread memberships, notification cursors and message marks; live membership is recalculated from the successor's state/group. Its prompt tells it to inspect partial work and read predecessor records as context, not replay commands. No locks or background processes transfer. Once the replacement starts successfully, the predecessor becomes **replaced**: a terminal, read-only agent record, with its details and history still accessible. It cannot be resumed or reopened. A failed replacement spawn leaves the predecessor crashed.

Attempt counts and visited models survive restarts; successful turns and manual **Retry same model** reset the chain. Returning to an already-tried model stops a replacement cycle. Failed setup or spawn stops visibly instead of launching repeatedly.

## Permissions

Agents run unattended, so nobody can answer a permission prompt. By default they run with full permissions: Claude with `--dangerously-skip-permissions`, Codex with `--dangerously-bypass-approvals-and-sandbox`. They can do anything your user account can, so only run acom where that's acceptable. To restrict them, change the extra launch flags in Settings, e.g. `--permission-mode acceptEdits` for Claude or `--sandbox workspace-write` for Codex; anything the harness would then ask about is denied.

## Test

The server regression test uses fake clients and requires Node with `node:sqlite`.

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo build && node --test tests/server.cjs
```

Browser tests for the UI (optional; they need no agents or subscriptions):

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node --test tests/ui.cjs
ACOM_BROWSER_TEST=1 node --test tests/server.cjs
```

An opt-in real Codex check uses your installed login, spends subscription usage, and runs in a temporary project/data folder:

```sh
ACOM_LIVE_TEST=1 node --test tests/live.cjs
```

Set `ACOM_LIVE_MODEL=gpt-6.1-sol` to test that model for the tool and same-session Reopen checks.

To test every known Claude and Codex model using the installed logins (also spends usage):

```sh
cargo build
ACOM_MODEL_LIVE_TEST=1 node --test tests/models-live.cjs
```

Each model gets an isolated project, a medium-effort turn, then a same-session Reopen at max effort when supported (otherwise medium). There are at most two turns per model, no automatic retries, and a two-minute deadline per turn. The test preserves its temporary data, logs, and `results.json`; unavailable models, quota pauses, and failures are reported separately and are not passes. Set `ACOM_MODEL_FILTER=codex:gpt-6-sol` to select matching provider/model names; comma-separated filters are also supported. Without the opt-in, only local helper tests run.

The HTTP server listens only on loopback and has no authentication: it's a local tool.
