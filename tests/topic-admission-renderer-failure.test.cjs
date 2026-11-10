'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '../renderer.js'), 'utf8');
const begin = renderer.indexOf('    const stopAdmissionAdvance = chatAPI.onTopicAdmissionAdvance(');
const end = renderer.indexOf('    const stopAdmissionSelection =', begin);
assert.ok(begin >= 0 && end > begin, 'production admission callback must exist');
const source = renderer.slice(begin, end);

for (const phase of ['prepare', 'start', 'stale-ack', 'success']) {
    test(`production renderer admission failure ownership: ${phase}`, async () => {
        const calls = [];
        const lifecycle = [];
        let handler;
        let finish;
        const settled = new Promise(resolve => { finish = resolve; });
        const request = { scope: { itemType: 'agent', itemId: 'a', topicId: 't' }, token: 'lease' };
        const chatAPI = {
            onTopicAdmissionAdvance(callback) { handler = callback; return () => {}; },
            async topicAdmissionAck(token, error) {
                calls.push(['ack', token, error]);
                if (error || phase === 'stale-ack') finish();
                return { success: phase !== 'stale-ack' };
            },
            async topicAdmissionUncertain(...args) { calls.push(['uncertain', ...args]); finish(); },
            async topicAdmissionFail() { assert.fail('post-ACK errors must never release via fail'); },
        };
        vm.runInNewContext(source, {
            chatAPI,
            window: { flowlockManager: { adoptRelayMessage() { lifecycle.push('adopt'); } } },
            mainChatSettingsOwner: { get: () => ({}) },
            chatManager: { createRequestTextOptions() {} },
            chatRepository: {},
            syncAdmissionHistory() {},
            console: { error() {} },
            async prepareTopicAdmissionSingleChat() {
                if (phase === 'prepare') throw new Error('prepare failed');
                return { messageId: 'new-message', async start() {
                    lifecycle.push('start');
                    if (phase === 'start') throw new Error('terminal save failed');
                    finish();
                } };
            },
        });
        handler(request);
        await Promise.race([
            settled,
            new Promise((_, reject) => {
                const timer = setTimeout(() => reject(new Error('callback did not settle')), 1000);
                settled.finally(() => clearTimeout(timer));
            }),
        ]);
        assert.deepEqual(lifecycle, ['start', 'success'].includes(phase) ? ['adopt', 'start'] : []);
        if (phase === 'prepare') {
            assert.deepEqual(calls, [['ack', 'lease', 'prepare failed']]);
        } else if (phase === 'start') {
            assert.deepEqual(calls, [
                ['ack', 'lease', undefined],
                ['uncertain', request.scope, 'lease', 'terminal save failed'],
            ]);
        } else {
            assert.deepEqual(calls, [['ack', 'lease', undefined]]);
        }
    });
}
for (const streaming of [true, false]) {
    test(`production renderer restores thinking before send and clears nonstream placeholder: ${streaming}`, async () => {
        const calls = [];
        let handler;
        let history = [{ id: 'user', role: 'user', content: 'hello' }];
        const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
        const message = { id: 'admission_lease', role: 'assistant', isThinking: true, context: { agentId: 'a', topicId: 't' } };
        let done;
        const settled = new Promise(resolve => { done = resolve; });
        vm.runInNewContext(source, {
            chatAPI: {
                onTopicAdmissionAdvance(callback) { handler = callback; },
                topicAdmissionAck: async () => ({ success: true }),
                topicAdmissionUncertain: async () => { assert.fail('healthy start must not report uncertain'); },
            },
            currentSelectedItemRef: { get: () => ({ id: 'a', type: 'agent' }) },
            currentTopicIdRef: { get: () => 't' },
            currentChatHistoryRef: { get: () => history, set: value => { history = value; } },
            mainChatAdapter: {
                async startStream(value) {
                    calls.push('stream-thinking');
                    assert.equal(value.id, message.id);
                    assert.equal(value.isThinking, true);
                    assert.equal(value.streamOperationId, message.id);
                },
            },
            messageRenderer: {
                async renderMessage(value) { calls.push('thinking'); assert.equal(value.isThinking, true); },
                async removeMessageById(id) { calls.push('remove'); assert.equal(id, message.id); },
            },
            mainChatSendOwner: { update() { calls.push('update'); } },
            window: {}, mainChatSettingsOwner: { get: () => ({}) }, chatManager: {},
            chatRepository: {}, console,
            syncAdmissionHistory: async () => { calls.push('sync'); },
            async prepareTopicAdmissionSingleChat(options) {
                return { messageId: message.id, async start() {
                    try {
                        await options.onStarting({ scope, streaming, message });
                        calls.push('send');
                        if (!streaming) {
                            assert.equal(history.at(-1), message);
                            await options.onCommitted(scope);
                        }
                    } finally { done(); }
                } };
            },
        });
        handler({ scope, token: 'lease' });
        await settled;
        assert.deepEqual(calls, streaming
            ? ['sync', 'stream-thinking', 'update', 'send']
            : ['sync', 'thinking', 'update', 'send', 'remove', 'sync']);
    });
}