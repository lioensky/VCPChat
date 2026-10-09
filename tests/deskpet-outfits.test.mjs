import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { measureSilhouette, silhouetteAspect, fitSilhouette } from '../DeskPetmodules/figure.js';

const require = createRequire(import.meta.url);
const outfits = require('../modules/deskpet/outfits.js');
const prefs = require('../modules/deskpet/petPrefs.js');

function makeAgent(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-outfits-'));
    for (const [rel, content] of Object.entries(files)) {
        const file = path.join(root, ...rel.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return root;
}

const rel = (root, file) => (file ? path.relative(root, file).split(path.sep).join('/') : null);

// ---- 换装：目录约定 ----

test('every folder under deskpet/ is an outfit, the old single-model layout keeps working', async () => {
    const root = makeAgent({
        'portrait.png': 'x',
        'portrait.happy.png': 'x',
        'deskpet/nova.model3.json': '{}',
        'deskpet/Tech/runtime/tech.model3.json': '{}',
        'deskpet/Tech/runtime/tech.2048/texture_00.png': 'x',
        'deskpet/Maid/portrait.png': 'x',
        'deskpet/Maid/happy.png': 'x',
        'deskpet/Maid/outfit.json': JSON.stringify({ name: '女仆', order: 1 }),
        'deskpet/Chibi/nova-chibi-simple.png': 'x',
        'deskpet/Mesh/nova.puppet.json': '{}',
        'deskpet/Mesh/base.png': 'x',
        'deskpet/empty/readme.txt': 'nothing here',
    });
    const list = await outfits.listOutfits(root, { hasCore: true });
    assert.deepEqual(list.map((o) => o.id), [':root', 'Maid', 'Chibi', 'Mesh', 'Tech', ':portrait'], '默认在前，order 优先，其次按名字，助手立绘在最后');
    const byId = Object.fromEntries(list.map((o) => [o.id, o]));
    assert.equal(byId[':root'].kind, 'live2d');
    assert.equal(rel(root, byId[':root'].live2d), 'deskpet/nova.model3.json');
    assert.equal(byId[':root'].name, '默认');
    assert.equal(rel(root, byId.Tech.live2d), 'deskpet/Tech/runtime/tech.model3.json', '模型可以在更深的子文件夹里');
    assert.equal(byId.Tech.portraits, null, 'Live2D 的贴图不能当立绘');
    assert.equal(byId.Maid.name, '女仆');
    assert.equal(byId.Maid.kind, 'portrait');
    assert.equal(rel(root, byId.Maid.portraits.default), 'deskpet/Maid/portrait.png');
    assert.equal(rel(root, byId.Maid.portraits.happy), 'deskpet/Maid/happy.png', '差分也可以直接用情绪键起名');
    assert.equal(rel(root, byId.Chibi.portraits.default), 'deskpet/Chibi/nova-chibi-simple.png', '只放一张图也算一套');
    assert.equal(byId.Mesh.kind, 'puppet');
    assert.equal(byId.Mesh.portraits, null, '网格立绘的切块不能当立绘');
    assert.equal(byId[':portrait'].kind, 'portrait');
    assert.ok(byId[':portrait'].portraits.happy);
    assert.equal(outfits.outfitLabel(byId.Maid), '女仆（立绘）');
    assert.equal(outfits.outfitLabel(byId[':portrait']), '立绘');
});

test('without a choice the pet looks like before: Live2D when Core is there, else the mesh, else portraits', async () => {
    const root = makeAgent({
        'portrait.png': 'x',
        'deskpet/A-Maid/portrait.png': 'x',
        'deskpet/B-Mao/Mao.model3.json': '{}',
        'deskpet/C-Mesh/nova.puppet.json': '{}',
    });
    const withCore = await outfits.listOutfits(root, { hasCore: true });
    assert.equal(outfits.defaultOutfit(withCore).id, 'B-Mao');
    const noCore = await outfits.listOutfits(root, { hasCore: false });
    assert.equal(noCore.find((o) => o.id === 'B-Mao').kind, 'live2d', '缺 Core 的 Live2D 还是 Live2D，页面会提示');
    assert.equal(outfits.defaultOutfit(noCore).id, 'C-Mesh');
    assert.equal(outfits.pickOutfit(noCore, 'A-Maid').id, 'A-Maid', '记住的选择优先');
    assert.equal(outfits.pickOutfit(noCore, 'deleted').id, 'C-Mesh', '选过的那套删了就回到默认');

    const portraitsOnly = await outfits.listOutfits(makeAgent({ 'portrait.png': 'x' }));
    assert.deepEqual(portraitsOnly.map((o) => o.id), [':portrait']);
    assert.equal(outfits.defaultOutfit(portraitsOnly).id, ':portrait');
    assert.deepEqual(await outfits.listOutfits(makeAgent({ 'avatar.png': 'x' })), [], '只有头像时没有可换的形象');
    assert.equal(outfits.defaultOutfit([]), null);
});

test('outfit ids stored in state.json stay plain folder names', () => {
    assert.ok(outfits.isOutfitId('Maid'));
    assert.ok(outfits.isOutfitId(':root'));
    for (const bad of ['', '..', '.', 'a/b', 'a\\b', 42, null]) assert.equal(outfits.isOutfitId(bad), false, String(bad));
});

// ---- 全身显示：窗口跟着形象的长宽比 ----

test('tall full-body figures get a taller, narrower window, chibi ones a shorter one, unknown stays as before', () => {
    assert.deepEqual(prefs.windowSizeForScale(1), { width: 360, height: 464 });
    assert.deepEqual(prefs.windowSizeForScale(1, null), prefs.windowSizeForScale(1));
    const full = prefs.windowSizeForScale(1, 2.8);
    const chibi = prefs.windowSizeForScale(1, 1.3);
    assert.ok(full.height > chibi.height, '全身像更高');
    assert.ok(full.width <= chibi.width, '全身像更窄');
    assert.ok(full.width >= 360, '再窄也放得下气泡');
    for (const aspect of [0.5, 1, 1.3, 2.8, 5]) {
        for (const scale of [0.5, 1, 1.35, 2]) {
            const size = prefs.windowSizeForScale(scale, aspect);
            assert.equal(size.width % 4, 0);
            assert.equal(size.height % 4, 0);
        }
    }
    assert.ok(prefs.maxScaleForWorkArea({ height: 1040 }, 2.8) < prefs.maxScaleForWorkArea({ height: 1040 }), '全身像在同一块屏上能放的最大档位更小');
    assert.equal(prefs.normalizeAspect(2.8371), 2.84);
    for (const bad of [0, -1, NaN, '1.5x', 100]) assert.equal(prefs.normalizeAspect(bad), null, String(bad));
});

test('switching to a full-body outfit keeps the feet where they were', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    const before = { x: 1200, y: 420, ...prefs.windowSizeForScale(1, 1.3) };
    const after = prefs.resizeAnchored(before, prefs.windowSizeForScale(1, 2.8), area);
    assert.equal(after.x + after.width / 2, before.x + before.width / 2);
    assert.equal(after.y + after.height, before.y + before.height);
});

// ---- 轮廓：按不透明像素摆，脚底贴底，头的位置 ----

// 画一个「人」：头是圆，身子是窄长条，四周留透明边
function drawFigure({ width, height, headR, headCx, headTop, bodyW, bodyBottom }) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    const cy = headTop + headR;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const inHead = (x - headCx) ** 2 + (y - cy) ** 2 <= headR ** 2;
            const inBody = y > cy && y < bodyBottom && Math.abs(x - headCx) <= bodyW / 2;
            if (inHead || inBody) pixels[(y * width + x) * 4 + 3] = 255;
        }
    }
    return pixels;
}

