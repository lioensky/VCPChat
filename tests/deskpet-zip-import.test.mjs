import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const iconv = require('iconv-lite');
const { extractOutfitZip, safeEntryPath, decodeName } = require('../modules/deskpet/zipImport.js');
const { planImport } = require('../modules/deskpet/settingsPage.js');
const { IMAGE_EXTENSIONS } = require('../modules/deskpet/outfits.js');

const LIMITS = { files: 50, bytes: 1024 * 1024 };

async function zipOf(files) {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) zip.file(name, content);
    return zip.generateAsync({ type: 'nodebuffer' });
}

function tempTarget() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-zip-')), 'outfit');
}

test('planImport 认出 .zip', () => {
    const plan = planImport([path.join('D', 'Hiyori.zip')]);
    assert.equal(plan.kind, 'zip');
    assert.equal(plan.name, 'Hiyori');
});

test('只解出模型所在那一层，跳过 __MACOSX', async () => {
    const buffer = await zipOf({
        'pack/readme.txt': 'hi',
        'pack/Hiyori/Hiyori.model3.json': '{}',
        'pack/Hiyori/Hiyori.moc3': 'moc',
        'pack/Hiyori/textures/t.png': 'png',
        '__MACOSX/pack/Hiyori/._Hiyori.moc3': 'junk',
    });
    const target = tempTarget();
    const result = await extractOutfitZip(buffer, target, { limits: LIMITS, imageExtensions: IMAGE_EXTENSIONS });
    assert.equal(result.success, true);
    assert.equal(result.kind, 'model');
    assert.equal(result.name, 'Hiyori');
    assert.deepEqual(fs.readdirSync(target).sort(), ['Hiyori.moc3', 'Hiyori.model3.json', 'textures']);
    assert.ok(fs.existsSync(path.join(target, 'textures', 't.png')));
});

test('没有模型时解出图片', async () => {
    const buffer = await zipOf({ 'imgs/happy.png': 'a', 'imgs/sad.webp': 'b', 'imgs/notes.txt': 'c' });
    const target = tempTarget();
    const result = await extractOutfitZip(buffer, target, { limits: LIMITS, imageExtensions: IMAGE_EXTENSIONS });
    assert.equal(result.kind, 'images');
    assert.deepEqual(fs.readdirSync(target).sort(), ['happy.png', 'sad.webp']);
});

test('认不出、超限、坏包都报错且不留文件夹', async () => {
    const target = tempTarget();
    const none = await extractOutfitZip(await zipOf({ 'a.txt': 'x' }), target, { limits: LIMITS, imageExtensions: IMAGE_EXTENSIONS });
    assert.equal(none.success, false);
    const big = await extractOutfitZip(await zipOf({ 'm.model3.json': '{}', 'big.bin': Buffer.alloc(2048) }), target, { limits: { files: 50, bytes: 1024 }, imageExtensions: IMAGE_EXTENSIONS });
    assert.equal(big.success, false);
    assert.equal(fs.existsSync(target), false);
    const many = await extractOutfitZip(await zipOf({ 'm.model3.json': '{}', 'a': '1', 'b': '2' }), target, { limits: { files: 2, bytes: LIMITS.bytes }, imageExtensions: IMAGE_EXTENSIONS });
    assert.equal(many.success, false);
    const broken = await extractOutfitZip(Buffer.from('not a zip'), target, { limits: LIMITS, imageExtensions: IMAGE_EXTENSIONS });
    assert.equal(broken.success, false);
});

test('路径穿越的条目不解出', () => {
    assert.equal(safeEntryPath('../evil.js'), null);
    assert.equal(safeEntryPath('a/../../evil.js'), null);
    assert.equal(safeEntryPath('/etc/passwd'), null);
    assert.equal(safeEntryPath('C:/x.js'), null);
    assert.equal(safeEntryPath('a\\b.png'), 'a/b.png');
});

test('非 UTF-8 文件名按 GBK 解', () => {
    assert.equal(decodeName(iconv.encode('模型.model3.json', 'gbk'), iconv), '模型.model3.json');
    assert.equal(decodeName(Buffer.from('模型.png', 'utf8'), iconv), '模型.png');
});
