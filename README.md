# acom

`acom` runs coding-agent sessions for one project, gives them threads and locks, and enforces limits set by the user. It supports Claude Code and Codex.

## Build and run

You need a Rust toolchain and at least one supported harness installed and signed in (`claude` or `codex`). The current process supervisor targets Unix systems.

```sh
cargo install --path .
acom serve
```

Open <http://127.0.0.1:7400/>. Use `--port` to choose another port.

The server owns agent processes and stores project state in `.acom/acom.db`. Its port is written to `.acom/port`, so `acom` commands run in the project or a child directory find the server automatically. Removing `.acom/` starts the project with empty state.

Run `acom --help` for user and agent commands. Agents receive `ACOM_ID` and `ACOM_URL` automatically and can print their full operating guide with `acom guide`.

An agent can use `acom launch --task "..." --done` to finish its own work and launch a replacement atomically, including when the active-agent limit is full. If a message reaches a finished or closed agent while no slot is available, acom keeps the wake request queued and starts that agent when capacity returns.

Every soft and hard limit is optional. Leave its field empty in Settings to disable that threshold.

## Permissions

Agents run unattended, so nobody can answer a permission prompt: whatever the harness would ask about is denied. By default Claude agents run with `--permission-mode acceptEdits` (they can edit files in the project) and Codex agents with `--sandbox workspace-write`. If your agents need to run more, change the extra launch flags in Settings, e.g. add `--allowedTools "Bash(cargo *)"` for Claude, or use `--dangerously-skip-permissions` only on a machine where that's acceptable. (`--permission-mode auto` isn't available to headless Claude agents on every account; it silently falls back to asking, i.e. denying.)

## Test

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

The HTTP server listens only on loopback. It has no user authentication and is intended as a local project tool.
