import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const outfits = require('../modules/deskpet/outfits.js');
const handlers = require('../modules/deskpet/petHandlers.js');
const { createPetAssets } = require('../modules/deskpet/petAssets.js');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundledSprites = path.join(projectRoot, 'assets', 'deskpet', 'codex');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-builtin-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = path.join(root, 'agent');
    const bundle = path.join(root, 'nova');
    fs.mkdirSync(agent);
    fs.writeFileSync(path.join(agent, 'portrait.png'), 'existing portrait');
    for (const preset of ['tech', 'maid', 'chibi']) {
        const dir = path.join(bundle, preset);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'Nova.model3.json'), '{}');
        fs.writeFileSync(path.join(dir, 'portrait.png'), 'fallback');
        fs.writeFileSync(path.join(dir, 'outfit.json'), JSON.stringify({ name: `Nova ${preset}` }));
    }
    return { agent, bundle, options: { builtInDir: bundle, builtInSpriteDir: bundledSprites } };
}

test('a fresh Nova offers every bundled outfit without writing to its agent folder', async (t) => {
    const { agent, options } = fixture(t);
    const list = await outfits.listOutfits(agent, { ...options, hasCore: true, preferBuiltIn: true });
    assert.deepEqual(list.filter((o) => o.builtIn).map((o) => o.id), ['builtin:nova-maid', 'builtin:nova-chibi', 'builtin:codex-keqing', 'builtin:codex-rana']);
    assert.equal(outfits.defaultOutfit(list).id, 'builtin:nova-maid');
    assert.equal(outfits.pickOutfit(list, 'builtin:nova-tech').id, 'builtin:nova-maid', 'retired tech selection falls back safely');
    assert.equal(outfits.pickOutfit(list, 'builtin:nova-chibi').id, 'builtin:nova-chibi');
    assert.ok(outfits.isOutfitId('builtin:nova-chibi'));
    assert.deepEqual(fs.readdirSync(agent), ['portrait.png']);
    assert.equal(fs.readFileSync(path.join(agent, 'portrait.png'), 'utf8'), 'existing portrait');
});

test('custom models and non-Nova portraits stay the default, while built-ins remain selectable', async (t) => {
    const { agent, options } = fixture(t);
    const otherAgent = await outfits.listOutfits(agent, { ...options, hasCore: true });
    assert.equal(outfits.defaultOutfit(otherAgent).id, ':portrait');
    fs.mkdirSync(path.join(agent, 'deskpet', 'custom'), { recursive: true });
    fs.writeFileSync(path.join(agent, 'deskpet', 'custom', 'Custom.model3.json'), '{}');
    const nova = await outfits.listOutfits(agent, { ...options, hasCore: true, preferBuiltIn: true });
    assert.equal(outfits.defaultOutfit(nova).id, 'custom');
    assert.equal(outfits.pickOutfit(nova, 'builtin:nova-maid').id, 'builtin:nova-maid');
});

test('Nova falls back to portraits without Core while the bundled sprites stay animated', async (t) => {
    const { agent, options } = fixture(t);
    const list = await outfits.listOutfits(agent, { ...options, hasCore: false, preferBuiltIn: true });
    for (const o of list.filter((item) => item.builtIn)) {
        if (o.id.startsWith('builtin:codex-')) {
            assert.equal(o.kind, 'sprite');
            assert.equal(o.needsCore, false);
            assert.ok(o.sprite.sheet);
            continue;
        }
        assert.equal(o.kind, 'portrait');
        assert.ok(o.portraits.default);
        assert.ok(o.live2d, 'model becomes available again when Core is installed');
    }
    assert.equal(outfits.pickOutfit(list, 'removed-preset').id, 'builtin:nova-maid');
    // 设置页卡片说清楚这是 Live2D、缺 Core 才先用立绘；桌宠页面不再每次打开都弹红字
    assert.match(outfits.outfitDescription(list.find((o) => o.id === 'builtin:nova-maid')), /Cubism Core/);
});

