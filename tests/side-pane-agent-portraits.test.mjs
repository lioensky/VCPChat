// 侧栏首页立绘的主进程部分：按 Agent 目录里的 portrait 文件给出立绘地址，大图换成缓存里的缩小图，拒绝越出 Agent 目录的 id。
import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const handlers = new Map();
const originalLoad = Module._load;
Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') {
        return { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} } };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const agentHandlers = require('../modules/ipc/agentHandlers.js');
Module._load = originalLoad;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-portraits-'));
const agentDir = path.join(root, 'Agents');
fs.mkdirSync(agentDir);
agentHandlers.initialize({ AGENT_DIR: agentDir, USER_DATA_DIR: path.join(root, 'UserData'), settingsManager: {} });
const getPortraits = (id) => handlers.get('get-agent-portraits')({}, id);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('an agent with portrait files gets the default and the light version, other files are ignored', async () => {
    const dir = path.join(agentDir, 'Nova');
    fs.mkdirSync(dir);
    for (const name of ['avatar.png', 'portrait.png', 'portrait.light.webp', 'portrait.Smile.jpg', 'portrait.txt', 'portrait..png']) {
        fs.writeFileSync(path.join(dir, name), 'x');
    }
    fs.mkdirSync(path.join(dir, 'portrait.dir.png'));

    const portraits = await getPortraits('Nova');
    assert.deepEqual(Object.keys(portraits).sort(), ['default', 'light']);
    assert.match(portraits.default, /^file:\/\/.*\/Nova\/portrait\.png\?v=\d+$/);
    assert.match(portraits.light, /\/portrait\.light\.webp\?v=\d+$/);
});

test('an agent without a default portrait, a missing agent and unsafe ids get null', async () => {
    const dir = path.join(agentDir, 'Coco');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'avatar.png'), 'x');
    fs.writeFileSync(path.join(dir, 'portrait.light.png'), 'x');
    fs.writeFileSync(path.join(root, 'portrait.png'), 'x');

    assert.equal(await getPortraits('Coco'), null);
    assert.equal(await getPortraits('missing'), null);
    for (const id of ['..', '.', '../Agents/Nova', '', null, 42]) {
        assert.equal(await getPortraits(id), null, String(id));
    }
});

// sharp 的平台二进制是可选依赖（CI 用 --omit=optional 安装时拿不到），缩小图那几条只在 sharp 能加载的机器上跑
const sharpUnavailable = (() => {
    try {
        require('sharp');
        return false;
    } catch {
        return 'sharp cannot load here (its platform binary is an optional dependency)';
    }
})();

test('without sharp every portrait is served as it is', async () => {
    const dir = path.join(agentDir, 'NoSharp');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'portrait.png'), 'x'.repeat(4096));
    fs.writeFileSync(path.join(dir, 'portrait.light.webp'), 'x');
    const load = Module._load;
    Module._load = function loadWithoutSharp(request, parent, isMain) {
        if (request === 'sharp') throw new Error('Could not load the "sharp" module');
        return load.call(this, request, parent, isMain);
    };
    try {
        const portraits = await getPortraits('NoSharp');
        assert.match(portraits.default, /\/NoSharp\/portrait\.png\?v=\d+$/);
        assert.match(portraits.light, /\/NoSharp\/portrait\.light\.webp\?v=\d+$/);
    } finally {
        Module._load = load;
    }
});

