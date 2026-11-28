// 播放远程曲目时拿哪台服务器的账号：同一台 NAS 上 /dav 和 /dav2 两个服务器不能串号。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('loading a remote track uses the account of the server its address sits under', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-webdav-'));
    process.env.VCP_DATA_PATH = dir;
    const handlers = new Map();
    const electron = {
        ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn), removeListener() {} },
        BrowserWindow: function () {}, app: { getPath: () => dir }, dialog: {}, shell: {}, nativeTheme: {}
    };
    const original = Module._load;
    Module._load = function (request, ...rest) { return request === 'electron' ? electron : original.call(this, request, ...rest); };
    let webdav;
    try {
        for (const f of ['../modules/ipc/musicHandlers.js', '../modules/webdavManager.js']) delete require.cache[require.resolve(f)];
        webdav = require('../modules/webdavManager.js');
        require('../modules/ipc/musicHandlers.js').initialize({
            mainWindow: null, openChildWindows: [], startAudioEngine() {}, stopAudioEngine() {}, APP_DATA_ROOT_IN_PROJECT: dir
        });
    } finally {
        Module._load = original;
    }
    await new Promise((r) => setTimeout(r, 20)); // 等服务器列表读完
    webdav.addServer({ url: 'https://nas/dav', username: 'u1', password: 'p1' });
    const second = webdav.addServer({ url: 'https://nas/dav2', username: 'u2', password: 'p2' });
    const calls = [];
    webdav.configureAndLoad = async (config) => { calls.push(config); return { status: 'success' }; };
    const load = handlers.get('music-load');

    await load({}, { path: 'https://nas/dav2/a.flac', isRemote: true });
    await load({}, { path: 'https://nas/dav/b.flac', isRemote: true });
    await load({}, { path: 'https://nas/dav2/c.flac', isRemote: true, serverId: 'removed-server' });
    await load({}, { path: 'https://nas/dav/d.flac', isRemote: true, serverId: second.id });
    assert.deepEqual(calls.map((c) => c.username), ['u2', 'u1', 'u2', 'u2']);
});

test('configureAndLoad prefers the longest matching WebDAV server prefix', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-webdav-prefix-'));
    process.env.VCP_DATA_PATH = dir;
    delete require.cache[require.resolve('../modules/webdavManager.js')];
    const webdav = require('../modules/webdavManager.js');
    await new Promise((r) => setTimeout(r, 20));
    webdav.addServer({ url: 'https://nas/dav', username: 'u1', password: 'p1' });
    webdav.addServer({ url: 'https://nas/dav/flac', username: 'u2', password: 'p2' });
    const requests = [];
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
        requests.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
        return { ok: true, json: async () => ({ status: 'success' }) };
    };
    try {
        const res = await webdav.configureAndLoad({ url: 'https://nas/dav/flac/sub/01.flac', username: 'u2', password: 'p2' });
        assert.equal(res.status, 'success');
        const cfg = requests.find((r) => r.url.endsWith('/webdav/configure'));
        assert.ok(cfg, 'sent /webdav/configure request');
        assert.equal(cfg.body.base_url, 'https://nas/dav/flac');
        assert.equal(cfg.body.username, 'u2');
    } finally {
        global.fetch = origFetch;
    }
});