test('bundled resources stay within their folders and never expose configuration or other app files', () => {
    const paths = { projectRoot, appDataRoot: path.join(projectRoot, 'AppData'), agentDir: path.join(projectRoot, 'AppData', 'Agents') };
    const resolve = (url) => handlers._resolveServedFile(url, paths);
    assert.equal(resolve('vcp-deskpet://pet/builtin/nova/chibi/NovaChibi.model3.json'), path.join(projectRoot, 'assets', 'deskpet', 'nova', 'chibi', 'NovaChibi.model3.json'));
    for (const pet of ['keqing', 'rana']) assert.equal(resolve(`vcp-deskpet://pet/builtin/codex/${pet}/spritesheet.webp`), path.join(bundledSprites, pet, 'spritesheet.webp'));
    for (const url of ['vcp-deskpet://pet/builtin/other/a.png', 'vcp-deskpet://pet/builtin/nova/..%2f..%2fmain.js', 'vcp-deskpet://pet/builtin/codex/..%2fmain.js', 'vcp-deskpet://pet/builtin/nova/..%5cconfig.json', 'vcp-deskpet://pet/builtin/nova/%E0%A4%A']) assert.equal(resolve(url), null, url);
});

test('a clean install serves bundled Nova without copying anything into the agent folder', async (t) => {
    const { agent } = fixture(t);
    const assets = createPetAssets({ paths: { projectRoot, appDataRoot: path.dirname(agent), agentDir: path.dirname(agent) } });
    const result = await assets.resolveAssets(path.basename(agent), 'builtin:nova-chibi');
    assert.equal(result.outfit.builtIn, true);
    assert.equal(result.outfit.id, 'builtin:nova-chibi');
    // 有没有 Core 只看装依赖时有没有下到随应用附带的那份，助手目录里什么都不放
    assert.equal(Boolean(result.coreUrl), fs.existsSync(path.join(projectRoot, 'vendor', 'live2d-cubism-core', 'live2dcubismcore.min.js')));
    assert.deepEqual(fs.readdirSync(agent), ['portrait.png']);
});

test('a clean install serves bundled Keqing and Rana without importing anything or installing Core', async (t) => {
    const { agent } = fixture(t);
    const assets = createPetAssets({ paths: { projectRoot, appDataRoot: path.dirname(agent), agentDir: path.dirname(agent) } });
    for (const [pet, name] of [['keqing', '刻晴'], ['rana', '乐奈']]) {
        const result = await assets.resolveAssets(path.basename(agent), `builtin:codex-${pet}`);
        assert.equal(result.outfit.builtIn, true);
        assert.equal(result.outfit.kind, 'sprite');
        assert.equal(result.outfit.name, name);
        assert.equal(result.sprite.sheetUrl, `vcp-deskpet://pet/builtin/codex/${pet}/spritesheet.webp`);
    }
    assert.deepEqual(fs.readdirSync(agent), ['portrait.png']);
});

test('the shipped Live2D resources are complete and included in packaging', async () => {
    const dir = path.join(projectRoot, 'assets', 'deskpet', 'nova');
    const list = await outfits.listOutfits(path.join(os.tmpdir(), 'nova-no-agent'), { hasCore: true, builtInDir: dir });
    assert.equal(list.length, 2);
    const sprites = await outfits.listOutfits(path.join(os.tmpdir(), 'nova-no-agent'), { builtInSpriteDir: bundledSprites });
    assert.deepEqual(sprites.map((o) => [o.id, o.kind, o.sprite?.version]), [['builtin:codex-keqing', 'sprite', 1], ['builtin:codex-rana', 'sprite', 1]]);
    assert.equal(fs.existsSync(path.join(dir, 'tech')), false, 'retired tech assets are no longer shipped');
    for (const o of list) {
        const model = JSON.parse(fs.readFileSync(o.live2d, 'utf8'));
        const refs = model.FileReferences;
        const files = [refs.Moc, refs.Physics, refs.DisplayInfo, ...refs.Textures, ...refs.Expressions.map((e) => e.File), ...Object.values(refs.Motions).flat().map((m) => m.File)];
        for (const file of files.filter(Boolean)) assert.ok(fs.existsSync(path.join(path.dirname(o.live2d), file)), `${o.id}: ${file}`);
        assert.ok(o.portraits.default);
        assert.ok(o.portraits.talk);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.ok(pkg.build.files.some((item) => ['assets/', 'assets/**/*'].includes(item)));
});

test('an agent without its own art keeps its avatar instead of turning into Nova', async (t) => {
    const { agent, options } = fixture(t);
    fs.rmSync(path.join(agent, 'portrait.png'));
    const list = await outfits.listOutfits(agent, { ...options, hasCore: true });
    assert.equal(list.filter((o) => o.builtIn).length, 4, 'Nova and the sprites stay selectable from the menu');
    assert.equal(outfits.defaultOutfit(list), null);
    assert.equal(outfits.pickOutfit(list, 'removed-preset'), null);
    assert.equal(outfits.pickOutfit(list, 'builtin:nova-maid').id, 'builtin:nova-maid');
});
