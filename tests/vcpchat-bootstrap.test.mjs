import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { parseArguments, waitForReady } from '../scripts/vcpchat-dev-launcher.mjs';
import { parseArguments as parseManagedEntryArguments, runVcpchat } from '../scripts/vcpchat.mjs';
import { collectDoctorReport } from '../modules/bootstrap/environment-doctor.js';

const require = createRequire(import.meta.url);
const protocol = require('../modules/bootstrap/launch-protocol.js');
const diagnostics = require('../modules/bootstrap/diagnostic-report.js');
const bootstrapMarker = require('../modules/bootstrap/bootstrap-marker.js');

function tempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('M0 protocol resolves platform state roots and publishes operation-scoped ready records', () => {
    const root = tempDir('vcpchat-bootstrap-protocol-');
    assert.equal(protocol.resolveStateRoot({ platform: 'win32', homeDirectory: 'C:/Users/test', env: {} }), path.join('C:', 'Users', 'test', 'AppData', 'Local', 'VCPChat', 'bootstrap'));
    assert.match(protocol.resolveStateRoot({ platform: 'darwin', homeDirectory: '/Users/test', env: {} }), /Library\/Application Support\/VCPChat\/bootstrap$/);
    const projectA = protocol.resolveProjectStateRoot({ projectRoot: '/tmp/vcpchat-a', platform: 'darwin', homeDirectory: '/Users/test', env: {} });
    const projectB = protocol.resolveProjectStateRoot({ projectRoot: '/tmp/vcpchat-b', platform: 'darwin', homeDirectory: '/Users/test', env: {} });
    assert.notEqual(projectA, projectB);
    assert.match(projectA, /VCPChat\/bootstrap-[a-f0-9]{16}$/);

    const operationId = protocol.createOperationId('test');
    const lock = protocol.acquireOperationLock({ stateRoot: root, operationId, kind: 'test' });
    assert.equal(protocol.inspectOperationLock(root).state, 'busy');
    assert.throws(() => protocol.acquireOperationLock({ stateRoot: root, operationId: 'other', kind: 'test' }), error => error.code === 'E_OPERATION_BUSY');

    const ready = protocol.writeReadyRecord({
        stateRoot: root,
        operationId,
        checks: { mainWindow: 'ready', preload: 'ready', renderer: 'ready' },
    });
    assert.equal(protocol.readReadyRecord({ stateRoot: root, operationId }).record.operationId, operationId);
    assert.equal(fs.existsSync(ready.path), true);
    assert.equal(protocol.removeReadyRecord({ stateRoot: root, operationId }), true);
    assert.equal(lock.release(), true);
    assert.equal(protocol.inspectOperationLock(root).state, 'free');
});

test('M0 stale operation locks are recoverable but live locks are not', () => {
    const root = tempDir('vcpchat-bootstrap-stale-');
    fs.writeFileSync(protocol.lockPath(root), JSON.stringify({
        schemaVersion: 1,
        operationId: 'stale',
        pid: 99999999,
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));
    assert.equal(protocol.inspectOperationLock(root).state, 'stale');
    const lock = protocol.acquireOperationLock({ stateRoot: root, operationId: 'new', kind: 'test' });
    assert.equal(protocol.inspectOperationLock(root).record.operationId, 'new');
    lock.release();
});

test('M1 doctor is read-only and reports missing project/dependencies without attempting repair', () => {
    const root = tempDir('vcpchat-doctor-missing-');
    const spawn = () => ({ status: 0, stdout: '10.9.0\n', stderr: '', error: null });
    const report = collectDoctorReport({ projectRoot: root, spawn, now: new Date('2026-08-20T00:00:00Z') });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some(item => item.code === 'E_PROJECT_INCOMPLETE'));
    assert.ok(report.checks.some(item => item.code === 'E_DEPENDENCY_MISSING'));
    assert.equal(fs.readdirSync(root).length, 0);
});

test('M1 doctor reports a valid project manifest and lockfile independently of dependency repair', () => {
    const root = tempDir('vcpchat-doctor-lockfile-');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'vcp-chat-desktop', main: 'main.js' }));
    fs.writeFileSync(path.join(root, 'main.js'), '');
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
    const spawn = () => ({ status: 0, stdout: '10.9.0\n', stderr: '', error: null });
    const report = collectDoctorReport({ projectRoot: root, spawn });
    assert.ok(report.checks.some(item => item.id === 'project' && item.status === 'pass'));
    assert.ok(report.checks.some(item => item.id === 'lockfile' && item.status === 'pass'));
    assert.ok(report.checks.some(item => item.id === 'dependencies' && item.status === 'fail'));
});

