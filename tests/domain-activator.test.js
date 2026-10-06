'use strict';

// 主进程领域按需激活：登记时只占通道，第一次调用才加载模块；失败可重试；退出只释放用过的领域；
// preload 清单里的通道和各 handler 模块自己的 CHANNELS 必须一致，否则会有通道漏注册。
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createDomainActivator, channelsForDomain } = require('../modules/ipc/domainActivator');
const { describeApis } = require('../preloads/core/registry');

function fakeIpcMain() {
    const handlers = new Map();
    return {
        handlers,
        handle(channel, fn) {
            if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
            handlers.set(channel, fn);
        },
        removeHandler(channel) { handlers.delete(channel); },
        invoke(channel, ...args) { return handlers.get(channel)({ sender: {} }, ...args); },
    };
}

const quiet = { error: () => {} };

test('a domain is loaded on its first call, once, and the call is forwarded', async () => {
    const ipc = fakeIpcMain();
    const activator = createDomainActivator({ ipcMain: ipc, logger: quiet });
    let loads = 0;
    let inits = 0;
    activator.register('demo', {
        channels: ['demo:echo', 'demo:twice'],
        load: () => { loads += 1; return { factor: 2 }; },
        init: (mod, { ipcMain }) => {
            inits += 1;
            ipcMain.handle('demo:echo', (_event, value) => ({ success: true, data: value }));
            ipcMain.handle('demo:twice', async (_event, value) => ({ success: true, data: value * mod.factor }));
        },
    });
    assert.equal(loads, 0, 'registering only reserves the channels');
    assert.equal(activator.stateOf('demo'), 'declared');
    assert.deepEqual([...ipc.handlers.keys()], ['demo:echo', 'demo:twice']);

    assert.deepEqual(await ipc.invoke('demo:twice', 21), { success: true, data: 42 });
    assert.deepEqual(await ipc.invoke('demo:echo', 'hi'), { success: true, data: 'hi' });
    assert.equal(loads, 1);
    assert.equal(inits, 1);
    const [entry] = activator.snapshot();
    assert.equal(entry.state, 'active');
    assert.equal(entry.calls, 2);
    assert.equal(entry.channels, 2);
});

test('a failed activation answers with an error envelope and the next call retries', async () => {
    const ipc = fakeIpcMain();
    const activator = createDomainActivator({ ipcMain: ipc, logger: quiet });
    let broken = true;
    activator.register('flaky', {
        channels: ['flaky:get'],
        load: () => { if (broken) throw new Error('module missing'); return {}; },
        init: (_mod, { ipcMain }) => ipcMain.handle('flaky:get', () => ({ success: true })),
    });
    const first = await ipc.invoke('flaky:get');
    assert.equal(first.success, false);
    assert.match(first.error, /module missing/);
    assert.equal(activator.stateOf('flaky'), 'failed');
    assert.equal(activator.snapshot()[0].error, 'module missing');

    broken = false;
    assert.deepEqual(await ipc.invoke('flaky:get'), { success: true });
    assert.equal(activator.stateOf('flaky'), 'active');
    assert.equal(activator.snapshot()[0].attempts, 2);
});

test('a domain may only register its own channels, and channels cannot belong to two domains', () => {
    const ipc = fakeIpcMain();
    const activator = createDomainActivator({ ipcMain: ipc, logger: quiet });
    activator.register('a', {
        channels: ['a:one'],
        load: () => ({}),
        init: (_mod, { ipcMain }) => ipcMain.handle('b:other', () => null),
    });
    assert.throws(() => activator.activate('a'), /不属于自己的通道/);
    assert.equal(activator.stateOf('a'), 'failed');
    assert.throws(() => activator.register('b', { channels: ['a:one'], load: () => ({}), init: () => {} }), /已属于 a/);
});

