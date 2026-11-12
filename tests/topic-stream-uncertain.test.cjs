'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../modules/renderer/mainChatSurfaceAdapter.js'), 'utf8');
const begin = source.indexOf('function createStreamCapabilities(');
const end = source.indexOf('/** Main-window composition owner.', begin);
assert.ok(begin >= 0 && end > begin);
const createCapabilities = vm.runInNewContext(
    `${source.slice(begin, end)}; createStreamCapabilities`,
    { console, isSideChatChildTopicId: () => false },
);

for (const mode of ['saved', 'failed', 'journal-rejected', 'journal-threw', 'no-token']) {
    test(`stream terminal uncertainty uses actual adapter capability: ${mode}`, async () => {
        const failure = new Error('controlled terminal save failure');
        const calls = [];
        const reports = [];
        const result = { persisted: true };
        const api = {
            async topicAdmissionUncertain(scope, token, error) {
                calls.push({ scope, token, error });
                if (mode === 'journal-threw') throw new Error('journal offline');
                return mode === 'journal-rejected'
                    ? { success: false, code: 'STALE_LEASE' }
                    : { success: true, retained: true };
            },
            async topicAdmissionRelease() { assert.fail('failed persistence must not release ownership'); },
        };
        const root = { ownerDocument: { defaultView: { chatAPI: api } } };
        const capabilities = createCapabilities(root, {
            streamProjection: {},
            historyPersistence: {
                async commit() {
                    if (mode !== 'saved') throw failure;
                    return result;
                },
            },
            messageRenderer: {},
            getSelection() {},
            getTopicId() {},
            reportError(...args) { reports.push(args); },
        });
        const projected = { context: {
            agentId: 'a', topicId: 't',
            ...(mode === 'no-token' ? {} : { admissionToken: 'lease' }),
        } };
        if (mode === 'saved') {
            assert.equal(await capabilities.persistTerminal(projected), result);
        } else {
            await assert.rejects(capabilities.persistTerminal(projected), error => error === failure);
        }
        assert.equal(calls.length, ['saved', 'no-token'].includes(mode) ? 0 : 1);
        if (calls.length) {
            assert.equal(calls[0].scope.itemId, 'a');
            assert.equal(calls[0].scope.topicId, 't');
            assert.equal(calls[0].token, 'lease');
            assert.equal(calls[0].error, failure.message);
        }
        assert.equal(reports.length, mode.startsWith('journal-') ? 1 : 0);
    });
}
for (const fails of [false, true]) {
    test(`adapter delegates saved relay without ordinary release or duplicate continuation; fails=${fails}`, async () => {
        const calls = [];
        const context = { agentId: 'a', topicId: 't', admissionToken: 'old' };
        const capabilities = createCapabilities({
            ownerDocument: { defaultView: { chatAPI: {
                topicAdmissionRelease: async () => assert.fail('relay must retain ownership until central handover'),
            } } },
        }, {
            streamProjection: {}, historyPersistence: {}, messageRenderer: {},
            getSelection: () => ({ id: 'a' }), getTopicId: () => 't',
            flowlockManager: { handleFinalizedMessage: () => assert.fail('old stream must not restart heartbeat') },
            chatManager: {
                hasStreamAdmissionRelay: id => id === 'live',
                async finishStreamAdmissionRelay(value) {
                    calls.push(value.messageId);
                    assert.equal(value.context, context);
                    if (fails) throw new Error('relay failed');
                },
                finishStreamContextCompaction: () => assert.fail('must not run second compression continuation'),
                attemptTopicSummarizationIfNeeded: () => assert.fail('relay owns post-commit sequencing'),
            },
        });
        const operation = capabilities.afterPersist({
            terminal: { kind: 'cancelled', fullResponse: 'tools returned' },
            finalized: { context, content: 'tools returned' }, context, messageId: 'live',
        });
        if (fails) await assert.rejects(operation, /relay failed/);
        else await operation;
        assert.deepEqual(calls, ['live']);
    });
}
for (const phase of ['transport', 'projection', 'persistence']) {
    test(`actual stream adapter clears real admission after ${phase} failure and permits retry`, async () => {
        const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
        const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
        const service = new TopicMessageAdmission({
            store: { load: async () => [], save: async () => {} },
            validate: async () => {},
            commit: async () => assert.fail('failed round must not deliver staging'),
            logger: { warn() {} },
        });
        await service.initialize();
        try {
            await service.acquire(scope, 'old');
            await service.submit({ scope, message: { id: 'queued', role: 'user' }, triggerPolicy: 'reply' });
            const context = { agentId: 'a', topicId: 't', admissionToken: 'old' };
            let releases = 0;
            let relays = 0;
            const capabilities = createCapabilities({
                ownerDocument: { defaultView: { chatAPI: {
                    topicAdmissionUncertain: (...args) => service.reportUncertain(...args),
                    topicAdmissionRelease: async () => { releases++; return { success: true }; },
                } } },
            }, {
                streamProjection: {}, messageRenderer: {},
                historyPersistence: { commit: async () => { throw new Error('disk failed'); } },
                getSelection: () => null, getTopicId: () => 't',
                chatManager: {
                    hasStreamAdmissionRelay: () => true,
                    finishStreamAdmissionRelay: async () => { relays++; },
                },
            });
            if (phase === 'transport') {
                await capabilities.afterPersist({
                    terminal: { kind: 'failed', error: new Error('terminated') },
                    finalized: { context, content: 'partial' }, context, messageId: 'm',
                });
            } else if (phase === 'persistence') {
                await assert.rejects(capabilities.persistTerminal({ context }), /disk failed/);
            }
            await capabilities.onSettled({ event: { type: 'failed' }, context, messageId: 'm' });
            assert.deepEqual(service.snapshot(scope), []);
            assert.equal(service.leases.size, 0);
            assert.equal(releases, 0);
            assert.equal(relays, 0);
            assert.equal((await service.acquire(scope, 'new')).success, true);
            // A delayed settled callback must not revoke the retry.
            await capabilities.onSettled({ event: { type: 'failed' }, context, messageId: 'm' });
            assert.equal(service.leases.get(require('../modules/services/historyMutationQueue').conversationKey(scope)), 'new');
        } finally { await service.dispose(); }
    });
}