import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPetStateStore, rememberFigure, MAX_REMEMBERED_FIGURES } = require('../modules/deskpet/petState.js');
const { applyTrayState, refreshWhenChanged } = require('../modules/deskpet/petTray.js');

function tempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-state-'));
    return path.join(dir, 'deskpet', 'state.json');
}

test('saves made back to back all land, and a read waits for them', async () => {
    const file = tempFile();
    const store = createPetStateStore({ file });
    store.save('Nova', { x: 10, y: 20 });
    store.save('Nova', { outfit: 'maid' });
    store.save('Coco', { scale: 1.5 });
    const state = await store.read();
    assert.equal(state.Nova.x, 10);
    assert.equal(state.Nova.outfit, 'maid');
    assert.equal(state.Coco.scale, 1.5);
    // 记大小、位置时标上按哪一版尺寸算的；只改形象的不标
    assert.ok(state.Nova.sizeVersion >= 2);
    assert.ok(state.Coco.sizeVersion >= 2);
    assert.equal(fs.existsSync(`${file}.tmp`), false, 'no half-written temp file is left behind');
});

test('a corrupt state file is kept as .bad instead of being overwritten silently', async () => {
    const file = tempFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"Nova": {"x": 1');
    const store = createPetStateStore({ file });
    assert.deepEqual(await store.read(), {});
    await store.save('Nova', { outfit: 'tech' });
    assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), '{"Nova": {"x": 1');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { Nova: { outfit: 'tech' } });
});

test('removing an agent drops only that agent and skips the write when it was never saved', async () => {
    const file = tempFile();
    const store = createPetStateStore({ file });
    await store.save('Nova', { outfit: 'tech' });
    await store.save('Coco', { outfit: 'chibi' });
    await store.remove('Nova');
    assert.deepEqual(Object.keys(await store.read()), ['Coco']);
    const before = fs.statSync(file).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.remove('Ghost');
    assert.equal(fs.statSync(file).mtimeMs, before);
});

test('remembered figure aspects keep only the most recent outfits', () => {
    let saved = {};
    for (let i = 0; i < MAX_REMEMBERED_FIGURES + 3; i += 1) saved = { figures: rememberFigure(saved, `o${i}`, 1.5) };
    const keys = Object.keys(saved.figures);
    assert.equal(keys.length, MAX_REMEMBERED_FIGURES);
    assert.equal(keys.at(-1), `o${MAX_REMEMBERED_FIGURES + 2}`);
    assert.ok(!keys.includes('o0'));
    // 再量一次旧的那套：挪到最新，不会被先挤掉
    const again = rememberFigure(saved, 'o3', 2);
    assert.equal(Object.keys(again).at(-1), 'o3');
});

test('tray menu: state-only changes update the built menu, text changes rebuild it', () => {
    let items = [{ label: '桌宠', submenu: [{ id: 'dnd', label: '免打扰', type: 'checkbox', checked: false, click() {} }] }];
    const rebuilds = [];
    const refresh = refreshWhenChanged(() => items, (structureChanged) => rebuilds.push(structureChanged));
    refresh();
    refresh();
    assert.deepEqual(rebuilds, [true], 'nothing changed: no rebuild');
    items = [{ label: '桌宠', submenu: [{ id: 'dnd', label: '免打扰', type: 'checkbox', checked: true, click() {} }] }];
    refresh();
    assert.deepEqual(rebuilds, [true, false]);
    const built = { dnd: { checked: false } };
    assert.equal(applyTrayState({ getMenuItemById: (id) => built[id] }, items), true);
    assert.equal(built.dnd.checked, true);
    // 建好的菜单里少了这一项：要重建
    assert.equal(applyTrayState({ getMenuItemById: () => null }, items), false);
    items = [{ label: '桌宠', submenu: [{ id: 'dnd', label: '勿扰', type: 'checkbox', checked: true, click() {} }] }];
    refresh();
    assert.deepEqual(rebuilds, [true, false, true]);
});