test('a large portrait is served as a cached display-size copy, small ones as they are', { skip: sharpUnavailable }, async () => {
    const sharp = require('sharp');
    const dir = path.join(agentDir, 'Big');
    fs.mkdirSync(dir);
    const solid = (width, height) => sharp({ create: { width, height, channels: 4, background: { r: 200, g: 120, b: 160, alpha: 0.8 } } });
    await solid(4000, 6000).png().toFile(path.join(dir, 'portrait.png'));
    await solid(600, 900).avif().toFile(path.join(dir, 'portrait.light.avif'));

    const first = await getPortraits('Big');
    const cached = fileURLToPath(first.default.replace(/\?v=\d+$/, ''));
    assert.equal(path.dirname(cached), path.join(root, 'PortraitCache'));
    const meta = await sharp(cached).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height, meta.hasAlpha], ['webp', 1600, 2400, true]);
    assert.match(first.light, /\/Big\/portrait\.light\.avif\?v=\d+$/);
    assert.deepEqual(await getPortraits('Big'), first);

    // 换了原图：生成新的缩小图，旧的删掉
    await solid(5000, 5000).png().toFile(path.join(dir, 'portrait.png'));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'portrait.png'), later, later);
    const second = await getPortraits('Big');
    assert.notEqual(second.default, first.default);
    assert.equal(fs.existsSync(cached), false);
    assert.equal((await sharp(fileURLToPath(second.default.replace(/\?v=\d+$/, ''))).metadata()).width, 1600);
});

test('animated PNGs and videos are served as they are, so the animation is kept', { skip: sharpUnavailable }, async () => {
    const sharp = require('sharp');
    const dir = path.join(agentDir, 'Moving');
    fs.mkdirSync(dir);
    // 大图加一个 acTL 块就是 APNG：缩小图只会留下第一帧，所以不能缩
    const still = await sharp({ create: { width: 4000, height: 6000, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    const acTL = Buffer.alloc(20);
    acTL.writeUInt32BE(8, 0);
    acTL.write('acTL', 4, 'latin1');
    acTL.writeUInt32BE(1, 8);
    const ihdrEnd = 8 + 8 + 13 + 4;
    fs.writeFileSync(path.join(dir, 'portrait.png'), Buffer.concat([still.subarray(0, ihdrEnd), acTL, still.subarray(ihdrEnd)]));
    fs.writeFileSync(path.join(dir, 'portrait.light.webm'), 'webm');

    const portraits = await getPortraits('Moving');
    assert.match(portraits.default, /\/Moving\/portrait\.png\?v=\d+$/);
    assert.match(portraits.light, /\/Moving\/portrait\.light\.webm\?v=\d+$/);

    const videoDir = path.join(agentDir, 'MovingVideo');
    fs.mkdirSync(videoDir);
    fs.writeFileSync(path.join(videoDir, 'portrait.mp4'), 'mp4');
    assert.match((await getPortraits('MovingVideo')).default, /\/MovingVideo\/portrait\.mp4\?v=\d+$/);
});

test('an unreadable portrait is served as it is, so the side pane can fall back to the avatar', { skip: sharpUnavailable }, async () => {
    const dir = path.join(agentDir, 'Broken');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'portrait.png'), 'not an image');
    assert.match((await getPortraits('Broken')).default, /\/Broken\/portrait\.png\?v=\d+$/);
});

test('a phone photo with an EXIF rotation is scaled by its upright size and keeps the whole picture', { skip: sharpUnavailable }, async () => {
    const sharp = require('sharp');
    const dir = path.join(agentDir, 'Rotated');
    fs.mkdirSync(dir);
    // 存成 6000×4000 横图，EXIF 方向 6（顺时针转 90°）：摆正后是 4000×6000 的竖图
    await sharp({ create: { width: 6000, height: 4000, channels: 3, background: { r: 30, g: 60, b: 90 } } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toFile(path.join(dir, 'portrait.jpg'));
    const portraits = await getPortraits('Rotated');
    const meta = await sharp(fileURLToPath(portraits.default.replace(/\?v=\d+$/, ''))).metadata();
    assert.deepEqual([meta.width, meta.height], [1600, 2400]);
});

const png = { type: 'image/png', buffer: new Uint8Array([1, 2, 3]).buffer };
const save = (id, variant, data) => handlers.get('save-agent-portrait')({}, id, variant, data);
const remove = (id, variant) => handlers.get('remove-agent-portrait')({}, id, variant);

test('saving a portrait replaces the same variant in any extension and leaves the others', async () => {
    const dir = path.join(agentDir, 'Saver');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'portrait.webp'), 'old');
    fs.writeFileSync(path.join(dir, 'portrait.light.png'), 'light');

    const result = await save('Saver', 'default', png);
    assert.equal(result.success, true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['portrait.light.png', 'portrait.png']);
    assert.deepEqual(Object.keys(result.portraits).sort(), ['default', 'light']);

    assert.ok((await save('Saver', 'smile', { type: 'image/jpeg', buffer: png.buffer })).error, '只有 default 和 light 两个版本');
    assert.equal(fs.existsSync(path.join(dir, 'portrait.smile.jpg')), false);

    // 视频可以比图片大；换成视频以后同一版本的图片删掉
    const video = await save('Saver', 'light', { type: 'video/webm', buffer: new ArrayBuffer(21 * 1024 * 1024) });
    assert.equal(video.success, true);
    assert.match(video.portraits.light, /\/Saver\/portrait\.light\.webm\?v=\d+$/);
    await save('Saver', 'light', { type: 'image/apng', buffer: png.buffer });
    assert.ok(fs.existsSync(path.join(dir, 'portrait.light.png')));
    assert.equal(fs.existsSync(path.join(dir, 'portrait.light.webm')), false);

    const removed = await remove('Saver', 'default');
    assert.equal(removed.success, true);
    assert.equal(removed.portraits, null, '没有默认立绘就不算有立绘');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['portrait.light.png']);
});

