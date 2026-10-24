import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissed } from '../DeskPetmodules/missedReply.js';

test('a reply that ends while the pet is hidden counts as missed', () => {
    assert.equal(isMissed({ hidden: true, idleMs: 0, now: 1000, startedAt: 0, endedAt: 900, heardAt: 950 }), true);
});

test('a reply read aloud counts as heard', () => {
    assert.equal(isMissed({ hidden: false, idleMs: 600000, now: 100000, startedAt: 10, endedAt: 50000, heardAt: 20000 }), false);
    // 念的是上一条：这条没念
    assert.equal(isMissed({ hidden: false, idleMs: 600000, now: 100000, startedAt: 30000, endedAt: 50000, heardAt: 20000 }), true);
});

test('no keyboard or mouse since the reply ended, for at least 20 s, counts as away', () => {
    const now = 100000;
    // 回复说完 12 秒收起，期间一直没碰，但才 12 秒：可能在看
    assert.equal(isMissed({ hidden: false, idleMs: 12000, now, endedAt: now - 12000 }), false);
    // 30 秒的长回复收起，30 秒都没碰
    assert.equal(isMissed({ hidden: false, idleMs: 31000, now, endedAt: now - 30000 }), true);
    // 说完以后动过鼠标
    assert.equal(isMissed({ hidden: false, idleMs: 25000, now, endedAt: now - 30000 }), false);
});
