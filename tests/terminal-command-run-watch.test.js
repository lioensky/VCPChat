'use strict';

// 命令记录的推送按页面计数：每次 watch 加一，unwatch 减一，归零才真正取消；
// 注册 IPC 时不加载终端执行器，第一次用到才加载。
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

function createFakeExecutor() {
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

test('registering the IPC does not load the executor; watch and unwatch are counted per page', async () => {
    const executor = createFakeExecutor();
    terminalHandlers.initialize({ executorLoader: () => { executor.loads += 1; return executor; } });
    try {
        assert.equal(executor.loads, 0, 'initialize only registers handlers');

        const page = new FakeSender();
        const other = new FakeSender();
        assert.equal((await call('terminal:watch-command-runs', page)).success, true);
        assert.equal((await call('terminal:watch-command-runs', page)).success, true);
        assert.equal((await call('terminal:watch-command-runs', other)).success, true);
        assert.equal(executor.listeners.size, 2, 'one executor subscription per page');

        await call('terminal:unwatch-command-runs', page);
        assert.equal(executor.listeners.size, 2, 'the page still has one watcher left');
        executor.emit({ id: 'r1', status: 'running' });
        await wait(200);
        assert.equal(page.sent.filter(m => m.channel === 'terminal:command-run-changed').length, 1);

        await call('terminal:unwatch-command-runs', page);
        assert.equal(executor.listeners.size, 1, 'last unwatch stops pushing to that page');
        await call('terminal:unwatch-command-runs', page);
        assert.equal(executor.listeners.size, 1, 'extra unwatch calls are ignored');

        executor.emit({ id: 'r1', status: 'completed' });
        await wait(200);
        assert.equal(page.sent.filter(m => m.channel === 'terminal:command-run-changed').length, 1);
        assert.equal(other.sent.filter(m => m.channel === 'terminal:command-run-changed').length, 2);

        const foreign = new FakeSender();
        foreign.getURL = () => 'https://example.com/';
        foreign.mainFrame = { url: foreign.getURL() };
        assert.equal((await call('terminal:unwatch-command-runs', foreign)).success, false);

        other.emit('destroyed');
        assert.equal(executor.listeners.size, 0, 'a destroyed page drops its watcher regardless of the count');
    } finally {
        terminalHandlers.disposeAll();
    }
});