test('H1 bootstrap completion marker skips deep work only for the same project inputs', () => {
    const root = tempDir('vcpchat-bootstrap-marker-');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'vcp-chat-desktop', version: '1.0.0' }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
    const state = tempDir('vcpchat-bootstrap-marker-state-');
    assert.equal(bootstrapMarker.isFresh({ stateRoot: state, projectRoot: root }), false);
    bootstrapMarker.writeMarker({ stateRoot: state, projectRoot: root, nodeVersion: '20.1.0' });
    assert.equal(bootstrapMarker.isFresh({ stateRoot: state, projectRoot: root, nodeVersion: '20.1.0' }), true);
    fs.appendFileSync(path.join(root, 'package-lock.json'), 'changed');
    assert.equal(bootstrapMarker.isFresh({ stateRoot: state, projectRoot: root, nodeVersion: '20.1.0' }), false);
});

test('M2 argument parser separates launcher options from Electron arguments', () => {
    assert.deepEqual(parseArguments([
        '--ready-timeout-ms', '5000', '--deep-doctor', '--', '--desktop-only', '--trace-warnings',
    ]), {
        projectRoot: null,
        readyTimeoutMs: 5000,
        deepDoctor: true,
        appArgs: ['--desktop-only', '--trace-warnings'],
    });
    assert.throws(() => parseArguments(['--repair']), /不会自动修复/);
});

test('H1 managed entry shows a repair plan without mutating when consent is absent', async () => {
    const output = []; const errors = []; let launched = false; let repaired = false;
    const io = { stdout: { write: text => output.push(text) }, stderr: { write: text => errors.push(text) } };
    const result = await runVcpchat({
        argv: [],
        projectRoot: '/tmp/vcpchat-h1',
        io,
        doctor: () => ({ ok: false, summary: { fail: 1 }, checks: [{ id: 'dependencies', status: 'fail', code: 'E_DEPENDENCY_MISSING' }] }),
        planFactory: () => ({ episode: { id: 'episode' }, attempts: 0, budgetRemaining: 2, stages: [{ id: 'install-dependencies', mutates: true }] }),
        repair: async () => { repaired = true; },
        launch: async () => { launched = true; return 0; },
    });
    assert.equal(result, 3);
    assert.equal(repaired, false);
    assert.equal(launched, false);
    assert.match(output.join(''), /repair-required/);
    assert.match(errors.join(''), /--repair --yes/);
});

test('H1 managed entry repairs with explicit consent, rechecks, then launches', async () => {
    const calls = []; let doctorCalls = 0;
    const io = { stdout: { write: text => calls.push(`out:${text}`) }, stderr: { write: text => calls.push(`err:${text}`) } };
    const result = await runVcpchat({
        argv: ['--repair', '--yes', '--ready-timeout-ms', '5000', '--', '--desktop-only'],
        projectRoot: '/tmp/vcpchat-h1',
        io,
        doctor: () => (++doctorCalls === 1
            ? { ok: false, summary: { fail: 1 }, checks: [{ id: 'dependencies', status: 'fail', code: 'E_DEPENDENCY_MISSING' }] }
            : { ok: true, summary: { pass: 4 }, checks: [] }),
        planFactory: () => ({ episode: { id: 'episode' }, attempts: 0, budgetRemaining: 2, stages: [] }),
        repair: async () => calls.push('repair'),
        launch: async ({ argv }) => { calls.push({ launch: argv }); return 0; },
    });
    assert.equal(result, 0);
    assert.deepEqual(calls, ['out:{"type":"repair-required","doctor":{"fail":1},"plan":{"episodeId":"episode","attempts":0,"budgetRemaining":2,"stages":[]}}\n', 'repair', { launch: ['--ready-timeout-ms', '5000', '--desktop-only'] }]);
    assert.equal(doctorCalls, 2);
});

