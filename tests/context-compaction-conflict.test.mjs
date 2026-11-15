import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextCompactionService } from '../modules/chat/contextCompactionService.js';
import { createChatHistoryMutationAuthority } from '../modules/chat/chatHistoryMutationAuthority.js';
import { createCheckpointMessage } from '../modules/chat/contextCompactionPrompts.js';

const scope = { itemId: 'agent', itemType: 'agent', topicId: 'topic' };
const settings = { enableContextCompaction: true, contextCompactionModel: 'compressor' };

async function run({ stored, visible = stored, change = () => {} }) {
    let durable = structuredClone(stored);
    let saves = 0;
    const service = createContextCompactionService({
        historyMutationAuthority: createChatHistoryMutationAuthority({
            repository: {
                getHistory: async () => structuredClone(durable),
                saveHistory: async (_id, _type, _topic, history, options) => {
                    assert.deepEqual(options.expectedHistory, durable);
                    durable = structuredClone(history);
                    saves++;
                    return { success: true };
                },
            },
        }),
        request: async () => {
            change(durable);
            return '压缩报告';
        },
    });
    try {
        const result = await service.compact({ scope, history: visible, settings });
        return { result, durable, saves };
    } finally {
        service.dispose();
    }
}

test('render-generated legacy IDs and terminal presentation metadata do not invalidate compression', async () => {
    const stored = [{ role: 'assistant', content: '已经确认的结果', timestamp: 1 }];
    const visible = [{ ...stored[0], id: 'render-only-id', isThinking: false,
        finishReason: 'completed', avatarUrl: 'local-avatar', streamOperationId: 'local-operation' }];
    const { durable, saves } = await run({ stored, visible });
    assert.equal(saves, 1);
    assert.deepEqual(durable[0], stored[0], 'commit preserves durable metadata instead of copying the UI snapshot');
    assert.equal(durable[1].contextCompaction.checkpoint, '压缩报告');
});

test('object key order and metadata-only changes during the request do not invalidate compression', async () => {
    const stored = [{ id: 'a', role: 'user', content: [{ type: 'text', text: '原始文本' }],
        attachments: [{ path: 'a.txt', type: 'text' }] }];
    const visible = [{ attachments: [{ type: 'text', path: 'a.txt' }],
        content: [{ text: '原始文本', type: 'text' }], role: 'user', id: 'a' }];
    const { durable } = await run({ stored, visible, change: history => {
        history[0].updatedAt = 100;
        history[0].avatarColor = '#ffffff';
    } });
    assert.equal(durable[0].updatedAt, 100);
    assert.equal(durable.length, 2);
});

for (const [name, change] of [
    ['content edit', history => { history[0].content = '修改后的文本'; }],
    ['role edit', history => { history[0].role = 'assistant'; }],
    ['attachment edit', history => { history[0].attachments[0].path = 'b.txt'; }],
    ['tool relationship edit', history => { history[0].tool_call_id = 'different-call'; }],
    ['append', history => { history.push({ role: 'user', content: '新增消息' }); }],
    ['active placeholder', history => { history.push({ role: 'assistant', content: '', isThinking: true }); }],
    ['delete', history => { history.pop(); }],
    ['reorder', history => { history.reverse(); }],
]) {
    test(`${name} still rejects a stale compression`, async () => {
        const stored = [
            { id: 'a', role: 'user', content: '原始文本', attachments: [{ path: 'a.txt' }] },
            { id: 'b', role: 'assistant', content: '第二条' },
        ];
        await assert.rejects(run({ stored, change }), /历史已变化/);
    });
}

test('changes before the latest checkpoint do not invalidate its effective context', async () => {
    const saved = createCheckpointMessage({ messages: [], diaries: [], warnings: [], sourceCount: 1 }, '旧快照');
    const stored = [{ role: 'user', content: '已被快照覆盖的旧历史' }, saved,
        { role: 'assistant', content: '新进展' }];
    const { durable } = await run({ stored, change: history => {
        history[0].content = '仅修订归档历史';
    } });
    assert.equal(durable[0].content, '仅修订归档历史');
    assert.equal(durable.length, 4);
});

test('host-retained diaries remain part of the conflict boundary', async () => {
    const saved = createCheckpointMessage({
        messages: [], diaries: [{ content: '日记原文', fileName: 'a' }], warnings: [], sourceCount: 1,
    }, '旧快照');
    await assert.rejects(run({ stored: [saved], change: history => {
        history[0].contextCompaction.diaries[0].content = '已更新日记';
    } }), /历史已变化/);
});