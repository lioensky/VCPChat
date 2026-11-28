// WebNowPlaying（Rainmeter 等桌面插件）收到的当前曲目：带封面的歌也要能发出去。
// sendUpdate 在 loadTrack 里同步调用，它一抛错，整个切歌流程就断在半路。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function load() {
    const sent = [];
    class FakeSocket {
        constructor() { this.readyState = FakeSocket.OPEN; }
        send(data) { sent.push(JSON.parse(data)); }
        close() {}
    }
    FakeSocket.OPEN = 1;
    const context = { window: {}, console, setTimeout, clearTimeout, WebSocket: FakeSocket, navigator: {} };
    vm.createContext(context);
    vm.runInContext(read('Musicmodules/music-utils.js'), context);
    vm.runInContext(read('Musicmodules/music-ui.js'), context);
    const app = {
        api: {},
        playlist: [{ path: 'C:\\Music\\a.flac', title: 'a.flac', artist: '歌手', album: '专辑', albumArt: "C:\\Users\\John's PC\\cover #1.jpg" }],
        currentTrackIndex: 0, isPlaying: true, lastKnownDuration: 200, lastKnownCurrentTime: 12,
        volumeSlider: { value: '0.5' }, playModes: ['repeat'], currentPlayMode: 0
    };
    context.setupUtils(app);
    const Adapter = vm.runInContext('WebNowPlayingAdapter', context);
    return { app, sent, Adapter };
}

test('the now-playing update for a track with a cover is sent, with an encoded cover URL', () => {
    const { app, sent, Adapter } = load();
    const adapter = new Adapter(app);
    assert.doesNotThrow(() => adapter.sendUpdate());
    assert.equal(sent.length >= 1, true);
    const last = sent[sent.length - 1];
    assert.equal(last.title, 'a');
    assert.equal(last.state, 1);
    assert.equal(decodeURIComponent(new URL(last.cover).pathname), "/C:/Users/John's PC/cover #1.jpg");
    adapter.destroy();
});

test('WebNowPlayingAdapter pauses reconnect timers while hidden, resumes on visibilitychange, and tolerates missing volumeSlider', () => {
    let connectCount = 0;
    let hidden = true;
    const visListeners = new Set();
    const timers = [];
    class FakeSocket {
        constructor() { connectCount += 1; this.readyState = FakeSocket.OPEN; }
        send() {}
        close() {}
    }
    FakeSocket.OPEN = 1;
    const doc = {
        get hidden() { return hidden; },
        addEventListener: (ev, fn) => { if (ev === 'visibilitychange') visListeners.add(fn); },
        removeEventListener: (ev, fn) => { if (ev === 'visibilitychange') visListeners.delete(fn); }
    };
    const context = {
        window: {}, document: doc, console, WebSocket: FakeSocket, navigator: {},
        setTimeout: (fn) => { timers.push(fn); return timers.length; },
        clearTimeout: () => {}
    };
    vm.createContext(context);
    vm.runInContext(read('Musicmodules/music-utils.js'), context);
    vm.runInContext(read('Musicmodules/music-ui.js'), context);
    const app = {
        api: {},
        playlist: [{ path: 'C:\\Music\\a.flac', title: 'a.flac' }],
        currentTrackIndex: 0, isPlaying: false, lastKnownDuration: 0, lastKnownCurrentTime: 0,
        volumeSlider: null, playModes: ['repeat'], currentPlayMode: 0
    };
    context.setupUtils(app);
    const Adapter = vm.runInContext('WebNowPlayingAdapter', context);
    const adapter = new Adapter(app);
    assert.doesNotThrow(() => adapter.sendUpdate(), 'sendUpdate tolerates missing volumeSlider');
    assert.equal(connectCount, 1);

    // Simulate disconnect while document is hidden: timer fires once, then parks on visibilitychange instead of spinning timers
    adapter.ws.onclose();
    assert.equal(timers.length, 1);
    timers.shift()();
    assert.equal(timers.length, 0, 'hidden document does not schedule another background reconnect timer');
    assert.equal(visListeners.size, 1, 'waits on visibilitychange instead of polling timers while hidden');
    assert.equal(connectCount, 1);

    // Becoming visible triggers reconnect once and removes visibilitychange listener
    hidden = false;
    for (const fn of [...visListeners]) fn();
    assert.equal(connectCount, 2, 'reconnects once window becomes visible again');
    assert.equal(visListeners.size, 0, 'visibilitychange listener cleaned up after reconnect');

    // Destroy cleans up pending visibility wait too
    hidden = true;
    adapter.ws.onclose();
    timers.shift()();
    assert.equal(visListeners.size, 1);
    adapter.destroy();
    assert.equal(visListeners.size, 0, 'destroy removes pending visibilitychange listener');
});
