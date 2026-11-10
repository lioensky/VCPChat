import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectForgeHistory, recoverForgeSource, inheritForgeStages } from '../modules/chat/contextCompactionForge.js';
import { prepareCompactionState, effectiveContextHistory } from '../modules/chat/contextCompactionState.js';
import { buildCompactionMessages, createCheckpointMessage } from '../modules/chat/contextCompactionPrompts.js';
import { createContextCompactionService } from '../modules/chat/contextCompactionService.js';
import { createChatHistoryMutationAuthority } from '../modules/chat/chatHistoryMutationAuthority.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const request = (command, fields = {}, pid = 'p1') => '<<<[TOOL_REQUEST]>>>\n' + Object.entries({ tool_name: 'ProjectForge', command, projectId: pid, ...fields }).map(([key, value]) => `${key}:「始」${value}「末」`).join(',\n') + '\n<<<[END_TOOL_REQUEST]>>>';
const exchange = (command, fields, body, pid) => request(command, fields, pid) + `\n[[VCP调用结果信息汇总:\n- 工具名称: ProjectForge\n- 执行状态: ✅ SUCCESS\n- 返回内容: ${body}\nVCP调用结果结束]]\n`;
function fixture(prefix = '', pid = 'p1') {
    return [
        { id: prefix + 'u', role: 'user', content: '只改实现；未验证线上。' },
        { id: prefix + 'a', role: 'assistant', content: exchange('ReadCode', { path: 'src/a.js', reason: '原因 $& $$' }, '## ReadCode\n' + 'source line\n'.repeat(6000), pid) + exchange('UpdateTodos', { done: '1' }, `## Todo 已更新 · demo（\`${pid}\`）\n- 变更：#1→done`, pid) },
        { id: prefix + 'h1', role: 'assistant', content: exchange('GetProject', {}, 'hot1', pid) },
        { id: prefix + 'h2', role: 'assistant', content: exchange('GetProject', {}, 'hot2', pid) },
    ];
}
const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
const settings = { enableContextCompaction: true, contextCompactionModel: 'fixture' };

test('T2 consumes projected history and carries two generations plus diaries without copying old raw payload', () => {
    const original = fixture();
    const before = hash(original);
    const state1 = prepareCompactionState(original);
    assert.equal(state1.forgeState.stages.length, 1);
    assert.ok(JSON.stringify(state1.messages).length < JSON.stringify(original).length);
    state1.diaries.push({ content: 'DIARY $& $$' });
    const cp1 = createCheckpointMessage(state1, '第一代发现，仍未测试。', {}, { id: 'cp1' });
    assert.deepEqual(cp1.contextCompaction.forgeState, state1.forgeState);
    assert.equal(cp1.content.split('## 宿主保留：Forge 阶段观察账本').length, 2);
    const history = JSON.parse(JSON.stringify([...original, cp1, ...fixture('new-', 'p2')]));
    const state2 = prepareCompactionState(history);
    assert.deepEqual(state2.forgeState.stages.map(stage => stage.projectId), ['p1', 'p2']);
    assert.deepEqual(state2.diaries, state1.diaries);
    const messages = buildCompactionMessages(state2);
    assert.equal(messages.filter(message => String(message.content).includes('## 宿主保留：Forge 阶段观察账本')).length, 1);
    assert.ok(!messages.some(message => String(message.content).includes('DIARY')));
    const cp2 = createCheckpointMessage(state2, '第二代发现。', {}, { id: 'cp2' });
    const reloaded = JSON.parse(JSON.stringify([...history, cp2]));
    assert.deepEqual(prepareCompactionState(reloaded).forgeState, cp2.contextCompaction.forgeState);
    for (const stage of cp2.contextCompaction.forgeState.stages) for (const entry of stage.entries) {
        const raw = recoverForgeSource(reloaded, entry.source);
        const source = reloaded.find(message => message.id === entry.source.messageId).content;
        assert.equal(raw, source.slice(entry.source.start, entry.source.end));
    }
    assert.equal(hash(original), before);
    assert.equal(effectiveContextHistory(reloaded)[0].id, 'cp2');
    assert.equal(prepareCompactionState(reloaded.filter(message => message.id !== 'cp2')).forgeState.stages.length, 2);
});

