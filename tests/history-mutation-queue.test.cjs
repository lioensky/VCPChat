const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-history-queue-'));
    const queue = new HistoryMutationQueue({ userDataDir: root });
    t.after(async () => {
        await queue.dispose();
        await fs.remove(root);
    });
    return queue;
}

const descriptor = () => ({ itemId: 'agent-a', itemType: 'agent', topicId: 'topic-a' });

test('concurrent mutations read latest history and retain every append', async t => {
    const queue = await fixture(t);
    await Promise.all(Array.from({ length: 30 }, (_, id) =>
        queue.mutate(descriptor(), history => [...history, { id, content: `message-${id}` }])
    ));
    const history = await queue.read(descriptor());
    assert.deepEqual(history.map(message => message.id), Array.from({ length: 30 }, (_, id) => id));
});

test('replacement freezes both target and nested payload when enqueued', async t => {
    const queue = await fixture(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const blocker = queue.run(descriptor(), () => gate);
    const target = descriptor();
    const history = [{ id: 'one', content: { text: 'original' } }];
    const pending = queue.replace(target, history);
    target.itemId = 'agent-b';
    history[0].content.text = 'changed';
    release();
    await blocker;
    await pending;
    assert.equal((await queue.read(descriptor()))[0].content.text, 'original');
    assert.deepEqual(await queue.read(target), []);
});

test('failed mutation does not damage persisted history or poison queue', async t => {
    const queue = await fixture(t);
    await queue.replace(descriptor(), [{ id: 'original' }]);
    await assert.rejects(queue.mutate(descriptor(), history => {
        history.length = 0;
        throw new Error('intent failed');
    }), /intent failed/);
    await queue.mutate(descriptor(), history => [...history, { id: 'next' }]);
    assert.deepEqual((await queue.read(descriptor())).map(message => message.id), ['original', 'next']);
});

test('agent and group aliases of the same physical history share a queue', async t => {
    const queue = await fixture(t);
    await Promise.all([
        queue.mutate(descriptor(), history => [...history, { id: 'agent' }]),
        queue.mutate({ ...descriptor(), itemType: 'group' }, history => [...history, { id: 'group' }])
    ]);
    assert.deepEqual((await queue.read(descriptor())).map(message => message.id), ['agent', 'group']);
});

test('invalid identifiers and item types are rejected before writing', async t => {
    const queue = await fixture(t);
    for (const itemId of ['..', '../escape', 'a\\b', 'C:drive', 'nul', 'trailing.', '']) {
        assert.throws(() => queue.replace({ ...descriptor(), itemId }, []), /Invalid/);
    }
    assert.throws(() => queue.replace({ ...descriptor(), itemType: 'unknown' }, []), /Invalid/);
    assert.throws(() => queue.replace(descriptor(), {}), /array/);
});

test('replace retains explicit deletion semantics and dispose rejects new work', async t => {
    const queue = await fixture(t);
    await queue.replace(descriptor(), [{ id: 'deleted' }]);
    await queue.replace(descriptor(), []);
    assert.deepEqual(await queue.read(descriptor()), []);
    await queue.dispose();
    await assert.rejects(queue.replace(descriptor(), []), /disposed/);
});
test('a deleted side chat child topic is not recreated by a late save', async t => {
    // 父话题被删时子目录已经删掉，流式回复被取消后还会存一次：不能把目录建回来留下孤儿
    const queue = await fixture(t);
    const child = { itemId: 'agent-a', itemType: 'agent', topicId: 'sidechat_1700000000000_abc123' };
    const childDir = path.dirname(queue.getHistoryPath(child.itemId, child.topicId));
    await assert.rejects(queue.replace(child, [{ id: 'late' }]), /SIDE_CHAT_CHILD_DELETED/);
    assert.equal(await fs.pathExists(childDir), false);

    // 还在的子话题照常保存；普通话题第一次保存照常建目录
    await fs.ensureDir(childDir);
    await queue.replace(child, [{ id: 'kept' }]);
    assert.deepEqual(await queue.read(child), [{ id: 'kept' }]);
    await queue.replace(descriptor(), [{ id: 'first' }]);
    assert.deepEqual(await queue.read(descriptor()), [{ id: 'first' }]);
});
