import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-evidence-manifest-'));
const main = path.join(temp, 'main.json');
const apps = path.join(temp, 'apps.json');
const matrix = path.join(temp, 'matrix.json');
const soak = path.join(temp, 'soak.json');
const packaged = path.join(temp, 'packaged.json');
const output = path.join(temp, 'manifest.json');
fs.writeFileSync(main, JSON.stringify({
    kind: 'electron-main-chat-sequence',
    requiredEdges: '1/1',
    coverage: { missingRequiredEdges: [] },
}));
fs.writeFileSync(apps, JSON.stringify({ kind: 'electron-ui-apps-smoke', passed: 2, total: 2 }));
fs.writeFileSync(matrix, JSON.stringify({ rows: [{ id: 'main', status: 'passed' }] }));
fs.writeFileSync(soak, JSON.stringify({ status: 'manual_observation_required' }));
fs.writeFileSync(packaged, JSON.stringify({ status: 'failed', reason: 'controlled build failure' }));
const run = env => spawnSync(process.execPath, ['scripts/write-chat-evidence-manifest.mjs', output], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
});
let result = run({
    VCPCHAT_SEQUENCE_EVIDENCE_OUTPUT: main,
    VCPCHAT_UI_APPS_EVIDENCE_OUTPUT: apps,
    VCPCHAT_WINDOWS_MATRIX_EVIDENCE_INPUT: matrix,
    VCPCHAT_MANUAL_SOAK_EVIDENCE_INPUT: soak,
    VCPCHAT_PACKAGED_ARTIFACT_EVIDENCE_INPUT: packaged,
});
assert.equal(result.status, 0, result.stderr);
let manifest = JSON.parse(fs.readFileSync(output, 'utf8'));
assert.equal(manifest.checks.realElectronSequence, 'pass');
assert.equal(manifest.checks.realElectronUiApps, 'pass');
assert.equal(manifest.status, 'manual_required');
assert.equal(manifest.checks.windowsMatrix, 'pass');
assert.equal(manifest.checks.manualSoak, 'manual_observation_required');
assert.equal(manifest.checks.packagedArtifact, 'failed');
assert.deepEqual(manifest.checks.transcriptSnapshots, [
    'docs/contracts/snapshots/chat-stream.json',
    'docs/contracts/snapshots/chat-stream-cancel.json',
    'docs/contracts/snapshots/chat-stream-failed.json',
    'docs/contracts/snapshots/chat-stream-discarded.json',
]);
assert.deepEqual(manifest.commands, [
    'node scripts/check-chat-contracts.mjs',
    'node scripts/run-chat-contract-invariants.mjs',
    'node scripts/test-chat-contract-invalid.mjs',
    'node scripts/test-facade-registry-invalid.mjs',
    'node scripts/test-artifact-plane-invalid.mjs',
    'node scripts/test-packaged-artifact-invalid.mjs',
    'node scripts/check-artifact-plane.mjs',
    'node scripts/test-built-artifact-smoke.mjs',
    'node scripts/test-packaged-artifact-smoke.mjs',
    'node scripts/test-chat-transcript-snapshot.mjs',
]);
for (const command of manifest.commands) {
    const script = command.split(' ')[1];
    assert.ok(fs.existsSync(path.join(root, script)), `manifest command script is missing: ${script}`);
}

result = run({ VCPCHAT_SEQUENCE_EVIDENCE_OUTPUT: path.join(temp, 'missing.json') });
assert.notEqual(result.status, 0);
result = run({
    VCPCHAT_REAL_ELECTRON_STATUS: 'pass',
    VCPCHAT_SEQUENCE_EVIDENCE_OUTPUT: main,
    VCPCHAT_UI_APPS_EVIDENCE_OUTPUT: apps,
    VCPCHAT_PACKAGED_ARTIFACT_EVIDENCE_INPUT: packaged,
});
assert.notEqual(result.status, 0, 'forced pass unexpectedly overrode failed packaged evidence');
assert.match(`${result.stderr}\n${result.stdout}`, /requires packaged artifact status passed/);
result = run({
    VCPCHAT_REAL_ELECTRON_STATUS: 'pass',
    VCPCHAT_SEQUENCE_EVIDENCE_OUTPUT: main,
    VCPCHAT_UI_APPS_EVIDENCE_OUTPUT: apps,
});
assert.notEqual(result.status, 0, 'forced pass unexpectedly accepted missing release evidence');
assert.match(`${result.stderr}\n${result.stdout}`, /requires packaged artifact status passed/);
fs.writeFileSync(packaged, JSON.stringify({ status: 'passed' }));
fs.writeFileSync(soak, JSON.stringify({ status: 'passed' }));
result = run({
    VCPCHAT_REAL_ELECTRON_STATUS: 'pass',
    VCPCHAT_SEQUENCE_EVIDENCE_OUTPUT: main,
    VCPCHAT_UI_APPS_EVIDENCE_OUTPUT: apps,
    VCPCHAT_WINDOWS_MATRIX_EVIDENCE_INPUT: matrix,
    VCPCHAT_MANUAL_SOAK_EVIDENCE_INPUT: soak,
    VCPCHAT_PACKAGED_ARTIFACT_EVIDENCE_INPUT: packaged,
});
assert.equal(result.status, 0, result.stderr);
manifest = JSON.parse(fs.readFileSync(output, 'utf8'));
assert.equal(manifest.status, 'pass');
console.log('Chat evidence manifest validation passed (real evidence paths and invalid paths).');