test('edited/deleted/duplicated sources, reordered observations and forged metadata are not inherited', () => {
    const history = fixture();
    const state = prepareCompactionState(history);
    const saved = state.forgeState;
    for (const variant of [
        history.filter(message => message.id !== 'a'),
        history.map(message => message.id === 'a' ? { ...message, content: message.content + 'edited' } : message),
        [...history, history[1]],
    ]) {
        assert.equal(inheritForgeStages(variant, saved).stages.length, 0);
        assert.equal(inheritForgeStages(variant, saved).warnings.length, 1);
    }
    for (const alter of [
        value => { value.stages[0].entries[0].status = 'invented'; },
        value => { value.stages[0].entries.reverse(); },
        value => { value.version = 2; },
        value => { value.stages[0].closure.messageId = 'missing'; },
    ]) {
        const copy = structuredClone(saved); alter(copy);
        assert.equal(inheritForgeStages(history, copy).stages.length, 0);
    }
    const cp = createCheckpointMessage(state, 'historical', {}, { id: 'cp' });
    const next = prepareCompactionState([...history.filter(message => message.id !== 'a'), cp]);
    assert.equal(next.forgeState, undefined);
    assert.match(next.warnings.join('\n'), /来源已变化/);
    assert.equal(cp.contextCompaction.forgeState.stages.length, 1, 'validation must not mutate old checkpoint');
});

test('custom forge slot preserves replacement characters; no Forge history remains compatible', () => {
    const state = prepareCompactionState(fixture());
    const checkpoint = createCheckpointMessage(state, 'report $& $$', {
        contextCompactionMainPrompt: '{{forge_state}}\n{{context_checkpoint}}\n{{latest_diaries}}',
    });
    assert.match(checkpoint.content, /原因 \$& \$\$/);
    assert.ok(checkpoint.content.includes('report $& $$'));
    assert.ok(!checkpoint.content.includes('{{forge_state}}'));
    const ordinary = prepareCompactionState([{ role: 'user', content: 'hello' }]);
    const noForge = createCheckpointMessage(ordinary, 'plain');
    assert.equal(noForge.contextCompaction.forgeState, undefined);
    assert.ok(!noForge.content.includes('Forge'));
    assert.deepEqual(inheritForgeStages([], undefined).stages, []);
});

test('actual history authority persists ledger through JSON roundtrip; cancel/CAS/save errors leave originals unchanged', async () => {
    for (const mode of ['success', 'cancel', 'drift', 'save-error']) {
        let durable = fixture();
        const original = structuredClone(durable);
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const authority = createChatHistoryMutationAuthority({ repository: {
            getHistory: async () => structuredClone(durable),
            saveHistory: async (_id, _type, _topic, value) => {
                if (mode === 'save-error') throw new Error('controlled-save');
                durable = JSON.parse(JSON.stringify(value));
                return { success: true };
            },
        } });
        const service = createContextCompactionService({ historyMutationAuthority: authority,
            request: async ({ state }) => { assert.equal(state.forgeState.stages.length, 1); return gate; } });
        const pending = service.compact({ scope, history: durable, settings });
        const rejected = mode === 'success' ? null : assert.rejects(pending, mode === 'cancel' ? /取消/ : mode === 'drift' ? /历史已变化/ : /controlled-save/);
        if (mode === 'cancel') service.cancel(scope);
        if (mode === 'drift') durable.push({ id: 'later', role: 'user', content: 'new' });
        release('model summary');
        if (rejected) await rejected;
        else {
            await pending;
            const next = prepareCompactionState(durable);
            assert.equal(next.forgeState.stages.length, 1);
            assert.equal(hash(durable.slice(0, original.length)), hash(original));
        }
        if (mode !== 'success') {
            assert.deepEqual(durable.slice(0, original.length), original);
            assert.equal(durable.some(message => message.contextCompaction), false);
        }
        service.dispose();
    }
});

test('failure survives stage closure and inherited budget exhaustion does not truncate old ledger', () => {
    const history = fixture();
    const failed = exchange('EditCode', { path: 'src/a.js', reason: 'failed attempt' }, 'Error: write failed', 'p1')
        .replace('- 执行状态: ✅ SUCCESS', '- 执行状态: ❌ ERROR');
    history[1].content = history[1].content.replace(request('UpdateTodos', { done: '1' }), failed + request('UpdateTodos', { done: '1' }));
    const projected = projectForgeHistory(history);
    assert.ok(projected.history[1].content.includes('Error: write failed'));
    const state = prepareCompactionState(history);
    const cp = createCheckpointMessage(state, 'summary does not imply all green');
    assert.ok(cp.content.includes('❌ ERROR'));
    assert.ok(prepareCompactionState([...history, cp]).forgeState.stages[0].entries.some(entry => entry.status === '❌ ERROR'));
    const saved = { version: 1, stages: projected.stages };
    const inherited = inheritForgeStages(history, saved);
    assert.deepEqual(inherited.stages, saved.stages);
    assert.equal(projectForgeHistory(history, { maxLedgerChars: 0 }).history, history);
    assert.equal(inheritForgeStages(history, { version: 1, stages: [], padding: 'x'.repeat(24001) }).stages.length, 0);
});
