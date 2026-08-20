import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRepairManifest } = require('../modules/bootstrap/repair-manifest');
const { selectRepairStages, validateLockfile, createRepairPlan } = require('../modules/bootstrap/repair-planner');
const { runProcess } = require('../modules/bootstrap/process-runner');
const { createProgressEvent, encodeProgressEvent, parseProgressLine } = require('../modules/bootstrap/progress-protocol');
const { createRuntimeClosureManifest, validateRuntimePolicy, verifyDirectoryAgainstManifest } = require('../modules/bootstrap/runtime-closure');
const { switchVersion, rollbackVersion, pointerPath, promoteVersionWithHealthCheck } = require('../modules/bootstrap/update-manager');
const { collectEvidence } = await import('../scripts/vcpchat-release-evidence.mjs');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-m3-m8-')); }

test('M3 repair manifest is deterministic and uses npm ci plus targeted rebuild', () => {
    const manifest = createRepairManifest({ projectRoot: '/tmp/project', platform: 'darwin' });
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.stages.find(stage => stage.id === 'install-dependencies').args.slice(0, 2), ['ci', '--no-audit']);
    assert.equal(manifest.stages.find(stage => stage.id === 'rebuild-native-modules').args[0], 'exec');
    assert.equal(manifest.stages.find(stage => stage.id === 'rebuild-native-modules').args.includes('electron-rebuild'), true);
});

test('M3 selection keeps optional Rust/vendor repairs opt-in', () => {
    const manifest = createRepairManifest({ projectRoot: '/tmp/project' });
    const report = { checks: [
        { id: 'dependencies', status: 'fail', code: 'E_DEPENDENCY_MISSING' },
        { id: 'rust-runtime', status: 'warn', code: 'E_RUST_RUNTIME_MISSING' },
    ] };
    const defaultStages = selectRepairStages({ doctorReport: report, manifest });
    assert.equal(defaultStages.some(stage => stage.id === 'build-rust-runtime'), false);
    const fullStages = selectRepairStages({ doctorReport: report, manifest, includeRust: true, repairVendor: true, full: true });
    assert.equal(fullStages.some(stage => stage.id === 'build-rust-runtime'), true);
    assert.equal(fullStages.some(stage => stage.id === 'repair-vendor-closure'), true);
});

test('M3 lock validation rejects package identity drift before npm ci', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'one', version: '1.0.0' }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'two', version: '1.0.0' } } }));
    assert.throws(() => validateLockfile(root), error => error.code === 'E_LOCKFILE_INVALID');
});

test('M3 process runner cancels and settles exactly once', async () => {
    const controller = new AbortController();
    const child = {
        exitCode: null,
        signalCode: null,
        killed: false,
        stdout: { on() {} }, stderr: { on() {} },
        once(event, callback) { if (event === 'exit') this.exit = callback; if (event === 'error') this.error = callback; },
        kill() { this.killed = true; this.exit?.(null, 'SIGTERM'); },
    };
    const promise = runProcess({ command: 'fake', spawnProcess: () => child, signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    const result = await promise;
    assert.equal(result.cancelled, true);
    assert.equal(child.killed, true);
});

test('M4 progress protocol rejects malformed or unknown frames', () => {
    const event = createProgressEvent({ type: 'stage-started', operationId: 'op', stage: 'x' });
    assert.deepEqual(parseProgressLine(encodeProgressEvent(event)), event);
    assert.throws(() => parseProgressLine('{"protocolVersion":99,"type":"stage-started"}'));
});

test('M5 runtime closure detects tampering and policy gaps', () => {
    const root = tempDir();
    for (const file of ['main.js', 'preload.js', 'renderer.js', 'main.html', 'package.json', 'modules/bootstrap/contracts.js', 'modules/ui-system/webawesome-runtime-manifest.js', 'vendor/webawesome-runtime/vcp-runtime-manifest.json']) {
        const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file);
    }
    const manifest = createRuntimeClosureManifest({ projectRoot: root, platform: 'darwin', arch: 'arm64' });
    const verification = verifyDirectoryAgainstManifest({ root, manifest });
    assert.equal(verification.ok, true);
    fs.appendFileSync(path.join(root, 'main.js'), 'tamper');
    assert.equal(verifyDirectoryAgainstManifest({ root, manifest }).ok, false);
    assert.equal(validateRuntimePolicy(manifest).ok, false);
});

test('M7 version switch is staged and rollback restores previous pointer', () => {
    const state = tempDir(); const first = tempDir(); const second = tempDir();
    const manifest = { schemaVersion: 1, version: '1.0.0', buildId: 'a', files: [{ path: 'main.js', size: 3, sha256: 'x' }] };
    const crypto = require('node:crypto');
    manifest.files[0].sha256 = crypto.createHash('sha256').update('one').digest('hex');
    fs.writeFileSync(path.join(first, 'main.js'), 'one');
    switchVersion({ stateRoot: state, sourceRoot: first, manifest, verify: ({ root, manifest: m }) => verifyDirectoryAgainstManifest({ root, manifest: m }) });
    const secondManifest = { ...manifest, version: '2.0.0', buildId: 'b', files: [{ path: 'main.js', size: 3, sha256: crypto.createHash('sha256').update('two').digest('hex') }] };
    fs.writeFileSync(path.join(second, 'main.js'), 'two');
    switchVersion({ stateRoot: state, sourceRoot: second, manifest: secondManifest, verify: ({ root, manifest: m }) => verifyDirectoryAgainstManifest({ root, manifest: m }) });
    const rolled = rollbackVersion({ stateRoot: state });
    assert.match(rolled.directory, /1\.0\.0-a/);
    assert.equal(fs.existsSync(pointerPath(state)), true);
});

test('M7 failed health check atomically returns current pointer to the prior version', async () => {
    const state = tempDir(); const first = tempDir(); const second = tempDir(); const crypto = require('node:crypto');
    fs.writeFileSync(path.join(first, 'main.js'), 'one'); fs.writeFileSync(path.join(second, 'main.js'), 'two');
    const one = { schemaVersion: 1, version: '1', buildId: 'a', files: [{ path: 'main.js', size: 3, sha256: crypto.createHash('sha256').update('one').digest('hex') }] };
    const two = { schemaVersion: 1, version: '2', buildId: 'b', files: [{ path: 'main.js', size: 3, sha256: crypto.createHash('sha256').update('two').digest('hex') }] };
    switchVersion({ stateRoot: state, sourceRoot: first, manifest: one });
    await assert.rejects(() => promoteVersionWithHealthCheck({ stateRoot: state, sourceRoot: second, manifest: two, healthCheck: async () => ({ ok: false }) }));
    const pointer = JSON.parse(fs.readFileSync(pointerPath(state), 'utf8'));
    assert.match(pointer.directory, /1-a/);
});

test('M8 evidence explicitly records external platform proof instead of claiming it', () => {
    const evidence = collectEvidence();
    assert.ok(Array.isArray(evidence.externalEvidenceRequired));
    assert.ok(evidence.externalEvidenceRequired.some(item => item.includes('Windows')));
});
