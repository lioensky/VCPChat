import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const core = require('../modules/deskpet/cubismCore.js');

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
    const { fetch, calls } = fakeFetch(zip);
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
    assert.equal(calls[0].url, core.SDK_URL);
    assert.ok(progress.includes('download') && progress.includes('verify'));
    assert.equal(fs.readFileSync(installer.corePath, 'utf8'), FAKE_CORE);
    assert.equal(fs.existsSync(installer.stagedPath), false);
    assert.deepEqual(await installer.status(), { installed: true, version: '5.0.1024', busy: false, release: '5-r.4', path: installer.corePath });

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

test('installer runs one install at a time', async () => {
    const appDataRoot = tempDir();
    let release;
    const installer = core.createCoreInstaller({
        appDataRoot,
        fetch: async () => { throw new Error('unused'); },
        probe: () => new Promise((resolve) => { release = () => resolve(V5); }),
    });
    const file = path.join(appDataRoot, 'live2dcubismcore.min.js.src');
    fs.writeFileSync(file, FAKE_CORE);
    const running = installer.installFromFile(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await installer.status()).busy, true);
    assert.match((await installer.installFromFile(file)).error, /正在安装/);
    release();
    assert.equal((await running).success, true);
});
