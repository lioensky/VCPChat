import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WANDER, wanderTarget, walkFrames } = require('../modules/deskpet/wander.js');
const petPrefs = require('../modules/deskpet/petPrefs.js');

const area = { x: 0, y: 0, width: 1600, height: 1000 };
const figure = { x: 40, y: 100, width: 200, height: 300 };
const onFloor = (x) => ({ x, y: 1000 - 400, width: 280, height: 420 });

test('walks along the taskbar only when standing on it', () => {
    assert.ok(wanderTarget(onFloor(600), figure, area, () => 0.2));
    assert.equal(wanderTarget({ ...onFloor(600), y: 300 }, figure, area, () => 0.2), null, '站在半空不走');
    assert.ok(wanderTarget({ ...onFloor(600), y: 600 - WANDER.floorSlack }, figure, area, () => 0.2), '差几像素也算站着');
});

test('picks a side at random, keeps off the walls and turns around at one', () => {
    const left = wanderTarget(onFloor(600), figure, area, () => 0);
    assert.equal(left.dir, 'left');
    assert.equal(left.x, 600 - WANDER.minStep);
    assert.equal(left.y, 600);
    const right = wanderTarget(onFloor(600), figure, area, () => 0.99);
    assert.equal(right.dir, 'right');
    assert.ok(right.x - 600 <= WANDER.maxStep);
    // 左边只剩 30：往右走
    const nearWall = wanderTarget(onFloor(-40 + WANDER.wallGap + 30), figure, area, () => 0);
    assert.equal(nearWall.dir, 'right');
    // 离右墙 100 想走 220：只走到墙前
    const x = 1600 - WANDER.wallGap - 100 - 40 - 200;
    const capped = wanderTarget(onFloor(x), figure, area, () => 0.99);
    assert.equal(capped.x, x + 100);
    // 两边都太窄：不走
    assert.equal(wanderTarget(onFloor(0), figure, { x: 0, y: 0, width: 300, height: 1000 }, () => 0.5), null);
    assert.equal(wanderTarget(onFloor(600), null, area), null);
});

test('walk frames move at a steady pace and end on the target', () => {
    const frames = walkFrames({ x: 0, y: 600 }, { x: 120, y: 600 }, 16, 60);
    assert.equal(frames.length, Math.ceil(120 / (60 * 0.016)));
    assert.deepEqual(frames.at(-1), { x: 120, y: 600 });
    for (let i = 1; i < frames.length; i += 1) assert.ok(frames[i].x - frames[i - 1].x <= 2);
    assert.deepEqual(walkFrames({ x: 5, y: 5 }, { x: 5, y: 5 }, 16), [{ x: 5, y: 5 }]);
});

test('wandering is off by default and only true turns it on', () => {
    assert.equal(petPrefs.DEFAULT_SETTINGS.wander, false);
    assert.equal(petPrefs.normalizeSettings({}).wander, false);
    assert.equal(petPrefs.normalizeSettings({ wander: 'yes' }).wander, false);
    assert.equal(petPrefs.normalizeSettings({ wander: true }).wander, true);
});
