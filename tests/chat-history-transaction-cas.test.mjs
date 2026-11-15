import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createChatRepository } from '../modules/chat/chatRepository.js';
import { createChatHistoryMutationAuthority } from '../modules/chat/chatHistoryMutationAuthority.js';

const require = createRequire(import.meta.url);
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

// 执行生产保存处理函数本体，隔离其余 Electron/网络运行时初始化。
async function loadSaveHandler(itemType, queue) {
    const group = itemType === 'group';
    const file = group ? 'groupChatHandlers.js' : 'chatHandlers.js';
    const channel = group ? 'save-group-chat-history' : 'save-chat-history';
    const source = await readFile(new URL(`../modules/ipc/${file}`, import.meta.url), 'utf8');
    const start = source.indexOf(`    ipcMain.handle('${channel}',`);
    assert.notEqual(start, -1);
    const end = source.indexOf('\n    });', start);
    assert.notEqual(end, -1);
    let handler;
    vm.runInNewContext(source.slice(start, end + '\n    });'.length), {
        ipcMain: { handle(name, callback) { assert.equal(name, channel); handler = callback; } },
        historyMutationQueue: queue,
        console: { log() {}, error() {} },
    });
    return handler;
}

for (const itemType of ['agent', 'group']) {
    test(`跨权威异步变更保留 CAS 和 IPC 冲突码，不重放、不降级：${itemType}`, async t => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'vcp-transaction-cas-'));
        const queue = new HistoryMutationQueue({ userDataDir: root });
        const scope = { itemId: 'owner', itemType, topicId: 'topic' };
        await queue.replace(scope, [{ id: 'original', content: { text: '原始' } }]);
        const handler = await loadSaveHandler(itemType, queue);
        let saves = 0;
        const save = async (id, topic, history, options) => {
            saves++;
            assert.ok(Array.isArray(options?.expectedHistory), '每次普通变更必须携带读取基线');
            return handler(null, id, topic, history, options);
        };
        const read = () => queue.read(scope);
        const repository = createChatRepository({
            getChatHistory: read, getGroupChatHistory: read,
            saveChatHistory: save, saveGroupChatHistory: save,
        });
        const first = createChatHistoryMutationAuthority({ repository });
        const second = createChatHistoryMutationAuthority({ repository });
        t.after(async () => {
            await Promise.all([first.dispose(), second.dispose()]);
            await queue.dispose();
            await rm(root, { recursive: true, force: true });
        });
        const entered = deferred();
        const release = deferred();
        let callbackRuns = 0;
        let staleNotifications = 0;
        second.subscribe(scope, () => { staleNotifications++; });
        const stale = second.mutate(scope, async history => {
            callbackRuns++;
            entered.resolve();
            await release.promise;
            history[0].content.text = '旧基线编辑';
            return history;
        });
        await entered.promise;
        const winner = await first.mutate(scope, history => [...history, { id: 'new', content: '新消息' }]);
        assert.equal(winner.localCommitVersion, 1);
        const rejected = assert.rejects(stale, { code: 'HISTORY_CONFLICT' });
        release.resolve();
        await rejected;
        assert.equal(callbackRuns, 1);
        assert.equal(saves, 2, '冲突后不能额外无基线保存或重试');
        assert.equal(staleNotifications, 0);
        assert.equal(second.getLocalCommitVersion(), 0);
        assert.deepEqual(await read(), [
            { id: 'original', content: { text: '原始' } }, { id: 'new', content: '新消息' },
        ]);
        const retry = await second.mutate(scope, history => {
            history[0].content.text = '重新确认后的编辑';
            return history;
        });
        assert.equal(retry.localCommitVersion, 1);
        assert.notEqual(retry.authorityId, winner.authorityId);
        assert.equal(staleNotifications, 1);
        assert.deepEqual((await read()).map(message => message.id), ['original', 'new']);
    });

    test(`受控填充已创建话题，删除后保存仍拒绝且不复活目录：${itemType}`, async t => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'vcp-transaction-create-'));
        const queue = new HistoryMutationQueue({ userDataDir: root });
        const scope = { itemId: 'owner', itemType, topicId: 'new-topic' };
        const handler = await loadSaveHandler(itemType, queue);
        const save = (id, topic, history, options) => handler(null, id, topic, history, options);
        const repository = createChatRepository({
            getChatHistory: () => queue.read(scope), getGroupChatHistory: () => queue.read(scope),
            saveChatHistory: save, saveGroupChatHistory: save,
        });
        const authority = createChatHistoryMutationAuthority({ repository });
        t.after(async () => {
            await authority.dispose();
            await queue.dispose();
            await rm(root, { recursive: true, force: true });
        });
        // 模拟独立生命周期创建操作已经建好正式空历史。
        await queue.replace(scope, []);
        await authority.replace({ ...scope, category: 'assistant-session-close' }, [{ id: 'session' }]);
        assert.deepEqual(await queue.read(scope), [{ id: 'session' }]);
        await queue.run(scope, () => rm(path.dirname(queue.getHistoryPath(scope.itemId, scope.topicId)), { recursive: true }));
        await assert.rejects(authority.replace(scope, [{ id: 'late' }]), /HISTORY_DELETED/);
        assert.equal(authority.getLocalCommitVersion(), 1);
        assert.deepEqual(await queue.read(scope), []);
    });
}