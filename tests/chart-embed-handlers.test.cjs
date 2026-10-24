'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { createTrustedMainSender } = require('./helpers/trusted-main-sender.cjs');

const handlers = new Map();
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'electron') return {
        BrowserWindow: class {},
        screen: {},
        ipcMain: {
            handle: (channel, handler) => handlers.set(channel, handler),
            removeHandler: channel => handlers.delete(channel),
            removeAllListeners() {},
            on() {},
        },
    };
    if (request === '../services/windowService' && parent.filename.endsWith('chartHandlers.js')) {
        return { register() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const chartHandlers = require('../modules/ipc/chartHandlers.js');
Module._load = originalLoad;

test('embed IPC authorizes top-level main sender and binds read-only requests to chart leases', async () => {
    const trusted = createTrustedMainSender();
    trusted.sender.id = 1;
    const sent = [];
    trusted.sender.send = (channel, payload) => sent.push({ channel, payload });
    trusted.mainWindow.isDestroyed = () => false;
    const service = new EventEmitter();
    service.initialize = async () => {};
    service.setDataSourceAdapter = () => {};
    service.setWindowAdapter = () => {};
    service.shutdown = async () => {};
    service.readSources = async id => ({
        manifest: { id, codeRevision: 1, dataRevision: 1 },
        template: '', style: '', runtime: '', data: { value: 1 },
    });
    const reads = [];
    await chartHandlers.initialize({
        mainWindow: trusted.mainWindow,
        chartService: service,
        chartDataSourceService: { read: async request => { reads.push(request); return { data: 42 }; } },
    });
    const call = (channel, request, event = trusted.event) => handlers.get(channel)(event, request);
    try {
        const foreign = createTrustedMainSender();
        await assert.rejects(call('chart:embed-acquire', 'cpu-monitor', foreign.event), /未授权/);
        await assert.rejects(call('chart:embed-acquire', 'cpu-monitor', {
            sender: trusted.sender, senderFrame: { url: trusted.sender.getURL() },
        }), /未授权/);
        assert.throws(() => call('chart:get-snapshot', 'cpu-monitor'), /未授权/);
        const first = await call('chart:embed-acquire', 'cpu-monitor');
        const second = await call('chart:embed-acquire', 'sales-trend');
        assert.notEqual(first.token, second.token);
        const lease = { chartId: 'cpu-monitor', token: first.token };
        assert.throws(() => call('chart:embed-snapshot', { ...lease, chartId: 'sales-trend' }), /失效/);
        assert.deepEqual(await call('chart:embed-read-data-source', {
            ...lease, request: { type: 'json', source: 'test.json', method: 'DELETE', operation: 'write' },
        }), { data: 42 });
        assert.deepEqual(reads, [{ type: 'json', source: 'test.json' }]);
        service.emit('change', { chartId: 'not-subscribed', type: 'data-replaced' });
        assert.equal(sent.length, 0);
        service.emit('change', { chartId: 'cpu-monitor', type: 'data-replaced' });
        assert.equal(sent.at(-1).channel, 'chart:embed-changed');
        await call('chart:embed-release', lease);
        assert.throws(() => call('chart:embed-snapshot', lease), /失效/);
        const otherLease = { chartId: 'sales-trend', token: second.token };
        trusted.sender.emit('did-navigate');
        assert.throws(() => call('chart:embed-snapshot', otherLease), /失效/);
    } finally {
        await chartHandlers.shutdown();
    }
    assert.equal(trusted.sender.listenerCount('did-navigate'), 0);
    assert.equal(trusted.sender.listenerCount('destroyed'), 0);
});