test('saving rejects unknown agents, bad variants, unsupported types and empty or oversized images', async () => {
    fs.mkdirSync(path.join(agentDir, 'Strict'));
    assert.ok((await save('../Strict', 'default', png)).error);
    assert.ok((await save('Missing', 'default', png)).error);
    assert.ok((await save('Strict', '../x', png)).error);
    assert.ok((await save('Strict', 'default', { type: 'image/svg+xml', buffer: png.buffer })).error);
    assert.ok((await save('Strict', 'default', { type: 'image/png', buffer: new ArrayBuffer(0) })).error);
    assert.ok((await save('Strict', 'default', { type: 'image/png', buffer: new ArrayBuffer(20 * 1024 * 1024 + 1) })).error);
    assert.ok((await save('Strict', 'default', { type: 'video/mp4', buffer: new ArrayBuffer(64 * 1024 * 1024 + 1) })).error);
    assert.deepEqual(fs.readdirSync(path.join(agentDir, 'Strict')), []);
    assert.ok((await remove('..', 'default')).error);
});

test('removing a portrait, changing its format or deleting the agent drops its cached display copy', { skip: sharpUnavailable }, async () => {
    const sharp = require('sharp');
    const big = (file) => sharp({ create: { width: 4000, height: 6000, channels: 3, background: { r: 90, g: 120, b: 200 } } }).png().toFile(file);
    const cachedOf = (url) => fileURLToPath(url.replace(/\?v=\d+$/, ''));
    const dir = path.join(agentDir, 'Cached');
    fs.mkdirSync(dir);
    await big(path.join(dir, 'portrait.png'));
    await big(path.join(dir, 'portrait.light.png'));
    const first = await getPortraits('Cached');
    const light = cachedOf(first.light);
    assert.equal(path.dirname(light), path.join(root, 'PortraitCache'));

    await remove('Cached', 'light');
    assert.equal(fs.existsSync(light), false, '删掉的立绘不留缩小图');

    // 换成另一种格式：原来那张 png 的缩小图跟着删掉
    const oldDefault = cachedOf(first.default);
    const jpeg = await sharp({ create: { width: 4000, height: 6000, channels: 3, background: { r: 10, g: 10, b: 10 } } }).jpeg().toBuffer();
    assert.equal((await save('Cached', 'default', { type: 'image/jpeg', buffer: jpeg })).success, true);
    assert.equal(fs.existsSync(oldDefault), false);
    const current = cachedOf((await getPortraits('Cached')).default);
    assert.ok(fs.existsSync(current));

    assert.equal((await handlers.get('delete-agent')({}, 'Cached')).success, true);
    assert.equal(fs.existsSync(current), false, '删掉助手不留缩小图');
});
