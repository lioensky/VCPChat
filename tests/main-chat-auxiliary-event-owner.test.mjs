import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainChatAuxiliaryEventOwner } from '../modules/renderer/mainChatAuxiliaryEventOwner.js';

const channel = () => {
    let listener = null;
    let removed = 0;
    return {
        subscribe(callback) { listener = callback; return () => { listener = null; removed += 1; }; },
        emit(value) { listener?.(value); },
        get removed() { return removed; },
    };
};

test('auxiliary event owner connects each producer to its explicit consumer', async () => {
    const loom = channel();
    const status = channel();
    const message = channel();
    const topic = channel();
    const consumed = [];
    const owner = createMainChatAuxiliaryEventOwner({
        subscriptions: {
            loomShareText: callback => loom.subscribe(callback),
            logStatus: callback => status.subscribe(callback),
            logMessage: callback => message.subscribe(callback),
            groupTopicUpdated: callback => topic.subscribe(callback),
        },
        insertSharedText: value => consumed.push(['loom', value]),
        consumeLogStatus: value => consumed.push(['status', value]),
        consumeLogMessage: value => consumed.push(['message', value]),
        consumeGroupTopicUpdate: value => consumed.push(['topic', value]),
    });
    owner.mount();
    loom.emit('text'); status.emit('up'); message.emit('log'); topic.emit('topic');
    assert.deepEqual(consumed, [['loom', 'text'], ['status', 'up'], ['message', 'log'], ['topic', 'topic']]);
    await owner.dispose();
    assert.deepEqual([loom.removed, status.removed, message.removed, topic.removed], [1, 1, 1, 1]);
});

test('auxiliary event owner is idempotent and revokes late delivery', async () => {
    const loom = channel();
    const consumed = [];
    const owner = createMainChatAuxiliaryEventOwner({
        subscriptions: { loomShareText: callback => loom.subscribe(callback) },
        insertSharedText: value => consumed.push(value),
    });
    owner.mount();
    owner.mount();
    await owner.dispose();
    await owner.dispose();
    loom.emit('late');
    assert.deepEqual(consumed, []);
    assert.equal(loom.removed, 1);
});
