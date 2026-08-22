import test from 'node:test';
import assert from 'node:assert/strict';
import { createVcpStreamBridge } from '../modules/chat/vcpStreamBridge.js';
import { createMainChatStreamConsumer } from '../modules/renderer/mainChatStreamConsumer.js';

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

test('VCP bridge dispose aborts an externally-driven operation and reaches quiescence', async () => {
    const seen = [];
    const bridge = createVcpStreamBridge({
        createConsumer: () => ({
            prepare() {},
            consume: event => seen.push(event.type),
            persist() { throw new Error('discarded operations must not persist'); },
        }),
    });
    bridge.accept({ type: 'data', messageId: 'pending', context: { agentId: 'a', topicId: 't' }, chunk: 'partial' });
    await bridge.dispose();
    assert.deepEqual(seen, ['started'], 'dispose detaches the consumer before queued projection work can publish');
});

test('one operation can be disposed without a producer terminal and rejects every late event', async () => {
    const seen = [];
    let consumerDisposals = 0;
    const bridge = createVcpStreamBridge({
        createConsumer: () => ({
            prepare: event => seen.push(`prepare:${event.type}`),
            consume: event => seen.push(`event:${event.type}`),
            persist() { assert.fail('a retracted operation must not persist'); },
            dispose() { consumerDisposals += 1; },
        }),
    });
    assert.equal(bridge.accept({ type: 'data', messageId: 'owned', context: { agentId: 'a', topicId: 't' }, chunk: 'partial' }), true);
    await waitUntil(() => seen.includes('event:chunk'));
    const outcome = await bridge.disposeOperation('owned');
    assert.equal(outcome.kind, 'discarded');
    assert.equal(consumerDisposals, 1);
    assert.equal(bridge.accept({ type: 'end', messageId: 'owned', context: { agentId: 'a', topicId: 't' } }), false);
    assert.equal(bridge.accept({ type: 'data', messageId: 'owned', context: { agentId: 'a', topicId: 't' }, chunk: 'late' }), false);
    await bridge.dispose();
});

test('retiring before the first producer event prevents operation creation and stream resurrection', async () => {
    let consumersCreated = 0;
    const bridge = createVcpStreamBridge({
        createConsumer: () => {
            consumersCreated += 1;
            return {};
        },
    });
    assert.equal(await bridge.disposeOperation('before-first-event'), false);
    assert.equal(bridge.accept({ type: 'data', messageId: 'before-first-event', context: { agentId: 'a', topicId: 't' }, chunk: 'late' }), false);
    assert.equal(bridge.accept({ type: 'end', messageId: 'before-first-event', context: { agentId: 'a', topicId: 't' } }), false);
    assert.equal(consumersCreated, 0);

    assert.equal(await bridge.cancelOperation('cancel-before-first-event'), null);
    assert.equal(bridge.accept({ type: 'start', messageId: 'cancel-before-first-event', context: { agentId: 'a', topicId: 't' } }), false);
    assert.equal(consumersCreated, 0);
    await bridge.dispose();
});

test('producer operation identity isolates a same-message retry from delayed events', async () => {
    const seen = [];
    const bridge = createVcpStreamBridge({
        createConsumer: event => ({
            prepare() {},
            consume: item => seen.push(`${event.streamOperationId}:${item.type}`),
            persist() {},
        }),
    });
    bridge.accept({ type: 'data', messageId: 'same-message', streamOperationId: 'attempt-1', context: { agentId: 'a', topicId: 't' }, chunk: 'one' });
    bridge.accept({ type: 'end', messageId: 'same-message', streamOperationId: 'attempt-1', context: { agentId: 'a', topicId: 't' } });
    await waitUntil(() => seen.includes('attempt-1:completed'));
    bridge.accept({ type: 'data', messageId: 'same-message', streamOperationId: 'attempt-2', context: { agentId: 'a', topicId: 't' }, chunk: 'two' });
    assert.equal(bridge.accept({ type: 'data', messageId: 'same-message', streamOperationId: 'attempt-1', context: { agentId: 'a', topicId: 't' }, chunk: 'late-old' }), false);
    bridge.accept({ type: 'end', messageId: 'same-message', streamOperationId: 'attempt-2', context: { agentId: 'a', topicId: 't' } });
    await waitUntil(() => seen.includes('attempt-2:completed'));
    assert.equal(seen.some(item => item.includes('late-old')), false);
    await bridge.dispose();
});

test('local cancellation drains accepted chunks and persists one cancelled terminal', async () => {
    const seen = [];
    const bridge = createVcpStreamBridge({
        createConsumer: () => ({
            prepare: event => seen.push(`prepare:${event.type}`),
            consume: event => seen.push(`event:${event.type}`),
            persist: value => { seen.push(`persist:${value.terminal.kind}`); },
        }),
    });
    bridge.accept({ type: 'data', messageId: 'cancel-local', context: { agentId: 'a', topicId: 't' }, chunk: 'partial' });
    const outcome = await bridge.cancelOperation('cancel-local', 'backend-interrupt-failed');
    assert.equal(outcome.kind, 'cancelled');
    assert.deepEqual(seen, [
        'event:started', 'prepare:data', 'event:chunk', 'persist:cancelled', 'event:cancelled',
    ]);
    assert.equal(bridge.accept({ type: 'end', messageId: 'cancel-local', context: { agentId: 'a', topicId: 't' } }), false);
    await bridge.dispose();
});

