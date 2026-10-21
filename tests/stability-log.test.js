'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStabilityLog, classifyProcessGone, classifyStall, HANG_MS, FREEZE_MS } = require('../modules/stabilityLog');

const projectRoot = path.resolve(__dirname, '..');

// 与 tests/diagnostics-snapshot.test.js 同一份禁用键：稳定性日志只许带数字、状态和 id。
const FORBIDDEN_KEYS = new Set(['title', 'url', 'content', 'text', 'html', 'message', 'messages', 'history', 'prompt']);

function collectKeys(value, keys = new Set()) {
    if (Array.isArray(value)) value.forEach(item => collectKeys(item, keys));
    else if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) { keys.add(key); collectKeys(nested, keys); }
    }
    return keys;
}

/** 假时钟 + 假定时器：时间只在 advance 时前进，到期的定时器按顺序触发。 */
function fakeClock(startMs = Date.parse('2026-10-11T08:00:00Z')) {
    let nowMs = startMs;
    const timers = new Map();
    let nextId = 1;
    return {
        now: () => nowMs,
        setTimeout: (fn, delay) => {
            const id = nextId++;
            timers.set(id, { fn, due: nowMs + delay, unref() { return this; } });
            return timers.get(id);
        },
        clearTimeout: handle => {
            for (const [id, timer] of timers) if (timer === handle) timers.delete(id);
        },
        advance(ms) {
            const target = nowMs + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
                if (!due) break;
                timers.delete(due[0]);
                nowMs = due[1].due;
                due[1].fn();
            }
            nowMs = target;
        },
    };
}

function quietConsole() {
    const warnings = [];
    return { warnings, warn: (...args) => warnings.push(args.join(' ')), error: () => {}, log: () => {} };
}

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-stability-'));
}

