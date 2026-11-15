import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatRepository } from '../modules/chat/chatRepository.js';

test('ChatRepository maps agent and group history through the narrow contract', async () => {
    const calls = [];
    const repo = createChatRepository({
        getChatHistory: async (...args) => { calls.push(['agent-get', ...args]); return []; },
        getGroupChatHistory: async (...args) => { calls.push(['group-get', ...args]); return []; },
        saveChatHistory: async (...args) => { calls.push(['agent-save', ...args]); return { success: true }; },
        saveGroupChatHistory: async (...args) => { calls.push(['group-save', ...args]); return { success: true }; }
    });
    await repo.getHistory('a', 'agent', 't');
    await repo.getHistory('g', 'group', 't');
    await repo.saveHistory('a', 'agent', 't', []);
    await repo.saveHistory('g', 'group', 't', []);
    assert.deepEqual(calls.map(([kind]) => kind), ['agent-get', 'group-get', 'agent-save', 'group-save']);
});


for (const itemType of ['agent', 'group']) {
    for (const failure of [
        { success: false, error: '保存冲突', code: 'HISTORY_CONFLICT' },
        { error: { message: '保存冲突', code: 'HISTORY_CONFLICT' } },
        { success: false, message: '保存冲突', code: 'HISTORY_CONFLICT' },
    ]) {
        test(`仓储统一读取和保存失败并保留错误码：${itemType} ${JSON.stringify(failure)}`, async () => {
            const fail = async () => failure;
            const repository = createChatRepository({
                getChatHistory: fail, getGroupChatHistory: fail,
                saveChatHistory: fail, saveGroupChatHistory: fail,
                topicAdmissionPersistAssistant: fail,
            });
            for (const operation of [
                () => repository.getHistory('a', itemType, 't'),
                () => repository.saveHistory('a', itemType, 't', []),
                () => repository.persistAssistant({ itemId: 'a', itemType, topicId: 't' }, {}),
            ]) {
                await assert.rejects(operation(), { message: '保存冲突', code: 'HISTORY_CONFLICT' });
            }
        });
    }
}

test('仓储保留被抛出的错误身份和结构化拒绝码，透传确认基线', async () => {
    const expected = Object.assign(new Error('失败'), { code: 'EXPECTED' });
    const repository = createChatRepository({
        getChatHistory() { throw expected; },
        saveChatHistory: async (_id, _topic, _history, options) => {
            assert.deepEqual(options, { expectedHistory: [{ id: 'old' }] });
            throw { code: 'HISTORY_CONFLICT', error: { message: '冲突' } };
        },
    });
    await assert.rejects(repository.getHistory('a', 'agent', 't'), error => error === expected);
    await assert.rejects(repository.saveHistory('a', 'agent', 't', [], { expectedHistory: [{ id: 'old' }] }),
        { code: 'HISTORY_CONFLICT', message: '冲突' });
});

test('仓储兼容没有回执的既有保存适配器', async () => {
    const repository = createChatRepository({ saveChatHistory: async () => {} });
    assert.equal(await repository.saveHistory('a', 'agent', 't', []), undefined);
});
