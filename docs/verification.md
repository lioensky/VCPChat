# Development verification

Run `npm run verify:development` from the repository root with normal process permissions and installed Node/Electron/Rust dependencies.

This runs every top-level `tests/*.test.{js,mjs,cjs}` file in its own Node process, followed by the UI-system, chat-evidence, settings-ownership, UIUX-artifact, release-surface and chat-kernel-consumer gates, dedicated-preload Electron smoke, and native voice-parser tests. Failed, cancelled, skipped, pending or timed-out tests fail verification. Profile writes use temporary LOCALAPPDATA. Set `VCPCHAT_TEST_REPORT_DIR` to retain per-file TAP logs and the summary.

Dynamic source reviews bind a file, line, operation and the receiver/event-name expression. Reviewed wrappers are not invented event endpoints or runtime safety guarantees. New calls, changed event-name expressions, and stale registrations fail the contract gate. Event inventory normalizes Git checkout line endings.

The design boundary checks the integrated product. Its former design-only PR path allowlist and upstream byte-parity rules were retired because Git, ProjectForge, side chats and upstream fixes are now intended product features; see the historical `design-system-upstream-pr-convergence.md`. Runtime isolation, embedded descriptor constraints, retained assets, CSS ownership, composer focus and script existence still fail on violations, including new untracked source files. Negative fixture tests exercise these constraints.

No legacy test was deleted. The repeated existing-failure count is replaced by the current run's actual totals. Shared-source digests record individually reviewed integrated changes in `scripts/next-delta-shared-baseline.json`; changing a protected source still requires a new review. The settings ownership gate recognizes the exact legacy `agentModelInput` alias while continuing to check its canonical `agentModel` control.

Interactive device tests, manual release approval and performance soaks remain separate from this reproducible development gate. Packaged-artifact smoke requires `VCPCHAT_PACKAGED_ROOT` pointing to an unpacked build; without it, the existing chat-evidence runner reports that smoke as skipped. A passing development gate does not certify a packaged release.
