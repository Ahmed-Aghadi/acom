# acom

Launch and coordinate Claude Code and Codex agents across your projects from one local dashboard.

- Run agents from either provider, grouped by task or team.
- Let agents exchange messages, launch helpers and coordinate shared work with named locks.
- Set project-level usage, concurrency and context limits.
- Configure crash retries, model replacement and usage recovery.
- Inspect activity, pause or resume work, and keep conversations across turns.
- Inspect token history, grant scoped agent controls, and export or restore projects.

![acom overview showing grouped agents, usage, lifecycle controls and shared locks](docs/images/overview.png)

*Actual UI with synthetic sample data. Usage is shown as unknown; no model turns were run for these screenshots.*

[Quickstart](#quickstart) · [Working with agents](#working-with-agents) · [Troubleshooting](#troubleshooting) · [Documentation](#documentation)

## Before running

You need Linux, a Rust toolchain, Git, and at least one supported CLI (`claude` or `codex`) installed and signed in. The server must be able to find that CLI on its `PATH`. Linux process supervision uses `/proc`; other operating systems are not currently supported.

**Agents run with full account permissions by default and share your project's files.** Review settings before launching in a trusted project. Locks and private threads are coordination tools, not a security sandbox. The web server binds to loopback and has no authentication: do not expose it publicly.

## Quickstart

```sh
git clone https://github.com/Ahmed-Aghadi/acom.git
cd acom
cargo install --path .
acom serve
```

Open <http://127.0.0.1:7400/>. To use a different port, run `acom serve --port 7401`.

1. **Add a project:** choose the folder where agents should work.
2. **Review Settings:** new projects use the read-only **Default** configuration. Choose **Custom** or **Save as new config** to change it; **Save** applies changes or a selected configuration.
3. **Launch:** choose the provider CLI you installed and signed into, an available model and effort, then enter a task. Check the selected provider explicitly if only one CLI is installed.
4. **Follow the work:** open **Details** for activity and configuration. Use **Threads** to create a conversation with the agent and send instructions. **Pause** stops its processes; **Resume** continues interrupted work when eligible.

An agent that marks its task done is closed by default; use **Reopen** to continue. Messages do not wake closed agents. The [user guide](docs/usage.md) explains lifecycle states, limits and recovery.

Models in the catalog are choices, not account-access checks. Select a model supported by your installed CLI and account.

## Working with agents

Each project has its own agents, threads, locks and settings. A single server handles all your projects. Agents receive their identity, task, rules and the built-in [agent guide](src/guide.md); they coordinate through the `acom` CLI.

Threads let you talk with agents and let them talk with each other. They can be public or private, use fixed members or follow live agent-state/group filters. Drafts save locally immediately and sync to the server, with conflict protection between tabs.

Messages display basic Markdown and appear immediately with a sending indicator until acom confirms they are saved. Copy icons preserve original message text and make paths and agent details easy to reuse. Hide the sidebar for more space; the workspace expands with your viewport.

Find threads by title, exact thread ID or current members, matching all or any selected agents. Agent Details lists its current threads. Message metadata includes its ID, **Copy reference** and **Copy link**; links identify the project, thread and message.

Search message text within one thread or across the selected project's complete accessible history, with optional thread, sender and date filters. Exact message-ID lookup is a separate mode, so a numeric text search stays a text search. Results show snippets; opening one highlights the message with surrounding context. Search previews and historical context leave read state unchanged; **Jump to latest** returns to ordinary live reading. Drafts and work marks are preserved.

The CLI provides the same bounded discovery:

```sh
acom threads --members 2,5 --member-match all
acom threads --id 12
acom messages --search 'review findings' --thread 12
acom messages --search 'review findings' --sender 2
acom read 83 --thread 12
```

Omit `--thread` to search all accessible project threads; use `--threads 12,15` for a selected set. `messages --id 83` looks up an exact message ID with optional filters; `read 83` reads its full record without knowing the thread. `--from`/`--to` accept inclusive Unix seconds. Follow printed continuation commands instead of assuming one page is complete. Numeric IDs are project-local, and member filters mean current membership, not historical participation.

![acom threads showing a user and agents coordinating a review](docs/images/threads.png)

Project Pause/Resume controls affect the selected project; global controls are under **All projects**. Agent-list filters never narrow those actions.

Search plain text across agent metadata, or use exact fields:

```text
group:"Security review" state:paused,crashed reentrancy
```

Spaces combine conditions with AND; commas within a field give alternatives. This finds the exact group, either state, and `reentrancy` in the agent's metadata. Use `state:idle OR pause_reason:limit` for idle or limit-paused agents, and `NOT (state:closed OR state:replaced)` to exclude closed and replaced agents. Parentheses group conditions; precedence is NOT, AND, OR. The visual **Filters** editor supports Match all/any, exclusion and nested groups without query syntax. Click **Apply filters** to update results. See [agent search](docs/usage.md#finding-agents) for all fields and quoting rules.

Use `name:"Launcher"` for an exact name, or `id:5` for one project-local agent. Details → **Delegated controls** lets you grant selected pause, resume, close or reopen actions to an agent, scoped to its directly launched workers, selected agents or the project. No permissions are granted by default. These are trusted-local coordination rules, not OS isolation.

## Data and shutdown

acom stores data in `~/.acom`; set `ACOM_HOME` for a separate installation. Each project has a stable UUID and its own core database, optional metrics database and captured files under `projects/<UUID>/`. Numeric agent/thread/message IDs start independently in each project. Global settings, saved configurations and account observations live separately. Native conversations remain in provider storage unless explicitly archived. Agents edit project files, but acom keeps none of its own state there.

**Settings → Storage → Calculate disk usage** checks allocated space on demand, split by project and core state, metrics, logs, native archives, trash and other data. Results may change while agents work; no scans run automatically. Optional history/captured-file cleanup does not remove messages or authoritative accounting. See [storage details](docs/usage.md#storage-restarts-and-upgrades).

Project archives are uncompressed `.tar` files containing private project data. Export includes the applied configuration and server-saved drafts; logs and native transcripts are optional. Import validates in staging, never overwrites a project, and starts no workers. See [project archives](docs/usage.md#project-archives).

Ctrl-C or SIGTERM stops owned workers and their tools, then releases their locks. Interrupted turns become **restart-paused**; idle agents and existing manual/limit pauses retain their state. Starting the server does not automatically resume interrupted turns. Use **Resume restart-paused**, or `acom resume-restart` for all projects, when ready.

This development format is intentionally incompatible with the previous shared database. Before upgrading, stop the old server and back up its entire data directory. Use a fresh `ACOM_HOME` and recreate configurations; there is no automatic migration or deletion. Current-format archives can be restored into another installation. See [storage, restarts and upgrades](docs/usage.md#storage-restarts-and-upgrades).

## Troubleshooting

- **`acom` is not found:** ensure Cargo's executable directory is on your shell's `PATH`.
- **A provider CLI or model is unavailable:** check the server's `PATH`, CLI version and login. The server uses the standalone client it finds, not necessarily the one bundled with your editor. Choose an accessible model explicitly; acom does not silently substitute one.
- **Usage is unknown or recovery is waiting:** open the provider's usage meter for the check error and **Check now**. Unknown is not zero; a reset estimate alone does not confirm available usage.
- **The server says it is already running:** only one server may use a data directory. For an isolated instance, set a different `ACOM_HOME` and choose a different port.

Run `acom --help` for commands or `acom <command> --help` for options. User CLI commands act on the project containing your current directory.

## Documentation

- [User guide](docs/usage.md): settings, threads, filters, waits, locks, limits, model changes, replacement and recovery.
- [Agent guide](src/guide.md): the instructions supplied to launched agents; also available with `acom guide`.
- [Model reference](src/models.md): model/provider comparisons and supported catalog choices; `acom models --catalog` lists IDs and efforts.
- [Specification](SPEC.md): behavioral contracts and API details.
- [Development](docs/development.md) and [contributor rules](AGENTS.md): testing, screenshot capture and planned behavior checks.

## Test

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

The [development instructions](docs/development.md#tests) cover isolated API/CLI and browser tests. Real-provider tests spend usage and require explicit approval; routine tests use fake clients.

## License

acom's own code is licensed under [MIT](LICENSE). Dependencies retain their licenses and attributions in [Third-party notices](THIRD_PARTY_NOTICES.txt). `acom licenses` prints both from the binary without a server.

See [licenses and releases](docs/development.md#licenses-and-releases) before distributing prebuilt binaries.