test('the silhouette skips transparent margins and finds the head', () => {
    const fig = { width: 200, height: 400, headR: 20, headCx: 120, headTop: 30, bodyW: 30, bodyBottom: 370 };
    const s = measureSilhouette(drawFigure(fig), fig.width, fig.height);
    assert.equal(s.top, 30);
    assert.equal(s.bottom, 370, '脚底是最后一行不透明像素，下面的透明边不算');
    assert.ok(Math.abs(s.left - 100) <= 1 && Math.abs(s.right - 141) <= 1);
    assert.ok(Math.abs(s.head.x - 120) <= 1, '头的中线');
    assert.equal(s.head.y, 30);
    assert.ok(s.head.width >= 30 && s.head.width <= 41, `头宽 ${s.head.width}`);
    assert.ok(Math.abs(silhouetteAspect(s) - 340 / 41) < 0.5);
    assert.equal(measureSilhouette(new Uint8ClampedArray(16 * 16 * 4), 16, 16), null, '全透明');

    // WebGL 读回来的行从下往上
    const flipped = new Uint8ClampedArray(fig.width * fig.height * 4);
    const src = drawFigure(fig);
    for (let y = 0; y < fig.height; y++) flipped.set(src.subarray(y * fig.width * 4, (y + 1) * fig.width * 4), (fig.height - 1 - y) * fig.width * 4);
    assert.deepEqual(measureSilhouette(flipped, fig.width, fig.height, { flipY: true }), s);
});