test('H1 parser keeps launcher flags separate from Electron arguments', () => {
    assert.deepEqual(parseManagedEntryArguments(['--repair', '--yes', '--full', '--project-root', '/tmp/x', '--', '--desktop-only']), {
        help: false,
        applyRepair: true,
        confirmed: true,
        full: true,
        includeRust: false,
        repairVendor: false,
        json: false,
        deepDoctor: true,
        projectRoot: '/tmp/x',
        readyTimeoutMs: null,
        appArgs: ['--desktop-only'],
    });
    assert.throws(() => parseManagedEntryArguments(['--yes']), /只能与 --repair/);
});

test('H6 managed launcher sequence is diagnose → plan → repair → recheck → launch', async () => {
    const sequence = [];
    let doctorCount = 0;
    const io = { stdout: { write() {} }, stderr: { write() {} } };
    const result = await runVcpchat({
        argv: ['--repair', '--yes'],
        projectRoot: '/tmp/vcpchat-h6-sequence',
        io,
        doctor: () => {
            sequence.push('doctor');
            doctorCount += 1;
            return doctorCount === 1
                ? { ok: false, summary: { fail: 1 }, checks: [{ id: 'dependencies', status: 'fail', code: 'E_DEPENDENCY_MISSING' }] }
                : { ok: true, summary: { pass: 1 }, checks: [] };
        },
        planFactory: () => { sequence.push('plan'); return { episode: { id: 'sequence' }, attempts: 0, budgetRemaining: 1, stages: [] }; },
        repair: async () => { sequence.push('repair'); },
        launch: async () => { sequence.push('launch'); return 0; },
    });
    assert.equal(result, 0);
    assert.deepEqual(sequence, ['doctor', 'plan', 'repair', 'doctor', 'launch']);
});

test('M2 ready waiter accepts only matching operation and child PID', async () => {
    const root = tempDir('vcpchat-bootstrap-ready-');
    const operationId = 'launch-test';
    const child = new EventEmitter();
    child.pid = 1234;
    child.exitCode = null;
    protocol.writeReadyRecord({
        stateRoot: root,
        operationId,
        checks: { mainWindow: 'ready', preload: 'ready', renderer: 'ready' },
    });
    // The ready record writer uses this process PID. Rewrite only the fixture
    // record to model the spawned Electron child.
    const readyPath = protocol.readyPath(root, operationId);
    const record = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
    record.pid = child.pid;
    fs.writeFileSync(readyPath, JSON.stringify(record));
    const result = await waitForReady({ stateRoot: root, operationId, child, timeoutMs: 100, sleep: async () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.record.operationId, operationId);
});

test('M2 ready waiter reports child exit before readiness', async () => {
    const root = tempDir('vcpchat-bootstrap-exit-');
    const child = new EventEmitter();
    child.pid = 4321;
    child.exitCode = null;
    let emitted = false;
    const result = await waitForReady({
        stateRoot: root,
        operationId: 'launch-exit',
        child,
        timeoutMs: 100,
        sleep: async () => {
            if (!emitted) {
                emitted = true;
                child.exitCode = 7;
                child.emit('exit', 7, null);
            }
        },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_ELECTRON_CRASH_BEFORE_READY');
    assert.equal(result.childExit.code, 7);
});

test('M2 ready waiter owns asynchronous spawn errors', async () => {
    const root = tempDir('vcpchat-bootstrap-spawn-error-');
    const child = new EventEmitter();
    child.pid = 5000;
    child.exitCode = null;
    let emitted = false;
    const result = await waitForReady({
        stateRoot: root,
        operationId: 'launch-spawn-error',
        child,
        timeoutMs: 100,
        sleep: async () => {
            if (!emitted) {
                emitted = true;
                const error = new Error('controlled ENOENT');
                error.code = 'ENOENT';
                child.emit('error', error);
            }
        },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_ELECTRON_SPAWN');
    assert.equal(result.childError.code, 'ENOENT');
});

test('M2 diagnostics redact secrets before writing failure evidence', () => {
    const root = tempDir('vcpchat-bootstrap-diagnostic-');
    const result = diagnostics.writeDiagnosticReport({
        stateRoot: root,
        operationId: 'launch-secret',
        phase: 'validating',
        code: 'E_TEST',
        message: 'test',
        detail: { apiKey: 'secret-value', nested: { authorization: 'Bearer hidden', safe: 'visible' } },
        now: new Date('2026-08-20T00:00:00Z'),
    });
    const written = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    assert.equal(written.detail.apiKey, '[redacted]');
    assert.equal(written.detail.nested.authorization, '[redacted]');
    assert.equal(written.detail.nested.safe, 'visible');
});
