import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatOperations } from '../modules/chat/chatOperation.js';

test('ChatOperations uses real send promise and locks duplicate submissions', async () => {
    let resolve;
    const operations = createChatOperations({ send: () => new Promise(r => { resolve = r; }) });
    const pending = operations.sendMessage({ content: 'hello' });
    assert.equal(operations.state.status, 'pending');
    await assert.rejects(() => operations.sendMessage({ content: 'duplicate' }), /already pending/);
    resolve({ success: true });
    assert.deepEqual(await pending, { success: true });
    assert.equal(operations.state.status, 'idle');
});

test('ChatOperations dispose cancels and waits for the operation', async () => {
    let resolve;
    let cancelled = false;
    const operations = createChatOperations({ send: () => new Promise(r => { resolve = r; }), cancel: async () => { cancelled = true; resolve?.({ cancelled: true }); } });
    operations.sendMessage({ content: 'hello' });
    await operations.dispose();
    assert.equal(cancelled, true);
    assert.equal(operations.state.status, 'disposed');
});

test('ChatOperations cancellation is idempotent and late completion cannot regain authority', async () => {
    let resolve;
    let cancelCalls = 0;
    const operations = createChatOperations({
        send: () => new Promise(r => { resolve = r; }),
        cancel: async () => { cancelCalls += 1; }
    });
    const pending = operations.sendMessage({ content: 'hold' });
    assert.equal(await operations.cancel(), true);
    assert.equal(await operations.cancel(), true);
    resolve({ cancelled: true });
    await pending;
    assert.equal(operations.state.status, 'idle');
    assert.equal(cancelCalls, 1);
    await operations.dispose();
    assert.equal(operations.state.status, 'disposed');
});
