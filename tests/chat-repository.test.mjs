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
