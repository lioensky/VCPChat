# Live2D integration — 2026-10-11

Base: `lioensky/VCPChat:feat/deskpet-live2d-v1` at `75090bda8106761a1b9ee7ecaf98edd7dec9500a`. Integration branch: `RoxyAsahi/VCPChat:codex/deskpet-hover-session-card`, upstream PR #241.

The branch combines the stable dock hover area, circular dock controls, bell-driven stacked conversation cards, and per-topic running/completed status with the three selectable built-in Nova outfits. Tech and maid now each map all twelve emotions to distinct expression files. The existing chibi model keeps its eleven expressions and gestures (calm shares Neutral). Model binaries and textures are unchanged from the base.

ZIP imports enforce limits while inflating, including forged declared sizes, and remove partial output on failure. The implementation uses Node zlib streaming without new dependencies. This port includes only the ZIP source and regression tests from `c6ae7132`, and model JSON configuration from `88141b13`, rather than importing their older branch history.

Validation on the integrated tree:

- 232 deskpet tests passed. Approval lifecycle tests wait for delivery before closing a pet and always clean up handlers after failure.
- 66 chat contracts passed; generated event graph contains 863 events.
- Actual Electron/Core rendering: 320 assertions passed across tech, maid, and chibi, including expression parameters, neutral reset, blink/talk, finite geometry, and outfit selection.
- Actual settings ZIP import: 7 assertions passed, including rejection of a forged 384 MiB archive at the 300 MiB limit and partial-output cleanup.
- Actual dock/session UI at 200% display scale: 26 assertions passed, including 32 px circular buttons, balanced pill padding, circular badge, hover, session navigation, and outfit reload.

The old `daily-deskpet` working tree was reviewed and left intact. Its unique local versions include removed upstream safeguards (agent cleanup, side-chat orphan prevention, tool presentation settings, sidebar state restoration) and obsolete generated baselines. Its stream-usage addition conflicts with the upstream regression test protecting backends that reject `stream_options`; it is intentionally excluded. Its unrelated side-pane CI job and wording changes are outside this Live2D integration.

Validation uses isolated fixture data. Existing chat records, user theme changes, and private Cubism Core files are not part of this commit. This integration does not claim the remaining art/rig limitations listed in the Nova README are resolved.
