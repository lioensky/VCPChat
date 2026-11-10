import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChatRepository } from '../modules/chat/chatRepository.js';
import { createChatHistoryMutationAuthority } from '../modules/chat/chatHistoryMutationAuthority.js';
const require = createRequire(import.meta.url);
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');

for (const itemType of ['agent', 'group']) {
    test(`history CAS preserves concurrent admission and exact edit/delete semantics: ${itemType}`, async t => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'vcp-history-cas-'));
        const queue = new HistoryMutationQueue({ userDataDir: root });
        const scope = { itemId: 'a', itemType, topicId: 't' };
        const base = [{ id: 'one', content: 'original' }, { id: 'two', content: 'delete me' }];
        await queue.replace(scope, base);
        const read = () => queue.read(scope);
        const save = (_id, _topic, history, options) =>
            queue.replace(scope, history, { requireExisting: true, expectedHistory: options?.expectedHistory });
        const repository = createChatRepository({
            getChatHistory: read, getGroupChatHistory: read,
            saveChatHistory: save, saveGroupChatHistory: save,
        });
        const authority = createChatHistoryMutationAuthority({ repository });
        t.after(async () => { await authority.dispose(); await queue.dispose(); await rm(root, { recursive: true, force: true }); });
        await assert.rejects(authority.mutate(scope, async history => {
            await queue.mutate(scope, current => [...current, { id: 'letter', content: 'concurrent' }]);
            history[0].content = 'edited';
            return history.filter(message => message.id !== 'two');
        }), { code: 'HISTORY_CONFLICT' });
        assert.deepEqual((await read()).map(message => message.id), ['one', 'two', 'letter']);
        assert.equal((await read())[0].content, 'original');
        await authority.mutate(scope, history => {
            history[0].content = 'edited';
            return history.filter(message => message.id !== 'two');
        });
        assert.deepEqual(await read(), [
            { id: 'one', content: 'edited' }, { id: 'letter', content: 'concurrent' },
        ]);
        await assert.rejects(authority.mutate(scope, async history => {
            await queue.run(scope, () => rm(path.dirname(queue.getHistoryPath('a', 't')), { recursive: true }));
            return history;
        }), /HISTORY_DELETED/);
        assert.deepEqual(await read(), []);
    });
}