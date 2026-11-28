// 和引擎的事件连接断了要尽快重连：切歌、播完都走这条连接，断开期间歌放完会一直静音。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('engine socket reconnects quickly first, backs off to 5 s, and resets after connecting', () => {
    const delays = [];
    const sockets = [];
    class FakeSocket {
        static OPEN = 1; static CONNECTING = 0;
        constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
        close() { this.readyState = 3; this.onclose?.(); }
    }
    let pending = null;
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        WebSocket: FakeSocket, performance: { now: () => 0 },
        setTimeout: (fn, ms) => { delays.push(ms); pending = fn; return delays.length; },
        clearTimeout() {},
        requestAnimationFrame: () => 1, cancelAnimationFrame() {},
        document: { addEventListener() {}, removeEventListener() {}, hidden: false, getElementById: () => null, querySelector: () => null, createElement: () => ({ getContext: () => null, style: {} }) },
        window: { addEventListener() {}, removeEventListener() {} },
        IntersectionObserver: class { observe() {} disconnect() {} }
    });
    vm.runInContext(fs.readFileSync('Musicmodules/music-visualizer.js', 'utf8'), context);
    const app = { api: {}, audioEngineWsUrl: 'ws://127.0.0.1:1/ws', currentVisualizerData: [], targetVisualizerData: [] };
    context.setupVisualizer(app);
    app.startVisualizerAnimation = () => {};
    const drop = () => { const s = sockets[sockets.length - 1]; s.close(); const fn = pending; pending = null; fn(); };

    app.connectWebSocket();
    for (let i = 0; i < 6; i++) drop();
    assert.deepEqual(delays, [500, 1000, 2000, 4000, 5000, 5000]);

    const live = sockets[sockets.length - 1];
    live.readyState = 1;
    live.onopen();
    delays.length = 0;
    drop();
    assert.deepEqual(delays, [500], 'a connection that worked starts over from the short delay');
});
