'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnosticsExporter, SCHEMA } = require('../modules/diagnosticsSnapshot');

const projectRoot = path.resolve(__dirname, '..');

// 诊断导出只许带数字、状态和 id。这些键名一旦出现，说明有人把内容类数据塞进了快照。
const FORBIDDEN_KEYS = new Set(['title', 'url', 'content', 'text', 'html', 'message', 'messages', 'history', 'prompt']);

function collectKeys(value, keys = new Set()) {
    if (Array.isArray(value)) value.forEach(item => collectKeys(item, keys));
    else if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) { keys.add(key); collectKeys(nested, keys); }
    }
    return keys;
}

function fakeElectron({ webContentsThrows = false } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-diagnostics-'));
    const contents = [
        { id: 1, getType: () => 'window', isDestroyed: () => false, isLoading: () => false, getBackgroundThrottling: () => true },
        { id: 2, getType: () => 'webview', isDestroyed: () => true },
    ];
    const windows = [{ id: 7, webContents: contents[0], isVisible: () => true, isMinimized: () => false, isFocused: () => true }];
    return {
        tmp,
        app: {
            name: 'VCPChat',
            getVersion: () => '9.9.9',
            isPackaged: false,
            getPath: name => (name === 'userData' ? tmp : os.tmpdir()),
            getAppMetrics: () => [
                { pid: 100, type: 'Browser', cpu: { percentCPUUsage: 1.2345, idleWakeupsPerSecond: 3 }, memory: { workingSetSize: 1000, peakWorkingSetSize: 1200, privateBytes: 900 }, creationTime: 1 },
                { pid: 200, type: 'Tab', name: 'main', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 500 } },
            ],
        },
        BrowserWindow: { getAllWindows: () => windows, fromWebContents: wc => (wc.id === 1 ? windows[0] : null) },
        webContents: { getAllWebContents: () => { if (webContentsThrows) throw new Error('boom'); return contents; } },
    };
}

test('the diagnostics snapshot combines process metrics, window state and the lifecycle snapshot', () => {
    const fake = fakeElectron();
    const exporter = createDiagnosticsExporter({
        ...fake,
        getLifecycleSnapshot: () => ({ mainWindowResponsiveness: { unresponsive: false, unresponsiveCount: 2 }, domains: [{ id: 'terminal', state: 'active' }] }),
        getTerminalSnapshot: () => ({ loaded: true, views: 1, runWatchers: 0 }),
        now: () => new Date('2026-10-11T08:09:10Z'),
    });
    const snapshot = exporter.collect();
    assert.equal(snapshot.schema, SCHEMA);
    assert.equal(snapshot.createdAt, '2026-10-11T08:09:10.000Z');
    assert.equal(snapshot.app.version, '9.9.9');
    assert.deepEqual(snapshot.processes.map(p => [p.pid, p.type, p.cpuPercent, p.workingSetKB]), [[100, 'Browser', 1.23, 1000], [200, 'Tab', 0, 500]]);
    assert.deepEqual(snapshot.windows, [{ id: 7, webContentsId: 1, visible: true, minimized: false, focused: true }]);
    assert.deepEqual(snapshot.webContents.map(w => [w.id, w.type, w.destroyed, w.backgroundThrottling, w.ownerWindowId]), [[1, 'window', false, true, 7], [2, 'webview', true, null, null]]);
    assert.equal(snapshot.lifecycle.mainWindowResponsiveness.unresponsiveCount, 2);
    assert.deepEqual(snapshot.terminal, { loaded: true, views: 1, runWatchers: 0 });
    assert.deepEqual(snapshot.errors, []);
    assert.ok(typeof snapshot.mainProcess.rssKB === 'number' && snapshot.system.cpuCount >= 1);
    const leaked = [...collectKeys(snapshot)].filter(key => FORBIDDEN_KEYS.has(key));
    assert.deepEqual(leaked, [], 'the snapshot must not carry content-like fields');
    fs.rmSync(fake.tmp, { recursive: true, force: true });
});

test('one failing source is recorded under errors and does not abort the export', () => {
    const fake = fakeElectron({ webContentsThrows: true });
    const exporter = createDiagnosticsExporter({ ...fake, getLifecycleSnapshot: () => { throw new Error('lifecycle down'); } });
    const snapshot = exporter.collect();
    assert.deepEqual(snapshot.webContents, []);
    assert.equal(snapshot.lifecycle, null);
    assert.equal(snapshot.processes.length, 2, 'process metrics are still collected');
    assert.deepEqual(snapshot.errors.map(e => e.section).sort(), ['lifecycle', 'webContents']);
    fs.rmSync(fake.tmp, { recursive: true, force: true });
});

test('exportToFile writes a timestamped JSON file under userData/diagnostics', async () => {
    const fake = fakeElectron();
    const exporter = createDiagnosticsExporter({ ...fake, now: () => new Date(2026, 9, 11, 8, 9, 10) });
    const result = await exporter.exportToFile();
    assert.equal(result.success, true);
    assert.equal(path.dirname(result.filePath), path.join(fake.tmp, 'diagnostics'));
    assert.equal(path.basename(result.filePath), 'vcpchat-diagnostics-20261011-080910.json');
    const parsed = JSON.parse(fs.readFileSync(result.filePath, 'utf8'));
    assert.equal(parsed.schema, SCHEMA);
    assert.deepEqual(result.summary, { processes: 2, windows: 1, webContents: 2, errors: 0 });
    fs.rmSync(fake.tmp, { recursive: true, force: true });
});

test('main.js, the preload and the lifecycle inspector expose the export end to end', () => {
    const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
    assert.match(mainSource, /ipcMain\.handle\('diagnostics:export-snapshot',\s*async event => \{\s*embeddedAppSessions\.assertMainRenderer\(event\);/, 'the IPC handler must be limited to the main renderer');
    assert.match(mainSource, /getLifecycleSnapshot:\s*buildMainLifecycleSnapshot/, 'the export must reuse the lifecycle snapshot builder');
    assert.match(mainSource, /label:\s*'导出诊断快照'/, 'the developer menu must offer the export');
    const preloadSource = fs.readFileSync(path.join(projectRoot, 'preloads/api/embeddedApps.js'), 'utf8');
    assert.match(preloadSource, /exportDiagnosticsSnapshot:\s*invoke\('diagnostics:export-snapshot'\)/);
    const inspectorSource = fs.readFileSync(path.join(projectRoot, 'modules/ui-system/lifecycle-inspector.js'), 'utf8');
    assert.match(inspectorSource, /exportMain/);
});
