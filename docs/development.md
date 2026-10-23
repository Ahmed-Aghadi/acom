# Development

[README](../README.md)

Read [AGENTS.md](../AGENTS.md) for contributor rules and [SPEC.md](../SPEC.md) for behavioral contracts, including [request validation and outcomes](../SPEC.md#request-validation-and-outcomes). These apply to CLI, server and UI changes.

The only browser library is a pinned local Markdown parser; its [dependency review, digests and licenses](../src/vendor/README.md) document what ships. No npm installation is needed to build or run acom. Updates require renewed artifact/source/dependency/advisory review and the injection, fallback, copy, paging and polling regressions; never replace it with a CDN or floating version.

The server rejects unknown request fields/query parameters, duplicate keys and malformed supplied values before applying an action; CLI/UI checks are additional safeguards. Defaults apply only to documented omissions/nulls. Failures return an HTTP error and a nonzero CLI exit status. A successful registration or queued action is not a completed event or provider turn: inspect its receipt and subsequent status. If a write's result is uncertain, inspect state before retrying.

## Licenses and releases

Keep the project's MIT [LICENSE](../LICENSE) unchanged when updating third-party notices. [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt) is generated from the reviewed [Rust inventory](../licenses/rust.json) and existing Markdown notices. It includes build dependencies and bundled native-source notices conservatively, not a claim that every listed source file is linked. `acom licenses` embeds and prints the project's license followed by these notices without using a server, provider or data directory.

After fetching/building the locked dependencies, check without network access or output changes:

```sh
node scripts/licenses.cjs --check
```

Dependency or feature changes require license review before editing the inventory: verify upstream license choices, applicable native/file-level copyrights and NOTICE files, then update the manifest/lock hashes, exact package versions, selected terms, file hashes and any source-header ranges/hashes. The generator refuses unreviewed changes; it does not choose licenses or update the inventory. Regenerate with `node scripts/licenses.cjs --write`, inspect the diff, rebuild, and run `node --test tests/licenses.cjs` with `ACOM_BINARY` pointing at that isolated build. License extraction only reads already-fetched package files; it adds no tools or build hooks and executes no package scripts. License text content is retained, with line endings normalized in the combined file.

The reviewed dependency graphs are the default aarch64 and x86_64 GNU Linux builds. Before publishing binaries, check the actual release features, target, compiler/standard-library and bundled system libraries; those toolchain/platform components are not covered by Cargo.lock. Include their matching licenses/notices as well as LICENSE and THIRD_PARTY_NOTICES.txt in the release package, or otherwise supply the required readable materials with the executable. Rust toolchains provide standard-library notices under `share/doc/rust/COPYRIGHT-library.html` in `rustc --print sysroot`. A different build configuration requires renewed coverage review; do not assume this inventory covers it. None of this changes acom's own MIT license.

## Tests

Deterministic regression tests use fake clients and require Node with `node:sqlite` (Node 24+ is a suitable choice).

When developing beside a running instance, use a separate `CARGO_TARGET_DIR` and point `ACOM_BINARY` at that build; do not replace binaries used by live agents. Test fixtures use isolated data directories.

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo build && node --test tests/server.cjs tests/pagination.cjs tests/thread-access.cjs tests/wait-watch.cjs tests/subscriptions.cjs
```

Browser tests for the UI (optional; no model turns or provider login):

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node --test tests/ui.cjs
ACOM_BROWSER_TEST=1 node --test tests/server.cjs
```

For just the real-server browser setup/settings/filter flow, add `ACOM_BROWSER_TEST_ONLY=1` and `--test-name-pattern='single server'` to the last command.

## Real-provider tests

These spend provider usage. Run only with explicit approval for the selected tests/models; never as part of routine checks.

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

## Screenshots

The README images are captured from the real server/UI with synthetic sample data. No model turns run, and usage remains unknown. The script uses a temporary data directory, an empty client PATH and isolated provider configuration; it never reads your acom database. It requires the optional Playwright setup above and a built binary.

```sh
node scripts/screenshots.cjs
```

Set `ACOM_BINARY` to an isolated binary when developing beside a running server. `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_CHROMIUM` can select an existing Playwright installation/browser. The script replaces only `docs/images/overview.png` and `docs/images/threads.png`.

## Future: real-agent behavior checks

Planned, not implemented: small real-agent scenarios to check whether agents understand the normal guide and use acom correctly. Tasks should describe the desired outcome, not supply command recipes. Check actual work, command results and server events, not just the agent's claim of success. These supplement deterministic tests, especially after major guide or lifecycle changes.

- Run only with explicit user approval for the selected scenarios, providers/models/efforts, repetitions and run limits. Never run automatically in CI or during routine testing. Bound agents (including helpers), turns, duration and concurrency; no unapproved retries or fallback models.
- Start with isolated single-agent tasks; add small messaging/marks, lock/expiry, helper/handoff and configuration/continuation scenarios where needed. Independent scenarios can run in parallel within the approved limits; cooperating agents share only their scenario's project. Use temporary projects and separate acom data, never live audit sessions.
- Keep a progress list and append-only results ledger: commit and dirty-worktree status, scenario/prompt revision, date, provider, requested and observed model/effort per turn, attempt number, result/reason, duration, usage when available, and evidence paths. Summarize run/pass/fail counts per commit/scenario/configuration; distinguish unavailable, blocked, timed-out and unrun cases from behavioral failures or passes. Preserve failures rather than retrying until green.
