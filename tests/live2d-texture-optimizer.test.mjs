import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const extra = require('fs-extra');
const { optimizeLive2DTextures } = require('../modules/deskpet/live2dTextureOptimizer');
async function fixture(t, width = 2560, height = 1280) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live2d-opt-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = path.join(root, 'deskpet', 'model');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'texture.png');
    await sharp({ create: { width, height, channels: 4, background: { r: 100, g: 180, b: 30, alpha: 0.5 } } }).png().toFile(file);
    const model = path.join(dir, 'model.model3.json');
    await fs.writeFile(model, JSON.stringify({ FileReferences: { Textures: ['texture.png'] } }));
    return { root, dir, file, model, allowed: path.join(root, 'deskpet') };
}
test('PNG atlas is bounded, retains alpha/path/config and is not re-encoded on repeated requests', async t => {
    const f = await fixture(t);
    const config = await fs.readFile(f.model);
    await Promise.all([optimizeLive2DTextures(f.model, f.allowed), optimizeLive2DTextures(f.model, f.allowed)]);
    const meta = await sharp(f.file).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height, meta.hasAlpha], ['png', 1280, 640, true]);
    const bytes = await fs.readFile(f.file);
    await optimizeLive2DTextures(f.model, f.allowed);
    assert.deepEqual(await fs.readFile(f.file), bytes);
    assert.deepEqual(await fs.readFile(f.model), config);
    assert.deepEqual((await fs.readdir(f.dir)).sort(), ['model.model3.json', 'texture.png']);
});
test('square 8K atlas becomes 1280 square', async t => {
    const f = await fixture(t, 8192, 8192);
    await optimizeLive2DTextures(f.model, f.allowed);
    const meta = await sharp(f.file).metadata();
    assert.deepEqual([meta.width, meta.height], [1280, 1280]);
});
test('small textures and unreferenced PNGs are untouched; traversal references rejected', async t => {
    const f = await fixture(t, 100, 200);
    const original = await fs.readFile(f.file);
    const outside = path.join(f.root, 'outside.png');
    await fs.copyFile(f.file, outside);
    await fs.writeFile(f.model, JSON.stringify({ FileReferences: { Textures: ['texture.png', '../../outside.png', 'https://bad/a.png'] } }));
    await fs.writeFile(path.join(f.dir, 'unused.png'), 'untouched');
    await optimizeLive2DTextures(f.model, f.allowed);
    assert.deepEqual(await fs.readFile(f.file), original);
    assert.deepEqual(await fs.readFile(outside), original);
    assert.equal(await fs.readFile(path.join(f.dir, 'unused.png'), 'utf8'), 'untouched');
});
test('rename failure preserves original atlas bytes and removes temporary output', async t => {
    const f = await fixture(t);
    const original = await fs.readFile(f.file);
    const rename = extra.rename;
    extra.rename = async () => { throw new Error('injected rename failure'); };
    try { await optimizeLive2DTextures(f.model, f.allowed); }
    finally { extra.rename = rename; }
    assert.deepEqual(await fs.readFile(f.file), original);
    assert.ok(!(await fs.readdir(f.dir)).some(n => n.endsWith('.tmp')));
});
test('outside model and symlinked texture are not rewritten', async t => {
    const f = await fixture(t);
    const original = await fs.readFile(f.file);
    await optimizeLive2DTextures(f.model, path.join(f.root, 'other'));
    assert.deepEqual(await fs.readFile(f.file), original);
    const external = path.join(f.root, 'external.png');
    await fs.copyFile(f.file, external);
    await fs.unlink(f.file);
    try { await fs.symlink(external, f.file); }
    catch (e) { if (e.code === 'EPERM') { t.skip('symlink privilege unavailable'); return; } throw e; }
    await optimizeLive2DTextures(f.model, f.allowed);
    assert.deepEqual(await fs.readFile(external), original);
});