test('a chibi head is most of the body and the bubble anchor follows it', () => {
    const fig = { width: 300, height: 300, headR: 90, headCx: 150, headTop: 20, bodyW: 120, bodyBottom: 290 };
    const s = measureSilhouette(drawFigure(fig), fig.width, fig.height);
    assert.ok(s.head.width > 120, `Q 版的头很宽：${s.head.width}`);
    assert.ok(silhouetteAspect(s) < 1.7);
});

test('wings or props reaching up beside the head do not make the head as wide as the figure', () => {
    const fig = { width: 400, height: 400, headR: 30, headCx: 200, headTop: 40, bodyW: 60, bodyBottom: 380 };
    const pixels = drawFigure(fig);
    // 两边的翅膀尖伸到头顶往下 10% 那么高，和头隔着一大段空白
    for (let y = 60; y < 300; y++) {
        for (const [a, b] of [[10, 90], [310, 390]]) for (let x = a; x < b; x++) pixels[(y * fig.width + x) * 4 + 3] = 255;
    }
    const s = measureSilhouette(pixels, fig.width, fig.height);
    assert.ok(s.right - s.left > 350, '包围盒照样包住翅膀');
    assert.ok(Math.abs(s.head.x - 200) <= 2, `头的中线 ${s.head.x}`);
    assert.ok(s.head.width >= 50 && s.head.width <= 70, `头宽只算头：${s.head.width}`);
});

test('fitting puts the feet on the window bottom and the figure under the bubble area', () => {
    const box = { left: 100, top: 30, right: 140, bottom: 370 };
    const fit = fitSilhouette(box, { width: 280, height: 692, topReserve: 150 });
    const feet = fit.y + box.bottom * fit.scale;
    const headTop = fit.y + box.top * fit.scale;
    const center = fit.x + ((box.left + box.right) / 2) * fit.scale;
    assert.ok(Math.abs(feet - 692) < 1e-6, '脚底贴窗口底边');
    assert.ok(headTop >= 150 - 1e-6, '头顶不进气泡区');
    assert.ok(Math.abs(center - 140) < 1e-6, '左右居中');
    assert.equal(fitSilhouette({ left: 0, right: 0, top: 0, bottom: 0 }, { width: 10, height: 10, topReserve: 0 }), null);
    // 脚下留出小胶囊的位置：脚底落在留白上沿，头顶照样不进气泡区
    const lifted = fitSilhouette(box, { width: 280, height: 692, topReserve: 150, bottomReserve: 54 });
    assert.ok(Math.abs(lifted.y + box.bottom * lifted.scale - (692 - 54)) < 1e-6, '脚底在小胶囊上面');
    assert.ok(lifted.y + box.top * lifted.scale >= 150 - 1e-6);
});

