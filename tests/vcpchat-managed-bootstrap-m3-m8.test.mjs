import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRepairManifest } = require('../modules/bootstrap/repair-manifest');
const { resolveCommandInvocation } = require('../modules/bootstrap/command-invocation');
const { environmentEpisode, selectRepairStages, validateLockfile, createRepairPlan } = require('../modules/bootstrap/repair-planner');
const { runProcess } = require('../modules/bootstrap/process-runner');
const { managedSpawnOptions, terminationPlan, terminateManagedProcess } = require('../modules/bootstrap/platform-process');
const { createProgressEvent, encodeProgressEvent, parseProgressLine } = require('../modules/bootstrap/progress-protocol');
const { createRuntimeClosureManifest, validateRuntimePolicy, verifyDirectoryAgainstManifest } = require('../modules/bootstrap/runtime-closure');
const { switchVersion, rollbackVersion, pointerPath, promoteVersionWithHealthCheck, validateUpdateManifest, checkStagingCapacity, canonicalize, validateUpdateSignature } = require('../modules/bootstrap/update-manager');
const { liveReadyRecords } = await import('../scripts/vcpchat-update.mjs');
const { downloadEntry, downloadSignedUpdate, safeHttpsUrl } = require('../modules/bootstrap/update-downloader');
const { collectEvidence } = await import('../scripts/vcpchat-release-evidence.mjs');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-m3-m8-')); }

test('M3 repair manifest is deterministic and uses npm ci plus targeted rebuild', () => {
    const manifest = createRepairManifest({ projectRoot: '/tmp/project', platform: 'darwin' });
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.stages.find(stage => stage.id === 'install-dependencies').args.slice(0, 2), ['ci', '--no-audit']);
    const rebuildArgs = manifest.stages.find(stage => stage.id === 'rebuild-native-modules').args;
    assert.match(rebuildArgs[0], /@electron[\\/]rebuild[\\/]lib[\\/]cli\.js$/);
    assert.equal(rebuildArgs.includes('-f'), true);
    assert.deepEqual(rebuildArgs.slice(-2), ['--only', 'better-sqlite3,node-pty,sharp']);
});

test('M3 Windows command shims run through cmd.exe instead of direct spawn', () => {
    assert.deepEqual(
        resolveCommandInvocation('npm.cmd', ['ci'], {
            platform: 'win32',
            env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        }),
        {
            command: 'C:\\Windows\\System32\\cmd.exe',
            args: ['/d', '/s', '/c', 'npm.cmd', 'ci'],
        },
    );
    assert.deepEqual(
        resolveCommandInvocation('npm', ['ci'], { platform: 'linux', env: {} }),
        { command: 'npm', args: ['ci'] },
    );
});

test('M3 selection keeps optional Rust/vendor repairs opt-in', () => {
    const manifest = createRepairManifest({ projectRoot: '/tmp/project' });
    const report = { checks: [
        { id: 'dependencies', status: 'fail', code: 'E_DEPENDENCY_MISSING' },
        { id: 'rust-runtime', status: 'warn', code: 'E_RUST_RUNTIME_MISSING' },
        { id: 'audio-runtime', status: 'warn', code: 'E_AUDIO_RUNTIME_MISSING' },
    ] };
    const defaultStages = selectRepairStages({ doctorReport: report, manifest });
    assert.equal(defaultStages.some(stage => stage.id === 'build-rust-runtime'), false);
    assert.equal(defaultStages.some(stage => stage.id === 'build-audio-runtime'), false);
    assert.equal(defaultStages.some(stage => stage.id === 'rebuild-native-modules'), true);
    const fullStages = selectRepairStages({ doctorReport: report, manifest, includeRust: true, repairVendor: true, full: true });
    assert.equal(fullStages.some(stage => stage.id === 'build-rust-runtime'), true);
    assert.equal(fullStages.some(stage => stage.id === 'build-audio-runtime'), true);
    assert.equal(fullStages.some(stage => stage.id === 'repair-vendor-closure'), true);
});

test('M3 lock validation rejects package identity drift before npm ci', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'one', version: '1.0.0' }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'two', version: '1.0.0' } } }));
    assert.throws(() => validateLockfile(root), error => error.code === 'E_LOCKFILE_INVALID');
});

