import test from 'node:test';
import assert from 'node:assert/strict';
import { createVcpStreamBridge } from '../modules/chat/vcpStreamBridge.js';

const waitUntil = async predicate => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.fail('stream bridge did not reach its real terminal promise');
};

test('VCP bridge drives one consumer from thinking through persisted terminal', async () => {
    const seen = [];
    const bridge = createVcpStreamBridge({
        createConsumer: () => ({
            normalizeChunk: chunk => chunk.choices[0].delta.content,
            prepare: event => seen.push(`prepare:${event.type}`),
            consume: event => seen.push(`event:${event.type}`),
            persist: value => { seen.push(`persist:${value.terminal.kind}`); return { content: value.snapshot.text }; },
        }),
    });
    assert.equal(bridge.accept({ type: 'agent_thinking', messageId: 'm1', context: { agentId: 'a', topicId: 't' } }), true);
    bridge.accept({ type: 'start', messageId: 'm1', context: { agentId: 'a', topicId: 't' } });
    bridge.accept({ type: 'data', messageId: 'm1', context: { agentId: 'a', topicId: 't' }, chunk: { choices: [{ delta: { content: 'hello' } }] } });
    bridge.accept({ type: 'end', messageId: 'm1', context: { agentId: 'a', topicId: 't' }, finish_reason: 'stop' });
    await waitUntil(() => seen.includes('event:completed'));
    assert.deepEqual(seen, [
        'event:started', 'prepare:agent_thinking', 'prepare:start', 'prepare:data',
        'event:chunk', 'prepare:end', 'persist:completed', 'event:completed',
    ]);
    await bridge.dispose();
});

test('VCP bridge ignores unrelated events and normalizes error once', async () => {
    const terminals = [];
    const bridge = createVcpStreamBridge({
        createConsumer: () => ({
            prepare() {},
            consume: event => {
                if (['completed', 'failed', 'cancelled', 'discarded'].includes(event.type)) terminals.push(event);
            },
            persist() {},
        }),
    });
    assert.equal(bridge.accept({ type: 'remove_message', messageId: 'm2' }), false);
    bridge.accept({ type: 'data', messageId: 'm2', context: { groupId: 'g', topicId: 't' }, chunk: 'partial' });
    bridge.accept({ type: 'error', messageId: 'm2', context: { groupId: 'g', topicId: 't' }, error: 'offline' });
    await waitUntil(() => terminals.length === 1);
    assert.equal(terminals[0].type, 'failed');
    assert.equal(terminals[0].outcome.transport.kind, 'failed');
    await bridge.dispose();
});
