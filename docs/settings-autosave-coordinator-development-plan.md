# Settings Autosave Coordinator Development Plan

Status: implementation pass completed; acceptance remains open for external-conflict UX and Electron evidence

Baseline: `exp/settings-schema` at `6d70bee6`; implementation branch: `feat/settings-autosave-coordinator`.

## Current architecture

The global settings surface currently has four overlapping save owners. The legacy autosave listener watches native form input/change events and submits a complete form snapshot through `modules/ui-system/settings/autosave.js`. Typed field owners in `modules/ui-system/typed-field-owners.js` debounce individual controls but assemble patches on top of a module-level snapshot before calling `createSettingsUiService`. Forum credentials have a separate typed owner and command. `modules/global-settings-manager.js` also collects and submits a complete snapshot, while `modules/ui-system/settings/save-coordinator.js` currently coordinates only request submission and result routing. `modules/ui-system/settings-bridge.js` calls flush callbacks without awaiting their asynchronous work during close.

The main process accepts the complete payload in `modules/ipc/settingsHandlers.js` and delegates to `modules/utils/appSettingsManager.js`. The manager serializes its in-process queue and writes a validated JSON file through a temporary sibling, but lock acquisition is check-then-write, stale locks are removed by age, and there is no compare-and-set revision contract. Multiple renderer owners can therefore submit stale complete snapshots that overwrite unrelated edits.

## Confirmed defects

1. A typed save that is in flight while a second field changes can publish the first result without advancing the local snapshot. The queued second save is then assembled from stale state and can erase the first field.
2. Typed and legacy owners submit complete snapshots through different queues. Whichever request lands last can overwrite a newer value from the other owner.
3. Close-time flush starts asynchronous work but does not await durable completion before destroying owners and result listeners.
4. The legacy 15-second fallback has no operation identity. A late result from timed-out save A can clear state belonging to save B.
5. Cancelled or stale generations are currently normalized as successful saves, which can clear dirty state despite no current commit.
6. A typed save failure does not reschedule a pending patch, leaving the next edit stranded until another event happens.
7. Legacy, typed settings, and typed forum owners write one shared dirty/status dataset. A successful result from one owner can clear another owner's unsaved work.
8. The main-process lock checks for existence before writing, allowing two processes to enter the critical section. Age-based cleanup can also remove a live lock during a slow write.

## DeepSeek Harness alignment

The implementation follows the useful settings principles from DeepSeek Harness without importing Cordis or replacing VCPChat's existing settings schema. This pass now includes:

- Keep an immutable draft and explicit durable base revision.
- Address edits as path operations so a partial/redacted view cannot delete fields it never saw.
- Serialize writes and evaluate the revision check at the queue front.
- Re-read under the writer lock, merge only touched paths, validate, and atomically persist.
- Return an explicit `operationId`, `expectedRevision`, `currentRevision`, and terminal outcome.
- Distinguish `success`, `failed`, `cancelled`, `stale`, and `conflict`; late operations lose publication rights.
- Make `flush()` and `dispose()` barriers that resolve only after the queue reaches quiescence.
- Retain failed batches/drafts for retry instead of silently dropping them.
- Treat external edits as reconciliation/conflict events; preserve a dirty local draft.

施工状态（本批）：

- 已完成 close 前 drain、结果通道保留、legacy/typed Promise flush 和失败 batch retention。
- 已完成 typed `set/unset` path operation、锁内 fresh read、CAS 和 `load-settings` revision 返回。
- 已补 coordinator path-operation 与 manager regression test。
- 尚未完成 watcher 驱动的 renderer conflict reconciliation、reload/keep-draft UI、所有直接 `chatAPI.saveSettings()` 调用迁移及真实 Electron/跨平台证据。

Revision tokens are opaque content-derived values exposed only through the save protocol. This keeps the existing `settings.json` user field shape unchanged while still allowing CAS across renderer windows and process restarts.

## Target contract

One per-surface `SettingsSaveCoordinator` owns draft state, pending path operations, dirty fields, one debounce timer, one in-flight durable operation, operation identity, retryable failure, conflict state, and child channel statuses. Typed and legacy clients register as channels and submit patches through the coordinator; no client may clear the aggregate dirty flag directly.

The aggregate status precedence is `conflict > error > saving > dirty > saved > idle`. Forum, Rust, and avatar persistence remain separate command boundaries for now, but their terminal states are represented as child transactions so a partial success cannot be reported as a global success.

`flush()` returns a promise that waits for the debounce window, all in-flight writes, and all child transactions. `dispose()` first reaches that barrier, then unregisters listeners, timers, result handlers, and owner references. If the barrier fails or detects a conflict, the draft remains available for retry/reload and teardown does not claim that the data is durable.

The main-process `save-settings` handler accepts the existing complete snapshot for compatibility plus a coordinator payload containing path operations and `expectedRevision`. It returns `{ success, status, operationId, currentRevision, settings?, error? }`. A revision mismatch returns `status: 'conflict'` and `code: 'SETTINGS_CONFLICT'` without writing.

## Conflict behavior

On an external edit or revision mismatch, the coordinator pauses automatic retry and keeps the local draft. The surface offers reload-from-disk and keep-draft-and-retry actions. Non-overlapping path patches are reapplied to the latest base; overlapping paths remain in conflict and are never silently overwritten.

## Scope and non-goals

This batch targets the Global Settings surface and its shared save-settings backend. Other direct `chatAPI.saveSettings()` callers retain the compatibility payload but are not comprehensively migrated. Rust configuration, forum configuration, avatar files, chat business state, plugin Loader, and chat persistence protocols remain unchanged. No Cordis, React, Vue, or second durable settings store is introduced.

## Acceptance and evidence matrix

Focused tests must cover rapid typed A/B edits, typed/legacy overlap, failure with pending work, late result isolation, explicit cancellation/stale/conflict outcomes, awaited flush/dispose, aggregate status, lock races, CAS conflicts, read-modify-write, atomic writes, external edits, close/reopen, reload, timeout, retry, and conflict recovery.

The implementation is validated with:

```text
node --test tests/global-settings-save.test.mjs
node --test tests/uiux-settings-adapter.test.mjs tests/uiux-settings-bridge-modules.test.mjs
node --test tests/settings-value-golden.test.mjs
npm run check:uiux
npm run test:ui-system
npm run test:settings-wa-electron
```

Packaged Electron, cross-platform Windows/macOS, GPU/DPI, and manual-soak evidence remain delivery gates outside this local implementation pass and must not be inferred from focused tests.
