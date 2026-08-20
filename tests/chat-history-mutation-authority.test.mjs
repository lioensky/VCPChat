import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatHistoryMutationAuthority } from '../modules/chat/chatHistoryMutationAuthority.js';

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

test('history mutations serialize per conversation and expose the durable commit result', async () => {
    const firstSave = deferred();
    const calls = [];
    const authority = createChatHistoryMutationAuthority({
        repository: {
            async getHistory() { return []; },
            async saveHistory(_itemId, _itemType, topicId, history) {
                calls.push({ topicId, history });
                if (calls.length === 1) await firstSave.promise;
                return { success: true };
            },
        },
    });
    const first = authority.replace({ itemId: 'a', topicId: 't', category: 'outgoing' }, [{ id: '1' }]);
    const second = authority.replace({ itemId: 'a', topicId: 't', category: 'attachment' }, [{ id: '2' }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    firstSave.resolve();
    assert.equal((await first).category, 'outgoing');
    assert.equal((await second).category, 'attachment');
    assert.deepEqual(calls.map(call => call.history[0].id), ['1', '2']);
});

test('mutation reads inside its queue and disposal revokes new write authority', async () => {
    let history = [{ id: '1' }];
    const authority = createChatHistoryMutationAuthority({
        repository: {
            async getHistory() { return history; },
            async saveHistory(_itemId, _itemType, _topicId, next) {
                history = next;
                return { success: true };
            },
        },
    });
    await authority.mutate({ itemId: 'a', topicId: 't', category: 'edit' }, current => [...current, { id: '2' }]);
    assert.deepEqual(history.map(message => message.id), ['1', '2']);
    await authority.dispose();
    await assert.rejects(
        authority.replace({ itemId: 'a', topicId: 't' }, []),
        /disposed/
    );
});
