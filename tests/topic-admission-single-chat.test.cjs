'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture(stream = true, options = {}) {
    const { prepareTopicAdmissionSingleChat } = await import('../modules/chat/topicAdmissionSingleChat.js');
    const history = [{ id: 'incoming', role: 'assistant', name: 'Kerr', content: '[Kerr的发言]: hello', timestamp: 100 }];
    const calls = [];
    const api = {
        getAgentConfig: async () => ({ name: 'Nova', model: 'test', streamOutput: stream, systemPrompt: 'You are Nova' }),
        getChatHistory: async () => history,
        tavernGetRules: async () => ({ success: true, store: { rules: [] } }),
        sendToVCP: async (...args) => {
            calls.push(['send', args]);
            return stream ? { streamingStarted: true } : { choices: [{ message: { content: 'reply' } }] };
        },
        topicAdmissionRelease: async (...args) => { calls.push(['release', args]); return { success: true }; },
        ...options.api,
    };
    const request = {
        scope: { itemType: 'agent', itemId: 'nova', topicId: 'topic_nova' },
        token: 'lease-1', messageId: 'incoming', automatic: true, invitePrompt: '[系统提示:] 请回应伙伴',
        ...options.request,
    };
    const operation = await prepareTopicAdmissionSingleChat({
        request, api, settings: { vcpServerUrl: 'https://test.invalid/v1/chat/completions' },
        createRequestTextOptions: options.createRequestTextOptions,
        onCommitted: options.onCommitted,
        onFinalized: options.onFinalized,
        onStarting: options.onStarting,
        persistAssistant: async (...args) => {
            calls.push(['persist', args]);
            if (options.persistError) throw new Error('disk full');
        },
    });
    return { operation, calls, history };
}

test('automatic invitation ends with user, does not mutate history, preserves lease', async () => {
    const { operation, calls, history } = await fixture();
    const before = structuredClone(history);
    await operation.start();
    const args = calls[0][1];
    assert.equal(args[2].at(-1).role, 'user');
    assert.ok(JSON.stringify(args[2].at(-1).content).includes('请回应伙伴'));
    assert.equal(args[6].admissionToken, 'lease-1');
    assert.equal(args[6].agentId, 'nova');
    assert.equal(args[6].topicId, 'topic_nova');
    assert.deepEqual(history, before);
    assert.deepEqual(calls.map(call => call[0]), ['send']);
});

test('non-streaming persists before releasing and uses deterministic message id', async () => {
    const { operation, calls } = await fixture(false);
    await operation.start();
    assert.deepEqual(calls.map(call => call[0]), ['send', 'persist', 'release']);
    assert.equal(calls[1][1][1].id, 'admission_lease-1');
    assert.equal(calls[1][1][1].admissionToken, 'lease-1');
    assert.equal(calls[1][1][1].admissionTerminal, true);
    assert.equal(calls[2][1][1], 'lease-1');
});

test('persistence failure never releases lease', async () => {
    const { operation, calls } = await fixture(false, { persistError: true });
    await assert.rejects(operation.start(), /disk full/);
    assert.deepEqual(calls.map(call => call[0]), ['send', 'persist']);
});

test('stream setup failure is propagated without false release', async () => {
    const { operation, calls } = await fixture(true, {
        api: { sendToVCP: async () => ({ streamError: true, error: 'offline' }) },
    });
    await assert.rejects(operation.start(), /offline/);
    assert.deepEqual(calls, []);
});

test('admission passes shared text transforms through actual request assembly without changing history', async () => {
    let received;
    const { operation, calls, history } = await fixture(true, {
        request: { automatic: false },
        createRequestTextOptions(config, snapshot, currentId) {
            received = { name: config.name, currentId, ids: snapshot.map(message => message.id) };
            return {
                transformMessageText: ({ text }) => text.replace('hello', 'filtered'),
                postProcessMessageContent: async ({ content }) =>
                    content.map(part => part.type === 'text' ? { ...part, text: `${part.text}\nCANVAS_EXPANDED` } : part),
            };
        },
    });
    const before = structuredClone(history);
    await operation.start();
    assert.deepEqual(received, { name: 'Nova', currentId: 'incoming', ids: ['incoming'] });
    const payload = JSON.stringify(calls[0][1][2]);
    assert.ok(payload.includes('filtered'));
    assert.ok(payload.includes('CANVAS_EXPANDED'));
    assert.deepEqual(history, before);
});
for (const mode of ['saved', 'ui-failed', 'finalization-failed', 'save-failed', 'stream']) {
    test(`admission nonstream post-commit finalization: ${mode}`, async () => {
        let calls;
        const f = await fixture(mode === 'stream', {
            persistError: mode === 'save-failed',
            onCommitted: async () => {
                calls.push(['ui']);
                if (mode === 'ui-failed') throw new Error('controlled UI failure');
            },
            onFinalized: async event => {
                calls.push(['finalized', event]);
                if (mode === 'finalization-failed') throw new Error('controlled finalization failure');
            },
        });
        calls = f.calls;
        if (mode === 'save-failed') await assert.rejects(f.operation.start(), /disk full/);
        else await f.operation.start();
        assert.deepEqual(calls.map(call => call[0]), mode === 'stream'
            ? ['send'] : mode === 'save-failed'
                ? ['send', 'persist'] : ['send', 'persist', 'release', 'ui', 'finalized']);
        const event = calls.find(call => call[0] === 'finalized')?.[1];
        if (event) {
            assert.equal(event.messageId, 'admission_lease-1');
            assert.equal(event.context.admissionToken, 'lease-1');
            assert.equal(event.content, 'reply');
        }
    });
}
for (const streaming of [true, false]) {
    test(`existing thinking projection starts before transport: streaming=${streaming}`, async () => {
        let projected = false;
        const { operation } = await fixture(streaming, {
            onStarting: async value => {
                assert.equal(value.streaming, streaming);
                assert.equal(value.message.id, 'admission_lease-1');
                assert.equal(value.message.isThinking, true);
                assert.equal(value.message.context.admissionToken, 'lease-1');
                projected = true;
            },
            api: {
                sendToVCP: async () => {
                    assert.equal(projected, true, 'no transport before thinking projection');
                    return streaming ? { streamingStarted: true } : { choices: [{ message: { content: 'reply' } }] };
                },
            },
        });
        await operation.start();
    });
}