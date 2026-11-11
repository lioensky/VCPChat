'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createToolLoopHandoff } = require('../modules/services/toolLoopHandoff');

test('real chat bootstrap injects admission queue and queued messages generate ready', async () => {
    const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
    const start = source.indexOf('chatHandlers.initialize(mainWindow, {');
    assert.ok(start >= 0);
    const end = source.indexOf('\n        });', start);
    assert.ok(end > start);
    let listener;
    const service = {
        subscribe(fn) { listener = fn; fn([]); return () => {}; },
    };
    const calls = [];
    const handoffs = createToolLoopHandoff({
        sendControl: async payload => { calls.push(payload); return { success: true }; },
    });
    const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
    let context;
    vm.runInNewContext(source.slice(start, end + '\n        });'.length), {
        mainWindow: {},
        chatHandlers: { initialize(_window, value) { context = value; } },
        AGENT_DIR: '', USER_DATA_DIR: '', APP_DATA_ROOT_IN_PROJECT: '', NOTES_AGENT_ID: '',
        assistantHandlers: {}, musicHandlers: {}, fileWatcher: {},
        agentConfigManager: {}, appSettingsManager: {}, historyMutationQueue: {},
        topicAdmissionHost: { service },
    });
    assert.equal(context.topicAdmission, service, 'single-chat bootstrap must inject central admission');
    // Match the subscription used by chatHandlers.initialize.
    context.topicAdmission.subscribe(entries => handoffs.updateEntries(entries));
    const handle = handoffs.register({ requestId: 'r', scope });
    listener([{ scope, entryId: 'pending', state: 'queued' }]);
    await handle.idle();
    assert.equal(calls.length, 0, 'capability must still gate control traffic');
    await handle.setSupported(true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'prepare_handoff');
    assert.equal(calls[0].requestId, 'r');
    handle.finish();
    handoffs.dispose();
});