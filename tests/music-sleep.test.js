const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 定时关闭：到点前 10 秒把引擎音量收到 0 再暂停，然后还原音量；「播完这首」赶在结尾前停。
const { setupMusicSleep } = require(path.join(__dirname, '../Musicmodules/music-sleep.js'));

function setup() {
    let t = 1000000;
    let tick = null;
    const volumes = [];
    const events = [];
    globalThis.document = { dispatchEvent: (e) => events.push(e.detail) };
    globalThis.CustomEvent = class { constructor(type, init) { this.detail = init?.detail; } };
    globalThis.setTimeout = (fn) => fn();
    const app = {
        isPlaying: true,
        volumeSlider: { value: '0.8' },
        api: { setMusicVolume: (v) => volumes.push(Math.round(v * 100) / 100) },
        pauseTrack: async () => { app.isPlaying = false; },
        lastKnownDuration: 200,
        playedSeconds: () => app.pos,
        pos: 10
    };
    const sleep = setupMusicSleep(app, { now: () => t, setTimer: (fn) => { tick = fn; return 1; }, clearTimer: () => { tick = null; } });
    const advance = (sec) => { t += sec * 1000; tick && tick(); };
    return { app, sleep, volumes, events, advance, running: () => Boolean(tick) };
}

test('timed: fades the engine volume in the last 10 s, pauses, then restores the volume', async () => {
    const { app, sleep, volumes, advance, running } = setup();
    sleep.set(1);
    assert.equal(sleep.state().mode, 'time');
    assert.equal(sleep.state().remaining, 60);
    assert.equal(sleep.state().minutes, 1, 'remembers which choice was picked');
    advance(55);
    assert.deepEqual(volumes, [0.4]);
    advance(5);
    await new Promise((r) => setImmediate(r));
    assert.equal(app.isPlaying, false);
    assert.equal(volumes.at(-1), 0.8, 'engine volume goes back to the slider value');
    assert.equal(sleep.state().mode, 'off');
    assert.equal(running(), false, 'no timer left running');
});

test('end of track: pauses just before the end, not earlier', async () => {
    const { app, sleep, advance } = setup();
    sleep.setTrackEnd();
    app.pos = 150; advance(0.2);
    assert.equal(app.isPlaying, true);
    app.pos = 199.7; advance(0.2);
    await new Promise((r) => setImmediate(r));
    assert.equal(app.isPlaying, false);
    assert.equal(sleep.state().mode, 'off');
});

test('cancel during the fade restores the volume and stops the timer', () => {
    const { sleep, volumes, advance, running, events } = setup();
    sleep.set(1);
    advance(58);
    sleep.cancel();
    assert.equal(volumes.at(-1), 0.8);
    assert.equal(running(), false);
    assert.equal(events.at(-1).mode, 'off');
});

test('cancelling during the fade restores the volume after any fade request still in flight, never before it', async () => {
    const { app, sleep, advance } = setup();
    const pending = [];
    const sent = [];
    app.api.setMusicVolume = (v) => { sent.push(Math.round(v * 100) / 100); return new Promise((resolve) => pending.push(resolve)); };
    // 与 music-effects.js 的 sendLatest 同样的约定：同一类同时只发一个，排队期间只留最新的
    const slots = new Map();
    app.sendLatest = (key, send) => {
        const slot = slots.get(key);
        if (slot) { slot.next = send; return slot.done; }
        const created = { next: null };
        slots.set(key, created);
        created.done = (async () => { let cur = send; while (cur) { created.next = null; await cur(); cur = created.next; } slots.delete(key); })();
        return created.done;
    };
    sleep.set(1);
    advance(55);
    assert.deepEqual(sent, [0.4]);
    sleep.cancel();
    assert.deepEqual(sent, [0.4], 'the restore waits until the fade request has reached the engine');
    pending.shift()();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, [0.4, 0.8], 'and is sent right after it, so it is the last value the engine sees');
    pending.shift()();
});
