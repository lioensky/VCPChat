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


const scope = () => ({ itemId: 'a', topicId: 't' });
const tick = () => new Promise(resolve => setImmediate(resolve));
const memoryFixture = () => {
    let history = [];
    const calls = [];
    const repository = {
        async getHistory(...args) { calls.push(['read', ...args]); return structuredClone(history); },
        async saveHistory(id, type, topic, next, options) {
            calls.push(['save', id, type, topic, next, options]);
            history = structuredClone(next);
            return { success: true, metadata: { tags: ['已保存'] } };
        },
    };
    return { repository, calls, read: () => structuredClone(history) };
};

test('入队时隔离替换目标、分类、嵌套输入及确认基线', async () => {
    const gate = deferred();
    const fixture = memoryFixture();
    const authority = createChatHistoryMutationAuthority({ repository: fixture.repository });
    const blocker = authority.mutate(scope(), async () => { await gate.promise; return []; });
    const target = { ...scope(), category: '确认替换', metadata: { note: '原始' } };
    const input = [{ id: 'one', content: { text: '原始' }, attachments: [{ info: { name: '原始' } }] }];
    const options = { expectedHistory: [] };
    const pending = authority.replace(target, input, options);
    target.itemId = 'b';
    target.itemType = 'group';
    target.topicId = 'other';
    target.category = '被修改';
    target.metadata.note = '被修改';
    input[0].content.text = '被修改';
    input[0].attachments[0].info.name = '被修改';
    options.expectedHistory.push({ id: '伪基线' });
    gate.resolve();
    await blocker;
    const result = await pending;
    assert.deepEqual(result.scope, { itemId: 'a', itemType: 'agent', topicId: 't' });
    assert.equal(result.category, '确认替换');
    assert.equal(result.history[0].content.text, '原始');
    assert.equal(result.history[0].attachments[0].info.name, '原始');
    assert.deepEqual(fixture.calls.at(-1).at(-1), { expectedHistory: [] });
    assert.equal(result.concurrency, 'compare-and-swap');
    await authority.dispose();
});

test('普通变更入队时固定目标，回调读取队列内最新基线', async () => {
    const gate = deferred();
    const fixture = memoryFixture();
    const authority = createChatHistoryMutationAuthority({ repository: fixture.repository });
    const first = authority.mutate(scope(), async () => {
        await gate.promise;
        return [{ id: 'one', content: { text: '原始' } }];
    });
    const target = { ...scope(), category: '编辑' };
    const second = authority.mutate(target, history => {
        assert.equal(history[0].content.text, '原始');
        history[0].content.text = '编辑';
        return history;
    });
    target.itemId = 'b';
    target.topicId = 'other';
    target.category = '被修改';
    gate.resolve();
    await first;
    const result = await second;
    assert.equal(result.category, '编辑');
    assert.equal(result.itemId, 'a');
    assert.deepEqual(fixture.calls.at(-1).at(-1).expectedHistory, [{ id: 'one', content: { text: '原始' } }]);
    assert.equal(result.localCommitVersion, 2);
    await authority.dispose();
});

for (const failure of [
    { success: false, error: '磁盘失败', code: 'DISK_FAILURE' },
    { error: { message: '磁盘失败', code: 'DISK_FAILURE' } },
    { success: true, error: { message: '磁盘失败', code: 'DISK_FAILURE' } },
    { success: false, message: '磁盘失败', code: 'DISK_FAILURE' },
    Object.assign(new Error('磁盘失败'), { code: 'DISK_FAILURE' }),
]) {
    test(`直接仓储失败对象不成为提交：${JSON.stringify(failure)}`, async () => {
        let fail = true;
        let notified = 0;
        const authority = createChatHistoryMutationAuthority({
            repository: {
                async getHistory() { return []; },
                async saveHistory() { return fail ? failure : { success: true }; },
            },
        });
        authority.subscribe(scope(), () => { notified++; });
        await assert.rejects(authority.replace(scope(), []), { message: '磁盘失败', code: 'DISK_FAILURE' });
        assert.equal(authority.getLocalCommitVersion(), 0);
        assert.equal(notified, 0);
        fail = false;
        assert.equal((await authority.mutate(scope(), history => history)).localCommitVersion, 1);
        assert.equal(notified, 1);
        await authority.dispose();
    });
}

