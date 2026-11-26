const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// 「上一首」：放了 3 秒以上先回到本曲开头，3 秒内才真的回上一首。
function setup() {
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, setInterval, clearInterval,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        document: { body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, dispatchEvent() {} },
        navigator: {},
        localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })()
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-app-hooks.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-player.js'), 'utf8'), context);
    const playlist = Array.from({ length: 4 }, (_, i) => ({ path: `C:/m/${i}.flac`, title: `t${i}` }));
    const loads = [];
    const seeks = [];
    const app = {
        playlist, currentTrackIndex: 2, currentFilteredTracks: null,
        playModes: ['repeat', 'repeat-one', 'shuffle'], currentPlayMode: 0, shuffleQueue: [], pendingLoadRequestId: 0,
        normalizePathForCompare: (p) => (p || '').toLowerCase(), api: {}
    };
    context.setupPlayer(app);
    app.loadTrack = (i) => { loads.push(i); app.currentTrackIndex = i; };
    app.seekTo = (s) => { seeks.push(s); app.lastKnownCurrentTime = s; app.lastStateUpdateTime = Date.now(); };
    return { app, loads, seeks };
}

test('after 3 seconds, previous restarts the current track instead of switching', () => {
    const { app, loads, seeks } = setup();
    app.isPlaying = true; app.lastKnownCurrentTime = 42; app.lastStateUpdateTime = Date.now();
    assert.equal(app.prevRestarts(), true);
    assert.equal(app.prevTrack(), 'restart');
    assert.deepEqual(seeks, [0]);
    assert.deepEqual(loads, []);
    // 回到开头之后马上再按：真的回上一首
    app.prevTrack();
    assert.deepEqual(loads, [1]);
});

test('within the first 3 seconds previous goes to the previous track', () => {
    const { app, loads, seeks } = setup();
    app.isPlaying = true; app.lastKnownCurrentTime = 1.2; app.lastStateUpdateTime = Date.now();
    app.prevTrack();
    assert.deepEqual(seeks, []);
    assert.deepEqual(loads, [1]);
});

test('while a track is still loading, previous never restarts', () => {
    const { app, loads, seeks } = setup();
    app.isTrackLoading = true; app.lastKnownCurrentTime = 90;
    app.prevTrack();
    assert.deepEqual(seeks, []);
    assert.deepEqual(loads, [1]);
});

test('paused at 1:00 still restarts; force skips the rule', () => {
    const { app, loads, seeks } = setup();
    app.isPlaying = false; app.lastKnownCurrentTime = 60;
    app.prevTrack();
    assert.deepEqual(seeks, [0]);
    app.lastKnownCurrentTime = 60;
    app.prevTrack({ force: true });
    assert.deepEqual(loads, [1]);
});