function readLines(dir, name = 'stability.log') {
    return fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('process-gone reasons collapse into a small set of classes', () => {
    assert.equal(classifyProcessGone('clean-exit'), 'clean-exit');
    assert.equal(classifyProcessGone('abnormal-exit'), 'crash');
    assert.equal(classifyProcessGone('crashed'), 'crash');
    assert.equal(classifyProcessGone('killed'), 'killed');
    assert.equal(classifyProcessGone('oom'), 'oom');
    assert.equal(classifyProcessGone('launch-failed'), 'launch-failed');
    assert.equal(classifyProcessGone('integrity-failure'), 'integrity-failure');
    assert.equal(classifyProcessGone('something-new'), 'unknown');
    assert.equal(classifyProcessGone(undefined), 'unknown');
});

test('stall severity follows the hang and freeze thresholds', () => {
    assert.equal(classifyStall(HANG_MS - 1), 'brief');
    assert.equal(classifyStall(HANG_MS), 'hang');
    assert.equal(classifyStall(FREEZE_MS - 1), 'hang');
    assert.equal(classifyStall(FREEZE_MS), 'freeze');
    assert.equal(classifyStall(null), null);
    assert.equal(classifyStall(NaN), null);
});

test('a hang that recovers before the freeze threshold is logged as unresponsive + responsive with the stall length', async () => {
    const clock = fakeClock();
    const dir = tmpDir();
    const log = createStabilityLog({ ...clock, resolveDirectory: () => dir, console: quietConsole() });

    assert.ok(log.recordUnresponsive('window'));
    assert.equal(log.recordUnresponsive('webContents'), null, 'the second notification for the same stall is ignored');
    clock.advance(12_000);
    assert.equal(log.snapshot().unresponsive.active, true);
    assert.equal(log.snapshot().unresponsive.currentStallMs, 12_000);

    const recovered = log.recordResponsive('window');
    assert.equal(recovered.stalledMs, 12_000);
    assert.equal(recovered.severity, 'hang');
    assert.equal(log.recordResponsive('window'), null, 'responsive without a preceding stall is a no-op');

    clock.advance(FREEZE_MS + 1_000);
    await log.flush();
    const kinds = readLines(dir).map(entry => entry.kind);
    assert.deepEqual(kinds, ['unresponsive', 'responsive'], 'no freeze entry once the stall ended in time');
    const snap = log.snapshot();
    assert.equal(snap.unresponsive.active, false);
    assert.equal(snap.unresponsive.count, 1);
    assert.deepEqual(snap.counters, { unresponsive: 1, responsive: 1 });
    log.dispose();
});

test('a stall that lasts past the freeze threshold gets an extra freeze entry and a freeze severity on recovery', async () => {
    const clock = fakeClock();
    const dir = tmpDir();
    const log = createStabilityLog({ ...clock, resolveDirectory: () => dir, console: quietConsole() });

    log.recordUnresponsive('window');
    clock.advance(FREEZE_MS);
    clock.advance(15_000);
    const recovered = log.recordResponsive('window');
    assert.equal(recovered.severity, 'freeze');
    assert.equal(recovered.stalledMs, FREEZE_MS + 15_000);

    await log.flush();
    const lines = readLines(dir);
    assert.deepEqual(lines.map(entry => entry.kind), ['unresponsive', 'freeze', 'responsive']);
    assert.equal(lines[1].elapsedMs, FREEZE_MS);
    assert.equal(lines[1].source, 'window');
    assert.equal(lines[0].at, '2026-10-11T08:00:00.000Z');
    log.dispose();
});

test('render and child process exits are logged with their reason, exit code and class', async () => {
    const clock = fakeClock();
    const dir = tmpDir();
    const log = createStabilityLog({ ...clock, resolveDirectory: () => dir, console: quietConsole() });

    log.recordRenderProcessGone('main-window', { reason: 'oom', exitCode: -536870904 });
    log.recordRenderProcessGone('assistant', { reason: 'clean-exit', exitCode: 0 });
    log.recordChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 1 });
    log.recordChildProcessGone({ type: 'Utility', serviceName: 'network.mojom.NetworkService', reason: 'killed' });

    await log.flush();
    const lines = readLines(dir);
    assert.deepEqual(lines.map(entry => [entry.kind, entry.class]), [
        ['render-process-gone', 'oom'],
        ['render-process-gone', 'clean-exit'],
        ['child-process-gone', 'crash'],
        ['child-process-gone', 'killed'],
    ]);
    assert.equal(lines[0].scope, 'main-window');
    assert.equal(lines[0].exitCode, -536870904);
    assert.equal(lines[2].processType, 'GPU');
    assert.equal(lines[3].serviceName, 'network.mojom.NetworkService');
    assert.equal(lines[3].exitCode, null);
    assert.deepEqual(log.snapshot().counters, { 'render-process-gone': 2, 'child-process-gone': 2 });
});

test('the in-memory ring is bounded, the file rotates once and the snapshot carries no content-like keys', async () => {
    const clock = fakeClock();
    const dir = tmpDir();
    const log = createStabilityLog({ ...clock, resolveDirectory: () => dir, console: quietConsole(), maxEntries: 5, maxFileBytes: 400 });

    for (let index = 0; index < 12; index += 1) {
        clock.advance(1_000);
        log.note('probe', { index });
    }
    await log.flush();

    const snap = log.snapshot();
    assert.equal(snap.recent.length, 5);
    assert.deepEqual(snap.recent.map(entry => entry.index), [7, 8, 9, 10, 11]);
    assert.equal(snap.counters.probe, 12);
    assert.equal(snap.written, 12);
    assert.equal(snap.writeErrors, 0);
    assert.equal(snap.directoryResolved, true);

    const current = readLines(dir);
    const rotated = readLines(dir, 'stability.1.log');
    assert.ok(current.length > 0 && rotated.length > 0, 'the log rotated at least once');
    assert.ok(fs.statSync(path.join(dir, 'stability.log')).size <= 400);
    assert.deepEqual([...rotated, ...current].slice(-12).map(entry => entry.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].slice(-([...rotated, ...current].length)));

    const keys = collectKeys(snap);
    for (const forbidden of FORBIDDEN_KEYS) assert.ok(!keys.has(forbidden), `snapshot must not carry "${forbidden}"`);
});

