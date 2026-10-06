'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { createStateSubscriptions } = require('../modules/ipc/stateSubscriptions');
const { onSenderGone } = require('../modules/ipc/senderLifetime');

function fakeSender() {
    const sender = new EventEmitter();
    sender.sent = [];
    sender.destroyed = false;
    sender.isDestroyed = () => sender.destroyed;
    sender.send = (channel, payload) => { sender.sent.push([channel, payload]); };
    sender.destroy = () => { sender.destroyed = true; sender.emit('destroyed'); };
    return sender;
}

const quiet = { error: () => {} };

test('a window counts once per topic no matter how many holders it has; onFirst/onLast follow windows', () => {
    const subs = createStateSubscriptions({ logger: quiet });
    const hooks = [];
    subs.declare('demo', { onFirst: key => hooks.push(['first', key]), onLast: key => hooks.push(['last', key]) });
    const a = fakeSender();
    const b = fakeSender();

    assert.deepEqual(subs.subscribe(a, 'demo'), { success: true });
    subs.subscribe(a, 'demo');
    subs.subscribe(b, 'demo');
    assert.equal(subs.windowsFor('demo'), 2);
    assert.deepEqual(hooks, [['first', '']]);
    assert.deepEqual(subs.snapshot(), [{ topic: 'demo', key: '', windows: 2 }]);

    subs.unsubscribe(a, 'demo');
    assert.equal(subs.windowsFor('demo'), 2, 'window A still has one holder');
    subs.unsubscribe(a, 'demo');
    subs.unsubscribe(a, 'demo');
    assert.equal(subs.windowsFor('demo'), 1, 'extra unsubscribes are ignored');
    subs.unsubscribe(b, 'demo');
    assert.deepEqual(hooks, [['first', ''], ['last', '']]);
    assert.deepEqual(subs.snapshot(), []);
});

test('publish only reaches subscribed windows, per key', () => {
    const subs = createStateSubscriptions({ logger: quiet });
    subs.declare('git.status', { keyed: true });
    const a = fakeSender();
    const b = fakeSender();
    const c = fakeSender();
    subs.subscribe(a, 'git.status', 'ws1');
    subs.subscribe(b, 'git.status', 'ws2');

    assert.equal(subs.publish('git.status', 'ws1', 'git:changed', { n: 1 }), 1);
    assert.deepEqual(a.sent, [['git:changed', { n: 1 }]]);
    assert.deepEqual(b.sent, []);
    assert.deepEqual(c.sent, []);
    assert.equal(subs.publish('git.status', 'ws3', 'git:changed', {}), 0);
});

test('a closed or navigated window loses its subscriptions; in-page navigation does not', () => {
    const subs = createStateSubscriptions({ logger: quiet });
    const hooks = [];
    subs.declare('demo', { onLast: () => hooks.push('last') });
    const closed = fakeSender();
    const navigated = fakeSender();
    subs.subscribe(closed, 'demo');
    subs.subscribe(closed, 'demo');
    subs.subscribe(navigated, 'demo');

    navigated.emit('did-start-navigation', {}, 'file:///x.html#a', true, true);
    navigated.emit('did-start-navigation', {}, 'https://frame', false, false);
    assert.equal(subs.windowsFor('demo'), 2, 'hash change and subframe navigation keep the subscription');
    navigated.emit('did-start-navigation', {}, 'file:///other.html', false, true);
    assert.equal(subs.windowsFor('demo'), 1);

    closed.destroy();
    assert.equal(subs.windowsFor('demo'), 0, 'both holders of the closed window are gone');
    assert.deepEqual(hooks, ['last']);
    assert.equal(subs.publish('demo', '', 'demo:changed', 1), 0);

    // 同一个页面重新订阅后照常工作，旧的离开监听不会重复触发
    subs.subscribe(navigated, 'demo');
    assert.equal(subs.windowsFor('demo'), 1);
    navigated.emit('did-start-navigation', {}, 'file:///again.html', false, true);
    assert.equal(subs.windowsFor('demo'), 0);
    assert.deepEqual(hooks, ['last', 'last']);
});

test('a destroyed window found during publish is dropped without throwing', () => {
    const subs = createStateSubscriptions({ logger: quiet });
    subs.declare('demo');
    const a = fakeSender();
    subs.subscribe(a, 'demo');
    a.destroyed = true; // 'destroyed' 事件还没来
    assert.equal(subs.publish('demo', '', 'demo:changed', 1), 0);
    assert.equal(subs.windowsFor('demo'), 0);
});