test('读取失败保留嵌套错误码且不调用变更回调或保存', async () => {
    const authority = createChatHistoryMutationAuthority({
        repository: {
            async getHistory() { return { error: { code: 'READ_FAILURE', message: '读取失败' } }; },
            async saveHistory() { assert.fail('不能保存'); },
        },
    });
    await assert.rejects(authority.mutate(scope(), () => assert.fail('不能执行回调')),
        { code: 'READ_FAILURE', message: '读取失败' });
    await authority.dispose();
});

test('提交历史、内容、附件、作用域、回执均深只读且不与仓储共享引用', async () => {
    const fixture = memoryFixture();
    let adapterInput;
    let adapterReceipt;
    const original = fixture.repository.saveHistory;
    fixture.repository.saveHistory = async (...args) => {
        adapterInput = args[3];
        adapterReceipt = await original(...args);
        return adapterReceipt;
    };
    const authority = createChatHistoryMutationAuthority({ repository: fixture.repository });
    const result = await authority.replace(scope(), [{
        id: 'one', content: [{ text: '原始' }], attachments: [{ metadata: { names: ['原始'] } }],
    }]);
    for (const value of [
        result, result.scope, result.history, result.history[0], result.history[0].content,
        result.history[0].content[0], result.history[0].attachments[0].metadata.names,
        result.result, result.result.metadata.tags,
    ]) assert.equal(Object.isFrozen(value), true);
    assert.throws(() => { result.history[0].content[0].text = '篡改'; }, TypeError);
    assert.throws(() => result.history[0].attachments[0].metadata.names.push('篡改'), TypeError);
    assert.throws(() => result.result.metadata.tags.push('篡改'), TypeError);
    assert.throws(() => { result.scope.topicId = 'other'; }, TypeError);
    adapterInput[0].content[0].text = '仓储后改';
    adapterReceipt.metadata.tags.push('仓储后改');
    assert.equal(result.history[0].content[0].text, '原始');
    assert.deepEqual(result.result.metadata.tags, ['已保存']);
    assert.equal('revision' in result, false);
    await authority.dispose();
});

test('作用域订阅隔离、撤销及同步和异步异常均不否定保存', async () => {
    const fixture = memoryFixture();
    const authority = createChatHistoryMutationAuthority({ repository: fixture.repository });
    const events = [];
    const subscribedScope = scope();
    const off = authority.subscribe(subscribedScope, result => { events.push(result); });
    subscribedScope.topicId = 'other';
    authority.subscribe(scope(), () => { throw new Error('观察失败'); });
    authority.subscribe(scope(), async () => { throw new Error('异步观察失败'); });
    authority.subscribe({ ...scope(), itemType: 'group' }, () => assert.fail('不属于该作用域'));
    authority.subscribe({ ...scope(), topicId: 'other' }, () => assert.fail('不属于该话题'));
    const commit = await authority.replace(scope(), [{ id: 'one' }]);
    await tick();
    assert.equal(events[0], commit);
    assert.equal(authority.diagnostics().subscriberErrors, 2);
    assert.deepEqual(fixture.read(), [{ id: 'one' }]);
    off();
    off();
    await authority.replace(scope(), []);
    await tick();
    assert.equal(events.length, 1);
    assert.equal(authority.diagnostics().subscriberErrors, 4);
    assert.equal(authority.getLocalCommitVersion(), 2);
    await authority.dispose();
});

test('销毁撤销新写入和订阅，排水已接受事务且重复调用等待同一排水', async () => {
    const gate = deferred();
    const fixture = memoryFixture();
    const authority = createChatHistoryMutationAuthority({ repository: fixture.repository });
    let notified = 0;
    authority.subscribe(scope(), () => { notified++; });
    const first = authority.mutate(scope(), async () => { await gate.promise; return [{ id: 'one' }]; });
    const second = authority.mutate(scope(), history => [...history, { id: 'two' }]);
    let drained = false;
    const disposal = authority.dispose();
    assert.equal(disposal, authority.dispose());
    disposal.then(() => { drained = true; });
    await assert.rejects(authority.replace(scope(), []), { code: 'HISTORY_AUTHORITY_DISPOSED' });
    await assert.rejects(authority.mutate(scope(), history => history), { code: 'HISTORY_AUTHORITY_DISPOSED' });
    assert.throws(() => authority.subscribe(scope(), () => {}), { code: 'HISTORY_AUTHORITY_DISPOSED' });
    await tick();
    assert.equal(drained, false);
    gate.resolve();
    await Promise.all([first, second, disposal]);
    assert.equal(notified, 2);
    assert.deepEqual(fixture.read().map(message => message.id), ['one', 'two']);
    assert.equal(authority.diagnostics().pendingConversations, 0);
    assert.equal(authority.diagnostics().subscribedScopes, 0);
});

