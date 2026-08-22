import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamCoordinator } from '../modules/chat/streamCoordinator.js';

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const request = (id, conversationKey = 'agent:a/topic:t') => ({ sessionId: id, messageId: id, conversationKey });
const waitUntil = async predicate => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.fail('condition did not settle through the operation promise chain');
};

test('done waits for transport, persistence and owned cleanup before one terminal event', async () => {
    const save = deferred();
    const cleanup = deferred();
    const events = [];
    const coordinator = createStreamCoordinator({
        run: async (_request, stream) => {
            stream.own(() => cleanup.promise);
            stream.pushChunk('a');
            stream.final({ render: 'ready' });
            return 'completed';
        },
        persist: () => save.promise,
    });
    const handle = coordinator.start(request('s1'), { onEvent: event => events.push(event) });
    let settled = false;
    handle.done.then(() => { settled = true; });
    await Promise.resolve();
    assert.deepEqual(events.map(event => event.type), ['started', 'chunk', 'final']);
    save.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
    cleanup.resolve();
    const outcome = await handle.done;
    assert.equal(outcome.kind, 'completed');
    assert.equal(outcome.persistence.status, 'saved');
    assert.deepEqual(events.map(event => event.type), ['started', 'chunk', 'final', 'completed']);
});

test('reader failures and disconnects normalize to one failed terminal', async () => {
    for (const mode of ['throw', 'disconnect']) {
        const events = [];
        const coordinator = createStreamCoordinator({
            run: async (_request, stream) => {
                if (mode === 'throw') throw new Error('reader broke');
                stream.terminal('disconnect', { source: 'socket' });
                return 'completed';
            },
        });
        const outcome = await coordinator.start(request(`s-${mode}`), { onEvent: event => events.push(event) }).done;
        assert.equal(outcome.kind, 'failed');
        assert.equal(events.filter(event => ['completed', 'failed', 'cancelled', 'discarded'].includes(event.type)).length, 1);
    }
});

test('cancel aborts transport and rejects duplicate terminal ownership', async () => {
    const running = deferred();
    let signal;
    const events = [];
    const coordinator = createStreamCoordinator({
        run: async (_request, stream) => {
            signal = stream.signal;
            await running.promise;
            stream.terminal('completed');
        },
    });
    const handle = coordinator.start(request('cancel'), { onEvent: event => events.push(event) });
    const done = handle.cancel('user-stop');
    assert.equal(signal.aborted, true);
    running.resolve();
    const outcome = await done;
    assert.equal(outcome.kind, 'cancelled');
    assert.deepEqual(events.map(event => event.type), ['started', 'cancelled']);
});

test('dispose detaches consumer before abort and waits for the blocked reader', async () => {
    const running = deferred();
    const events = [];
    let abortSeen = false;
    const coordinator = createStreamCoordinator({
        run: async (_request, stream) => {
            stream.signal.addEventListener('abort', () => { abortSeen = true; });
            await running.promise;
            stream.pushChunk('late');
        },
    });
    const handle = coordinator.start(request('dispose'), { onEvent: event => events.push(event) });
    const first = handle.dispose();
    const second = handle.dispose();
    assert.equal(first, second);
    assert.equal(abortSeen, true);
    let settled = false;
    first.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    running.resolve();
    assert.equal((await first).kind, 'discarded');
    assert.deepEqual(events.map(event => event.type), ['started']);
});

test('external abort becomes cancelled and remains visible to the live surface', async () => {
    const running = deferred();
    const external = new AbortController();
    const events = [];
    const coordinator = createStreamCoordinator({ run: async () => running.promise });
    const handle = coordinator.start(request('external'), { signal: external.signal, onEvent: event => events.push(event) });
    external.abort();
    running.resolve();
    assert.equal((await handle.done).kind, 'cancelled');
    assert.deepEqual(events.map(event => event.type), ['started', 'cancelled']);
});

test('persistence failure produces a single failed outcome after completed transport', async () => {
    const events = [];
    const coordinator = createStreamCoordinator({
        run: async (_request, stream) => { stream.pushChunk('answer'); return 'completed'; },
        persist: async () => { throw new Error('disk full'); },
        reportError: () => {},
    });
    const outcome = await coordinator.start(request('persist-fail'), { onEvent: event => events.push(event) }).done;
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.phase, 'persistence');
    assert.equal(outcome.transport.kind, 'completed');
    assert.equal(outcome.persistence.status, 'failed');
    assert.equal(events.filter(event => ['completed', 'failed', 'cancelled', 'discarded'].includes(event.type)).length, 1);
});

test('same message retry revokes the old lease but distinct messages in one topic coexist', async () => {
    const runs = new Map();
    const saved = [];
    const coordinator = createStreamCoordinator({
        run: async current => {
            const gate = deferred();
            runs.set(current.sessionId + ':' + current.attempt, gate);
            return gate.promise;
        },
        persist: async value => { saved.push(value.request.sessionId + ':' + value.request.attempt); },
    });
    const old = coordinator.start({ ...request('same'), attempt: 1 });
    await Promise.resolve();
    const replacement = coordinator.start({ ...request('same'), attempt: 2 });
    const other = coordinator.start({ ...request('other'), attempt: 1 });
    await Promise.resolve();
    runs.get('same:1').resolve('completed');
    runs.get('other:1').resolve('completed');
    runs.get('same:2').resolve('completed');
    assert.equal((await old.done).kind, 'discarded');
    await Promise.all([replacement.done, other.done]);
    assert.deepEqual(saved.sort(), ['other:1', 'same:2']);
});

test('persistence serializes per conversation but not across conversations', async () => {
    const gates = new Map();
    const entered = [];
    const coordinator = createStreamCoordinator({
        run: async () => 'completed',
        persist: async value => {
            entered.push(value.request.sessionId);
            const gate = deferred();
            gates.set(value.request.sessionId, gate);
            await gate.promise;
        },
    });
    const first = coordinator.start(request('first', 'topic:one'));
    const second = coordinator.start(request('second', 'topic:one'));
    const independent = coordinator.start(request('third', 'topic:two'));
    await waitUntil(() => entered.length === 2);
    assert.deepEqual(entered.sort(), ['first', 'third']);
    gates.get('third').resolve();
    gates.get('first').resolve();
    await waitUntil(() => entered.includes('second'));
    assert.equal(entered.includes('second'), true);
    gates.get('second').resolve();
    await Promise.all([first.done, second.done, independent.done]);
});

test('consumer failure does not block persistence, terminal completion or later work', async () => {
    let persisted = false;
    const coordinator = createStreamCoordinator({
        run: async (_request, stream) => { stream.pushChunk('x'); return 'completed'; },
        persist: async () => { persisted = true; },
        reportError: () => {},
    });
    const outcome = await coordinator.start(request('consumer'), { onEvent: () => { throw new Error('bad consumer'); } }).done;
    assert.equal(outcome.kind, 'completed');
    assert.equal(persisted, true);
});

test('coordinator dispose aborts every active run and waits for quiescence', async () => {
    const gates = [deferred(), deferred()];
    let index = 0;
    const signals = [];
    const coordinator = createStreamCoordinator({
        run: async (_request, stream) => {
            signals.push(stream.signal);
            await gates[index++].promise;
        },
    });
    coordinator.start(request('a'));
    coordinator.start(request('b'));
    const disposing = coordinator.dispose();
    assert.equal(signals.every(signal => signal.aborted), true);
    let settled = false;
    disposing.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    gates.forEach(gate => gate.resolve());
    await disposing;
    assert.throws(() => coordinator.start(request('late')), /disposed/);
});
