import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { releaseVelocity, throwPath, THROW_MIN_SPEED } = require('../modules/deskpet/throwMotion.js');

const area = { x: 0, y: 0, width: 1600, height: 960 };
const figure = { x: 50, y: 120, width: 220, height: 400 };
const win = { x: 600, y: 100, width: 320, height: 580 };
const floorY = 960 - 120 - 400;

test('release speed comes from the last 100 ms of cursor movement', () => {
    const samples = [{ t: 0, x: 0, y: 0 }, { t: 900, x: 0, y: 0 }, { t: 950, x: 60, y: 0 }, { t: 1000, x: 120, y: -30 }];
    assert.deepEqual(releaseVelocity(samples, 1010), { vx: 1200, vy: -300 });
    // 停稳了再松手：不算甩
    assert.deepEqual(releaseVelocity(samples, 1100), { vx: 0, vy: 0 });
    assert.deepEqual(releaseVelocity([{ t: 0, x: 0, y: 0 }], 5), { vx: 0, vy: 0 });
});

test('a slow drop is not a throw', () => {
    assert.equal(throwPath(win, figure, area, { vx: THROW_MIN_SPEED - 1, vy: 0 }), null);
    assert.equal(throwPath(win, null, area, { vx: 3000, vy: 0 }), null);
});

test('a throw slides on, falls and lands on the taskbar', () => {
    const frames = throwPath(win, figure, area, { vx: 1500, vy: -400 });
    assert.ok(frames.length > 5);
    const last = frames.at(-1);
    assert.equal(last.y, floorY, '落在工作区底边');
    assert.ok(last.x > win.x + 100, '带着速度往右滑了一段');
    assert.ok(frames[2].y < win.y, '往上甩先往上走');
    for (const f of frames) assert.ok(f.x >= -50 && f.x <= 1600 - 270 && f.y <= floorY, '不出屏幕');
});

test('a hard throw stops at the screen edge', () => {
    const frames = throwPath(win, figure, area, { vx: -4000, vy: 0 });
    assert.equal(frames.at(-1).x, -50, '角色左边贴着屏幕左边');
    assert.equal(frames.at(-1).y, floorY);
});
