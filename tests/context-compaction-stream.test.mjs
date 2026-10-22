import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainChatStreamConsumer } from '../modules/renderer/mainChatStreamConsumer.js';

const marker = '<<<[END_ROLE_DIVIDE_USER]>>>';
function fixture(context = {}) {
    const boundaries = [];
    const appended = [];
    const consumer = createMainChatStreamConsumer({
        messageId: 'stream-1',
        context: { agentId: 'agent', topicId: 'topic', ...context },
    }, {
        append: (_id, text) => appended.push(text),
        onToolReturnBoundary: value => boundaries.push(value),
    });
    return { boundaries, appended, push: text => consumer.consume({ type: 'chunk', text }) };
}

test('split tool-return marker triggers immediately during streaming without a terminal event', () => {
    const f = fixture();
    f.push('说话\n工具结果\n<<<[END_ROLE_');
    assert.equal(f.boundaries.length, 0);
    f.push('DIVIDE_USER]>>>');
    assert.equal(f.boundaries.length, 1);
    assert.equal(f.boundaries[0].text, `说话\n工具结果\n${marker}`);
    f.push('\n继续流式');
    assert.equal(f.boundaries.length, 1, 'same boundary cannot trigger on subsequent chunks');
    assert.equal(f.appended.length, 3);
});

test('only a standalone line triggers; CRLF and surrounding horizontal whitespace are accepted', () => {
    const f = fixture();
    f.push(`行内 ${marker} 不是边界\n`);
    assert.equal(f.boundaries.length, 0);
    f.push(` \t${marker}\t\r\n`);
    assert.equal(f.boundaries.length, 1);
    f.push(`第二轮\n${marker}\n`);
    assert.equal(f.boundaries.length, 2);
});

test('group streams never run context-compaction boundary checks', () => {
    for (const context of [{ isGroupMessage: true }, { groupId: 'group' }]) {
        const f = fixture(context);
        f.push(`${marker}\n`);
        assert.equal(f.boundaries.length, 0);
        assert.equal(f.appended.length, 1);
    }
});

for (const saveFailure of [false, true]) {
    test(`cancelled stream reaches compressor only after durable save: failure=${saveFailure}`, async () => {
        const { prepareCompactionState } = await import('../modules/chat/contextCompactionState.js');
        const { requestContextCompaction } = await import('../modules/chat/contextCompactionService.js');
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const partial = `已执行 src/core/kbm.rs 检查，Revision: 12\n工具返回完整原文\n${marker}\n中止前最后收到的尾部`;
        let durable = [{ role: 'user', content: '修复问题，不删除文件。' }];
        let requestBody;
        const consumer = createMainChatStreamConsumer({
            messageId: 'cancelled-partial', context: { agentId: 'agent', topicId: 'topic' },
        }, {
            projectTerminal: async (_id, reason, context, payload) => {
                assert.equal(reason, 'cancelled');
                return { role: 'assistant', content: payload.fullResponse, context };
            },
            async persistTerminal(projected) {
                await gate;
                if (saveFailure) throw new Error('disk unavailable');
                durable = [...durable, projected];
                return projected;
            },
            async afterPersist() {
                await requestContextCompaction({
                    settings: { contextCompactionModel: 'compressor', vcpServerUrl: 'https://fixture.local/v1/chat/completions' },
                    state: prepareCompactionState(durable),
                    fetchImpl: async (_url, init) => {
                        requestBody = JSON.parse(init.body);
                        return { ok: true, json: async () => ({ choices: [{ message: { content: '压缩报告' } }] }) };
                    },
                });
            },
        });
        const saving = consumer.persist({
            terminal: { kind: 'cancelled' }, snapshot: { text: partial },
        });
        const outcome = saving.then(() => null, error => error);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(requestBody, undefined, 'must not compress while the partial reply is still saving');
        release();
        const error = await outcome;
        if (saveFailure) {
            assert.match(error.message, /disk unavailable/);
            assert.equal(requestBody, undefined);
            assert.equal(durable.length, 1);
        } else {
            assert.equal(error, null);
            assert.equal(requestBody.messages[1].content, durable[0].content);
            assert.equal(requestBody.messages[2].role, 'assistant');
            assert.equal(requestBody.messages[2].content, partial);
            assert.match(requestBody.messages.at(-1).content, /禁止续写/);
        }
    });
}