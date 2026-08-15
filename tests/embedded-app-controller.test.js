const test = require('node:test');
const assert = require('node:assert/strict');
const { EmbeddedAppController } = require('../modules/ui-system/next-shell/embedded-app-controller.js');

test('embedded controller is the single gateway for native session operations', async () => {
    const calls = [];
    let stateListener = null;
    const api = {
        desktopCreateEmbeddedVchatApp: async action => { calls.push(['create', action]); return { success: true }; },
        desktopActivateEmbeddedVchatApp: async action => { calls.push(['activate', action]); return { success: true }; },
        desktopSetEmbeddedVchatAppBounds: async (action, bounds) => { calls.push(['bounds', action, bounds]); },
        desktopListEmbeddedVchatApps: async () => ({ sessions: [] }),
        desktopDetachEmbeddedVchatApp: async (action, point) => { calls.push(['detach', action, point]); },
        desktopCloseEmbeddedVchatApp: async action => { calls.push(['close', action]); },
        onEmbeddedVchatAppState: listener => {
            stateListener = listener;
            return () => { stateListener = null; calls.push(['unsubscribe']); };
        },
    };
    const states = [];
    const controller = new EmbeddedAppController({ getApi: () => api });
    controller.mount(null, state => states.push(state));
    assert.equal(controller.supported, true);
    stateListener({ action: 'notes', state: 'ready' });
    await controller.create('notes');
    await controller.activate('notes');
    await controller.hide();
    await controller.setBounds('notes', { x: 1, y: 2, width: 3, height: 4 });
    await controller.detach('notes', { x: 8, y: 9 });
    await controller.close('notes');
    controller.dispose();
    controller.dispose();
    assert.deepEqual(states, [{ action: 'notes', state: 'ready' }]);
    assert.deepEqual(calls.map(call => call[0]), ['create', 'activate', 'activate', 'bounds', 'detach', 'close', 'unsubscribe']);
});

test('closeAll uses the bulk API and falls back to individual close', async () => {
    const bulkCalls = [];
    const bulk = new EmbeddedAppController({
        getApi: () => ({ desktopCloseAllEmbeddedVchatApps: async () => bulkCalls.push('all') }),
    });
    await bulk.closeAll(['a', 'b']);
    assert.deepEqual(bulkCalls, ['all']);

    const individualCalls = [];
    const fallback = new EmbeddedAppController({
        getApi: () => ({ desktopCloseEmbeddedVchatApp: async action => individualCalls.push(action) }),
    });
    await fallback.closeAll(['a', 'b']);
    assert.deepEqual(individualCalls, ['a', 'b']);
});
