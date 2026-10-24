import test from 'node:test';
import assert from 'node:assert/strict';

import { GAZE_LIMITS, shapeGaze, limitGaze } from '../DeskPetmodules/gaze.js';

test('a cursor near the face keeps the pet looking straight ahead', () => {
    assert.deepEqual(shapeGaze(0, 0), { x: 0, y: 0 });
    assert.deepEqual(shapeGaze(0.05, 0.08), { x: 0, y: 0 });
});

test('a cursor far above (the usual case for a pet at the bottom of the screen) only tilts the head up a little', () => {
    const up = shapeGaze(0, 4);
    assert.equal(up.x, 0);
    assert.equal(up.y, GAZE_LIMITS.maxUp);
    assert.ok(up.y <= 0.25, 'Live2D 上不超过约 7°');
    // 斜上方：往旁边转得比往上多
    const diagonal = shapeGaze(2, 2);
    assert.ok(diagonal.x > diagonal.y * 2, JSON.stringify(diagonal));
});

test('turning grows with distance instead of jumping to the limit', () => {
    const steps = [0.2, 0.4, 0.7, 1.0, 1.5].map((d) => shapeGaze(d, 0).x);
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i] >= steps[i - 1], steps.join(','));
    assert.ok(steps[0] < 0.1, `just outside the dead zone: ${steps[0]}`);
    assert.equal(steps.at(-1), GAZE_LIMITS.maxX);
    assert.ok(shapeGaze(0, -3).y >= -GAZE_LIMITS.maxDown);
});

test('idle wandering and drowsy looks are held to the same limits', () => {
    assert.deepEqual(limitGaze({ x: 0, y: 1 }), { x: 0, y: GAZE_LIMITS.maxUp });
    assert.deepEqual(limitGaze({ x: -1, y: -1 }), { x: -GAZE_LIMITS.maxX, y: -GAZE_LIMITS.maxDown });
    assert.deepEqual(limitGaze(null), { x: 0, y: 0 });
});
