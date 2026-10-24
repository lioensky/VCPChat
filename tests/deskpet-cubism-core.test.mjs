import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const core = require('../modules/deskpet/cubismCore.js');
const fetchScript = require('../scripts/deskpet/fetch-cubism-core.cjs');

// 不是真的 Core：只要有名字、大小像样，校验和解压就认；能不能用交给 probe
const FAKE_CORE = `var Live2DCubismCore;${'/*pad*/'.repeat(4000)}`;
const V5 = 0x05000400;
const V6 = 0x06000000;

async function sdkZip(root, files) {
    const zip = new JSZip();
    for (const [rel, content] of Object.entries(files)) zip.file(`${root}/${rel}`, content);
    return zip.generateAsync({ type: 'nodebuffer' });
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-core-'));
}

function fakeFetch(body, { status = 200, length = body.length } = {}) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, init });
        let sent = false;
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name) => (name === 'content-length' && length ? String(length) : null) },
            body: {
                getReader: () => ({
                    read: async () => {
                        if (sent) return { done: true };
                        sent = true;
                        return { done: false, value: new Uint8Array(body) };
                    },
                }),
            },
        };
    };
    return { fetch, calls };
}

// 按地址返回不同内容：单独的 Core 一个结果，SDK 压缩包一个结果
function routedFetch(routes) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, init });
        const route = routes[url];
        if (!route) throw new Error(`unexpected ${url}`);
        return fakeFetch(route.body, route).fetch(url, init);
    };
    return { fetch, calls };
}

test('SDK release parsing: 5-r.5 and later carry Core 6 and are refused', () => {
    assert.deepEqual(core.sdkReleaseOf('CubismSdkForWeb-5-r.4/Core/live2dcubismcore.min.js'), { major: 5, revision: 4 });
    assert.equal(core.sdkReleaseOf('Core/live2dcubismcore.min.js'), null);
    assert.equal(core.isUnsupportedRelease({ major: 5, revision: 4 }), false);
    assert.equal(core.isUnsupportedRelease({ major: 5, revision: 5 }), true);
    assert.equal(core.isUnsupportedRelease({ major: 6, revision: 0 }), true);
    assert.equal(core.isUnsupportedRelease(null), false);
    assert.equal(core.formatCoreVersion(V5), '5.0.1024');
    assert.equal(core.formatCoreVersion(0), '');
    assert.match(core.SDK_URL, /CubismSdkForWeb-5-r\.4\.zip$/);
});

test('extracts the root Core from an SDK zip and ignores sample copies', async () => {
    const zip = await sdkZip('CubismSdkForWeb-5-r.4', {
        'Samples/TypeScript/Demo/public/Core/live2dcubismcore.min.js': 'sample copy',
        'Core/live2dcubismcore.min.js': FAKE_CORE,
        'README.md': 'readme',
    });
    const result = await core.extractCoreFromZip(zip);
    assert.equal(result.source, FAKE_CORE);
    assert.deepEqual(result.release, { major: 5, revision: 4 });
});

test('refuses zips without Core, with Core 6, or that are not zips', async () => {
    await assert.rejects(core.extractCoreFromZip(await sdkZip('Other', { 'a.txt': 'x' })), /没有 Core/);
    await assert.rejects(core.extractCoreFromZip(await sdkZip('CubismSdkForWeb-5-r.5', { 'Core/live2dcubismcore.min.js': FAKE_CORE })), /6\.x/);
    await assert.rejects(core.extractCoreFromZip(Buffer.from('not a zip')), /打不开/);
    await assert.rejects(core.extractCoreFromZip(await sdkZip('CubismSdkForWeb-5-r.4', { 'Core/live2dcubismcore.min.js': 'tiny' })), /不完整/);
});

test('local files: a bare Core or an SDK zip, anything else is refused', async () => {
    const dir = tempDir();
    const js = path.join(dir, 'live2dcubismcore.min.js');
    fs.writeFileSync(js, FAKE_CORE);
    assert.equal((await core.readCoreSource(js)).source, FAKE_CORE);
    const zipFile = path.join(dir, 'CubismSdkForWeb-5-r.1.zip');
    fs.writeFileSync(zipFile, await sdkZip('CubismSdkForWeb-5-r.1', { 'Core/live2dcubismcore.min.js': FAKE_CORE }));
    assert.deepEqual((await core.readCoreSource(zipFile)).release, { major: 5, revision: 1 });
    const other = path.join(dir, 'other.js');
    fs.writeFileSync(other, 'console.log(1)');
    await assert.rejects(core.readCoreSource(other), /不是 Cubism Core/);
});

