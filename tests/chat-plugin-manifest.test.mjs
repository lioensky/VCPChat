import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatPluginLoader, validateChatPluginManifest } from '../modules/chat/chatPluginManifest.js';

test('chat plugin manifest rejects undeclared powers and loader disposes provider', () => {
    assert.throws(() => validateChatPluginManifest({ id: 'bad', apiVersion: 1, cssText: 'body{}' }), /CSS text/);
    assert.throws(() => validateChatPluginManifest({ id: 'bad', apiVersion: 1, selectors: ['.message-item'] }), /selectors/);
    assert.throws(() => validateChatPluginManifest({ id: 'bad', apiVersion: 1, ipc: ['save-chat'] }), /IPC/);
    assert.throws(() => validateChatPluginManifest({ id: 'bad', apiVersion: 1, capabilities: ['history-write'] }), /unsupported chat plugin capability/);
    assert.throws(() => validateChatPluginManifest({ id: 'bad', apiVersion: 1, slots: ['arbitrary-root'] }), /unsupported chat plugin slot/);
    let disposed = false;
    const loader = createChatPluginLoader({ state: { getSnapshot: () => ({ mode: 'idle' }) }, slots: { register: () => () => {} } });
    const uninstall = loader.install({ id: 'skin', apiVersion: 1, capabilities: ['theme'], slots: [] }, ({ manifest, state }) => {
        assert.equal(manifest.id, 'skin');
        assert.equal(state.mode, 'idle');
        return () => { disposed = true; };
    });
    uninstall();
    assert.equal(disposed, true);
    loader.dispose();
});

test('chat plugin loader owns slot/theme/skin teardown and rejects undeclared capability', () => {
    const events = [];
    const slots = { register: (_slot, _id, _mount) => () => events.push('slot') };
    const loader = createChatPluginLoader({
        state: { getSnapshot: () => ({ mode: 'next' }) }, slots
    });
    const uninstall = loader.install({ id: 'controlled', apiVersion: 1, capabilities: ['surface-slot'], slots: ['header'] }, ({ registerSlot, applyTheme }) => {
        registerSlot('header', 'x', () => {});
        assert.throws(() => applyTheme({}, { apply: () => {} }), /theme capability/);
        return () => events.push('provider');
    });
    uninstall();
    assert.deepEqual(events, ['slot', 'provider']);
    loader.dispose();
    assert.throws(() => loader.install({ id: 'late', apiVersion: 1, capabilities: [], slots: [] }, () => {}), /disposed/);
});

test('chat plugin state subscription is capability-gated, readonly, and disposed with owner', () => {
    let active = true;
    const snapshots = [];
    const listeners = new Set();
    const state = {
        getSnapshot: () => ({ mode: 'idle' }),
        subscribe(listener) { listeners.add(listener); listener({ mode: 'idle' }); return () => { active = false; listeners.delete(listener); }; }
    };
    const loader = createChatPluginLoader({ state });
    loader.install({ id: 'stateful', apiVersion: 1, capabilities: ['presentation-state'], slots: [] }, ({ subscribeState }) => {
        subscribeState(snapshot => {
            snapshots.push(snapshot);
            assert.throws(() => { snapshot.mode = 'mutated'; }, TypeError);
        });
    });
    assert.equal(snapshots.length, 1);
    loader.dispose();
    assert.equal(active, false);
    assert.throws(() => createChatPluginLoader({ state }).install({ id: 'plain', apiVersion: 1, capabilities: [], slots: [] }, ({ subscribeState }) => subscribeState(() => {})), /capability/);
});

test('loader owns presentation skin updates and removes the subscription on uninstall', () => {
    const listeners = new Set();
    const state = {
        getSnapshot: () => ({ mode: 'idle' }),
        subscribe(listener) { listeners.add(listener); listener({ mode: 'idle' }); return () => listeners.delete(listener); }
    };
    const root = { dataset: {} };
    const loader = createChatPluginLoader({ state });
    const seen = [];
    const uninstall = loader.install({ id: 'updates', apiVersion: 1, capabilities: ['presentation-state'], slots: [] }, ({ mountSkin }) => {
        const skin = { mount(host, snapshot) { host.dataset.mode = snapshot.mode; const teardown = () => {}; teardown.update = next => { seen.push(next.mode); host.dataset.mode = next.mode; }; return teardown; } };
        mountSkin(root, skin);
    });
    [...listeners][0]({ mode: 'streaming' });
    assert.deepEqual(seen, ['idle', 'streaming']);
    uninstall();
    assert.equal(listeners.size, 0);
});

test('plugin provider failure rolls back every earlier registration', () => {
    const events = [];
    const loader = createChatPluginLoader({
        slots: { register: () => () => events.push('slot') }
    });
    assert.throws(() => loader.install({ id: 'rollback', apiVersion: 1, capabilities: ['surface-slot'], slots: ['header'] }, ({ registerSlot }) => {
        registerSlot('header', 'first', () => {});
        throw new Error('controlled provider failure');
    }), /controlled provider failure/);
    assert.deepEqual(events, ['slot']);
    assert.doesNotThrow(() => loader.install({ id: 'rollback', apiVersion: 1, capabilities: [], slots: [] }, () => {}));
});

test('uninstalled plugin ignores late state updates and duplicate uninstall', () => {
    const listeners = new Set();
    const state = { getSnapshot: () => ({ mode: 'idle' }), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
    const loader = createChatPluginLoader({ state });
    let updates = 0;
    const uninstall = loader.install({ id: 'late-state', apiVersion: 1, capabilities: ['presentation-state'], slots: [] }, ({ subscribeState }) => {
        subscribeState(() => { updates += 1; });
    });
    uninstall();
    uninstall();
    for (const listener of listeners) listener({ mode: 'late' });
    assert.equal(updates, 0);
    assert.equal(listeners.size, 0);
});
