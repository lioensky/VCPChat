// 双曲场图（modules/warpedFieldAtlas）主进程这一层：只放行只读路径，只认允许的页面，带上设置里的地址和密钥去问后端插件。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createHandler, isMainFrameOf, ROUTE } = require('../modules/warpedFieldAtlas/index.js');

const frame = {};
const win = { isDestroyed: () => false, webContents: { mainFrame: frame } };
const event = { sender: win.webContents, senderFrame: frame };
const settings = async () => ({ vcpServerUrl: 'http://127.0.0.1:6105/v1/chat/completions', vcpApiKey: 'k' });

test('只放行这几种只读路径', () => {
    for (const route of ['/status', '/messages', '/messages?q=%E8%AE%B0%E5%BF%86', '/field/tag', '/field/chunk/node/12',
        '/field/tag/query?node=5', '/field/chunk/query?message=ab12cd34ef', '/field/tag/query?message=ab12cd34ef&radius=0.42']) {
        assert.ok(ROUTE.test(route), route);
    }
    for (const route of ['', '/', '/field/x', '/field/tag/node/1/../../x', '/status?x=1', 'http://example.com/', '/field/tag/query?node=5&x=1',
        '/messages?q=a&x=1', '/field/tag/query?message=../x', '/field/tag/query?message=ab12cd34ef&radius=9', '/field/tag/node/abc']) {
        assert.ok(!ROUTE.test(route), route);
    }
});

test('转给后端插件时带上设置里的地址和密钥', async () => {
    const seen = [];
    const forward = createHandler({
        allowed: e => isMainFrameOf(win, e), readSettings: settings,
        fetchImpl: async (url, init) => {
            seen.push({ url: String(url), auth: init.headers.Authorization, redirect: init.redirect });
            return { ok: true, status: 200, json: async () => ({ fields: {} }) };
        },
    });
    assert.deepEqual(await forward(event, '/status'), { success: true, data: { fields: {} } });
    assert.deepEqual(seen, [{ url: 'http://127.0.0.1:6105/api/plugins/WarpedFieldAtlas/status', auth: 'Bearer k', redirect: 'error' }]);
});

test('不允许的页面和不放行的路径都不会发到后端', async () => {
    let calls = 0;
    const forward = createHandler({ allowed: e => isMainFrameOf(win, e), readSettings: settings, fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json: async () => ({}) }; } });
    assert.equal((await forward({ sender: {}, senderFrame: frame }, '/status')).success, false);
    assert.equal((await forward({ sender: win.webContents, senderFrame: {} }, '/status')).success, false);
    assert.equal((await forward(event, '/field/tag/../x')).success, false);
    assert.equal((await forward(event, 42)).success, false);
    assert.equal(calls, 0);
    assert.equal(isMainFrameOf(null, event), false);
    assert.equal(isMainFrameOf({ ...win, isDestroyed: () => true }, event), false);
});

test('后端没装插件、返回出错、连不上，各有一句说得清的话', async () => {
    const make = fetchImpl => createHandler({ allowed: () => true, readSettings: settings, fetchImpl });
    const missing = await make(async () => ({ ok: false, status: 404, json: async () => { throw new Error('html'); } }))(event, '/status');
    assert.deepEqual(missing, { success: false, message: '后端的双曲场图插件尚未加载。' });
    const refused = await make(async () => ({ ok: false, status: 409, json: async () => ({ message: '距离函数与快照里的距离表对不上，查询视图停用。' }) }))(event, '/field/tag/query?node=1');
    assert.equal(refused.message, '距离函数与快照里的距离表对不上，查询视图停用。');
    const down = await make(async () => { throw new Error('ECONNREFUSED'); })(event, '/status');
    assert.deepEqual(down, { success: false, message: '无法连接后端。' });
    const badBase = await createHandler({ allowed: () => true, readSettings: async () => ({ vcpServerUrl: 'file:///x', vcpApiKey: 'k' }), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) })(event, '/status');
    assert.equal(badBase.success, false);
});

// 展开话题团时的角度换算（界面里的纯函数）。
const { focusMap } = await import('../modules/warpedFieldAtlas/renderer/atlas-app.js');
const TAU = Math.PI * 2;

test('展开话题团：这一团占到七成，接缝不动，先后次序不变', () => {
    const group = { start: 1.0, end: 1.6 };
    const map = focusMap(group, 1000);
    assert.ok(Math.abs(map(0)) < 1e-12);
    assert.ok(Math.abs(map(TAU) - TAU) < 1e-9);
    const pad = Math.PI / 1000;
    const width = map(group.end + pad) - map(group.start - pad);
    assert.ok(Math.abs(width - TAU * 0.7) < 1e-9, `展开后的宽度 ${width}`);
    // 团里两个节点的间隔按同一个倍数拉开，团外的按同一个倍数压窄。
    const inside = (map(1.4) - map(1.2)) / 0.2;
    const outside = (map(4.0) - map(3.0)) / 1.0;
    assert.ok(Math.abs(inside - TAU * 0.7 / (0.6 + 2 * pad)) < 1e-9);
    assert.ok(Math.abs(outside - (TAU * 0.3) / (TAU - 0.6 - 2 * pad)) < 1e-9);
    assert.ok(Math.abs((map(0.5) - map(0.1)) / 0.4 - outside) < 1e-9, '团前和团后压窄的倍数相同');
    let previous = -1;
    for (let step = 0; step <= 2000; step++) {
        const value = map(TAU * step / 2000);
        assert.ok(value > previous, `第 ${step} 步没有递增`);
        previous = value;
    }
});

test('展开话题团：没有选团、或者这一团本来就占七成以上时，角度不变', () => {
    assert.equal(focusMap(null, 100)(2.5), 2.5);
    const wide = focusMap({ start: 0.2, end: 5.9 }, 100);
    for (const a of [0, 0.1, 1, 3, 6, TAU]) assert.equal(wide(a), a);
});

test('展开话题团：只有一个节点的团也能展开', () => {
    const map = focusMap({ start: 2, end: 2 }, 4000);
    const pad = Math.PI / 4000;
    assert.ok(Math.abs(map(2 + pad) - map(2 - pad) - TAU * 0.7) < 1e-9);
    assert.ok(Number.isFinite(map(2)));
});