test('普通数据之外的嵌套内部可变对象在保存前拒绝', async () => {
    const fixture = memoryFixture();
    const authority = createChatHistoryMutationAuthority({ repository: fixture.repository });
    for (const value of [new Map([['a', 1]]), new Set([1]), new Date(), new Uint8Array([1])]) {
        assert.throws(() => authority.replace(scope(), [{ content: value }]), /普通数据/);
        await assert.rejects(authority.mutate(scope(), () => [{ content: value }]), /普通数据/);
    }
    assert.equal(fixture.calls.filter(call => call[0] === 'save').length, 0);
    await authority.dispose();
});

test('不合规回执不会使已经保存的事务成为失败或泄露可变对象', async () => {
    const authority = createChatHistoryMutationAuthority({
        repository: {
            async getHistory() { return []; },
            async saveHistory() { return { success: true, metadata: new Map() }; },
        },
    });
    const result = await authority.replace(scope(), []);
    assert.deepEqual(result.result, { success: true, receiptUnavailable: true });
    assert.equal(authority.diagnostics().receiptErrors, 1);
    assert.equal(result.localCommitVersion, 1);
    await authority.dispose();
});

test('显式替换保留先创建正式话题后填充短会话的路径，不隐式读基线', async () => {
    const authority = createChatHistoryMutationAuthority({
        repository: {
            async getHistory() { assert.fail('受控替换不读取普通变更基线'); },
            async saveHistory(id, type, topicId, history, options) {
                assert.equal(topicId, '正式新话题');
                assert.equal(options, undefined);
                assert.deepEqual(history, [{ id: '辅助会话消息' }]);
                return { success: true };
            },
        },
    });
    const result = await authority.replace({ itemId: 'a', topicId: '正式新话题', category: 'voice-session-close' },
        [{ id: '辅助会话消息' }]);
    assert.equal(result.operation, 'replace');
    assert.equal(result.concurrency, 'controlled-replace');
    await authority.dispose();
});


test('异步观察者等待后续事务或永不结束时，不阻塞提交和排水', async () => {
    const fixture = memoryFixture();
    const authority = createChatHistoryMutationAuthority({ repository: fixture.repository });
    const never = new Promise(() => {});
    authority.subscribe(scope(), () => never);
    const versions = [];
    let followup;
    authority.subscribe(scope(), async commit => {
        versions.push(commit.localCommitVersion);
        if (commit.localCommitVersion === 1) {
            followup = authority.mutate(scope(), history => [...history, { id: 'two' }]);
            await followup;
        }
    });
    await authority.replace(scope(), [{ id: 'one' }]);
    await followup;
    await authority.dispose();
    assert.deepEqual(versions, [1, 2]);
    assert.deepEqual(fixture.read().map(message => message.id), ['one', 'two']);
});

test('读取启动后迟到可由本地提交水位识别，但水位不宣称存储修订', async () => {
    const fixture = memoryFixture();
    const authority = createChatHistoryMutationAuthority({ repository: fixture.repository });
    const gate = deferred();
    const readVersion = authority.getLocalCommitVersion();
    const lateRead = gate.promise.then(() => []);
    const commit = await authority.replace(scope(), [{ id: 'new' }]);
    gate.resolve();
    await lateRead;
    assert.ok(readVersion < authority.getLocalCommitVersion());
    assert.equal(authority.getLocalCommitVersion(), commit.localCommitVersion);
    assert.equal('revision' in commit, false);
    assert.equal('diskRevision' in commit, false);
    await authority.dispose();
});