test('M3 repair episodes remain isolated across clones with the same lockfile', () => {
    const report = { checks: [{ id: 'native-abi', status: 'fail', code: 'E_NATIVE_ABI_MISMATCH' }] };
    const first = environmentEpisode({ projectRoot: '/tmp/vcpchat-a', doctorReport: report });
    const second = environmentEpisode({ projectRoot: '/tmp/vcpchat-b', doctorReport: report });
    assert.notEqual(first.id, second.id);
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

test('H4 process boundary emits explicit Windows and POSIX ownership plans', () => {
    assert.deepEqual(managedSpawnOptions('win32'), { detached: false, windowsHide: true });
    assert.deepEqual(managedSpawnOptions('darwin'), { detached: true, windowsHide: false });
    assert.deepEqual(terminationPlan(42, { platform: 'win32' }), {
        kind: 'command', command: 'taskkill.exe', args: ['/PID', '42', '/T', '/F'], options: { windowsHide: true, stdio: 'ignore' },
    });
    assert.deepEqual(terminationPlan(42, { platform: 'linux', signal: 'SIGKILL' }), { kind: 'process-group', pid: -42, signal: 'SIGKILL' });
});

test('H4 process boundary kills a Windows tree and falls back from POSIX group kill', () => {
    const calls = [];
    const windowsChild = { pid: 42, exitCode: null, signalCode: null, kill() { calls.push('unexpected-child-kill'); } };
    terminateManagedProcess(windowsChild, { platform: 'win32', spawnProcess: (command, args) => calls.push([command, args]) });
    assert.deepEqual(calls.shift(), ['taskkill.exe', ['/PID', '42', '/T', '/F']]);
    const posixChild = { pid: 43, exitCode: null, signalCode: null, kill(signal) { calls.push(['fallback', signal]); } };
    terminateManagedProcess(posixChild, { platform: 'linux', killProcess: () => { throw new Error('no group'); } });
    assert.deepEqual(calls.shift(), ['fallback', 'SIGTERM']);
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

test('M5 runtime closure excludes node-gyp obj.target intermediates', () => {
    const root = tempDir();
    for (const file of ['main.js', 'preload.js', 'renderer.js', 'main.html', 'package.json', 'modules/bootstrap/contracts.js', 'modules/ui-system/webawesome-runtime-manifest.js', 'vendor/webawesome-runtime/vcp-runtime-manifest.json']) {
        const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file);
    }
    const release = path.join(root, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node');
    const intermediate = path.join(root, 'node_modules', 'node-pty', 'build', 'Release', 'obj.target', 'pty.node');
    fs.mkdirSync(path.dirname(release), { recursive: true }); fs.mkdirSync(path.dirname(intermediate), { recursive: true });
    fs.writeFileSync(release, 'runtime'); fs.writeFileSync(intermediate, 'intermediate');
    const manifest = createRuntimeClosureManifest({ projectRoot: root, platform: 'linux', arch: 'x64' });
    assert.equal(manifest.files.some(entry => entry.path.includes('obj.target')), false);
    assert.equal(manifest.files.some(entry => entry.path.endsWith('build/Release/pty.node')), true);
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

test('M7 update manifests reject path aliases, malformed entries, and uncovered launch executables', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'main.js'), 'one');
    const digest = require('node:crypto').createHash('sha256').update('one').digest('hex');
    const base = { schemaVersion: 1, version: '1.0.0', files: [{ path: 'main.js', sha256: digest }] };
    assert.throws(() => validateUpdateManifest({ sourceRoot: root, manifest: { ...base, files: [{ path: 'main.js', sha256: digest }, { path: './main.js', sha256: digest }] } }), /更新运行时校验失败/);
    assert.throws(() => validateUpdateManifest({ sourceRoot: root, manifest: { ...base, files: [null] } }), /更新运行时校验失败/);
    assert.throws(() => validateUpdateManifest({ sourceRoot: root, manifest: { ...base, launch: { executable: 'missing' } } }), /更新运行时校验失败/);
});

test('M7 update staging rejects unlisted symlinks in the source tree', () => {
    if (process.platform === 'win32') return;
    const root = tempDir(); const target = path.join(root, 'real.js'); const link = path.join(root, 'linked.js');
    fs.writeFileSync(target, 'one'); fs.symlinkSync(target, link);
    const digest = require('node:crypto').createHash('sha256').update('one').digest('hex');
    assert.throws(() => validateUpdateManifest({ sourceRoot: root, manifest: { schemaVersion: 1, version: '1', files: [{ path: 'real.js', sha256: digest }] } }), /符号链接/);
});

test('M7 update staging rejects insufficient disk capacity before copying', () => {
    assert.throws(() => checkStagingCapacity({
        stateRoot: tempDir(),
        manifest: { files: [{ path: 'main.js', size: 100 }] },
        reserveBytes: 1,
        statfs: () => ({ bavail: 1, bsize: 10 }),
    }), error => error.code === 'E_UPDATE_DISK_SPACE');
});

test('H5 signed manifests require the matching public key and cover nested launch fields', () => {
    const crypto = require('node:crypto');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const manifest = { schemaVersion: 1, version: '1', files: [{ path: 'main.js', size: 3, sha256: 'x' }], launch: { executable: 'main.js', args: ['--safe'] } };
    manifest.signature = {
        algorithm: 'RSA-SHA256',
        value: crypto.sign('RSA-SHA256', Buffer.from(canonicalize(manifest, true)), privateKey).toString('base64'),
    };
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    assert.equal(validateUpdateSignature({ manifest, publicKey: pem }).signed, true);
    assert.throws(() => validateUpdateSignature({ manifest }), error => error.code === 'E_UPDATE_SIGNATURE_INVALID');
    manifest.launch.args = ['--tampered'];
    assert.throws(() => validateUpdateSignature({ manifest, publicKey: pem }), error => error.code === 'E_UPDATE_SIGNATURE_INVALID');
});

test('H5 network update requires HTTPS and resumes same-origin partial files', async () => {
    assert.throws(() => safeHttpsUrl('http://updates.example/test'), error => error.code === 'E_UPDATE_URL_INVALID');
    const root = tempDir(); const destination = path.join(root, 'main.js');
    fs.writeFileSync(`${destination}.part`, 'he');
    const result = await downloadEntry({
        entry: { path: 'main.js', size: 5 },
        baseUrl: new URL('https://updates.example/releases/manifest.json'),
        stagingRoot: root,
        fetchImpl: async (_url, options) => {
            assert.equal(options.headers.Range, 'bytes=2-');
            return new Response('llo', { status: 206, headers: { 'content-range': 'bytes 2-4/5' } });
        },
    });
    assert.equal(result.resumedFrom, 2);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'hello');
});

test('H5 network update rejects mismatched ranges and oversized bodies', async () => {
    const root = tempDir(); fs.writeFileSync(path.join(root, 'main.js.part'), 'he');
    await assert.rejects(() => downloadEntry({
        entry: { path: 'main.js', size: 5 }, baseUrl: new URL('https://updates.example/manifest.json'), stagingRoot: root,
        fetchImpl: async () => new Response('llo', { status: 206, headers: { 'content-range': 'bytes 1-3/5' } }),
    }), error => error.code === 'E_UPDATE_DOWNLOAD');
    await assert.rejects(() => downloadEntry({
        entry: { path: 'large.js', size: 2 }, baseUrl: new URL('https://updates.example/manifest.json'), stagingRoot: root,
        fetchImpl: async () => new Response('toolarge'),
    }), error => error.code === 'E_UPDATE_INTEGRITY_FAILED');
    assert.equal(fs.existsSync(path.join(root, 'large.js.part')), false);
});

test('H5 signed network manifest downloads and verifies its file closure', async () => {
    const crypto = require('node:crypto');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const content = 'one';
    const manifest = { schemaVersion: 1, version: '1', files: [{ path: 'main.js', size: 3, sha256: crypto.createHash('sha256').update(content).digest('hex') }] };
    manifest.signature = { algorithm: 'RSA-SHA256', value: crypto.sign('RSA-SHA256', Buffer.from(canonicalize(manifest, true)), privateKey).toString('base64') };
    const manifestBody = JSON.stringify(manifest);
    const fetched = await downloadSignedUpdate({
        manifestUrl: 'https://updates.example/releases/manifest.json',
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
        stagingRoot: tempDir(),
        fetchImpl: async url => String(url).endsWith('manifest.json') ? new Response(manifestBody) : new Response(content),
    });
    assert.equal(fetched.files.length, 1);
    assert.equal(fs.readFileSync(path.join(fetched.sourceRoot, 'main.js'), 'utf8'), content);
});

test('M7 update gate detects a live VCPChat ready process before staging', () => {
    const state = tempDir();
    fs.writeFileSync(path.join(state, 'ready-live.json'), JSON.stringify({ operationId: 'live', pid: process.pid, readyAt: new Date().toISOString() }));
    assert.equal(liveReadyRecords(state).length, 1);
});

test('M8 evidence explicitly records external platform proof instead of claiming it', () => {
    const evidence = collectEvidence();
    assert.ok(Array.isArray(evidence.externalEvidenceRequired));
    assert.ok(evidence.externalEvidenceRequired.some(item => item.includes('Windows')));
});
