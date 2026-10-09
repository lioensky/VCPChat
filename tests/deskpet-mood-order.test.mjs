import test from 'node:test';
import assert from 'node:assert/strict';

import { createMoodOrder } from '../DeskPetmodules/moodOrder.js';

const mood = (seq, updatedAt, emotion = 'happy', agentId = 'Nova') => ({ agentId, seq, updatedAt, emotion });

test('after the system clock is set back, newer mood broadcasts are still taken', () => {
    const accept = createMoodOrder('Nova');
    assert.equal(accept(mood(3, Date.UTC(2026, 9, 8, 12))), true);
    // 时间往回调了一小时：updatedAt 变小，但这是主进程后发的一条
    assert.equal(accept(mood(4, Date.UTC(2026, 9, 8, 11), 'sad')), true);
    assert.equal(accept(mood(5, Date.UTC(2026, 9, 8, 11, 5), 'calm')), true);
});

test('a query answered before a broadcast but arriving after it does not win; other agents are ignored', () => {
    const accept = createMoodOrder('Nova');
    assert.equal(accept(mood(7, 2000, 'excited')), true, 'pushed broadcast');
    assert.equal(accept(mood(6, 3000, 'neutral')), false, 'late reply of the startup query');
    assert.equal(accept(mood(7, 2000, 'excited')), true, 'a query that returns the current seq is the same mood');
    assert.equal(accept(mood(9, 4000, 'sad', 'Other')), false);
    assert.equal(accept(null), false);
});
