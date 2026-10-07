'use strict';

// 命令记录的推送按页面计数：每次 watch 加一，unwatch 减一，归零才真正取消；
// 命令记录从无副作用的记录模块读，列出、读取、订阅记录都不会加载终端执行器。
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const handlers = new Map();
const originalLoad = Module._load;
Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') {
        return {
            ipcMain: {
                handle: (channel, fn) => handlers.set(channel, fn),
                removeHandler: (channel) => handlers.delete(channel),
                on: () => {},
            },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const terminalHandlers = require('../modules/ipc/terminalHandlers');
Module._load = originalLoad;
const path = require('node:path');
const PLUGIN_DIR = path.join(__dirname, '..', 'VCPDistributedServer', 'Plugin', 'PowerShellExecutor');

class FakeSender extends EventEmitter {
    constructor() {
        super();
        this.mainFrame = { url: this.getURL() };
        this.destroyed = false;
        this.sent = [];
    }
    getType() { return 'window'; }
    isDestroyed() { return this.destroyed; }
    send(channel, payload) { this.sent.push({ channel, payload }); }
    getURL() { return require('./helpers/trusted-main-sender.cjs').createTrustedMainSender().sender.getURL(); }
}

function createFakeRunStore() {
    const listeners = new Set();
    return {
        loads: 0,
        listeners,
        subscribeCommandRuns(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        listCommandRuns: () => [],
        emit(summary) { listeners.forEach(listener => listener(summary)); },
    };
}

const call = (channel, sender, ...args) => handlers.get(channel)({ sender, senderFrame: sender.mainFrame }, ...args);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 要放在第一个：之后的用例会注入假的加载器，这里验证的是默认路径
test('reading command runs goes through the run store and never loads the executor', async () => {
    const executorPath = path.join(PLUGIN_DIR, 'PowerShellExecutor.js');
    const store = require(path.join(PLUGIN_DIR, 'commandRunStore.js'));
    terminalHandlers.initialize();
    try {
        const run = store.beginCommandRun('git status');
        store.appendCommandRunOutput(run, 'On branch main\r\n');
        store.finishCommandRun(run, 'completed');
        const page = new FakeSender();
        const list = await call('terminal:command-runs', page);
        assert.equal(list.success, true);
        assert.equal(list.data[0].id, run.id);
        const detail = await call('terminal:command-run', page, run.id);
        assert.equal(detail.data.output, 'On branch main\n');
        assert.equal((await call('terminal:watch-command-runs', page)).success, true);
        await call('terminal:unwatch-command-runs', page);
        assert.equal(require.cache[executorPath], undefined, 'the executor (IPC, theme watcher, config) stays unloaded');
    } finally {
        terminalHandlers.disposeAll();
    }
});

test('registering the IPC loads nothing; watch and unwatch are counted per page', async () => {
    const runStore = createFakeRunStore();
    let executorLoads = 0;
    terminalHandlers.initialize({
        executorLoader: () => { executorLoads += 1; return {}; },
        commandRunStoreLoader: () => { runStore.loads += 1; return runStore; }
    });
    try {
        assert.equal(runStore.loads, 0, 'initialize only registers handlers');

        const page = new FakeSender();
        const other = new FakeSender();
        assert.equal((await call('terminal:watch-command-runs', page)).success, true);
        assert.equal((await call('terminal:watch-command-runs', page)).success, true);
        assert.equal((await call('terminal:watch-command-runs', other)).success, true);
        assert.equal(runStore.listeners.size, 2, 'one store subscription per page');

        await call('terminal:unwatch-command-runs', page);
        assert.equal(runStore.listeners.size, 2, 'the page still has one watcher left');
        runStore.emit({ id: 'r1', status: 'running' });
        await wait(200);
        assert.equal(page.sent.filter(m => m.channel === 'terminal:command-run-changed').length, 1);

        await call('terminal:unwatch-command-runs', page);
        assert.equal(runStore.listeners.size, 1, 'last unwatch stops pushing to that page');
        await call('terminal:unwatch-command-runs', page);
        assert.equal(runStore.listeners.size, 1, 'extra unwatch calls are ignored');

        runStore.emit({ id: 'r1', status: 'completed' });
        await wait(200);
        assert.equal(page.sent.filter(m => m.channel === 'terminal:command-run-changed').length, 1);
        assert.equal(other.sent.filter(m => m.channel === 'terminal:command-run-changed').length, 2);

        const foreign = new FakeSender();
        foreign.getURL = () => 'https://example.com/';
        foreign.mainFrame = { url: foreign.getURL() };
        assert.equal((await call('terminal:unwatch-command-runs', foreign)).success, false);

        other.emit('destroyed');
        assert.equal(runStore.listeners.size, 0, 'a destroyed page drops its watcher regardless of the count');
        assert.equal(executorLoads, 0, 'following command runs never loads the executor');
    } finally {
        terminalHandlers.disposeAll();
    }
});

test('mirror output after the first chunk is coalesced per frame; exit flushes first and kill drops the rest', async () => {
    let sink = null;
    let detached = 0;
    terminalHandlers.initialize({
        executorLoader: () => ({
            getSessionState: () => ({ pid: 1, cols: 80, rows: 24 }),
            resizeSession() {},
            ensureMirrorSession: () => ({ pid: 1 }),
            attachMirror(next) { sink = next; return () => { detached += 1; }; }
        }),
        commandRunStoreLoader: () => createFakeRunStore()
    });
    const page = new FakeSender();
    const { data: { id } } = await call('terminal:create', page, {});
    await wait(0);
    const dataMessages = () => page.sent.filter(m => m.channel === 'terminal:data').map(m => m.payload.data);

    sink.onData('k');
    assert.deepEqual(dataMessages(), ['k'], 'the first chunk after quiet (a key echo) goes out at once');
    for (let i = 0; i < 500; i++) sink.onData('x');
    assert.equal(dataMessages().length, 1, 'chunks inside the window are not sent one by one');
    await wait(40);
    assert.deepEqual(dataMessages(), ['k', 'x'.repeat(500)]);
    await wait(40);

    sink.onData('a');
    sink.onData('a'.repeat(70 * 1024));
    assert.equal(dataMessages().length, 4, 'a large burst goes out without waiting for the window');

    sink.onData('bye');
    sink.onExit(0);
    assert.deepEqual(page.sent.slice(-2).map(m => m.channel), ['terminal:data', 'terminal:exit']);

    sink.onData('more');
    sink.onData('late');
    await call('terminal:kill', page, id);
    await wait(40);
    assert.equal(dataMessages().at(-1), 'more', 'output buffered when the view closed is not sent');
    assert.equal(detached, 1);
});