test('topics and keys are validated', () => {
    const subs = createStateSubscriptions({ logger: quiet });
    assert.throws(() => subs.declare('Bad Name'), /invalid topic/);
    subs.declare('plain');
    subs.declare('keyed', { keyed: true });
    assert.throws(() => subs.declare('plain'), /twice/);
    const a = fakeSender();
    assert.equal(subs.subscribe(a, 'unknown').success, false);
    assert.equal(subs.subscribe(a, 'plain', 'k').success, false);
    assert.equal(subs.subscribe(a, 'keyed').success, false);
    assert.equal(subs.subscribe(a, 'keyed', 'x'.repeat(301)).success, false);
    assert.deepEqual(subs.snapshot(), []);
});

test('a hook that throws does not break the table', () => {
    const errors = [];
    const subs = createStateSubscriptions({ logger: { error: (...args) => errors.push(args) } });
    subs.declare('demo', { onFirst: () => { throw new Error('boom'); } });
    const a = fakeSender();
    assert.deepEqual(subs.subscribe(a, 'demo'), { success: true });
    assert.equal(subs.windowsFor('demo'), 1);
    assert.equal(errors.length, 1);
});

test('IPC handlers reject senders the guard does not accept, and dispose removes them', async () => {
    const subs = createStateSubscriptions({ logger: quiet });
    subs.declare('demo');
    const handlers = new Map();
    const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: ch => handlers.delete(ch) };
    const trusted = fakeSender();
    const stranger = fakeSender();
    subs.registerIpc(ipcMain, event => event.sender === trusted);
    assert.deepEqual([...handlers.keys()].sort(), ['state:subscribe', 'state:unsubscribe']);

    assert.deepEqual(await handlers.get('state:subscribe')({ sender: stranger }, 'demo'), { success: false, error: 'UNAUTHORIZED_SENDER' });
    assert.deepEqual(await handlers.get('state:subscribe')({ sender: trusted }, 'demo'), { success: true });
    assert.equal(subs.windowsFor('demo'), 1);
    await handlers.get('state:unsubscribe')({ sender: trusted }, 'demo');
    assert.equal(subs.windowsFor('demo'), 0);

    subs.subscribe(trusted, 'demo');
    subs.dispose();
    assert.equal(handlers.size, 0);
    assert.equal(subs.windowsFor('demo'), 0, 'dispose drops every window');
});

test('onSenderGone fires each release once and can be cancelled', () => {
    const sender = fakeSender();
    const calls = [];
    onSenderGone(sender, () => calls.push('a'));
    const cancel = onSenderGone(sender, () => calls.push('b'));
    cancel();
    sender.emit('destroyed');
    sender.emit('destroyed');
    assert.deepEqual(calls, ['a']);
    assert.equal(sender.listenerCount('destroyed'), 1, 'one listener per page, not one per release');
});

test('ProjectForge: the plugin is loaded when the first window subscribes, and changes reach only subscribers', () => {
    const pluginPath = require.resolve('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService.js');
    const handlerPath = require.resolve('../modules/ipc/projectForgeHandlers');
    delete require.cache[pluginPath];
    delete require.cache[handlerPath];
    const handlers = new Map();
    const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: ch => handlers.delete(ch) };
    const originalLoad = Module._load;
    Module._load = function mockElectron(request, parent, isMain) {
        if (request === 'electron') return { ipcMain };
        return originalLoad.call(this, request, parent, isMain);
    };
    let projectForgeHandlers;
    try {
        projectForgeHandlers = require(handlerPath);
    } finally {
        Module._load = originalLoad;
    }

    const subs = createStateSubscriptions({ logger: quiet });
    projectForgeHandlers.initialize({ subscriptions: subs });
    assert.ok(handlers.has('project-forge:get-project'));
    assert.equal(require.cache[pluginPath], undefined, 'starting the app does not load the ProjectForge plugin');

    const watcher = fakeSender();
    const bystander = fakeSender();
    subs.subscribe(watcher, projectForgeHandlers.CHANGED_TOPIC);
    assert.ok(require.cache[pluginPath], 'the first subscriber loads it');

    const forge = require(pluginPath);
    forge.events.emit('changed', { action: 'edit', projectId: 'p1' });
    assert.deepEqual(watcher.sent, [['project-forge:changed', { action: 'edit', projectId: 'p1' }]]);
    assert.deepEqual(bystander.sent, []);

    // 再次订阅不会重复挂监听
    watcher.destroy();
    subs.subscribe(bystander, projectForgeHandlers.CHANGED_TOPIC);
    forge.events.emit('changed', { action: 'edit', projectId: 'p2' });
    assert.equal(bystander.sent.length, 1);
    assert.equal(watcher.sent.length, 1, 'a closed window gets nothing more');
    subs.dispose();
});
