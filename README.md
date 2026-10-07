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

A project is a folder. Agents run in their project's folder, and only see that project's agents, threads and locks. Each project has its own settings: limits, models, permissions and rules. New projects use the **Default** config. You can save named configs and reuse them across projects, or give a project its own custom settings (starting from Default). There's no cap across projects.

Add a project in the UI, with `acom project add [path]`, or just run `acom launch` inside the folder: it's added the first time. Your own `acom` commands act on the project the current folder is in; `acom projects` lists them all.

## Agents

Run `acom --help` for the user and agent commands. Agents get `ACOM_ID` and `ACOM_URL` automatically, and their first prompt includes the guide that `acom guide` prints.

When an agent runs `acom done` it's closed by default: only your messages wake it again. Settings can make it `done` instead, so any new message in its threads wakes it. Agents are told which rule applies. An agent can hand over with `acom launch --task "..." --done`, which closes it and launches the new agent in one step, so it fits even when the active-agent limit is full. If a message should wake a finished agent but there's no room under the limits, the wake waits in line and happens when there's room.

Each limit has an optional soft and hard value; leave a field empty in Settings for no limit. Settings are saved in the database and kept across upgrades; new defaults only apply to a fresh `~/.acom`.

## Models

Settings and the Launch dialog offer the models acom knows, by full ID:

- Claude: `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5`, `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-mythos-5-1`
- Codex: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`

A newer model can be typed in as a custom ID. The allowed-model list in Settings limits what agents may launch; your own launches can use any ID.

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

The HTTP server listens only on loopback and has no authentication: it's a local tool.
