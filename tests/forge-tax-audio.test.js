'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Sound, selectCue } = require('../Gamemodules/forge-tax/audio');
const hit = (result, blocked = false) => ({ type: 'hammer', result, blocked });
test('十连及专注追加只选择一个cue，真实破碎优先', () => {
    const events = [...Array.from({ length: 10 }, () => hit('success')),
        { type: 'focus' }, ...Array.from({ length: 5 }, () => hit('critical'))];
    assert.equal(selectCue({ ok: true, events }), 'focus');
    events.push(hit('break'));
    assert.equal(selectCue({ ok: true, events }), 'break');
    assert.equal(selectCue({ ok: false, events }), null);
    assert.equal(selectCue({ ok: true, events: [hit('break', true)] }), 'hammer');
});
function factory() {
    const stats = { created: 0, stopped: 0, closed: false };
    const param = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
    const ctx = {
        state: 'running', currentTime: 0, destination: {},
        createOscillator() { stats.created++; return {
            frequency: param, connect() {}, disconnect() {}, start() {},
            stop() { stats.stopped++; }
        }; },
        createGain() { return { gain: param, connect() {}, disconnect() {} }; },
        close() { stats.closed = true; return Promise.resolve(); }
    };
    return { stats, ctx };
}
test('十次成功只合成一段两音符音效；静音释放且不继续播放', async () => {
    const { ctx, stats } = factory(), sound = new Sound({ factory: () => ctx });
    const result = { ok: true, events: Array.from({ length: 10 }, () => hit('success')) };
    await sound.playResult(result);
    assert.equal(stats.created, 2);
    sound.setEnabled(false);
    assert.equal(sound.voices.size, 0);
    await sound.playResult(result);
    assert.equal(stats.created, 2);
    sound.dispose(); assert.equal(stats.closed, true);
});
test('快速请求只播放最后一段，不排队补播；无AudioContext降级', async () => {
    const { ctx, stats } = factory(), sound = new Sound({ factory: () => ctx });
    await Promise.all(Array.from({ length: 10 }, () => sound.playResult({ ok: true, events: [hit('success')] })));
    assert.equal(stats.created, 2);
    sound.dispose();
    await new Sound({ factory: () => null }).playResult({ ok: true, events: [hit('break')] });
});