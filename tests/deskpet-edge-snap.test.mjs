import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SNAP_DIP, snapPosition, snapFrames, tuckPosition } = require('../modules/deskpet/edgeSnap.js');

const area = { x: 0, y: 0, width: 1600, height: 960 };
const figure = { x: 50, y: 120, width: 220, height: 400 };

test('the figure, not the transparent window, snaps to the left, right and bottom edges', () => {
    assert.deepEqual(snapPosition({ x: -40, y: 100, width: 320, height: 580 }, figure, area), { x: -50, y: 100, edges: ['left'] });
    // 右边：角色右沿离屏幕右边 12
    const right = snapPosition({ x: 1600 - 270 - 12, y: 100, width: 320, height: 580 }, figure, area);
    assert.deepEqual(right, { x: 1600 - 270, y: 100, edges: ['right'] });
    // 脚底落到任务栏上（工作区底边），角落里两条边一起
    const corner = snapPosition({ x: -45, y: 960 - 520 + 15, width: 320, height: 580 }, figure, area);
    assert.deepEqual(corner, { x: -50, y: 960 - 520, edges: ['left', 'bottom'] });
});

test('far from every edge, or pushed well past one, nothing moves', () => {
    assert.equal(snapPosition({ x: 600, y: 200, width: 320, height: 580 }, figure, area), null);
    assert.equal(snapPosition({ x: -50 - SNAP_DIP - 30, y: 200, width: 320, height: 580 }, figure, area), null);
    assert.equal(snapPosition({ x: 0, y: 0, width: 320, height: 580 }, null, area), null);
    assert.equal(snapPosition({ x: 0, y: 0, width: 320, height: 580 }, { x: 0, y: 0, width: 0, height: 10 }, area), null);
});

test('a second display with a negative origin works the same', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1040 };
    assert.deepEqual(snapPosition({ x: -1920 - 50 + 8, y: 300, width: 320, height: 580 }, figure, left), { x: -1970, y: 300, edges: ['left'] });
});

test('the slide eases out and ends exactly on the target', () => {
    const frames = snapFrames({ x: 0, y: 0 }, { x: -30, y: 12 });
    assert.equal(frames.length, 6);
    assert.deepEqual(frames.at(-1), { x: -30, y: 12 });
    assert.ok(Math.abs(frames[0].x) > Math.abs(frames[1].x - frames[0].x) / 2, 'fast first, slow last');
});

test('dragged well past the left or right edge, the figure tucks in and leaves a strip showing', () => {
    // 角色左沿在屏幕外 100（220 宽的 45%）：收进左边，露 30%
    const left = tuckPosition({ x: -150, y: 200, width: 320, height: 580 }, figure, area);
    assert.equal(left.side, 'left');
    assert.equal(left.tucked.x + figure.x + figure.width, Math.round(220 * 0.3));
    assert.equal(left.out.x + figure.x, 0, '探出来时角色贴着左边');
    assert.equal(left.tucked.y, 200);
    // 右边，同时脚掉到了任务栏下面：拉回工作区
    const right = tuckPosition({ x: 1600 - 50 - 100, y: 700, width: 320, height: 580 }, figure, area);
    assert.equal(right.side, 'right');
    assert.equal(right.tucked.x + figure.x, 1600 - Math.round(220 * 0.3));
    assert.equal(right.out.x + figure.x + figure.width, 1600);
    assert.equal(right.tucked.y + figure.y + figure.height, 960);
});

test('only a little past the edge, or past an edge with another display beyond it, nothing tucks', () => {
    assert.equal(tuckPosition({ x: -100, y: 200, width: 320, height: 580 }, figure, area), null, '只出去 50（不到四成）');
    assert.equal(tuckPosition({ x: 600, y: 200, width: 320, height: 580 }, figure, area), null);
    assert.equal(tuckPosition({ x: -150, y: 200, width: 320, height: 580 }, figure, area, (side) => side !== 'left'), null);
});
