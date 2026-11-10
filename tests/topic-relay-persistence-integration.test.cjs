'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
const { createTopicMessageAdmissionHost } = require('../modules/services/topicMessageAdmissionHost');

for (const fails of [false, true]) {
    test(`consumer → persistence → host disk → relay ordering; save fails=${fails}`, async t => {
        const { createMainChatStreamConsumer } = await import('../modules/renderer/mainChatStreamConsumer.js');
        const { createChatHistoryPersistence } = await import('../modules/chat/chatHistoryPersistence.js');
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-relay-chain-'));
        const queue = new HistoryMutationQueue({ userDataDir: path.join(root, 'UserData') });
        const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
        const context = { agentId: 'a', topicId: 't', admissionToken: 'old' };
        const file = queue.getHistoryPath('a', 't');
        await fs.outputJson(file, [{ id: 'question', role: 'user', content: 'work' }]);
        const handlers = new Map(), events = [];
        const contents = { id: 1, isDestroyed: () => false,
            send: (channel, payload) => events.push({ channel, payload }) };
        const host = await createTopicMessageAdmissionHost({
            appDataRoot: root, historyQueue: queue,
            validate: async () => { assert.ok(await fs.pathExists(file)); },
            getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }),
            ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler() {} },
        });
        t.after(async () => { await host.dispose(); await queue.dispose(); await fs.remove(root); });
        const invoke = (name, ...args) => handlers.get(`topic-admission:${name}`)({ sender: contents }, ...args);
        await invoke('acquire', scope, 'old');
        await invoke('submit', { scope,
            message: { id: 'letter', role: 'assistant', content: 'new information' },
            triggerPolicy: 'none',
        });
        let unlock, entered;
        const gate = new Promise(resolve => { unlock = resolve; });
        const started = new Promise(resolve => { entered = resolve; });
        const provider = createChatHistoryPersistence({
            getHistory: () => assert.fail('atomic terminal must not read a renderer snapshot'),
            saveHistory: () => assert.fail('atomic terminal must not replace a renderer snapshot'),
            persistAssistant: async (target, message) => {
                entered();
                await gate;
                if (fails) return { success: false, error: 'controlled disk failure' };
                return invoke('persist-assistant', target, message);
            },
        });
        const consumer = createMainChatStreamConsumer({ messageId: 'old-reply', context }, {
            start() {}, append() {},
            projectTerminal: async () => ({
                messageId: 'old-reply', context, content: 'tools returned', finishReason: 'cancelled',
                history: [{ id: 'old-reply', role: 'assistant', content: 'tools returned',
                    admissionToken: 'old', isThinking: false }],
            }),
            persistTerminal: projected => provider.commit(projected),
            afterPersist: async () => {
                assert.deepEqual((await queue.read(scope)).map(message => message.id), ['question', 'old-reply']);
                assert.equal((await invoke('relay', scope, 'old', { saved: true })).success, true);
            },
        });
        await consumer.prepare({ type: 'start', context });
        const saving = consumer.persist({ terminal: { kind: 'cancelled', context, fullResponse: 'tools returned' } });
        await started;
        assert.deepEqual((await queue.read(scope)).map(message => message.id), ['question']);
        assert.equal(events.some(event => event.channel === 'topic-admission:advance'), false);
        assert.equal((await invoke('acquire', scope, 'intruder')).code, 'TOPIC_BUSY');
        unlock();
        if (fails) {
            await assert.rejects(saving, /controlled disk failure/);
            assert.deepEqual((await queue.read(scope)).map(message => message.id), ['question']);
            assert.equal(events.some(event => event.channel === 'topic-admission:advance'), false);
            assert.equal((await invoke('acquire', scope, 'intruder')).code, 'TOPIC_BUSY');
        } else {
            await saving;
            const deadline = Date.now() + 3000;
            while (!events.some(event => event.channel === 'topic-admission:advance')) {
                assert.ok(Date.now() < deadline, 'saved relay must dispatch');
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            const advances = events.filter(event => event.channel === 'topic-admission:advance');
            assert.equal(advances.length, 1);
            assert.equal(advances[0].payload.relayFrom, 'old');
            assert.equal(advances[0].payload.continuation, true);
            assert.equal((await invoke('ack', advances[0].payload.token)).success, true);
            const disk = await queue.read(scope);
            assert.deepEqual(disk.map(message => message.id), ['question', 'old-reply', 'letter']);
            assert.equal(disk[1].admissionTerminal, true);
            await invoke('release', scope, advances[0].payload.token, { saved: true });
        }
        consumer.dispose();
    });
}