test('eager domains activate on registration; disposeAll only touches the ones that were used', async () => {
    const ipc = fakeIpcMain();
    const activator = createDomainActivator({ ipcMain: ipc, logger: quiet });
    const disposed = [];
    let lazyLoads = 0;
    activator.register('fence', {
        channels: ['fence:get'],
        load: () => ({}),
        init: (_mod, { ipcMain }) => ipcMain.handle('fence:get', () => 'ok'),
        dispose: () => disposed.push('fence'),
        eager: true,
    });
    activator.register('lazy', {
        channels: ['lazy:get'],
        load: () => { lazyLoads += 1; return {}; },
        init: (_mod, { ipcMain }) => ipcMain.handle('lazy:get', () => 'ok'),
        dispose: () => disposed.push('lazy'),
    });
    assert.equal(activator.stateOf('fence'), 'active');
    activator.disposeAll();
    assert.deepEqual(disposed, ['fence']);
    assert.equal(lazyLoads, 0, 'quitting does not load a domain just to dispose it');
    assert.equal(activator.stateOf('fence'), 'declared');
    assert.equal(await ipc.invoke('fence:get'), 'ok', 'a disposed domain comes back on its next call');

    activator.unregisterAll();
    assert.equal(ipc.handlers.size, 0);
});

test('channelsForDomain skips push channels and refuses send channels', () => {
    const apis = [
        { domain: 'x', kind: 'query', channel: 'x:get' },
        { domain: 'x', kind: 'query', channel: 'x:get' },
        { domain: 'x', kind: 'subscription', channel: 'x:changed' },
        { domain: 'y', kind: 'command', channel: 'y:fire' },
    ];
    assert.deepEqual(channelsForDomain(apis, 'x'), ['x:get']);
    assert.throws(() => channelsForDomain(apis, 'y'), /y:fire/);
});

function loadWithElectronMock(paths) {
    const originalLoad = Module._load;
    const ipcMain = { handle: () => {}, removeHandler: () => {}, on: () => {} };
    Module._load = function mockElectron(request, parent, isMain) {
        if (request === 'electron') {
            return { ipcMain, shell: {}, session: { fromPartition: () => ({}) }, app: { getPath: () => '' } };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return paths.map(file => require(file));
    } finally {
        Module._load = originalLoad;
    }
}

test('preload declarations and handler modules list the same channels', () => {
    const apis = describeApis();
    const [terminal, trajectory, browser, sideChat] = loadWithElectronMock([
        '../modules/ipc/terminalHandlers',
        '../modules/ipc/modelTrajectoryHandlers',
        '../modules/ipc/browserHandlers',
        '../modules/ipc/sideChatHandlers',
    ]);
    for (const [domain, mod] of [['terminal', terminal], ['modelTrajectory', trajectory], ['browser', browser], ['sideChat', sideChat]]) {
        assert.deepEqual(
            [...channelsForDomain(apis, domain)].sort(),
            [...mod.CHANNELS].sort(),
            `${domain}: preloads/api/${domain}.js and its handler module disagree`
        );
    }
});

test('the terminal domain does not load the executor until a terminal channel is actually used', async () => {
    const [terminal] = loadWithElectronMock(['../modules/ipc/terminalHandlers']);
    const { createTrustedMainSender } = require('./helpers/trusted-main-sender.cjs');
    const ipc = fakeIpcMain();
    const activator = createDomainActivator({ ipcMain: ipc, logger: quiet });
    let executorLoads = 0;
    let storeLoads = 0;
    activator.register('terminal', {
        channels: channelsForDomain(describeApis(), 'terminal'),
        load: () => terminal,
        init: (mod, { ipcMain }) => mod.initialize({
            ipcMain,
            executorLoader: () => {
                executorLoads += 1;
                return {};
            },
            commandRunStoreLoader: () => {
                storeLoads += 1;
                return { listCommandRuns: () => [{ id: 'r1' }], subscribeCommandRuns: () => () => {} };
            },
        }),
        dispose: mod => mod.disposeAll(),
    });
    try {
        assert.equal(activator.stateOf('terminal'), 'declared');
        assert.equal(storeLoads, 0);
        const { event } = createTrustedMainSender();
        const result = await ipc.handlers.get('terminal:command-runs')(event);
        assert.deepEqual(result, { success: true, data: [{ id: 'r1' }] });
        assert.equal(activator.stateOf('terminal'), 'active');
        assert.equal(storeLoads, 1);
        // 只读命令记录：执行器（注册 IPC、主题监视、读配置）一直不加载
        assert.equal(executorLoads, 0);
    } finally {
        activator.unregisterAll();
    }
});
