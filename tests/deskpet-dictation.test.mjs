import test from 'node:test';
import assert from 'node:assert/strict';

// 录音只测「还没开起来就取消」：麦克风一拿到就要关掉，不能留一个没人管的录音
test('cancelling while the microphone is still opening closes it as soon as it arrives', async () => {
    let grant;
    const stopped = [];
    const stream = { getTracks: () => [{ stop: () => stopped.push('track') }] };
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) } },
    });
    try {
        const { createDictation } = await import('../DeskPetmodules/dictation.js');
        const dictation = createDictation({ status: async () => ({ phase: 'ready' }), transcribe: async () => ({ success: true, text: '' }) });
        const starting = dictation.start();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(dictation.starting, true);
        assert.equal(dictation.active, false);
        dictation.cancel();
        grant(stream);
        await assert.rejects(starting, (error) => error.code === 'cancelled');
        assert.deepEqual(stopped, ['track']);
        assert.equal(dictation.active, false);
        assert.equal(dictation.starting, false);
    } finally {
        if (original) Object.defineProperty(globalThis, 'navigator', original);
        else delete globalThis.navigator;
    }
});

test('cancelling while the model status is still being checked never asks for the microphone', async () => {
    let asked = false;
    let answer;
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { mediaDevices: { getUserMedia: async () => { asked = true; return { getTracks: () => [] }; } } },
    });
    try {
        const { createDictation } = await import('../DeskPetmodules/dictation.js');
        const dictation = createDictation({ status: () => new Promise((resolve) => { answer = resolve; }), transcribe: async () => ({}) });
        const starting = dictation.start();
        dictation.cancel();
        answer({ phase: 'ready' });
        await assert.rejects(starting, (error) => error.code === 'cancelled');
        assert.equal(asked, false);
    } finally {
        if (original) Object.defineProperty(globalThis, 'navigator', original);
        else delete globalThis.navigator;
    }
});
