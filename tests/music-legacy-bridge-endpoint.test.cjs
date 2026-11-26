// 旧版音乐页面在 DOMContentLoaded 里同步连引擎的频谱连接。引擎换了端口时（63789 被系统预留），
// 那一刻主进程的地址还没回来：以前先连 63789 失败，要等 5 秒重连，开头的频谱和播完事件都收不到。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function page({ endpointDelay = 20, endpoint = { wsUrl: 'ws://127.0.0.1:43789/ws' } } = {}) {
    const listeners = [];
    const opened = [];
    class NativeSocket { constructor(url) { opened.push(url); } }
    const proto = {
        readyState: 'loading',
        addEventListener(type, fn) { listeners.push({ type, fn }); },
        getElementById: () => null,
        querySelector: () => null
    };
    const document = Object.create(proto);
    const window = {
        WebSocket: NativeSocket,
        electronAPI: { getAudioEngineEndpoint: () => new Promise((r) => { if (endpointDelay !== null) setTimeout(() => r(endpoint), endpointDelay); }) }
    };
    const context = vm.createContext({ window, document, setTimeout, Promise });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules-legacy/legacy-bridge.js'), 'utf8'), context);
    const fireReady = () => {
        document.readyState = 'interactive';
        for (const l of listeners.slice()) if (l.type === 'DOMContentLoaded') l.fn.call(document, { type: 'DOMContentLoaded' });
    };
    return { window, document, opened, fireReady };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the original page connects to the engine port the main process reports, even on its first try', async () => {
    const p = page();
    // 原版 music.js 就是这样：DOMContentLoaded 里同步 new WebSocket(写死的地址)
    p.document.addEventListener('DOMContentLoaded', () => { new p.window.WebSocket('ws://127.0.0.1:63789/ws'); });
    p.fireReady();
    await wait(60);
    assert.deepEqual(p.opened, ['ws://127.0.0.1:43789/ws']);
});

test('an old main process that never answers only holds the page up briefly', async () => {
    const p = page({ endpointDelay: null });
    p.document.addEventListener('DOMContentLoaded', () => { new p.window.WebSocket('ws://127.0.0.1:63789/ws'); });
    p.fireReady();
    await wait(1600);
    assert.deepEqual(p.opened, ['ws://127.0.0.1:63789/ws']);
});

test('listeners added after the page is ready are not delayed', async () => {
    const p = page();
    p.fireReady();
    assert.equal(Object.prototype.hasOwnProperty.call(p.document, 'addEventListener'), false, 'the wrapper is gone');
});
