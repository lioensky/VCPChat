import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GESTURES, gestureOf, dueGestures } from '../DeskPetmodules/gestures.js';
import { ACTION_MS } from '../DeskPetmodules/petLife.js';
import { createLifeMotion } from '../DeskPetmodules/lifeMotion.js';

test('tag variants map to life actions, anything else is not a gesture', () => {
    assert.equal(gestureOf('nod'), 'agree');
    assert.equal(gestureOf('Shake'), 'disagree');
    assert.equal(gestureOf('bow'), 'bow');
    assert.equal(gestureOf('smile'), null);
    assert.equal(gestureOf(''), null);
    assert.equal(gestureOf(undefined), null);
});

test('every gesture has a duration, a Live2D curve and an image animation', () => {
    const css = fs.readFileSync(new URL('../DeskPetmodules/deskpet.css', import.meta.url), 'utf8');
    for (const action of Object.values(GESTURES)) {
        assert.ok(ACTION_MS[action] > 0, `${action} has a duration`);
        assert.match(css, new RegExp(`data-life-act="${action}"`), `${action} has an image animation`);
        const motion = createLifeMotion({ random: () => 0.5 });
        motion.play(action);
        let moved = false;
        for (let i = 0; i < 10; i += 1) {
            const { params, hop } = motion.step(ACTION_MS[action] / 1000 / 12);
            if (hop || Object.values(params).some((v) => Math.abs(v) > 0.01)) moved = true;
        }
        assert.ok(moved, `${action} moves the model`);
    }
});

test('a gesture plays once, when the text around its tag is revealed', () => {
    const tags = [
        { at: 5, gesture: 'agree' },
        { at: 12, gesture: null },
        { at: 30, gesture: 'bow' },
    ];
    assert.deepEqual(dueGestures(tags, 3), []);
    assert.deepEqual(dueGestures(tags, 10), ['agree']);
    assert.deepEqual(dueGestures(tags, 10), [], 'not again');
    assert.deepEqual(dueGestures(tags, 40), ['bow']);
});

test('when the whole reply shows at once, only the last gesture plays', () => {
    const tags = [{ at: 1, gesture: 'agree' }, { at: 9, gesture: 'cheer' }];
    assert.deepEqual(dueGestures(tags, null), ['cheer']);
    assert.deepEqual(dueGestures(tags, null), []);
    assert.deepEqual(dueGestures(undefined, null), []);
});
