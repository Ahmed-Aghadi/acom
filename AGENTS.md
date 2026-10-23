# Development rules

Contributor instructions for editing this repository. These are separate from the runtime guide supplied to agents launched by acom.

## Contract and scope

- Read the relevant [SPEC](SPEC.md) sections and trace the implementation before changing behavior. Code establishes current behavior; SPEC records the agreed contract. Resolve discrepancies explicitly instead of assuming either is correct.
- Keep changes small and use existing shared helpers. Avoid speculative features, parallel implementations, compatibility layers unless requested, and comments that merely repeat code.
- Put behavioral contracts in SPEC, user workflows in README, and only runtime-agent instructions in `src/guide.md`. Use code comments for non-obvious reasons/invariants and regression tests for concrete failures. Update affected documents together; never document proposed behavior as already implemented.
- Dependency/feature updates require license and attribution review, including bundled native code. Keep `licenses/rust.json` and generated notices current using `scripts/licenses.cjs`; follow the documented toolchain/platform checks before binary releases. Do not change the project's MIT license to replace third-party terms.

## Input and outcome boundaries

- Follow [Request validation and outcomes](SPEC.md#request-validation-and-outcomes) for every CLI command and endpoint. Enforce rules in shared server/application code; CLI/UI checks supplement that boundary.
- Distinguish omitted, invalid, unknown and unavailable values. Defaults apply only where documented, never as a fallback for malformed supplied input. Keep canonical IDs separate from display labels; normalize only explicit, unambiguous aliases.
- Check permissions, project scope and lifecycle eligibility at the point of mutation. Rejected validation must not leave business-state changes, consumed notifications/cursors or started workers.
- Report the actual outcome: registered/queued is not completed. A failed wake must not turn a saved message into a failed send; uncertain write responses must not encourage blind retries.

## State and delivery

- Commit related state, memberships, history, notices and delivery cursors atomically. Build prompts from committed state. Do not expose half-completed transitions.
- Tie delayed callbacks/waits to the relevant turn/process, not just an agent ID or lifecycle label. Recheck after blocking or asynchronous work; prevent duplicate starts and clean up failed starts.
- When stopping a worker, keep its locks reserved until it and its owned tools stop; ordinary TTL expiry is separate. Never signal a process based only on a reusable PID.
- Preserve durable delivery and acknowledgement rules across failures, restarts and replacements. Notification acknowledgement, read status and work marks are distinct; omitted/truncated content must not be silently acknowledged.
- Keep reads bounded with explicit continuation/truncation. Test page boundaries for omissions and duplicates. UI polling must preserve drafts, selection and focus, and reject stale responses.
- Preserve uncertainty: missing usage is not zero, a reset estimate is not observed recovery, and assistant text is not a harness failure. Document provider/version evidence for parser changes; synthetic fixtures do not establish real provider behavior.

## Verification and handoff

- For behavior changes, add a regression that fails before the fix. Cover valid input and rejection/no-side-effects, direct API bypass of client checks, and affected failure/restart/concurrency paths. Test shared behavior through each affected entry point.
- Use the [README test instructions](README.md#test). Isolate data, ports, credentials, fake clients and builds from running instances. Never alter live data or replace a live executable as a test. Real-provider tests spend usage and require explicit user approval.
- Report what changed, evidence, tests run/skipped and remaining gaps. Documentation alone is not a fix or a guarantee: enforce contracts in code and tests, and extend these rules when a new general failure pattern is confirmed.
