# X11 Event Backend Plan (Rust)

## Goal
Replace Linux X11 polling-heavy trigger path with selection-event-driven backend while keeping current fallback behavior.

## Current Baseline
- Session detection and providers are already abstracted in `src/linux_platform.rs`.
- `SelectionListener` uses injected Linux providers in `src/capture.rs`.
- X11 text read mode already prefers `PRIMARY` then `CLIPBOARD`.

## Target Architecture
1. Keep `LinuxSessionDetector` as-is for backend selection.
2. Add `LinuxSelectionEventProvider` trait for Linux trigger events:
   - `fn poll_event(&mut self) -> Option<SelectionSignal>`
3. Implement backends:
   - `X11SelectionEventProvider` (event-driven)
   - `WaylandSelectionEventProvider` (restricted copy-key mode)
4. Wire provider via factory (dependency inversion), no direct crate coupling in `capture.rs`.

## Crate Options
- Preferred: `x11rb` (pure Rust, maintained)
- Alternative: `x11` FFI bindings (more manual unsafe surface)

## X11 Event Strategy
1. Open X connection, query XFixes availability.
2. Subscribe to selection owner changes for `PRIMARY` and `CLIPBOARD`.
3. On owner change:
   - debounce small bursts
   - request `text/plain;charset=utf-8` or fallback target
   - emit `SelectionSignal` with current pointer position
4. If XFixes unavailable, degrade to current polling trigger path.

## Safety / UX Constraints
- Do not mutate user clipboard on Linux.
- Keep guard rules active only when window metadata is available.
- Preserve existing `Wayland` limited semantics.

## Capability Fields to Keep Updated
- `session_kind`
- `session_confidence`
- `window_info_available`
- `selection_read_mode`
- `global_selection_event` (set true when X11 event backend is active)

## Rollout Steps
1. Add trait and placeholder provider implementation with tests. (Done: trait + provider abstraction integrated)
2. Implement X11 provider behind runtime detection. (Done: XFixes-backed backend integrated with automatic polling fallback)
3. Shadow run with logging against existing path. (Done: event backend emits shadow comparison stats against polling fallback)
4. Flip default for X11 when stability criteria met. (Done: auto-promotion to event-default with drift-based demotion fallback)

## Validation Checklist
- X11 apps: browser, terminal, IDE, PDF viewer.
- Selection types: drag-select, double-click word, keyboard selection.
- Clipboard integrity: ensure no overwrite side effect.
- Repeated rapid selections and long-text selections.
