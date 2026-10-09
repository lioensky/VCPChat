import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const outfits = require('../modules/deskpet/outfits.js');
const handlers = require('../modules/ipc/deskPetHandlers.js');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    return { agent, bundle };
}

test('a fresh Nova offers all three bundled outfits without writing to its agent folder', async (t) => {
    const { agent, bundle } = fixture(t);
    const list = await outfits.listOutfits(agent, { hasCore: true, builtInDir: bundle, preferBuiltIn: true });
    assert.deepEqual(list.filter((o) => o.builtIn).map((o) => o.id), ['builtin:nova-tech', 'builtin:nova-maid', 'builtin:nova-chibi']);
    assert.equal(outfits.defaultOutfit(list).id, 'builtin:nova-tech');
    assert.equal(outfits.pickOutfit(list, 'builtin:nova-chibi').id, 'builtin:nova-chibi');
    assert.ok(outfits.isOutfitId('builtin:nova-chibi'));
    assert.deepEqual(fs.readdirSync(agent), ['portrait.png']);
    assert.equal(fs.readFileSync(path.join(agent, 'portrait.png'), 'utf8'), 'existing portrait');
});

test('custom models and non-Nova portraits stay the default, while built-ins remain selectable', async (t) => {
    const { agent, bundle } = fixture(t);
    const otherAgent = await outfits.listOutfits(agent, { hasCore: true, builtInDir: bundle });
    assert.equal(outfits.defaultOutfit(otherAgent).id, ':portrait');
    fs.mkdirSync(path.join(agent, 'deskpet', 'custom'), { recursive: true });
    fs.writeFileSync(path.join(agent, 'deskpet', 'custom', 'Custom.model3.json'), '{}');
    const nova = await outfits.listOutfits(agent, { hasCore: true, builtInDir: bundle, preferBuiltIn: true });
    assert.equal(outfits.defaultOutfit(nova).id, 'custom');
    assert.equal(outfits.pickOutfit(nova, 'builtin:nova-maid').id, 'builtin:nova-maid');
});

test('all three outfits have a usable portrait fallback when Core is absent', async (t) => {
    const { agent, bundle } = fixture(t);
    const list = await outfits.listOutfits(agent, { hasCore: false, builtInDir: bundle, preferBuiltIn: true });
    for (const o of list.filter((item) => item.builtIn)) {
        assert.equal(o.kind, 'portrait');
        assert.ok(o.portraits.default);
        assert.ok(o.live2d, 'model becomes available again when Core is installed');
    }
    assert.equal(outfits.pickOutfit(list, 'removed-preset').id, 'builtin:nova-tech');
    // 设置页卡片说清楚这是 Live2D、缺 Core 才先用立绘；桌宠页面不再每次打开都弹红字
    assert.match(outfits.outfitDescription(list.find((o) => o.id === 'builtin:nova-tech')), /Cubism Core/);
});

test('bundled resources stay within Nova and never expose configuration or other app files', () => {
    const paths = { projectRoot, appDataRoot: path.join(projectRoot, 'AppData'), agentDir: path.join(projectRoot, 'AppData', 'Agents') };
    const resolve = (url) => handlers._resolveServedFile(url, paths);
    assert.equal(resolve('vcp-deskpet://pet/builtin/nova/chibi/NovaChibi.model3.json'), path.join(projectRoot, 'assets', 'deskpet', 'nova', 'chibi', 'NovaChibi.model3.json'));
    assert.equal(resolve('vcp-deskpet://pet/builtin/nova/tech/expressions/Happy.exp3.json'), path.join(projectRoot, 'assets', 'deskpet', 'nova', 'tech', 'expressions', 'Happy.exp3.json'));
    for (const url of ['vcp-deskpet://pet/builtin/other/a.png', 'vcp-deskpet://pet/builtin/nova/..%2f..%2fmain.js', 'vcp-deskpet://pet/builtin/nova/..%5cconfig.json', 'vcp-deskpet://pet/builtin/nova/%E0%A4%A']) assert.equal(resolve(url), null, url);
});

test('the shipped three models have complete runtime references and are included in packaging', async () => {
    const dir = path.join(projectRoot, 'assets', 'deskpet', 'nova');
    const list = await outfits.listOutfits(path.join(os.tmpdir(), 'nova-no-agent'), { hasCore: true, builtInDir: dir });
    assert.equal(list.length, 3);
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
    const { agent, bundle } = fixture(t);
    fs.rmSync(path.join(agent, 'portrait.png'));
    const list = await outfits.listOutfits(agent, { hasCore: true, builtInDir: bundle });
    assert.equal(list.filter((o) => o.builtIn).length, 3, 'Nova stays selectable from the menu');
    assert.equal(outfits.defaultOutfit(list), null);
    assert.equal(outfits.pickOutfit(list, 'removed-preset'), null);
    assert.equal(outfits.pickOutfit(list, 'builtin:nova-maid').id, 'builtin:nova-maid');
});
