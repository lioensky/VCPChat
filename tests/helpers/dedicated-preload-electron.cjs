'use strict';

// Run only through the isolated Electron bootstrap; never attach to the app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const root = path.resolve(__dirname, '../..');
const cases = [
    { preload: 'chart', global: 'chartAPI', listen: 'onChartChanged', channel: 'chart:changed', query: 'getChartSnapshot', request: 'chart:get-snapshot' },
    { preload: 'docx', global: 'scriptoriumAPI', listen: 'onOpenPathRequest', channel: 'docx:open-path-request', query: 'readPath', request: 'docx:read-path' },
    { preload: 'loom', global: 'loomAPI', listen: 'onRegistryChanged', channel: 'loom:registry-changed', query: 'getApp', request: 'loom:get-app' },
];
const windows = new Set();
const failures = [];
// Keep the isolated process alive between successive hidden test windows.
app.on('window-all-closed', () => {});

async function waitForLength(window, length) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const seen = await window.webContents.executeJavaScript('window.probe.seen');
        if (seen.length >= length) return seen;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected ' + length + ' actual IPC deliveries');
}

async function verify(spec) {
    const requests = [];
    ipcMain.handle(spec.request, (event, ...args) => { requests.push(args); return { source: spec.preload, args }; });
    const window = new BrowserWindow({ show: false, webPreferences: {
        preload: path.join(root, 'preloads', spec.preload + '.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
    } });
    windows.add(window);
    window.webContents.on('preload-error', (_event, _file, error) => failures.push(String(error)));
    try {
        await window.loadURL('data:text/html;charset=utf-8,<title>Isolated preload verification</title>');
        const global = JSON.stringify(spec.global), listen = JSON.stringify(spec.listen);
        const setup = await window.webContents.executeJavaScript(`(() => {
            const api = window[${global}];
            window.probe = { seen: [] };
            const callback = (...args) => window.probe.seen.push(args);
            window.probe.old = api[${listen}](callback);
            window.probe.current = api[${listen}](callback);
            return { nodeHidden: typeof require === 'undefined' && typeof process === 'undefined',
                apiPresent: !!api, aliasPresent: ${spec.preload === 'docx' ? "typeof window.docxAPI?.onOpenPathRequest === 'function'" : 'true'} };
        })()`);
        assert.deepEqual(setup, { nodeHidden: true, apiPresent: true, aliasPresent: true });
        const first = { owner: spec.preload, sequence: 1 };
        window.webContents.send(spec.channel, first);
        assert.deepEqual(await waitForLength(window, 2), [[first], [first]], 'Electron event object is not exposed to the page');
        await window.webContents.executeJavaScript('window.probe.old(); void window.probe.old();');
        const second = { owner: spec.preload, sequence: 2 };
        window.webContents.send(spec.channel, second);
        assert.deepEqual(await waitForLength(window, 3), [[first], [first], [second]], 'old unsubscribe leaves the new subscription alive');
        await window.webContents.executeJavaScript('void window.probe.current();');
        window.webContents.send(spec.channel, { sequence: 3 });
        // Invoke travels through the same renderer IPC sender after the event;
        // awaiting its reply gives queued delivery a deterministic barrier.
        const response = await window.webContents.executeJavaScript(`window[${global}][${JSON.stringify(spec.query)}]('owned-value')`);
        assert.deepEqual(response, { source: spec.preload, args: ['owned-value'] });
        assert.deepEqual(requests, [['owned-value']]);
        assert.deepEqual(await window.webContents.executeJavaScript('window.probe.seen'), [[first], [first], [second]], 'all disposed listeners stay quiet');
        return { preload: spec.preload, exposure: true, invoke: true, payload: true, independentUnsubscribe: true, lateDeliveryRevoked: true };
    } finally {
        ipcMain.removeHandler(spec.request);
        if (!window.isDestroyed()) window.destroy();
        windows.delete(window);
    }
}

app.whenReady().then(async () => {
    try {
        const results = [];
        for (const spec of cases) results.push(await verify(spec));
        assert.deepEqual(failures, []);
        fs.writeFileSync(path.join(process.env.VCP_ELECTRON_TEST_DATA, 'verification.json'), JSON.stringify({
            electron: process.versions.electron, contextIsolation: true, nodeIntegration: false, sandbox: false, results,
            scope: 'real dedicated preloads and isolated controlled main handlers; not production business endpoints',
        }, null, 2));
        console.log('Dedicated preload IPC verification: 3/3');
        app.exit(0);
    } catch (error) {
        console.error(error);
        for (const window of windows) if (!window.isDestroyed()) window.destroy();
        app.exit(1);
    }
});
