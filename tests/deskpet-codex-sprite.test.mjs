import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ANIMATION_SPEEDS, animationCell, lookCell, spriteFps, spriteState } from '../DeskPetmodules/spriteAnimation.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const JSZip = require('jszip');
const { readCodexPet } = require('../modules/deskpet/codexPet');
const outfits = require('../modules/deskpet/outfits');
const { planImport } = require('../modules/deskpet/settingsPage');
const { extractOutfitZip } = require('../modules/deskpet/zipImport');
const { createPetAssets } = require('../modules/deskpet/petAssets');
const { fingerprintOf } = require('../modules/deskpet/petPreviews');

async function fixture(t, version = 1) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pet-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = path.join(root, 'Agents', 'Nova', 'deskpet', 'Rana');
    await fs.mkdir(dir, { recursive: true });
    await sharp({ create: { width: 1536, height: version === 2 ? 2288 : 1872, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(path.join(dir, 'spritesheet.png'));
    const manifest = { id: 'rana', displayName: 'Rana', description: 'Sprite pet', spritesheetPath: 'spritesheet.png' };
    if (version === 2) manifest.spriteVersionNumber = 2;
    await fs.writeFile(path.join(dir, 'pet.json'), JSON.stringify(manifest));
    return { root, dir, manifest };
}

test('v1 packages without a version and v2 packages are outfits without Cubism Core', async t => {
    for (const version of [1, 2]) {
        const { root, dir } = await fixture(t, version);
        const pet = await readCodexPet(dir);
        assert.equal(pet.version, version);
        const listed = await outfits.listOutfits(path.join(root, 'Agents', 'Nova'));
        assert.equal(listed.length, 1);
        assert.equal(listed[0].kind, 'sprite');
        assert.equal(listed[0].name, 'Rana');
        assert.equal(listed[0].portraits, null, 'an atlas must never appear as an entire portrait');
        assert.equal(listed[0].needsCore, false);
        assert.equal(outfits.defaultOutfit(listed).id, 'Rana');
        const assets = await createPetAssets({ paths: { projectRoot: root, appDataRoot: root, agentDir: path.join(root, 'Agents') } }).resolveAssets('Nova', 'Rana');
        assert.equal(assets.sprite.version, version);
        assert.match(assets.sprite.sheetUrl, /\/deskpet\/Rana\/spritesheet\.png$/);
        assert.equal(assets.coreUrl, null);
    }
});

test('sprite manifests reject external, parent and mismatched-version sheets', async t => {
    const { dir, manifest } = await fixture(t);
    for (const extra of [{ spritesheetPath: '../spritesheet.png' }, { spritesheetPath: 'https://example.com/a.png' }, { spriteVersionNumber: 2 }, { spriteVersionNumber: 99 }]) {
        await fs.writeFile(path.join(dir, 'pet.json'), JSON.stringify({ ...manifest, ...extra }));
        assert.equal(await readCodexPet(dir), null);
        assert.equal(await outfits.inspectFolder(dir), null, 'invalid packages must not fall back to showing the whole atlas');
    }
});

test('an exported spritesheet imports by itself and previews change when its pixels change', async t => {
    const { dir } = await fixture(t);
    await fs.unlink(path.join(dir, 'pet.json'));
    const sprite = await readCodexPet(dir);
    assert.equal(sprite.version, 1);
    const outfit = { kind: 'sprite', sprite };
    const before = await fingerprintOf(outfit);
    const sheet = path.join(dir, 'spritesheet.png');
    const bytes = await fs.readFile(sheet);
    await fs.writeFile(sheet, Buffer.concat([bytes, Buffer.from('cache-test')]));
    assert.notEqual(await fingerprintOf(outfit), before);
});

test('pet.json and nested Codex ZIP packages preserve the manifest and atlas together', async t => {
    const { root, dir } = await fixture(t);
    assert.deepEqual(planImport([path.join(dir, 'pet.json')]), { kind: 'folder', source: dir, name: 'Rana' });
    const zip = new JSZip();
    zip.file('download/Rana/pet.json', await fs.readFile(path.join(dir, 'pet.json')));
    zip.file('download/Rana/spritesheet.png', await fs.readFile(path.join(dir, 'spritesheet.png')));
    zip.file('download/notes.txt', 'not part of the pet');
    const target = path.join(root, 'unpacked');
    const result = await extractOutfitZip(await zip.generateAsync({ type: 'nodebuffer' }), target, { limits: { files: 20, bytes: 1024 * 1024 }, imageExtensions: outfits.IMAGE_EXTENSIONS });
    assert.equal(result.success, true);
    assert.equal((await readCodexPet(target)).name, 'Rana');
    assert.deepEqual((await fs.readdir(target)).sort(), ['pet.json', 'spritesheet.png']);
});

test('task, approval and drag states select meaningful rows without consuming unused cells', () => {
    assert.equal(spriteState({ frame: { state: 'tool' } }), 'running');
    assert.equal(spriteState({ frame: { state: 'thinking' }, approval: true }), 'waiting');
    assert.equal(spriteState({ frame: { state: 'error' } }), 'failed');
    assert.equal(spriteState({ held: true, velocity: -80 }), 'left');
    assert.equal(spriteState({ walk: 'right' }), 'right');
    assert.equal(spriteState({ action: 'review' }), 'review');
    for (const [state, frames] of [['idle', 6], ['waving', 4], ['jumping', 5]]) {
        for (let ms = 0; ms < 3000; ms += 17) assert.ok(animationCell(state, ms).column < frames);
    }
});

test('v2 gaze follows sixteen clockwise directions, with an idle deadzone and no v1 look rows', () => {
    assert.equal(lookCell(0, 0, 2), null);
    assert.equal(lookCell(0, 1, 1), null);
    assert.deepEqual(lookCell(0, 1, 2), { row: 9, column: 0 });
    assert.deepEqual(lookCell(1, 0, 2), { row: 9, column: 4 });
    assert.deepEqual(lookCell(0, -1, 2), { row: 10, column: 0 });
    assert.deepEqual(lookCell(-1, 0, 2), { row: 10, column: 4 });
    for (let i = 0; i < 16; i++) {
        const angle = i * Math.PI / 8;
        assert.deepEqual(lookCell(Math.sin(angle), Math.cos(angle), 2), { row: 9 + Math.floor(i / 8), column: i % 8 });
    }
});

test('sprite frame rate is calm by default and follows the animation speed setting', () => {
    // 待机 6 帧一圈至少 1.5 秒，不再像以前 0.6 秒转一圈
    assert.ok(6 * 1000 / spriteFps('idle') >= 1500);
    assert.ok(spriteFps(true) <= 6 && spriteFps('idle') < spriteFps(true) && spriteFps('sleep') < spriteFps('idle'));
    assert.ok(spriteFps(true, 'slow') < spriteFps(true) && spriteFps(true) < spriteFps(true, 'fast'));
    assert.equal(spriteFps(true, 'warp'), spriteFps(true));
    assert.ok(spriteFps('sleep', 'slow') >= 1);
    assert.deepEqual(require('../modules/deskpet/petPrefs.js').ANIMATION_SPEEDS, Object.keys(ANIMATION_SPEEDS));
});