test('download reports progress, stops on oversize bodies and on HTTP errors', async () => {
    const body = Buffer.alloc(1000, 1);
    const seen = [];
    const ok = fakeFetch(body);
    const data = await core.download(ok.fetch, 'https://example.test/sdk.zip', { onProgress: (p) => seen.push(p) });
    assert.equal(data.length, 1000);
    assert.deepEqual(seen.at(-1), { received: 1000, total: 1000 });
    await assert.rejects(core.download(fakeFetch(body, { length: 0 }).fetch, 'u', { maxBytes: 500 }), /太大/);
    await assert.rejects(core.download(fakeFetch(body).fetch, 'u', { maxBytes: 500 }), /太大/);
    await assert.rejects(core.download(fakeFetch(body, { status: 404 }).fetch, 'u'), /404/);
    await assert.rejects(core.download(async () => { throw new Error('ECONNRESET'); }, 'u'), /连不上/);
});

test('installer: verified 5.x replaces the Core, Core 6 and broken files keep the old one', async () => {
    const appDataRoot = tempDir();
    let version = V5;
    const probed = [];
    const zip = await sdkZip('CubismSdkForWeb-5-r.4', { 'Core/live2dcubismcore.min.js': FAKE_CORE });
    // 单独的 Core 下不下来，退回 SDK 压缩包
    const { fetch, calls } = routedFetch({
        [core.CORE_URL]: { body: Buffer.from('gone'), status: 404 },
        [core.SDK_URL]: { body: zip },
    });
    const installer = core.createCoreInstaller({
        appDataRoot,
        fetch,
        probe: async (file) => {
            probed.push(fs.readFileSync(file, 'utf8'));
            return version;
        },
    });
    assert.equal((await installer.status()).installed, false);

    const progress = [];
    const first = await installer.installOfficial((p) => progress.push(p.phase));
    assert.equal(first.success, true, first.error);
    assert.equal(first.version, '5.0.1024');
    assert.deepEqual(calls.map((c) => c.url), [core.CORE_URL, core.SDK_URL]);
    assert.ok(progress.includes('download') && progress.includes('verify'));
    assert.equal(fs.readFileSync(installer.corePath, 'utf8'), FAKE_CORE);
    assert.equal(fs.existsSync(installer.stagedPath), false);
    assert.deepEqual(await installer.status(), { installed: true, bundled: false, version: '5.0.1024', busy: false, release: '5-r.4', path: installer.corePath });

    const replacement = path.join(appDataRoot, 'new-core.js');
    fs.writeFileSync(replacement, `${FAKE_CORE}/*v6*/`);
    version = V6;
    const refused = await installer.installFromFile(replacement);
    assert.equal(refused.success, false);
    assert.match(refused.error, /只支持 5\.x/);
    version = 0;
    assert.match((await installer.installFromFile(replacement)).error, /加载不起来/);
    assert.equal(fs.readFileSync(installer.corePath, 'utf8'), FAKE_CORE, 'the working Core stays');
    assert.equal(fs.existsSync(installer.stagedPath), false);
    assert.equal(probed.length, 3);
});

test('installer: the standalone Core is used when it is 5.x, a Core 6 there falls back to the pinned SDK', async () => {
    const standalone = `${FAKE_CORE}/*standalone*/`;
    const zip = await sdkZip('CubismSdkForWeb-5-r.4', { 'Core/live2dcubismcore.min.js': FAKE_CORE });
    const routes = { [core.CORE_URL]: { body: Buffer.from(standalone) }, [core.SDK_URL]: { body: zip } };

    const direct = routedFetch(routes);
    const sources = [];
    const quick = core.createCoreInstaller({ appDataRoot: tempDir(), fetch: direct.fetch, probe: async () => V5 });
    const ok = await quick.installOfficial((p) => sources.push(p.source));
    assert.equal(ok.success, true, ok.error);
    assert.equal(ok.sdk, null);
    assert.deepEqual(direct.calls.map((c) => c.url), [core.CORE_URL], 'the SDK zip is not downloaded');
    assert.ok(sources.length && sources.every((s) => s === 'core'));
    assert.equal(fs.readFileSync(quick.corePath, 'utf8'), standalone);

    const latest = routedFetch(routes);
    const fallback = core.createCoreInstaller({
        appDataRoot: tempDir(),
        fetch: latest.fetch,
        probe: async (file) => (fs.readFileSync(file, 'utf8') === standalone ? V6 : V5),
    });
    const result = await fallback.installOfficial();
    assert.equal(result.success, true, result.error);
    assert.equal(result.sdk, '5-r.4');
    assert.deepEqual(latest.calls.map((c) => c.url), [core.CORE_URL, core.SDK_URL]);
    assert.equal(fs.readFileSync(fallback.corePath, 'utf8'), FAKE_CORE);
});

