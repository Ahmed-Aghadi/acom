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

A project is a folder. Agents run in their project's folder, and only see that project's agents, threads and locks. Each project has its own settings: limits, models, permissions and rules. New projects use the **Default** config. You can save named configs and reuse them across projects, or give a project its own custom settings (starting from Default). In Settings, choose a config for the project and press Save to apply it; editing a shared config shows which projects it affects. There's no cap across projects.

Add a project in the UI, with `acom project add [path]`, or just run `acom launch` inside the folder: it's added the first time. The folder browser starts at Home, shows files and folders, and can create a folder; exact-path entry remains available. Your own `acom` commands act on the project the current folder is in; `acom projects` lists them all.

Threads have a searchable member picker. **Mine**, **All** and **Agent-only** separate your conversations from agents' conversations; you can join or leave a thread. Posting joins it automatically. IDs and selectors remain available under Advanced.

The list and open conversation show each thread's ID. **Copy reference** copies `thread #<ID>` for use in another conversation; agents can look it up with `acom thread read <ID>`.

Unread counts appear on Threads, individual conversations, project choices and the browser tab. **Unread** filters the current project's conversations. Only other people's messages in threads you've joined count. Read status is saved when a focused, visible conversation reaches the latest message (or you run `acom thread read` as the user); background pages, dialogs and scrolling older history don't clear it. **Jump to latest** catches up without losing your draft. Leaving stops notifications; rejoining keeps your previous read position.

## Agents

Run `acom --help` for the user and agent commands. Agents get `ACOM_ID` and `ACOM_URL` automatically, and their first prompt includes the guide that `acom guide` prints.

An open **Details** dialog refreshes status and recent activity every two seconds. It also shows the native conversation-history path when the harness has created it, and acom's raw output-log path. Logs follow new lines when you're at the bottom and keep your place when you scroll back. Connection failures keep the last view and show a retry status.

When an agent runs `acom done` it's closed by default: no message wakes it. Messages stay in its inbox until you **Reopen** it, resuming the same conversation. Settings can make it `done` instead, so any new message in its threads wakes it. Agents are told which rule applies. An agent can hand over with `acom launch --task "..." --done`, which closes it and launches the new agent in one step, so it fits even when the active-agent limit is full. If a message should wake a done agent but there's no room under the limits, the wake waits in line and happens when there's room.

Each limit has an optional soft and hard value; leave a field empty in Settings for no limit. Settings are saved in the database and kept across upgrades; new defaults only apply to a fresh `~/.acom`.

Claude's five-hour and weekly limits are separate, with both readings visible in the top bar. Either window can pause that project's agents; recovery requires both to allow work. Unknown isn't zero. Previously saved Claude provider-wide thresholds are shown for both windows until you save separate values. Launch briefings include the full acom guide, identity, project folder, task, model/effort, limits and finishing rule; custom guidance supplements rather than replaces them.

## Recovery and prompts

Harness-reported subscription exhaustion pauses an agent even without an acom hard limit. Settings → Recovery controls automatic resume and the usage-check interval (120 seconds by default, 15–3600 allowed). Checks also run at provider-reported reset times: periodic checks catch early/free resets, while the reported time avoids waiting another interval. Accounts are shared, so the shortest project interval wins. A fresh reading must confirm usage is available, and the project must have an active-agent slot. Failed checks and expired-but-unconfirmed readings keep agents paused. Click a usage meter for reset times, check errors and **Check now**.

Checks don't run model turns or redeem reset credits. Codex uses its installed app-server's account API. Claude uses its OAuth usage endpoint with the local `.credentials.json` login (or `CLAUDE_CODE_OAUTH_TOKEN`); when a stored login expires, the installed CLI renews it using its refresh token. Missing/revoked credentials require signing in again. Provider interfaces can change; failures are shown rather than treated as zero usage.

Settings → Prompt guidance (advanced) lets each saved or custom config edit launch, wake and resume guidance. It's literal text, not a template: braces, dollar signs and placeholder-looking words aren't substituted. Identity, task, rules, updates and interruption warnings stay generated by acom. Recovery continues the same harness conversation and warns about partial commands, lost unsaved work and stopped background tasks.

## Models

Settings and the Launch dialog offer the models acom knows, by full ID:

- Claude: `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5`, `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-mythos-5-1`
- Codex: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`

A newer model can be typed in as a custom ID. The allowed-model list in Settings limits what agents may launch; your own launches can use any ID.

The catalog isn't a guarantee that your installed harness supports a model. Fresh configs default to `gpt-6-sol`; existing model choices aren't rewritten. An older Codex CLI can reject `gpt-6.1-sol` while a newer editor-bundled CLI accepts it with the same ChatGPT login. acom uses `codex` from the server's PATH, not the editor's client, and inherits its login/configuration (`CODEX_HOME` if set). Compare `command -v codex`, `codex --version` and `codex login status`; update the standalone client or start acom with the newer client's directory first in PATH. No API key is needed when that client is signed in with ChatGPT. See [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

Errors are shown plainly, with **Retry same model** and **Launch another model…**; acom never silently substitutes one.

## Permissions

Agents run unattended, so nobody can answer a permission prompt. By default they run with full permissions: Claude with `--dangerously-skip-permissions`, Codex with `--dangerously-bypass-approvals-and-sandbox`. They can do anything your user account can, so only run acom where that's acceptable. To restrict them, change the extra launch flags in Settings, e.g. `--permission-mode acceptEdits` for Claude or `--sandbox workspace-write` for Codex; anything the harness would then ask about is denied.

## Test

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

The HTTP server listens only on loopback and has no authentication: it's a local tool.
