# Forge-aware T1/T2 context compaction

## Purpose

Improve the existing general context compactor for ProjectForge coding sessions without replacing it or requiring a new model response schema.

- T1 is a deterministic request-boundary projection of closed tool stages.
- T2 is the existing semantic compaction request, consuming the T1 projection plus a host-maintained historical observation ledger.
- Original topic history remains the recovery source; T1 never overwrites it.

## Trigger and protection

A stage closes only on a uniquely paired, successful ProjectForge `UpdateTodos(done)` whose result confirms the same project and requested `#N→done` changes. `done` is a state transition, not evidence that tests passed. `doing`, an old done status, `SubmitReport accepted`, and merely passing two tool batches are not triggers.

Only known, successful, sufficiently large code payloads are previewed. Complete requests, public assistant narration, user content, failures, and the latest two recognized Forge results are retained. A preview includes bounded head/tail text, available node/batch anchors and original message ID/range; it is explicitly not a complete semantic finding.

The parser accepts a single result plus the server's complete tool-status summary epilogue. Concurrent or ambiguous batches, recovered/unclosed protocol, embedded examples, media, async/approval content and missing/duplicate message IDs remain conservative barriers. Structurally paired unknown/unowned calls such as `CreateProject` are opaque barriers: preserved as-is, without suppressing later independent stages or allowing a closure to borrow content across the barrier.

The original protocol is historical text, not authenticated evidence. Source fingerprints detect ordinary changes; they are not authentication, collision resistance or proof of testing.

## Request boundaries versus in-flight loops

Normal send, regeneration, continuation and Flowlock share the same sender projection. Pre-send estimation uses that same projection. The running server loop already owns a copy of the request history, so in-flight checks explicitly use unprojected history; client savings cannot increase its budget retroactively.

Existing 85% pre-send, 100% complete streaming-tool boundary, manual and Flowlock T2 entry points are unchanged. T2 also works when no T1 stage is adopted. Token estimates remain local heuristics, not provider usage or complete assembled-request prices.

## T2 ledger inheritance and recovery

The host saves versioned `forgeState` in existing checkpoint metadata and renders the same observations in the checkpoint appendix. It contains project identity, status, intent, available node/batch anchors and stable message ID/UTF-16 ranges. It is a record of past observations, not the current project database.

Before inheritance, source identity, ordinary-edit fingerprints, ordering and parsed observations are checked against complete original history. Changed/deleted/duplicate sources or invalid metadata produce warnings rather than invented replacements. Budgets reserve inherited observations first; new folds are declined rather than silently truncating old sources.

The compaction model still returns text. An optional `{{forge_state}}` template slot can place the host appendix; otherwise it is appended only for Forge stages. Diary handling and checkpoint kind/version remain compatible. Cancel, history CAS drift and save failures use the existing mutation authority. Host-only checkpoint metadata is excluded from outbound text pricing; its rendered content is still charged.

There is no automatic retirement of failures based on a later done status. Original results remain readable using the stored message ID and range. Rolling back code does not erase existing checkpoint metadata or appended text: back up topic history and use an older checkpoint or undo the relevant checkpoint if necessary; do not delete original user messages.

## Tests and verification

The added synthetic tests cover modern/legacy protocols, summary epilogues, opaque ownership barriers, false triggers, failures, concurrent/malformed batches, media, hot-tail protection, immutable inputs, net benefit including metadata/rendering, shared outgoing text versus in-flight pricing, two checkpoint generations, literal template substitutions, source edits/deletes/duplicates, cancellation, CAS drift and save failure.

Portable related suite from the repository root:

```bash
node --test tests/context-compaction-*.test.mjs \
  tests/chat-context-pipeline.test.mjs \
  tests/chat-history-mutation-authority.test.mjs \
  tests/chat-history-persistence.test.mjs \
  tests/chat-manager-selection-race.test.js \
  tests/single-chat-request-orchestrator.test.js \
  tests/flowlock-*.test.* tests/main-chat-flowlock-owner.test.mjs \
  tests/topic-history-cas.test.mjs tests/tool-batch-*.test.mjs \
  tests/tool-request-scanner.test.js tests/tool-request-malformed-marker.test.mjs \
  tests/tool-result-regions.test.js tests/text-viewer-tool-batch.test.mjs
```

On the original implementation baseline this suite passed 221 tests with zero failures/skips on an actual Electron Node runtime. An additional filesystem-only rehearsal restored checked source backups, removed new runtime/test files in an isolated temporary tree and verified two-generation JSON reload with original-source SHA-256 equality. The broader chat-kernel suite had three pre-existing JSDOM eval/import fixture failures that reproduced in restored pre-change source; they were not hidden with skips. Results on the PR's newer upstream baseline are recorded in the PR description.

A large-read synthetic fixture produced 57,352 raw history JSON characters versus 6,370 including the T1 projection, machine ledger and rendered appendix. Full T2 input including system/task prompts and appendix changed from 60,135 to 7,716 characters. This measures deterministic payload savings for that fixture only, not real conversation averages or semantic model quality.

## Limits

No server-loop compactor, mutable global T1 cache, extra timer, DSH kernel/storage dependency, or new model JSON format is introduced. No runtime configuration, private topic histories, credentials or local audit artifacts belong to this change.

Real model omission rates, live GUI loading, full Rust history-service integration and service-side in-loop compaction were not verified. Tests with fixed synthetic model responses are pipeline checks, not a claim of lossless semantic compaction. Unsupported or over-budget stages remain unmodified.