test('status: the Core bundled with the app counts as installed until the user installs their own', async () => {
    const projectRoot = tempDir();
    const appDataRoot = tempDir();
    const bundled = core.bundledCorePath(projectRoot);
    const installer = core.createCoreInstaller({ appDataRoot, projectRoot, fetch: async () => { throw new Error('offline'); }, probe: async () => V5 });
    assert.equal((await installer.status()).installed, false);

    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    fs.writeFileSync(bundled, FAKE_CORE);
    fs.writeFileSync(path.join(path.dirname(bundled), 'core.json'), JSON.stringify({ version: '5.1.0', origin: 'bundled' }));
    assert.deepEqual(await installer.status(), { installed: true, bundled: true, version: '5.1.0', busy: false, release: '5-r.4', path: bundled });

    const own = path.join(appDataRoot, 'own-core.js');
    fs.writeFileSync(own, FAKE_CORE);
    assert.equal((await installer.installFromFile(own)).success, true);
    const status = await installer.status();
    assert.equal(status.bundled, false);
    assert.equal(status.path, installer.corePath);
});

test('fetch script: saves a verified 5.x Core next to the app, skips when present, refuses Core 6', async () => {
    const projectRoot = tempDir();
    const target = core.bundledCorePath(projectRoot);
    const zip = await sdkZip('CubismSdkForWeb-5-r.4', { 'Core/live2dcubismcore.min.js': FAKE_CORE });
    const routes = { [core.CORE_URL]: { body: Buffer.from(FAKE_CORE) }, [core.SDK_URL]: { body: zip } };
    const quiet = () => {};

    const first = routedFetch(routes);
    const saved = await fetchScript.fetchBundledCore({ projectRoot, fetchImpl: first.fetch, probe: async () => 0x05010000, log: quiet });
    assert.equal(saved.version, '5.1.0');
    assert.equal(fs.readFileSync(target, 'utf8'), FAKE_CORE);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(target), 'core.json'), 'utf8')).origin, 'bundled');

    const again = routedFetch(routes);
    assert.equal((await fetchScript.fetchBundledCore({ projectRoot, fetchImpl: again.fetch, probe: async () => V5, log: quiet })).skipped, true);
    assert.equal(again.calls.length, 0);

    const fresh = tempDir();
    await assert.rejects(fetchScript.fetchBundledCore({ projectRoot: fresh, fetchImpl: routedFetch(routes).fetch, probe: async () => V6, log: quiet }), /only 5\.x/);
    assert.equal(fs.existsSync(core.bundledCorePath(fresh)), false);
});

test('fetch script: a file that is not a Core does not load in the probe', async () => {
    assert.equal(await fetchScript.probeInNode('var Live2DCubismCore = {};'), 0);
    assert.equal(await fetchScript.probeInNode('this is not javascript'), 0);
});

test('installer runs one install at a time', { timeout: 5000 }, async () => {
    const appDataRoot = tempDir();
    let release;
    let entered;
    const probeReady = new Promise(resolve => { entered = resolve; });
    const installer = core.createCoreInstaller({
        appDataRoot,
        fetch: async () => { throw new Error('unused'); },
        probe: () => new Promise((resolve) => { release = () => resolve(V5); entered(); }),
    });
    const file = path.join(appDataRoot, 'live2dcubismcore.min.js.src');
    fs.writeFileSync(file, FAKE_CORE);
    const running = installer.installFromFile(file);
    await probeReady;
    assert.equal((await installer.status()).busy, true);
    assert.match((await installer.installFromFile(file)).error, /正在安装/);
    release();
    assert.equal((await running).success, true);
});
