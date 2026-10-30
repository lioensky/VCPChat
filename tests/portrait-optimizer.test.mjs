import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { optimizePortraitBuffer, migratePortraits, withPortraitLock } = require('../modules/services/portraitOptimizer');
const image = (width, height) => sharp({ create: { width, height, channels: 4, background: { r: 100, g: 150, b: 200, alpha: 0.4 } } }).png().toBuffer();

test('1080p bounds preserve aspect, alpha and small images', async () => {
    for (const [w, h, expected] of [[2160, 3840, [1080, 1920]], [3840, 2160, [1920, 1080]], [2400, 2400, [1080, 1080]], [200, 300, [200, 300]], [4000, 1000, [1920, 480]]]) {
        const output = await optimizePortraitBuffer(await image(w, h));
        const meta = await sharp(output).metadata();
        assert.deepEqual([meta.width, meta.height], expected);
        assert.equal(meta.format, 'webp');
        assert.equal(meta.hasAlpha, true);
        assert.equal(await optimizePortraitBuffer(output), null, 'bounded WebP is not recompressed');
    }
});

test('migration is concurrent-safe, removes source only after publication and skips unrelated/model files', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-opt-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'portrait.png'), await image(2160, 3840));
    await fs.writeFile(path.join(dir, 'avatar.png'), await image(10, 10));
    await fs.mkdir(path.join(dir, 'deskpet'));
    await fs.writeFile(path.join(dir, 'deskpet', 'portrait.png'), 'model asset');
    await Promise.all([migratePortraits(dir), migratePortraits(dir)]);
    const target = path.join(dir, 'portrait.webp');
    assert.equal((await sharp(target).metadata()).height, 1920);
    await assert.rejects(fs.stat(path.join(dir, 'portrait.png')), { code: 'ENOENT' });
    const bytes = await fs.readFile(target);
    await migratePortraits(dir);
    assert.deepEqual(await fs.readFile(target), bytes);
    assert.equal(await fs.readFile(path.join(dir, 'deskpet', 'portrait.png'), 'utf8'), 'model asset');
    assert.ok((await fs.stat(path.join(dir, 'avatar.png'))).isFile());
    assert.ok(!(await fs.readdir(dir)).some(name => name.endsWith('.tmp')));
});

test('conflicts and unreadable files remain intact', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-conflict-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const original = await image(100, 200);
    const existing = await sharp(await image(30, 40)).webp().toBuffer();
    await fs.writeFile(path.join(dir, 'portrait.png'), original);
    await fs.writeFile(path.join(dir, 'portrait.webp'), existing);
    await fs.writeFile(path.join(dir, 'portrait.broken.jpg'), 'broken');
    await migratePortraits(dir);
    assert.deepEqual(await fs.readFile(path.join(dir, 'portrait.png')), original);
    assert.deepEqual(await fs.readFile(path.join(dir, 'portrait.webp')), existing);
    assert.equal(await fs.readFile(path.join(dir, 'portrait.broken.jpg'), 'utf8'), 'broken');
});

test('APNG control chunk is bypassed before any decode', async () => {
    const png = await image(10, 20);
    const chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8);
    chunk.write('acTL', 4);
    const apng = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
    assert.equal(await optimizePortraitBuffer(apng), null);
});

test('directory lock survives a failed operation and serializes mutations', async () => {
    const events = [];
    await Promise.allSettled([
        withPortraitLock('lock-test', async () => { events.push(1); throw new Error('failure'); }),
        withPortraitLock('lock-test', async () => events.push(2))
    ]);
    assert.deepEqual(events, [1, 2]);
});
test('failed publication retains original bytes and cleans temporary files', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-fail-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const original = await image(100, 200);
    const source = path.join(dir, 'portrait.png');
    await fs.writeFile(source, original);
    const extra = require('fs-extra');
    const link = extra.link;
    extra.link = async () => { throw new Error('injected publication failure'); };
    try { await migratePortraits(dir); }
    finally { extra.link = link; }
    assert.deepEqual(await fs.readFile(source), original);
    assert.deepEqual(await fs.readdir(dir), ['portrait.png']);
});

test('animated WebP is never flattened', async () => {
    const frames = Buffer.alloc(8 * 16 * 4, 180);
    frames.fill(40, 8 * 8 * 4);
    const animated = await sharp(frames, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } })
        .webp({ delay: [100, 100], loop: 0 }).toBuffer();
    assert.equal((await sharp(animated).metadata()).pages, 2);
    assert.equal(await optimizePortraitBuffer(animated), null);
});
test('opaque RGBA PNG permits WebP to omit redundant alpha and migrates successfully', async t => {
    const png = await sharp({ create: {
        width: 1248, height: 1824, channels: 4,
        background: { r: 100, g: 150, b: 200, alpha: 1 }
    } }).png().toBuffer();
    assert.equal((await sharp(png).metadata()).hasAlpha, true);
    const output = await optimizePortraitBuffer(png);
    const meta = await sharp(output).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 1080, 1578]);
    assert.equal((await sharp(output).stats()).isOpaque, true);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-opaque-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'portrait.png'), png);
    await migratePortraits(dir);
    assert.deepEqual(await fs.readdir(dir), ['portrait.webp']);
    assert.equal((await sharp(path.join(dir, 'portrait.webp')).metadata()).width, 1080);
});