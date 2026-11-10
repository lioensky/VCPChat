import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainChatStreamConsumer } from '../modules/renderer/mainChatStreamConsumer.js';

const marker = '<<<[END_ROLE_DIVIDE_USER]>>>';
const result = body => `[[VCP调用结果信息汇总:${body}VCP调用结果结束]]`;
const batchStart = id => `<<<[VCP_TOOL_BATCH_START:${id}]>>>`;
const batchEnd = id => `<<<[VCP_TOOL_BATCH_END:${id}]>>>`;
const request = '<<<[TOOL_REQUEST]>>>\ntool_name:「始」Demo「末」\n<<<[END_TOOL_REQUEST]>>>';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('receipt literals inside completed or streaming request fields are not tool returns', async () => {
    for (const closed of [false, true]) {
        const f = fixture();
        f.push('<<<[TOOL_REQUEST]>>>\ntool_name:\u300c始\u300dWriteFile\u300c末\u300d,\ncontent:\u300c始ESCAPE\u300d'
            + result('待写入的源码')
            + (closed ? '\u300c末ESCAPE\u300d\n<<<[END_TOOL_REQUEST]>>>' : ''));
        await tick();
        assert.equal(f.boundaries.length, 0);
        if (closed) {
            f.push('\n' + result('真正的执行结果'));
            await tick();
            assert.equal(f.boundaries.length, 1);
        }
    }
});

test('a split next receipt header revokes the previous safe point', async () => {
    const header = '[[VCP调用结果信息汇总:';
    for (let size = 1; size <= header.length; size += 1) {
        const f = fixture();
        f.push(result('第一项'));
        await tick();
        f.push('\n' + header.slice(0, size));
        assert.equal(f.boundaries[0].isActive(), false, `result header split ${size}`);
    }
});
function fixture(context = {}, onBoundary) {
    const boundaries = [];
    const appended = [];
    const consumer = createMainChatStreamConsumer({
        messageId: 'stream-1',
        context: { agentId: 'agent', topicId: 'topic', ...context },
    }, {
        append: (_id, text) => appended.push(text),
        onToolReturnBoundary: value => { boundaries.push(value); return onBoundary?.(value); },
    });
    return { boundaries, appended, consumer, push: text => consumer.consume({ type: 'chunk', text }) };
}

test('role delimiter and complete request never prove a tool has returned', async () => {
    const f = fixture();
    f.push(`${request}\n${marker}\n`);
    await tick();
    assert.equal(f.boundaries.length, 0);
    f.push('[[VCP调用结果信息汇总:还在返回');
    await tick();
    assert.equal(f.boundaries.length, 0);
    f.push('VCP调用结果结束]]');
    await tick();
    assert.equal(f.boundaries.length, 1);
    f.push('\n继续流式');
    await tick();
    assert.equal(f.boundaries.length, 1);
});

test('atomic parallel batch waits for matching batch closure, not inner result or role delimiter', async () => {
    const f = fixture();
    f.push(`${batchStart('a')}${result('一')}\n${marker}\n`);
    await tick();
    assert.equal(f.boundaries.length, 0);
    f.push(`${result('二')}${batchEnd('wrong')}`);
    await tick();
    assert.equal(f.boundaries.length, 0);
    f.push(batchEnd('a'));
    await tick();
    assert.equal(f.boundaries.length, 1);
});

test('every split position of both result and atomic batch closing markers waits for closure', async () => {
    for (const [prefix, end] of [
        ['[[VCP调用结果信息汇总:结果', 'VCP调用结果结束]]'],
        [batchStart('split') + result('结果'), batchEnd('split')],
    ]) {
        for (let split = 1; split < end.length; split += 1) {
            const f = fixture();
            f.push(prefix + end.slice(0, split));
            await tick();
            assert.equal(f.boundaries.length, 0, `premature at ${end}:${split}`);
            f.push(end.slice(split));
            await tick();
            assert.equal(f.boundaries.length, 1);
        }
    }
});

test('nested result literals and code examples do not create premature boundaries', async () => {
    const f = fixture();
    f.push('```\n' + result('示例') + '\n```\n');
    await tick();
    assert.equal(f.boundaries.length, 0);
    f.push('[[VCP调用结果信息汇总:外层 ' + result('内层'));
    await tick();
    assert.equal(f.boundaries.length, 0);
    f.push(' 外层尾部VCP调用结果结束]]');
    await tick();
    assert.equal(f.boundaries.length, 1);
});

test('new request revokes in-flight budget check; a later receipt is checked after the old query settles', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture({}, () => gate);
    f.push(result('第一轮'));
    await tick();
    assert.equal(f.boundaries.length, 1);
    const old = f.boundaries[0];
    assert.equal(old.isActive(), true);
    f.push('\n' + request);
    assert.equal(old.isActive(), false);
    f.push(batchStart('next') + result('第二轮'));
    assert.equal(old.isActive(), false);
    f.push(batchEnd('next'));
    release();
    await tick();
    assert.equal(f.boundaries.length, 2);
    assert.equal(f.boundaries[1].isActive(), true);
    f.consumer.dispose();
    assert.equal(f.boundaries[1].isActive(), false);
});

test('a new request in the same chunk cannot be interrupted at an earlier receipt', async () => {
    const f = fixture();
    f.push(result('旧回执') + '\n' + request);
    await tick();
    assert.equal(f.boundaries.length, 0);
});

test('every partial request header revokes an older boundary', async () => {
    const open = '<<<[TOOL_REQUEST]>>>';
    for (let size = 1; size <= open.length; size += 1) {
        const f = fixture();
        f.push(result('旧回执'));
        await tick();
        f.push('\n' + open.slice(0, size));
        assert.equal(f.boundaries[0].isActive(), false, `header split ${size}`);
    }
});

test('group streams never run context-compaction boundary checks', async () => {
    for (const context of [{ isGroupMessage: true }, { groupId: 'group' }]) {
        const f = fixture(context);
        f.push(result('群聊'));
        await tick();
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