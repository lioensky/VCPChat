import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assembleRequestMessages } from '../modules/chat/chatContextPipeline.js';
import { projectContextHistory } from '../modules/chat/contextCompactionState.js';
import { estimateContextTokens, shouldCompactContext } from '../modules/chat/contextCompactionService.js';

function historyFixture() {
    const call = (command, extra = '') => `<<<[TOOL_REQUEST]>>>\ntool_name:「始」ProjectForge「末」,\ncommand:「始」${command}「末」,\nprojectId:「始」p1「末」,\n${extra}\n<<<[END_TOOL_REQUEST]>>>`;
    const receipt = body => `[[VCP调用结果信息汇总:\n- 工具名称: ProjectForge\n- 执行状态: ✅ SUCCESS\n- 返回内容: ${body}\nVCP调用结果结束]]`;
    const read = '## ReadCode\n' + '1 | const ordinaryValue = 42;\n'.repeat(2200);
    return [
        { id: 'user', role: 'user', content: '只改代码，不重启。', timestamp: 1 },
        { id: 'stage', role: 'assistant', timestamp: 2, content: '公开说明保持。\n'
            + call('ReadCode', 'path:「始」src/a.js「末」') + '\n' + receipt(read) + '\n'
            + call('UpdateTodos', 'done:「始」1「末」') + '\n' + receipt('## Todo 已更新 · demo（`p1`）\n- 变更：#1→done') },
        { id: 'hot', role: 'assistant', content: call('GetProject') + '\n' + receipt('snapshot') },
        { id: 'hot2', role: 'assistant', content: call('GetProject') + '\n' + receipt('snapshot2') },
    ];
}
function textEstimate(history, system = '') {
    let cost = 0;
    for (const char of system + JSON.stringify(history)) cost += char.codePointAt(0) > 127 ? 1 : 0.3;
    return Math.ceil(cost);
}

test('shared sender projection and pre-send pricing agree while in-flight pricing stays raw', async () => {
    const history = historyFixture();
    const original = JSON.stringify(history);
    const projected = projectContextHistory(history);
    assert.equal(projected.stats.foldedResults, 1);
    const result = await assembleRequestMessages({
        history, context: { agentId: 'agent', topicId: 'topic' }, agentConfig: {},
        electronAPI: {}, tavernRules: [], systemPromptAppend: '',
    });
    for (let index = 0; index < history.length; index++) {
        assert.equal(result.messagesForVCP[index].content[0].text, projected.history[index].content);
    }
    assert.equal(result.messagesForVCP[1].__vcpchatTimestampMeta.messageId, 'stage');
    assert.equal(result.messagesForVCP[1].__vcpchatTimestampMeta.timestamp, 2);
    assert.equal(estimateContextTokens(history, 'system'), textEstimate(projected.history, 'system'));
    assert.equal(estimateContextTokens(history, 'system', { forgeProjection: false }), textEstimate(history, 'system'));
    assert.ok(estimateContextTokens(history) < estimateContextTokens(history, '', { forgeProjection: false }));
    const pending = { role: 'user', content: '继续' };
    const price = textEstimate([...projected.history, pending]);
    assert.equal(shouldCompactContext(history, { contextTokenLimit: Math.ceil(price / 0.85) + 1 }, '继续'), false);
    assert.equal(shouldCompactContext(history, { contextTokenLimit: Math.floor(price / 0.85) }, '继续'), true);
    assert.equal(JSON.stringify(history), original);
    const manager = fs.readFileSync(new URL('../modules/chatManager.js', import.meta.url), 'utf8');
    assert.match(manager, /estimateContextTokens\(\[\.\.\.effective,[^\n]+forgeProjection: false/);
});

test('all entry intents share projection; user suffix targeting and custom builders still see projected data', async () => {
    const history = historyFixture();
    const projected = projectContextHistory(history).history;
    for (const mode of ['send', 'regenerate', 'continue', 'flowlock']) {
        const seen = [];
        const result = await assembleRequestMessages({
            history, mode, context: { agentId: 'a' }, electronAPI: {}, tavernRules: [], systemPromptAppend: '',
            temporaryPrompt: 'continue',
            buildMessageContent: ({ message }) => { seen.push(message); return message.content; },
        });
        assert.equal(seen[1].content, projected[1].content);
        assert.equal(result.messagesForVCP.at(-1).content[0].text, 'continue');
    }
});

test('ordinary chat, attachments and user bytes have no Forge discount', async () => {
    const history = [{ id: 'u', role: 'user', content: '短句 $&', attachments: [{ type: 'text/plain', name: 'x', extractedText: '附件' }] }];
    assert.equal(projectContextHistory(history).stats.foldedResults, 0);
    assert.equal(estimateContextTokens(history), textEstimate(history));
    assert.deepEqual(projectContextHistory(history).history, history);
});

test('checkpoint host metadata is not charged as outbound text or allowed to trigger extra T2', () => {
    const checkpoint = {
        id: 'cp', role: 'user', content: 'historical checkpoint',
        contextCompaction: { kind: 'vchat-context-checkpoint', version: 1, checkpoint: 'historical checkpoint',
            forgeState: { version: 1, stages: [], padding: 'x'.repeat(20000) } },
    };
    const history = [checkpoint, { role: 'user', content: '继续' }];
    const outbound = history.map(message => {
        const copy = { ...message };
        delete copy.contextCompaction;
        return copy;
    });
    assert.equal(estimateContextTokens(history), textEstimate(outbound));
    assert.equal(estimateContextTokens(history, '', { forgeProjection: false }), textEstimate(outbound));
    assert.equal(shouldCompactContext(history, { contextTokenLimit: 6000 }), false);
});
