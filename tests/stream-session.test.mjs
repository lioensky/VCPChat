import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createStreamSession,
    createStreamStateReducer,
    normalizeStreamTerminal,
} from '../modules/chat/streamSession.js';

test('stream session emits ordered immutable chunks and one terminal outcome', () => {
    const session = createStreamSession({ sessionId: 's1', conversationKey: 'agent:a/topic:t', generation: 2 });
    const events = [];
    session.subscribe(event => events.push(event));
    assert.equal(session.pushChunk('a'), true);
    assert.equal(session.pushChunk({ text: 'b' }), true);
    assert.equal(session.terminal('completed', { messageId: 'm1' }), true);
    assert.equal(session.terminal('failed', { error: 'late' }), false);
    assert.deepEqual(events.map(event => event.type), ['chunk', 'chunk', 'completed']);
    assert.equal(session.snapshot.text, 'ab');
    assert.equal(Object.isFrozen(session.snapshot), true);
});

test('stale generation and late chunks cannot regain authority', () => {
    const session = createStreamSession({ sessionId: 's2', conversationKey: 'agent:a/topic:t', generation: 7 });
    assert.equal(session.pushChunk('stale', 6), false);
    assert.equal(session.terminal('cancelled', { source: 'user' }), true);
    assert.equal(session.pushChunk('late'), false);
    assert.equal(session.terminal('completed'), false);
});

test('dispose publishes one discarded terminal, then silences consumers and is idempotent', async () => {
    const session = createStreamSession({ sessionId: 's3', conversationKey: 'agent:a/topic:t' });
    const events = [];
    session.subscribe(event => events.push(event));
    const first = session.dispose('surface-closed');
    const second = session.dispose('ignored-late-reason');
    assert.equal(session.pushChunk('late'), false);
    assert.equal(session.terminal('discarded'), false);
    assert.deepEqual(events.map(event => event.type), ['discarded']);
    assert.deepEqual(await first, { kind: 'discarded', reason: 'surface-closed' });
    assert.deepEqual(await second, { kind: 'discarded', reason: 'surface-closed' });
});

test('subscriber failure does not block later stream consumers', () => {
    const session = createStreamSession({ sessionId: 's4', conversationKey: 'agent:a/topic:t' });
    const seen = [];
    session.subscribe(() => { throw new Error('controlled consumer failure'); });
    session.subscribe(event => seen.push(event.type));
    session.pushChunk('x');
    assert.deepEqual(seen, ['chunk']);
});

test('done resolves once from the accepted terminal even when a consumer throws', async () => {
    const session = createStreamSession({ sessionId: 's6', conversationKey: 'agent:a/topic:t' });
    let resolveCount = 0;
    session.done.then(() => { resolveCount += 1; });
    session.subscribe(event => {
        if (event.type === 'completed') throw new Error('controlled terminal consumer failure');
    });
    assert.equal(session.terminal('completed', { messageId: 'm6' }), true);
    assert.equal(session.terminal('failed', { error: 'late' }), false);
    assert.deepEqual(await session.done, { kind: 'completed', messageId: 'm6' });
    await Promise.resolve();
    assert.equal(resolveCount, 1);
});

test('normalizes transport terminal aliases into the four protocol outcomes', () => {
    const cases = new Map([
        ['end', 'completed'], ['done', 'completed'], ['success', 'completed'], ['stop', 'completed'],
        ['abort', 'cancelled'], ['cancel', 'cancelled'],
        ['disconnect', 'failed'], ['reader-error', 'failed'], ['error', 'failed'],
        ['stale', 'discarded'], ['discard', 'discarded'],
    ]);
    for (const [input, expected] of cases) {
        assert.equal(normalizeStreamTerminal(input).kind, expected, input);
    }
    assert.deepEqual(
        normalizeStreamTerminal({ type: 'unknown', detail: 'kept' }, { kind: 'cancelled', source: 'fallback' }),
        { kind: 'cancelled', source: 'fallback', type: 'unknown', detail: 'kept' },
    );
});

test('reducer mirrors events and ignores a late event after terminal', () => {
    const reduce = createStreamStateReducer();
    const initial = Object.freeze({ sessionId: 's5', status: 'started', text: '', chunkCount: 0, terminal: null });
    const next = reduce(initial, { sessionId: 's5', type: 'chunk', text: 'hello' });
    const done = reduce(next, { sessionId: 's5', type: 'completed', terminal: { kind: 'completed' } });
    assert.equal(done.text, 'hello');
    assert.equal(done.chunkCount, 1);
    assert.equal(done.status, 'completed');
    assert.equal(reduce(done, { sessionId: 's5', type: 'chunk', text: 'late' }), done);
});
