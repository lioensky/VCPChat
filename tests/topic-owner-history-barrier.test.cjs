'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
test('owner deletion waits for all topic writes and blocks late writes without blocking other owners', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-owner-barrier-'));
    const queue = new HistoryMutationQueue({ userDataDir: root });
    t.after(async () => { await queue.dispose(); await fs.remove(root); });
    const scope = topicId => ({ itemId: 'a', itemType: 'agent', topicId });
    await queue.replace(scope('one'), []);
    await queue.replace(scope('two'), []);
    let entered, unblock, deleting, finishDelete;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { unblock = resolve; });
    const deletionReached = new Promise(resolve => { deleting = resolve; });
    const deleteGate = new Promise(resolve => { finishDelete = resolve; });
    const events = [];
    const first = queue.mutate(scope('one'), async history => {
        entered(); await gate; events.push('write'); return [...history, { id: 'old' }];
    }, { requireExisting: true });
    await reached;
    const deletion = queue.runOwner('a', async () => {
        events.push('delete-start'); deleting(); await deleteGate;
        await fs.remove(path.join(root, 'a')); events.push('deleted');
    });
    const late = queue.replace(scope('two'), [{ id: 'late' }], { requireExisting: true });
    const lateRejected = assert.rejects(late, /HISTORY_DELETED/);
    await queue.replace({ itemId: 'b', itemType: 'group', topicId: 't' }, []);
    assert.deepEqual(events, []);
    unblock(); await first; await deletionReached;
    assert.deepEqual(events, ['write', 'delete-start']);
    finishDelete(); await deletion; await lateRejected;
    assert.equal(await fs.pathExists(path.join(root, 'a')), false);
    assert.equal(await fs.pathExists(path.join(root, 'b')), true);
});