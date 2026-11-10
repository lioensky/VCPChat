'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = path.resolve(__dirname, '../modules/ipc/groupChatHandlers.js');
const realRequire = createRequire(filename);

test('actual group IPC module injects admission and schedules committed generation without awaiting it', async () => {
    const handlers = new Map();
    const events = [];
    let runtime;
    let call;
    let finish;
    const groupChat = {
        initializeRuntimeServices: value => { runtime = value; },
        getAgentGroupConfig: async () => ({ topics: [{ id: 't1' }] }),
        handleGroupChatMessage: (...args) => {
            call = args;
            args[3]({ type: 'fixture' });
            return new Promise(resolve => { finish = resolve; });
        },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, console,
        require: name => {
            if (name === 'electron') return { ipcMain: { handle: (key, value) => handlers.set(key, value) } };
            if (name === '../../Groupmodules/groupchat') return groupChat;
            if (name === '../modelTrajectory') return {};
            return realRequire(name);
        },
    }, { filename });
    const api = module.exports;
    assert.throws(() => api.advanceTopicAdmission({}), /尚未初始化/);
    const submissions = [];
    const admission = {
        marker: 'central authority',
        submit: async value => { submissions.push(value); return { success: true, queued: true }; },
    };
    const webContents = { isDestroyed: () => false, send: (...args) => events.push(args) };
    api.initialize({ webContents }, {
        AGENT_DIR: path.join(__dirname, 'fixtures-unused'),
        USER_DATA_DIR: path.join(__dirname, 'fixtures-unused'),
        historyMutationQueue: { read: async () => [{ id: 'm1', role: 'user', content: 'hello' }] },
        topicAdmission: admission,
    });
    assert.equal(runtime.topicAdmission, admission);
    assert.equal(typeof runtime.getAgentConfigById, 'function');
    const accepted = await api.advanceTopicAdmission({
        scope: { itemType: 'group', itemId: 'g1', topicId: 't1' },
        token: 'lease1', messageId: 'm1',
    });
    assert.equal(accepted.accepted, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(call.slice(0, 2), ['g1', 't1']);
    assert.equal(call[5].admissionToken, 'lease1');
    assert.equal(call[5].committedMessageId, 'm1');
    assert.equal(call[4], runtime.getAgentConfigById);
    assert.equal(events[0][0], 'vcp-stream-event');
    const send = handlers.get('send-group-chat-message');
    assert.equal((await send({ sender: {} }, 'g1', 't1', {})).code, 'FORBIDDEN');
    const originalCall = call;
    const sent = await send({ sender: webContents }, 'g1', 't1', {
        id: 'human1', role: 'user', name: 'Ryan', content: { text: 'raw + file' },
        originalUserText: 'raw', attachments: [{ name: 'file' }],
    });
    assert.equal(sent.queued, true);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].message.content, 'raw');
    assert.equal(submissions[0].message._metadata.groupRequestText, 'raw + file');
    assert.equal(submissions[0].scope.itemType, 'group');
    assert.equal(submissions[0].requestId, 'human1');
    assert.equal(call, originalCall);
    assert.equal((await send({ sender: webContents }, 'g1', 't1', {
        id: 'fake', role: 'assistant', content: { text: 'x' },
    })).success, false);
    assert.equal(submissions.length, 1);
    finish();
});