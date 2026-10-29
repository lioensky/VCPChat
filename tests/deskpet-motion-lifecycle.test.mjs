import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPetMotion } = require('../modules/deskpet/petMotion.js');

function setup(t) {
    const callbacks = new Map();
    const cleared = [];
    let nextId = 0;
    t.mock.method(globalThis, 'setInterval', callback => {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
    });
    t.mock.method(globalThis, 'clearInterval', id => { cleared.push(id); });
    let bounds = { x: 500, y: 300, width: 360, height: 424 };
    const sent = [];
    const saved = [];
    const pet = {
        agentId: 'Nova',
        snap: null,
        win: {
            getBounds: () => ({ ...bounds }),
            isDestroyed: () => false,
            webContents: { send: channel => sent.push(channel) },
        },
    };
    const motion = createPetMotion({
        electron: { screen: {} },
        geometry: {
            sizeOf: () => ({ width: 360, height: 424 }),
            applyBounds: (_pet, value) => { bounds = { ...bounds, ...value }; },
            workAreaAt: () => ({ x: 0, y: 0, width: 1600, height: 1000 }),
        },
        savePetState: async (...args) => { saved.push(args); },
    });
    const figure = { x: 40, y: 100, width: 200, height: 300 };
    const fling = () => {
        const now = Date.now();
        assert.equal(motion.throwPet(pet, figure, [
            { t: now - 20, x: 500, y: 300 },
            { t: now, x: 420, y: 280 },
        ]), true);
    };
    return { motion, pet, callbacks, cleared, sent, saved, fling };
}

for (const replacement of ['slide', 'throw']) {
    test(`a stale slide callback cannot move or stop a replacement ${replacement}`, t => {
        const { motion, pet, callbacks, cleared, sent, fling } = setup(t);
        let oldDone = 0;
        let newDone = 0;
        motion.slideTo(pet, { x: 100, y: 300 }, () => { oldDone++; });
        const oldId = pet.snap;
        if (replacement === 'throw') fling();
        else motion.slideTo(pet, { x: 700, y: 300 }, () => { newDone++; });
        const newId = pet.snap;
        const before = pet.win.getBounds();
        callbacks.get(oldId)();
        assert.deepEqual(pet.win.getBounds(), before, '旧动画不能再写位置');
        assert.equal(pet.snap, newId);
        assert.ok(cleared.includes(oldId));
        assert.equal(cleared.includes(newId), false, '旧动画不能取消新动画');
        for (let i = 0; i < 200 && pet.snap !== null; i++) callbacks.get(newId)();
        assert.equal(pet.snap, null, '正常完成后清空运动状态');
        assert.ok(cleared.includes(newId));
        assert.equal(oldDone, 0);
        assert.equal(newDone, replacement === 'slide' ? 1 : 0);
        assert.equal(sent.length, replacement === 'throw' ? 1 : 0);
        callbacks.get(oldId)();
        callbacks.get(newId)();
        assert.equal(oldDone, 0);
        assert.equal(newDone, replacement === 'slide' ? 1 : 0, '完成回调只执行一次');
        assert.equal(sent.length, replacement === 'throw' ? 1 : 0);
    });
}

test('a stale throw callback cannot move a replacement slide or report landing', t => {
    const { motion, pet, callbacks, sent, saved, fling } = setup(t);
    fling();
    const oldId = pet.snap;
    motion.slideTo(pet, { x: 700, y: 300 });
    const newId = pet.snap;
    const before = pet.win.getBounds();
    callbacks.get(oldId)();
    assert.deepEqual(pet.win.getBounds(), before);
    assert.equal(pet.snap, newId);
    assert.deepEqual(sent, []);
    assert.deepEqual(saved, []);
});

test('playFrames clears its own timer and stops once when halted', t => {
    const { motion, pet, callbacks, cleared } = setup(t);
    let stops = 0;
    let completions = 0;
    const id = motion.playFrames(pet, [{ x: 100, y: 200 }], {
        halted: () => true,
        stop: () => { stops++; },
        done: () => { completions++; },
    });
    callbacks.get(id)();
    callbacks.get(id)();
    assert.deepEqual(cleared, [id]);
    assert.equal(stops, 1);
    assert.equal(completions, 0);
    assert.equal(pet.win.getBounds().x, 500);
});