test('a log directory that cannot be resolved disables persistence without throwing', async () => {
    const clock = fakeClock();
    const logger = quietConsole();
    const log = createStabilityLog({ ...clock, resolveDirectory: () => { throw new Error('app not ready'); }, console: logger });

    assert.doesNotThrow(() => log.note('session-start', { pid: 1 }));
    assert.doesNotThrow(() => log.recordUnresponsive('window'));
    await log.flush();
    const snap = log.snapshot();
    assert.equal(snap.directoryResolved, false);
    assert.equal(snap.written, 0);
    assert.equal(snap.writeErrors, 1, 'the failed resolution is counted once, not per entry');
    assert.equal(snap.recent.length, 2, 'entries stay in memory for the lifecycle snapshot');
    assert.equal(logger.warnings.length, 1);
    log.dispose();
});

test('main.js feeds responsiveness, process exits and the launch timeline into the stability log', () => {
    const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
    assert.match(mainSource, /createStabilityLog\(\{\s*resolveDirectory:\s*\(\)\s*=>\s*path\.join\(app\.getPath\('userData'\),\s*'diagnostics'\)/, 'the log lives under userData/diagnostics and resolves the directory lazily');
    assert.match(mainSource, /stabilityLog\.note\('session-start'/);
    assert.match(mainSource, /app\.on\('child-process-gone',[\s\S]{0,200}stabilityLog\.recordChildProcessGone\(details\)/);

    const recorderStart = mainSource.indexOf('function recordMainWindowResponsiveness');
    assert.ok(recorderStart >= 0);
    const recorder = mainSource.slice(recorderStart, mainSource.indexOf('\n}\n', recorderStart));
    assert.match(recorder, /stabilityLog\.recordResponsive\(source\)/);
    assert.match(recorder, /stabilityLog\.recordUnresponsive\(source\)/);

    assert.match(mainSource, /render-process-gone'[\s\S]{0,400}stabilityLog\.recordRenderProcessGone\('main-window',\s*details\)/);

    const snapshotStart = mainSource.indexOf('const buildMainLifecycleSnapshot = () => {');
    const snapshotBlock = mainSource.slice(snapshotStart, snapshotStart + 3000);
    assert.match(snapshotBlock, /stability:\s*stabilityLog\.snapshot\(\)/);
    assert.match(snapshotBlock, /launch:\s*launchMarks\.snapshot\(\)/);

    assert.match(mainSource, /ipcMain\.on\('lifecycle:renderer-ready',\s*event\s*=>\s*\{[\s\S]{0,300}event\.sender !== mainWindow\.webContents\)\s*return;[\s\S]{0,200}launchMarks\.mark\('renderer-ready'\)[\s\S]{0,100}stabilityLog\.note\('launch',\s*launchMarks\.summary\(\)\)/, 'renderer-ready is accepted only from the main window and lands in the stability log once');
});

test('the renderer, preload and inspector carry the renderer-ready signal and the new snapshot sections', () => {
    const preload = fs.readFileSync(path.join(projectRoot, 'preloads', 'api', 'embeddedApps.js'), 'utf8');
    assert.match(preload, /markRendererReady:\s*send\('lifecycle:renderer-ready'\)/);

    const renderer = fs.readFileSync(path.join(projectRoot, 'renderer.js'), 'utf8');
    const readyIndex = renderer.indexOf("dataset.vcpRendererReady = 'true'");
    assert.ok(readyIndex >= 0);
    assert.match(renderer.slice(readyIndex, readyIndex + 400), /window\.electronAPI\?\.markRendererReady\?\.\(\)/, 'the renderer notifies the main process right where it marks itself ready');

    const inspector = fs.readFileSync(path.join(projectRoot, 'modules', 'ui-system', 'lifecycle-inspector.js'), 'utf8');
    assert.match(inspector, /stability:\s*result\?\.stability\s*\?\s*Object\.freeze\(result\.stability\)\s*:\s*null/);
    assert.match(inspector, /launch:\s*result\?\.launch\s*\?\s*Object\.freeze\(result\.launch\)\s*:\s*null/);
});
