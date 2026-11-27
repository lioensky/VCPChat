const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 引擎只记一套 WebDAV 凭据；这里换成假引擎，检查「配凭据 + 发请求」不被别的请求插队、
// 读不到服务器时报错、引擎卡住时有超时、日志里没有密码。
const source = fs.readFileSync(path.join(__dirname, '..', 'modules', 'webdavManager.js'), 'utf8');

function load({ engine, fastTimers = false } = {}) {
    const logs = [];
    const keep = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const module = { exports: {} };
    const context = {
        module, exports: module.exports, process, URL, AbortController, clearTimeout, Promise,
        setTimeout: fastTimers ? (fn) => setTimeout(fn, 20) : setTimeout,
        console: { log: keep, error: keep, warn: keep },
        require(name) {
            if (name === './services/audioEngineEndpoint') return { getBaseUrl: () => 'http://engine' };
            if (name === 'fs-extra') return { pathExists: async () => false, ensureDir: async () => {}, writeJson: async () => {} };
            return require(name);
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    context.fakeFetch = engine;
    vm.runInContext('fetch = fakeFetch;', context);
    return { api: module.exports, logs };
}

const reply = (body, ok = true) => ({ ok, json: async () => body, text: async () => JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeEngine() {
    let creds = null;
    const seen = [];
    const engine = async (url, options) => {
        const endpoint = url.replace('http://engine', '');
        if (endpoint === '/webdav/configure') {
            await wait(5);
            creds = JSON.parse(options.body);
            return reply({ status: 'success' });
        }
        const used = creds && creds.username;
        await wait(endpoint.startsWith('/load') ? 15 : 10);
        seen.push({ endpoint, used });
        if (endpoint.startsWith('/webdav/browse')) {
            return reply({ status: 'success', path: '/', entries: [{ display_name: 'a.flac', href: '/a.flac', url: 'https://b.example/dav/a.flac', is_dir: false }] });
        }
        return reply({ status: 'success' });
    };
    return { engine, seen };
}

test('browsing one server while loading from another keeps each request on its own account', async () => {
    const { engine, seen } = fakeEngine();
    const { api } = load({ engine });
    const a = api.addServer({ url: 'https://a.example/dav', username: 'alice', password: 'pa' });
    api.addServer({ url: 'https://b.example/dav', username: 'bob', password: 'pb' });
    const creds = api.getServerCredentials(a.id);
    await Promise.all([
        api.listDirectory({ ...creds, path: '/' }),
        api.configureAndLoad({ url: 'https://b.example/dav/x.flac', serverId: 'webdav_2' }),
        api.listDirectory({ ...creds, path: '/sub' })
    ]);
    assert.deepEqual(seen.map((s) => [s.endpoint.split('?')[0], s.used]), [
        ['/webdav/browse', 'alice'], ['/load', 'bob'], ['/webdav/browse', 'alice']
    ]);
});

test('a scan that cannot read its starting folder is an error, not "0 tracks"; nothing logs the password', async () => {
    const engine = async (url) => (url.includes('/browse')
        ? reply({ status: 'error', message: '401 Unauthorized' })
        : reply({ status: 'success' }));
    const { api, logs } = load({ engine });
    const result = await api.scanAudioFiles({ url: 'https://a.example/dav', username: 'alice', password: 'hunter2-secret', path: '/' });
    assert.equal(result.status, 'error');
    assert.match(result.message, /401/);
    assert.ok(!logs.some((l) => l.includes('hunter2-secret')), 'password ended up in the log');

    const { engine: ok } = fakeEngine();
    const good = await load({ engine: ok }).api.scanAudioFiles({ url: 'https://b.example/dav', username: 'b', password: 'p', path: '/' });
    assert.equal(good.status, 'success');
    assert.equal(good.tracks.length, 1);
});

test('an engine that never answers times out instead of leaving the window waiting', async () => {
    const engine = (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const { api } = load({ engine, fastTimers: true });
    const result = await api.listDirectory({ url: 'https://a.example/dav', username: 'a', password: 'p', path: '/' });
    assert.equal(result.status, 'error');
    assert.match(result.message, /没有响应/);
    // 卡住的那次不挡后面的请求
    const after = await api.testConnection({ url: 'https://a.example/dav', username: 'a', password: 'p' });
    assert.equal(after.status, 'error');
});

test('credentials for a remote track: by server id, else by the server its address sits under', () => {
    const { api } = load({ engine: async () => reply({}) });
    api.addServer({ url: 'https://nas/dav', username: 'u1', password: 'p1' });
    api.addServer({ url: 'https://nas/dav2/', username: 'u2', password: 'p2' });
    api.addServer({ url: 'https://nas/dav/music', username: 'u3', password: 'p3' });
    assert.equal(api.credentialsForTrack({ serverId: 'webdav_2', path: 'https://nas/dav/x.flac' }).username, 'u2');
    assert.equal(api.credentialsForTrack({ path: 'https://nas/dav2/x.flac' }).username, 'u2');
    assert.equal(api.credentialsForTrack({ path: 'https://nas/dav/x.flac' }).username, 'u1');
    assert.equal(api.credentialsForTrack({ path: 'https://nas/dav/music/x.flac' }).username, 'u3');
    assert.equal(api.credentialsForTrack({ path: 'D:\\Music\\x.flac' }), null);
    assert.equal(api.credentialsForTrack({ path: 'https://other/x.flac' }), null);
    assert.equal(api.credentialsForTrack({ serverId: 'gone', path: 'https://nas/dav2/y.flac' }).username, 'u2');
});

test('reconciles serverIdCounter above existing server IDs when saved nextId is stale', () => {
    const module = { exports: {} };
    const context = {
        module, exports: module.exports, process, URL, AbortController, clearTimeout, setTimeout, Promise,
        console: { log() {}, error() {}, warn() {} },
        require(name) {
            if (name === './services/audioEngineEndpoint') return { getBaseUrl: () => 'http://engine' };
            if (name === 'fs-extra') {
                return {
                    pathExistsSync: () => true,
                    readJsonSync: () => ({
                        servers: [{ id: 'webdav_5', name: 'Existing', url: 'https://nas/dav', username: 'u', password: 'p' }],
                        nextId: 1
                    }),
                    ensureDir: async () => {},
                    writeJson: async () => {}
                };
            }
            return require(name);
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    const added = module.exports.addServer({ name: 'New', url: 'https://nas2/dav' });
    assert.equal(added.id, 'webdav_6', 'new server ID advances past existing webdav_5 despite stale nextId=1');
});

test('scanAudioFiles throttles rapid progress callbacks and always reports the final track count', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
        display_name: `song-${i}.flac`,
        href: `/music/song-${i}.flac`,
        url: `https://nas.example/dav/music/song-${i}.flac`,
        is_dir: false
    }));
    const engine = async (url) => (url.includes('/browse')
        ? reply({ status: 'success', path: '/music', entries })
        : reply({ status: 'success' }));
    const { api } = load({ engine });
    const progress = [];
    const res = await api.scanAudioFiles(
        { url: 'https://nas.example/dav', username: 'u', password: 'p', path: '/music' },
        (count) => progress.push(count)
    );
    assert.equal(res.status, 'success');
    assert.equal(res.tracks.length, 50);
    assert.ok(progress.length >= 1 && progress.length <= 5, `expected throttled progress updates, got ${progress.length}`);
    assert.equal(progress[progress.length - 1], 50, 'final progress callback reports total scanned count');
});

test('addServer rejects blank/missing URL and removeServer invalidates cached engine credentials', async () => {
    let configCalls = 0;
    const engine = async (url) => {
        if (url.includes('/webdav/configure')) configCalls += 1;
        return reply({ status: 'success', path: '/', entries: [] });
    };
    const { api } = load({ engine });
    assert.equal(api.addServer(null), null);
    assert.equal(api.addServer({ name: 'Bad', url: '   ' }), null);
    assert.equal(api.listServers().length, 0);

    const s1 = api.addServer({ name: 'NAS', url: 'https://nas/dav/', username: 'u', password: 'p' });
    assert.equal(s1.url, 'https://nas/dav');
    await api.listDirectory({ url: s1.url, username: 'u', password: 'p', path: '/' });
    assert.equal(configCalls, 1);
    await api.listDirectory({ url: s1.url, username: 'u', password: 'p', path: '/sub' });
    assert.equal(configCalls, 1, 'same credentials reuse engine config');

    api.removeServer(s1.id);
    assert.equal(api.listServers().length, 0);
    await api.listDirectory({ url: s1.url, username: 'u', password: 'p', path: '/' });
    assert.equal(configCalls, 2, 'removeServer invalidates cached engine credential key');
});
