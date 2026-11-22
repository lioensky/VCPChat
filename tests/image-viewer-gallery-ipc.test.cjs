const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const ipc = new EventEmitter();
const handlers = new Map();
ipc.handle = (channel, handler) => handlers.set(channel, handler);
const windows = [];
class BrowserWindow extends EventEmitter {
    constructor() {
        super();
        this.webContents = { mainFrame: {} };
        this.bounds = { x: 10, y: 40, width: 800, height: 600 };
    }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    isDestroyed() { return false; }
    isMaximized() { return this.maximized === true; }
    isFullScreen() { return this.fullScreen === true; }
    setMenu() {}
    loadURL(url) { this.url = new URL(url); }
}
const originalLoad = Module._load;
try {
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') return { ipcMain: ipc, BrowserWindow, screen: { getDisplayMatching: () => ({ workArea: { x: 0, width: 1600 } }) }, app: { getAppPath: () => __dirname } };
        if (request === '../services/windowPinService') return { setupGlobalWindowPinObserver() {} };
        return originalLoad.call(this, request, parent, isMain);
    };
    require('../modules/ipc/windowHandlers.js').initialize(null, windows);
} finally {
    Module._load = originalLoad;
}

function open(payload) {
    ipc.emit('open-image-viewer', {}, payload);
    return windows.at(-1);
}

function consume(token) {
    return handlers.get('image-viewer:consume-payload')({}, token);
}

test('gallery stays in a one-shot token and selected index is remapped after filtering and capping', () => {
    const first = { src: 'https://example.test/0.png', title: 'Earlier', extra: true };
    const selected = 'https://example.test/199.png';
    const gallery = [null, first, { src: 42 },
        ...Array.from({ length: 200 }, (_, i) => ({ src: `https://example.test/${i + 1}.png`, title: 42 }))];
    const win = open({ src: selected, title: 'Selected', theme: 'light', gallery, index: 201, extra: true });
    const query = win.url.searchParams;
    const token = query.get('token');
    assert.ok(token);
    assert.equal(query.has('src'), false);
    assert.equal(query.has('gallery'), false);
    const payload = consume(token);
    assert.deepEqual(Object.keys(payload).sort(), ['gallery', 'index', 'src', 'theme', 'title']);
    assert.equal(payload.src, selected);
    assert.equal(payload.title, 'Selected');
    assert.equal(payload.theme, 'light');
    assert.equal(payload.gallery.length, 200);
    assert.deepEqual(payload.gallery[0], { src: first.src, title: first.title });
    assert.equal(payload.index, 199);
    assert.deepEqual(payload.gallery[payload.index], { src: selected, title: '' });
    assert.equal(consume(token), null);
    win.emit('closed');
});

test('gallery falls back when the index is invalid, mismatched, or outside the retained range', () => {
    const gallery = Array.from({ length: 201 }, (_, i) => ({ src: `https://example.test/${i}.png` }));
    for (const [src, index] of [[gallery[0].src, 1], [gallery[0].src, '0'], [gallery[200].src, 200]]) {
        const win = open({ src, index, gallery });
        assert.equal(win.url.searchParams.get('src'), src);
        assert.equal(win.url.searchParams.has('token'), false);
        win.emit('closed');
    }
});

test('short single images, long sources, and explicit single-image registration remain compatible', () => {
    const short = open({ src: 'https://example.test/single.png', title: 'Single', theme: 'light' });
    assert.equal(short.url.searchParams.get('src'), 'https://example.test/single.png');
    assert.equal(short.url.searchParams.get('title'), 'Single');
    assert.equal(short.url.searchParams.get('theme'), 'light');
    short.emit('closed');

    for (const src of ['data:image/png;base64,AA', `https://example.test/${'x'.repeat(1501)}`]) {
        const win = open({ src, title: 'Single' });
        const token = win.url.searchParams.get('token');
        assert.ok(token);
        assert.equal(win.url.searchParams.has('src'), false);
        assert.deepEqual(consume(token), { src, title: 'Single', theme: 'dark' });
        win.emit('closed');
    }
    const token = handlers.get('image-viewer:register-payload')({}, { src: 'data:image/png;base64,AA' });
    assert.deepEqual(consume(token), { src: 'data:image/png;base64,AA', title: '图片预览', theme: 'dark' });
});

test('open rejects non-string sources and ignores invalid metadata', () => {
    const count = windows.length;
    open({ src: { url: 'https://example.test/invalid.png' } });
    assert.equal(windows.length, count);
    const win = open({ src: 'data:image/png;base64,AA', title: 'data:image/png;base64,AA', theme: {} });
    assert.deepEqual(consume(win.url.searchParams.get('token')), {
        src: 'data:image/png;base64,AA', title: '图片预览', theme: 'dark',
    });
    assert.equal(win.url.searchParams.get('title'), '图片预览');
    win.emit('closed');
});

test('closing a gallery before it is consumed clears its token', () => {
    const src = 'https://example.test/1.png';
    const win = open({ src, gallery: [{ src }, { src: 'https://example.test/2.png' }], index: 0 });
    const token = win.url.searchParams.get('token');
    assert.ok(token);
    win.emit('closed');
    assert.equal(consume(token), null);
});

test('OCR drawer widens only the viewer main frame and restores unchanged bounds', () => {
    const win = open({ src: 'sample.png' });
    const toggle = handlers.get('image-viewer:set-ocr-open');
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    const initial = win.getBounds();
    assert.equal(toggle({ sender: {}, senderFrame: {} }, true), false);
    assert.equal(toggle({ ...event, senderFrame: {} }, true), false);
    assert.equal(toggle(event, 'true'), false);
    assert.deepEqual(win.getBounds(), initial);
    assert.equal(toggle(event, true), true);
    assert.equal(toggle(event, true), true);
    assert.deepEqual(win.getBounds(), { ...initial, width: 1180 });
    toggle(event, false);
    assert.deepEqual(win.getBounds(), initial);
    win.emit('closed');
});

test('OCR drawer leaves edge, maximized, fullscreen and manually adjusted bounds alone', () => {
    const win = open({ src: 'sample.png' });
    const toggle = handlers.get('image-viewer:set-ocr-open');
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    const initial = win.getBounds();
    toggle(event, true);
    const manual = { ...initial, x: 45, width: 900 };
    win.setBounds(manual);
    toggle(event, false);
    assert.deepEqual(win.getBounds(), manual);
    for (const mode of ['edge', 'maximized', 'fullscreen']) {
        win.setBounds({ ...initial, x: mode === 'edge' ? 800 : 10 });
        win.maximized = mode === 'maximized';
        win.fullScreen = mode === 'fullscreen';
        const before = win.getBounds();
        toggle(event, true);
        assert.deepEqual(win.getBounds(), before);
        toggle(event, false);
        assert.deepEqual(win.getBounds(), before);
    }
    win.emit('closed');
});
