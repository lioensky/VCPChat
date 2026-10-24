import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalQueue, normalizeApproval } from '../DeskPetmodules/approvals.js';

test('approval requests are normalized for the card', () => {
    assert.equal(normalizeApproval(null), null);
    assert.equal(normalizeApproval({ toolName: 'X' }), null);
    const item = normalizeApproval({ requestId: 7, toolName: '  ', command: 'rm  -rf\n /tmp/x' }, 0);
    assert.deepEqual(item, { requestId: '7', toolName: '工具', command: 'rm -rf /tmp/x', expiresAt: null });
    const long = normalizeApproval({ requestId: 'a', command: 'x'.repeat(500) });
    assert.equal(long.command.length, 160);
    assert.ok(long.command.endsWith('…'));
    assert.equal(normalizeApproval({ requestId: 'a', expiresAt: 5 }, 10), null, 'already expired');
});

test('the queue shows the oldest pending request first and drops duplicates', () => {
    const q = createApprovalQueue({ now: () => 0 });
    assert.equal(q.current, null);
    assert.ok(q.add({ requestId: 'a', toolName: 'A' }));
    assert.ok(q.add({ requestId: 'b', toolName: 'B' }));
    assert.equal(q.add({ requestId: 'a', toolName: 'A again' }), false, 'replayed request');
    assert.equal(q.current.toolName, 'A');
    assert.equal(q.size, 2);
    assert.ok(q.remove('a'));
    assert.equal(q.remove('a'), false);
    assert.equal(q.current.toolName, 'B');
});

test('expired requests leave the queue on their own', () => {
    let t = 0;
    const q = createApprovalQueue({ now: () => t });
    q.add({ requestId: 'a', expiresAt: 1000 });
    q.add({ requestId: 'b' });
    assert.equal(q.current.requestId, 'a');
    t = 1000;
    assert.equal(q.current.requestId, 'b');
    assert.equal(q.size, 1);
});

test('the queue keeps at most 20 requests', () => {
    const q = createApprovalQueue({ now: () => 0 });
    for (let i = 0; i < 25; i++) q.add({ requestId: `r${i}` });
    assert.equal(q.size, 20);
    assert.equal(q.current.requestId, 'r5');
});

test('an expired replay cannot turn into a request with no expiry', () => {
    const q = createApprovalQueue({ now: () => 1000 });
    assert.equal(q.add({ requestId: 'late', expiresAt: 999 }), false);
    assert.equal(q.add({ requestId: 'boundary', expiresAt: 1000 }), false);
    assert.equal(q.current, null);
    assert.equal(q.size, 0);
    assert.equal(q.add({ requestId: 'unlimited', expiresAt: null }), true);
});
