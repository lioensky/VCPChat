import test from 'node:test';
import assert from 'node:assert/strict';
import { createTtsSurfaceOwner } from '../modules/renderer/ttsSurfaceOwner.js';

function createHarness() {
    let play;
    let stop;
    let unsubscribed = 0;
    const sources = [];
    const indicators = [];
    let resolveDecode;
    const context = {
        destination: {},
        decodeAudioData: () => new Promise(resolve => { resolveDecode = resolve; }),
        createBufferSource: () => {
            const source = { connect() {}, start() {}, stopCalled: 0, stop() { this.stopCalled += 1; } };
            sources.push(source);
            return source;
        },
        async close() {},
    };
    const owner = createTtsSurfaceOwner({
        subscribePlay: callback => { play = callback; return () => { unsubscribed += 1; }; },
        subscribeStop: callback => { stop = callback; return () => { unsubscribed += 1; }; },
        createAudioContext: () => context,
        decodeBase64: () => new ArrayBuffer(1),
        updateSpeakingIndicator: (id, active) => indicators.push([id, active]),
        showError() {},
    });
    return { owner, emitPlay: value => play(value), emitStop: () => stop(), resolveDecode: value => resolveDecode(value), sources, indicators, get unsubscribed() { return unsubscribed; } };
}

test('TTS owner rejects late sessions and stops the prior source on replacement', async () => {
    const harness = createHarness();
    harness.owner.mount();
    assert.equal(harness.owner.ensureAudioContext(), true);
    harness.emitPlay({ audioData: 'a', msgId: 'm1', sessionId: 1 });
    harness.resolveDecode({});
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(harness.sources.length, 1);
    harness.emitPlay({ audioData: 'b', msgId: 'm2', sessionId: 2 });
    assert.equal(harness.sources[0].stopCalled, 1);
    harness.emitPlay({ audioData: 'late', msgId: 'late', sessionId: 1 });
    harness.resolveDecode({});
    await harness.owner.dispose();
});

test('TTS owner dispose unsubscribes, waits for decode, and silences late completion', async () => {
    const harness = createHarness();
    harness.owner.mount();
    harness.owner.ensureAudioContext();
    harness.emitPlay({ audioData: 'a', msgId: 'm1', sessionId: 1 });
    const disposal = harness.owner.dispose();
    harness.resolveDecode({});
    await disposal;
    assert.equal(harness.unsubscribed, 2);
    assert.equal(harness.sources.length, 0);
    assert.deepEqual(harness.indicators.at(-1), ['m1', false]);
    assert.equal(harness.owner.ensureAudioContext(), false);
});

test('TTS owner mount and dispose are idempotent', async () => {
    const harness = createHarness();
    harness.owner.mount();
    harness.owner.mount();
    await harness.owner.dispose();
    await harness.owner.dispose();
    assert.equal(harness.unsubscribed, 2);
});
