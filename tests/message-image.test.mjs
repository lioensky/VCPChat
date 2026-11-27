// 消息图片（modules/messageImage）的拼图：几张位图竖着拼，四周和中间铺底色。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stitchBitmaps, MAX_PIXELS } = require('../modules/messageImage/stitch.js');

const solid = (width, height, [b, g, r]) => ({ width, height, data: Buffer.from(Array.from({ length: width * height }, () => [b, g, r, 255]).flat()) });
const pixel = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

test('parts stack top to bottom with padding and gaps in the background colour', () => {
    const image = stitchBitmaps([solid(2, 1, [1, 2, 3]), solid(1, 2, [4, 5, 6])], { pad: 1, gap: 1, background: [30, 20, 10] });
    assert.equal(image.width, 4); // 最宽的 2 + 两边各 1
    assert.equal(image.height, 6); // 1 + 1（间隔）+ 2 + 两边各 1
    const ground = [10, 20, 30, 255]; // 底色按 B、G、R、A 存
    assert.deepEqual(pixel(image, 0, 0), ground);
    assert.deepEqual(pixel(image, 1, 1), [1, 2, 3, 255]);
    assert.deepEqual(pixel(image, 2, 1), [1, 2, 3, 255]);
    assert.deepEqual(pixel(image, 3, 1), ground);
    assert.deepEqual(pixel(image, 1, 2), ground, 'gap row');
    assert.deepEqual(pixel(image, 1, 3), [4, 5, 6, 255]);
    assert.deepEqual(pixel(image, 2, 3), ground, 'narrower part leaves background on its right');
    assert.deepEqual(pixel(image, 1, 4), [4, 5, 6, 255]);
    assert.deepEqual(pixel(image, 1, 5), ground);
});

test('per-seam gaps join the slices of one long message without a gap', () => {
    // 长消息分段画（renderer/index.js），同一条消息的段与段之间不留缝，消息之间照常留 gap。
    const image = stitchBitmaps([solid(1, 1, [1, 1, 1]), solid(1, 1, [2, 2, 2]), solid(1, 1, [3, 3, 3])],
        { gap: 2, gaps: [0, 2], background: [9, 9, 9] });
    assert.equal(image.height, 5);
    assert.deepEqual(pixel(image, 0, 0), [1, 1, 1, 255]);
    assert.deepEqual(pixel(image, 0, 1), [2, 2, 2, 255], 'slice follows directly');
    assert.deepEqual(pixel(image, 0, 2), [9, 9, 9, 255]);
    assert.deepEqual(pixel(image, 0, 4), [3, 3, 3, 255]);
});

test('empty, truncated and oversized input is refused', () => {
    assert.throws(() => stitchBitmaps([]), /没有可拼的图/);
    assert.throws(() => stitchBitmaps([{ width: 2, height: 2, data: Buffer.alloc(4) }]), /不完整/);
    const tall = { width: 1000, height: Math.ceil(MAX_PIXELS / 1000) + 1, data: { length: Infinity } };
    assert.throws(() => stitchBitmaps([tall]), /太大/);
});