test('VCP bridge serializes deferred prepare before immediate chunk and terminal', async () => {
    const seen = [];
    let releasePrepare;
    const prepareGate = new Promise(resolve => { releasePrepare = resolve; });
    const bridge = createVcpStreamBridge({
        createConsumer: () => ({
            async prepare(event) {
                seen.push(`prepare-start:${event.type}`);
                if (event.type === 'data') await prepareGate;
                seen.push(`prepare-end:${event.type}`);
            },
            consume: event => seen.push(`event:${event.type}`),
            persist: value => { seen.push(`persist:${value.terminal.kind}`); },
        }),
    });
    bridge.accept({ type: 'data', messageId: 'fast', context: { agentId: 'a', topicId: 't' }, chunk: 'x' });
    bridge.accept({ type: 'end', messageId: 'fast', context: { agentId: 'a', topicId: 't' } });
    await Promise.resolve();
    assert.deepEqual(seen, ['event:started', 'prepare-start:data']);
    releasePrepare();
    await waitUntil(() => seen.includes('event:completed'));
    assert.deepEqual(seen, [
        'event:started', 'prepare-start:data', 'prepare-end:data', 'event:chunk',
        'prepare-start:end', 'prepare-end:end', 'persist:completed', 'event:completed',
    ]);
    await bridge.dispose();
});

test('projection failure silences already queued events and cannot commit a partial terminal', async () => {
    const seen = [];
    // Fail the first projection before queuing an end event synchronously.
    const failingBridge = createVcpStreamBridge({
        reportError: () => {},
        createConsumer: event => createMainChatStreamConsumer(event, {
            start: async () => { throw new Error('controlled projection failure'); },
            append: () => {},
            projectTerminal: async () => { seen.push('unexpected-project-terminal'); return { id: event.messageId }; },
            persistTerminal: async () => { seen.push('unexpected-persist-terminal'); },
        }),
    });
    failingBridge.accept({ type: 'data', messageId: 'projection-failure', context: { agentId: 'a', topicId: 't' }, chunk: 'x' });
    failingBridge.accept({ type: 'end', messageId: 'projection-failure', context: { agentId: 'a', topicId: 't' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(seen.includes('unexpected-project-terminal'), false);
    assert.equal(seen.includes('unexpected-persist-terminal'), false);
    await failingBridge.dispose();
});

test('missing terminal projection becomes one persistence failure instead of a completed no-op', async () => {
    const terminals = [];
    const bridge = createVcpStreamBridge({
        reportError: () => {},
        createConsumer: event => {
            const consumer = createMainChatStreamConsumer(event, {
                start() {},
                append() {},
                async projectTerminal() { return null; },
                async persistTerminal() { assert.fail('a missing projection must not be committed'); },
                renderError() {},
                dispatchTerminal() {},
                getSurfaceGeneration: () => 0,
            });
            return Object.freeze({
                ...consumer,
                consume(streamEvent) {
                    if (['completed', 'failed', 'cancelled', 'discarded'].includes(streamEvent.type)) terminals.push(streamEvent);
                    consumer.consume(streamEvent);
                },
            });
        },
    });
    bridge.accept({ type: 'end', messageId: 'missing', context: { agentId: 'a', topicId: 't' } });
    await waitUntil(() => terminals.length === 1);
    assert.equal(terminals[0].type, 'failed');
    assert.equal(terminals[0].outcome.phase, 'persistence');
    await bridge.dispose();
});

test('post-commit side effect failure is reported without changing the durable completed outcome', async () => {
    const terminals = [];
    const reports = [];
    let committed = false;
    const bridge = createVcpStreamBridge({
        reportError: (...args) => reports.push(args),
        createConsumer: event => {
            const consumer = createMainChatStreamConsumer(event, {
                start() {},
                append() {},
                async projectTerminal() {
                    return { messageId: 'post-commit', context: event.context, history: [], finishReason: 'completed' };
                },
                async persistTerminal(value) { committed = true; return value; },
                async afterPersist() { throw new Error('summary failed'); },
                reportError: (...args) => reports.push(args),
                getSurfaceGeneration: () => 0,
            });
            return Object.freeze({
                ...consumer,
                consume(streamEvent) {
                    if (['completed', 'failed', 'cancelled', 'discarded'].includes(streamEvent.type)) terminals.push(streamEvent);
                    consumer.consume(streamEvent);
                },
            });
        },
    });
    bridge.accept({ type: 'end', messageId: 'post-commit', context: { agentId: 'a', topicId: 't' } });
    await waitUntil(() => terminals.length === 1);
    assert.equal(committed, true);
    assert.equal(terminals[0].type, 'completed');
    assert.equal(terminals[0].outcome.persistence.status, 'saved');
    assert.equal(reports.some(([, error]) => error?.message === 'summary failed'), true);
    await bridge.dispose();
});
