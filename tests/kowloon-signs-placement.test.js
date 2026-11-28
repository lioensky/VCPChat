const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modes = path.resolve(__dirname, '..', 'Musicmodules', 'music-stage', 'modes');
const Layout = require(path.join(modes, 'kowloon-layout.js'));
const Signs = require(path.join(modes, 'kowloon-signs.js'));
const { chooseSlots, designSign, mulberry, layoutRows, wordsOf, VERTICAL_SHOPS, HORIZONTAL_SHOPS, ROOF_BRANDS } = Signs._test;

const layout = Layout.build('kowloon');
const pools = () => ({ vertical: VERTICAL_SHOPS.slice(), horizontal: HORIZONTAL_SHOPS.slice(), roof: ROOF_BRANDS.slice() });

test('picks a bounded, spaced set of sign places, mostly where the cameras look', () => {
    const picked = chooseSlots(layout, 184, mulberry(7));
    assert.equal(picked.length, 184);
    assert.ok(picked.every(s => s.use === 'sign'));
    for (let i = 0; i < picked.length; i += 1) {
        for (let j = i + 1; j < picked.length; j += 1) {
            const a = picked[i].pos, b = picked[j].pos;
            assert.ok(Math.hypot(a[0] - b[0], (a[1] - b[1]) * 0.8, a[2] - b[2]) >= 2.6 - 1e-6, 'signs crowd each other');
        }
    }
    const south = picked.filter(s => s._street && s.normal[2] > 0.5).length;
    const east = picked.filter(s => s._street && s.normal[0] > 0.5).length;
    const roofs = picked.filter(s => s.kind === 'roof').length;
    assert.ok(south >= 50, `south street face has ${south}`);
    assert.ok(east >= 20, `east street face has ${east}`);
    assert.ok(roofs >= 15, `roofscape has ${roofs} billboards`);
    assert.ok(picked.filter(s => s._alley === 2).length >= 25, 'main alleys get their share');
});

test('alley signs hang low and leave the alley passable', () => {
    const picked = chooseSlots(layout, 184, mulberry(3));
    const alley = picked.filter(s => s._alleyW);
    assert.ok(alley.length > 0);
    assert.ok(alley.every(s => s.floor <= 2), 'alley signs above the roofed-over floors');
    const random = mulberry(11);
    alley.filter(s => s.kind === 'blade').forEach((slot, i) => {
        const spec = designSign(slot, i, random, pools());
        assert.ok(0.35 + spec.width <= Math.max(0.85, slot._alleyW * 0.42) + 1e-6, `blade reaches ${0.35 + spec.width} m into a ${slot._alleyW} m alley`);
    });
});

test('the same seed paints the same street', () => {
    const slot = { kind: 'blade', pos: [0, 5, 60], normal: [0, 0, 1], tangent: [1, 0, 0], floor: 1, width: 2.05 };
    const a = designSign(slot, 0, mulberry(42), pools());
    const b = designSign(slot, 0, mulberry(42), pools());
    assert.deepEqual(a, b);
    assert.ok(a.width > 0 && a.height > 0);
});

test('lyric rows break between words, never inside one', () => {
    const ctx = { font: '', measureText: text => ({ width: [...text].length * 10 }) };
    const words = wordsOf({ line: 'x', words: ['I ', 'will ', 'follow ', 'the ', 'light'].map(text => ({ text: text.trim() })) });
    const rows = layoutRows(ctx, words, '', 120, 3);
    const flat = rows.flat().map(c => c.text);
    assert.deepEqual(flat, ['I', 'will', 'follow', 'the', 'light']);
    assert.ok(rows.length >= 2 && rows.length <= 3);
    assert.ok(rows.every(r => r.width <= 120 || r.length === 1));
});

test('hologram banners hang high, apart, and clear of the main screen', () => {
    const { chooseHoloAds } = Signs._test;
    const ads = chooseHoloAds(layout, 16, mulberry(3));
    assert.ok(ads.length >= 10, `only ${ads.length} banners`);
    const screen = layout.SCREENS.find(s => s.primary);
    ads.forEach(a => {
        assert.ok(a.bottom >= 6.9, 'banner hangs into the street');
        assert.ok(a.height > a.width * 3, 'banners stand tall');
        assert.ok(Math.hypot(a.foot[0] - screen.center[0], a.foot[1] - screen.center[1], a.foot[2] - screen.center[2]) >= 24, 'banner on the main screen');
    });
});

test('no sign hangs in the gate and market keep-out', () => {
    const k = (layout.GATE || { keepOut: { x0: -28, x1: -1, z0: 50, z1: 64, y1: 9 } }).keepOut;
    const picked = chooseSlots(layout, 256, mulberry(11));
    const inside = picked.filter(s => s.pos[0] > k.x0 && s.pos[0] < k.x1 && s.pos[2] > k.z0 && s.pos[2] < k.z1 && s.pos[1] < k.y1 + 1.5);
    assert.equal(inside.length, 0);
});
