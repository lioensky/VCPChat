const test = require('node:test');
const assert = require('node:assert/strict');
const createWindowStateService = require('../modules/services/windowStateService.js');
const { StateChannel } = require('../modules/ui-system/state-channel.js');

function harness() {
    const callbacks = {};
    const calls = [];
    const api = {
        onWindowMaximized: callback => { callbacks.maximized = callback; return () => { callbacks.maximized = null; }; },
        onWindowUnmaximized: callback => { callbacks.unmaximized = callback; return () => { callbacks.unmaximized = null; }; },
        minimizeWindow: () => calls.push('minimize'),
        minimizeToTray: () => calls.push('tray'),
        maximizeWindow: () => calls.push('maximize'),
        unmaximizeWindow: () => calls.push('unmaximize'),
        closeWindow: () => calls.push('close'),
    };
    let channel;
    const channels = { create: (name, value) => (channel = new StateChannel(name, value)) };
    return { service: createWindowStateService({ api, channels }), callbacks, calls, get channel() { return channel; } };
}

test('window state is authoritative, monotonic and presentation independent', () => {
    const h = harness();
    const seen = [];
    const unsubscribe = h.service.subscribe((state, snapshot) => seen.push([state.ready, state.maximized, snapshot.revision]));
    h.service.toggleMaximize();
    assert.deepEqual(h.calls, ['maximize']);
    h.callbacks.maximized();
    h.callbacks.maximized();
    assert.deepEqual(seen, [[false, false, 0], [true, true, 1]]);
    h.service.toggleMaximize();
    assert.deepEqual(h.calls, ['maximize', 'unmaximize']);
    h.callbacks.unmaximized();
    assert.equal(h.service.getSnapshot().revision, 2);
    unsubscribe();
    assert.equal(h.service.dispose(), true);
    assert.equal(h.service.dispose(), false);
    assert.equal(h.callbacks.maximized, null);
});
