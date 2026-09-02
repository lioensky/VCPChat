# Settings Autosave Coordinator Development Plan

Status: implementation complete for Global Settings; external delivery evidence gates remain open

Baseline: `exp/settings-schema` at `6d70bee6`; implementation branch: `feat/settings-autosave-coordinator`.

## Current architecture

The global settings surface still contains compatibility owners, but all Global Settings owners register with `SettingsSaveCoordinator`. Legacy form submission, typed field patches, and forum child transactions publish aggregate state through the coordinator. Typed saves use the coordinator's operation-aware `savePatch()` transport; direct IPC remains only as an early-bootstrap/compatibility fallback. The coordinator keeps durable base, local draft, pending path operations, operation identity, retryable failure, and conflict state; close waits for its barrier before owner teardown.

The main process accepts both compatibility snapshots and operation-aware path payloads in `modules/ipc/settingsHandlers.js` and delegates to `modules/utils/appSettingsManager.js`. The manager serializes its in-process queue, acquires an exclusive lock, performs fresh-read/CAS/read-modify-write, validates, and atomically replaces a temporary sibling. Unknown lock owners are never removed automatically.

## Historical defects addressed by this plan

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
- 已接入主进程 settings watcher、preload subscription、renderer conflict 标记，以及 reload/keep-draft 操作条。
- Prompt Manager and other external callers still use the compatibility complete-snapshot API by design; they are outside this Global Settings migration. Packaged Electron/cross-platform evidence remains an environment gate.

全量完成追踪（保持 active）：

1. `filterManager`、`chatManager`、`uiManager`、`event-listeners`、`middleClickHandler` 和 `appearance-studio` 的直接保存调用已迁移为 path ops；仍保留完整快照兼容入口供未迁移的外部插件使用。
2. renderer typed service 与 coordinator 已分离 committed base、local draft、pending ops，并在 dirty/conflict 时禁止外部快照覆盖控件。
3. Electron-facing close/reload/conflict contracts 已覆盖；真实 packaged Electron 操作序列仍待环境可用时补证。
4. macOS packaged smoke、Windows runner、GPU/DPI 几何和人工 soak 仍是发布前证据项。
5. `test:ui-system` 的 UI contract assertions pass; the wrapper may remain alive under JSDOM because of existing open handles, which is recorded as environment evidence rather than hidden.

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