// ---- 设置页：卡片介绍、导入 ----

test('cards describe each outfit, outfit.json can say it in its own words', async () => {
    const root = makeAgent({
        'deskpet/Maid/portrait.png': 'x',
        'deskpet/Maid/happy.png': 'x',
        'deskpet/Maid/sad.png': 'x',
        'deskpet/Q/one.png': 'x',
        'deskpet/Q/outfit.json': JSON.stringify({ name: 'Q 版', description: '大头小身子' }),
        'deskpet/Mesh/nova.puppet.json': '{}',
    });
    const list = await outfits.listOutfits(root);
    const by = (id) => list.find((o) => o.id === id);
    assert.equal(outfits.outfitDescription(by('Q')), '大头小身子');
    assert.match(outfits.outfitDescription(by('Maid')), /3 张表情/);
    assert.match(outfits.outfitDescription(by('Mesh')), /网格立绘/);
    assert.equal((await outfits.inspectFolder(path.join(root, 'deskpet', 'Mesh'))).kind, 'puppet');
    assert.equal(await outfits.inspectFolder(path.join(root, 'deskpet', 'nothing')), null);
});

test('a Live2D outfit that falls back to its portraits still says it needs Cubism Core', async () => {
    const root = makeAgent({
        'deskpet/Tech/nova.model3.json': '{}',
        'deskpet/Tech/portrait.png': 'x',
        'deskpet/Plain/portrait.png': 'x',
    });
    const without = await outfits.listOutfits(root, { hasCore: false });
    const tech = without.find((o) => o.id === 'Tech');
    assert.equal(tech.kind, 'portrait');
    assert.equal(tech.needsCore, true);
    assert.match(outfits.outfitDescription(tech), /Cubism Core/);
    assert.equal(without.find((o) => o.id === 'Plain').needsCore, false);
    const withCore = (await outfits.listOutfits(root, { hasCore: true })).find((o) => o.id === 'Tech');
    assert.equal(withCore.kind, 'live2d');
    assert.equal(withCore.needsCore, false);
    assert.match(outfits.outfitDescription(withCore), /Live2D 模型，会眨眼/);
});

test('importing a model copies its folder, importing pictures copies just those pictures', () => {
    const { planImport } = require('../modules/deskpet/settingsPage.js');
    const model = planImport([path.join('C:', 'models', 'Nova', 'nova.model3.json')]);
    assert.deepEqual(model, { kind: 'folder', source: path.join('C:', 'models', 'Nova'), name: 'Nova' });
    const pictures = planImport([path.join('D', 'maid.png'), path.join('D', 'happy.webp'), path.join('D', 'notes.txt')]);
    assert.equal(pictures.kind, 'images');
    assert.equal(pictures.name, 'maid');
    assert.equal(pictures.files.length, 2);
    assert.equal(planImport([path.join('D', 'notes.txt')]), null);
});

test('a re-measured figure that differs only a little keeps the remembered ratio; a clipped silhouette is detected', async () => {
    const petPrefs = (await import('../modules/deskpet/petPrefs.js')).default;
    assert.equal(petPrefs.sameAspect(2.46, 2.4), true, 'breathing / idle motion while measuring');
    assert.equal(petPrefs.sameAspect(2.07, 2.4), false, 'a different outfit');
    assert.equal(petPrefs.sameAspect(null, 2.4), false);
    const { touchesEdge } = await import('../DeskPetmodules/figure.js');
    assert.equal(touchesEdge({ left: 0, top: 40, right: 200, bottom: 400 }, 300, 500), true);
    assert.equal(touchesEdge({ left: 50, top: 40, right: 250, bottom: 460 }, 300, 500), false);
    assert.equal(touchesEdge({ left: 50, top: 40, right: 250, bottom: 500 }, 300, 500), false, 'feet on the window bottom are expected');
    assert.equal(touchesEdge(null, 300, 500), false);
});
