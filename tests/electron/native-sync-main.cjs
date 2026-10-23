'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { registerNativeIpc, registerGroupIpc, HistoryMutationQueue, quiet, root } = require('../helpers/nativeSyncFixture.cjs');
const { NativeSyncAdapter } = require('../../modules/services/nativeSync/adapter');
const { startSyncService } = require('../helpers/nativeSyncHttpService.cjs');
const artifactRoot = process.argv[2] ? path.resolve(process.argv[2]) : require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'native-sync-electron-'));
if (!path.basename(artifactRoot).startsWith('native-sync-')) throw new Error('Explicit isolated native-sync test root required');
app.setPath('userData', path.join(artifactRoot, 'electron-profile'));
app.disableHardwareAcceleration();
const clients = [], routes = new Map(), registered = new Set(), checks = [];
const rendererErrors = [];
let service;
const timeout = setTimeout(() => { console.error('Electron integration timed out'); app.exit(1); }, 60000);
const topic = { itemId: 'agent-a', itemType: 'agent', topicId: 'topic-a' };
const group = { itemId: 'group-a', itemType: 'group', topicId: 'topic-g' };
const m = (id, content = id, timestamp = 100) => ({ id, role: 'user', content, timestamp });
async function waitFor(check) {
    const until = Date.now() + 10000;
    while (!await check()) { if (Date.now() > until) throw new Error('Renderer condition timed out'); await new Promise(r => setTimeout(r, 20)); }
}
const js = (client, code) => client.window.webContents.executeJavaScript(code);
async function makeClient(name) {
    const dataRoot = path.join(artifactRoot, name);
    const queue = new HistoryMutationQueue({ userDataDir: path.join(dataRoot, 'UserData'), logger: quiet });
    const fixture = registerNativeIpc(queue.userDataDir, queue);
    const fse = require('fs-extra');
    await fse.outputJson(path.join(dataRoot, 'settings.json'), { vcpServerUrl: 'http://127.0.0.1:1/v1/chat/completions', vcpApiKey: 'synthetic-only' });
    await fse.outputJson(path.join(dataRoot, 'Agents/member/config.json'), { id: 'member', name: 'Member', model: 'fixture', streamOutput: false });
    await fse.outputJson(path.join(dataRoot, 'AgentGroups/group-a/config.json'), { id: 'group-a', name: 'Fixture Group', mode: 'sequential', members: ['member'], topics: [{ id: 'topic-g' }] });
    let providerFailure = false;
    registerGroupIpc(dataRoot, queue, fixture.ipcMain, async url => { assert.ok(url.startsWith('http://127.0.0.1:1/')); if (providerFailure) throw new Error('synthetic automatic error'); return new Response(JSON.stringify({ choices: [{ message: { content: 'Automatic native reply via group IPC' } }] })); });
    const window = new BrowserWindow({ show: false, width: 1100, height: 1120, webPreferences: { preload: path.join(root, 'preloads/chat.js'), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `native-sync-${name}` } });
    window.webContents.on('console-message', (event, level, message) => { if (level === 3 || event.level === 'error') rendererErrors.push(message || event.message); });
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    routes.set(window.webContents.id, fixture.routes);
    for (const channel of fixture.routes.keys()) {
        if (registered.has(channel)) continue;
        registered.add(channel);
        ipcMain.handle(channel, (event, ...args) => {
            const handler = routes.get(event.sender.id)?.get(channel);
            if (!handler) throw new Error('Unknown isolated test sender');
            return handler(event, ...args);
        });
    }
    const adapter = await NativeSyncAdapter.open({ queue, statePath: path.join(dataRoot, 'sync.json'), deviceId: name, url: service.url, token: 'isolated-poc-token', topics: [topic, group], notify: change => { if (!window.isDestroyed()) window.webContents.send('history-file-updated', change); } });
    const client = { name, queue, window, adapter, failProvider(value) { providerFailure = value; } }; clients.push(client);
    await window.loadFile(path.join(__dirname, 'native-sync-renderer.html'), { query: { client: name } });
    await waitFor(() => js(client, 'Boolean(window.nativeSyncTest) || Boolean(window.nativeSyncErrors?.length)'));
    const initializationErrors = await js(client, 'window.nativeSyncErrors || []');
    if (initializationErrors.length) throw new Error(initializationErrors.join('\n'));
    return client;
}
app.whenReady().then(async () => {
    try {
        ipcMain.handle('get-emoticon-library', () => []);
        await fs.mkdir(artifactRoot, { recursive: true });
        service = await startSyncService({ dbPath: path.join(artifactRoot, 'central.sqlite'), token: 'isolated-poc-token' });
        const a = await makeClient('Windows-A'), b = await makeClient('Windows-B');
        assert.equal((await js(a, `window.nativeSyncTest.save(${JSON.stringify([m('one', 'Native IPC A → SQLite → Renderer B')])})`)).success, true);
        await a.adapter.flush(); await b.adapter.pull();
        await waitFor(async () => (await js(b, 'window.nativeSyncTest.snapshot()')).visible.some(m => m.id === 'one' && m.text.includes('SQLite')));
        checks.push('real Electron preload/IPC A -> Queue -> durable Outbox -> HTTP/SQLite -> B Queue -> notification -> ChatManager/State/DOM');

        await js(b, 'window.nativeSyncTest.beginTerminal()');
        const before = await js(b, 'window.nativeSyncTest.snapshot()');
        assert.equal(before.refresh.saving, 1);
        await js(a, `window.nativeSyncTest.save(${JSON.stringify([m('one', 'Native IPC A → SQLite → Renderer B'), m('during-saving', 'Remote arrival during terminal saving', 200)])})`);
        await a.adapter.flush(); await b.adapter.pull();
        await new Promise(r => setTimeout(r, 100));
        const blocked = await js(b, 'window.nativeSyncTest.snapshot()');
        assert.ok(blocked.visible.some(m => m.id === 'terminal'));
        assert.equal(blocked.visible.some(m => m.id === 'during-saving'), false);
        await js(b, 'window.nativeSyncTest.finishTerminal()');
        await waitFor(async () => (await js(b, 'window.nativeSyncTest.snapshot()')).visible.some(m => m.id === 'during-saving'));
        assert.deepEqual((await b.queue.read(topic)).map(m => m.id).sort(), ['during-saving', 'one', 'terminal']);
        checks.push('projection finished + saving barrier; terminal merges latest history; pending refresh drains after durable terminal');
        await b.adapter.flush(); await a.adapter.pull();

        await js(b, "window.nativeSyncTest.select('agent-a','agent','other-topic')");
        await js(a, `window.nativeSyncTest.save(${JSON.stringify([...await a.queue.read(topic), m('other-arrival', 'Must not enter other topic', 400)])})`);
        await a.adapter.flush(); await b.adapter.pull(); await new Promise(r => setTimeout(r, 80));
        assert.equal((await js(b, 'window.nativeSyncTest.snapshot()')).visible.length, 0);
        checks.push('remote event cannot refresh another selected topic');

        await js(a, "window.nativeSyncTest.select('group-a','group','topic-g')");
        await js(b, "window.nativeSyncTest.select('group-a','group','topic-g')");
        assert.equal((await js(a, `window.nativeSyncTest.save(${JSON.stringify([m('group-one', 'Native Group IPC and Renderer B')])})`)).success, true);
        await a.adapter.flush(); await b.adapter.pull();
        await waitFor(async () => (await js(b, 'window.nativeSyncTest.snapshot()')).visible.some(m => m.id === 'group-one'));
        checks.push('real Group save IPC and B native receive/Renderer');
        assert.equal((await js(a, "window.nativeSyncTest.sendGroup('auto-user','automatic normal')")).success, true);
        await a.adapter.flush(); await b.adapter.pull();
        await waitFor(async () => (await js(b, 'window.nativeSyncTest.snapshot()')).visible.some(m => m.text.includes('Automatic native reply')));
        const originalReply = (await a.queue.read(group)).find(m => m.role === 'assistant');
        checks.push('group automatic normal terminal through real Electron IPC, Queue and Renderer B');
        a.failProvider(true);
        await js(a, "window.nativeSyncTest.sendGroup('error-user','automatic error')");
        await a.adapter.flush(); await b.adapter.pull();
        await waitFor(async () => (await js(b, 'window.nativeSyncTest.snapshot()')).visible.some(m => m.text.includes('synthetic automatic error')));
        checks.push('group automatic error terminal through real IPC, Queue and Renderer B; provider transport synthetic');
        a.failProvider(false);
        await js(a, `window.nativeSyncTest.redoGroup(${JSON.stringify(originalReply.id)})`);
        await a.adapter.flush(); await b.adapter.pull();
        await waitFor(async () => !(await js(b, 'window.nativeSyncTest.snapshot()')).visible.some(m => m.id === originalReply.id));
        assert.equal((await b.queue.read(group)).some(m => m.id === originalReply.id), false);
        checks.push('group redo deletes via Queue/tombstone and publishes replacement; Renderer B removes old reply');
        await js(b, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        await new Promise(r => setTimeout(r, 120));
        await fs.writeFile(path.join(artifactRoot, 'renderer-group.png'), (await b.window.webContents.capturePage()).toPNG());
        await js(b, "window.nativeSyncTest.select('agent-a','agent','topic-a')");
        await b.adapter.recover();
        await waitFor(async () => (await js(b, 'window.nativeSyncTest.snapshot()')).visible.some(m => m.id === 'terminal'));
        await js(b, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        await new Promise(r => setTimeout(r, 120));
        await fs.writeFile(path.join(artifactRoot, 'renderer-agent.png'), (await b.window.webContents.capturePage()).toPNG());
        const receipt = { result: 'NATIVE_SYNC_WIRING_POC_PASS', electron: process.versions.electron, node: process.versions.node, platform: process.platform, checks, renderer: 'isolated real Electron BrowserWindow; original chat-role preload, real handlers, ChatRepository, ChatManager, MainChatStateAuthority, ChatDomRenderer and production createMessageRenderer/Marked/morphdom; fixture shell, full production main startup not run', dataRoots: clients.map(c => path.join(artifactRoot, c.name)), journal: service.store.metrics() };
        await fs.writeFile(path.join(artifactRoot, 'electron-result.json'), JSON.stringify(receipt, null, 2));
        console.log(JSON.stringify(receipt));
    } catch (error) {
        console.error(error.stack); process.exitCode = 1;
        await fs.mkdir(artifactRoot, { recursive: true });
        const rendererDiagnostics = [];
        for (const client of clients) {
            try { rendererDiagnostics.push(await js(client, `({base:document.baseURI, ready:document.readyState, scripts:[...document.scripts].map(s=>({type:s.type,src:s.src})), resources:performance.getEntriesByType('resource').map(e=>({name:e.name,type:e.initiatorType})), errors:window.nativeSyncErrors})`)); } catch {}
        }
        await fs.writeFile(path.join(artifactRoot, 'electron-failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, rendererErrors: rendererErrors.slice(-12), rendererDiagnostics }, null, 2));
    }
    finally {
        for (const c of clients) { try { await js(c, 'window.nativeSyncTest?.dispose()'); } catch {} await c.adapter.close(); await c.queue.dispose(); if (!c.window.isDestroyed()) c.window.destroy(); }
        await service?.close(); clearTimeout(timeout); app.exit(process.exitCode || 0);
    }
});
