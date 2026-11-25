import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import engine from '../modules/tavernRulesEngine.js';
import { assembleRequestMessages } from '../modules/chat/chatContextPipeline.js';
import { createSingleChatRequestOrchestrator } from '../modules/chat/singleChatRequestOrchestrator.js';

const context = { agentId: 'a', topicId: 't' };
const rule = (type, content) => ({ id: type, type, content, enabled: true, scope: 'agent', wrap: false });
function fixture(systemPrompt = 'You are {{AgentName}}. {{VCPChatWorkSpace}}') {
    const snapshot = { success: true, rules: [
        rule('system_suffix', 'SUFFIX {{VCPChatWorkSpace}}'), rule('user_suffix', 'USER'),
        { ...rule('context_inject', 'INJECT'), role: 'assistant', depth: 0 },
    ] };
    const calls = [];
    return {
        snapshot, calls,
        agentConfig: { name: 'Kerr', systemPrompt, agentDataPath: 'H:\\Agents\\a', topics: [{ id: 't', createdAt: '2026-11-03T00:00:00' }] },
        electronAPI: {
            resolveConversationContext: async owner => { calls.push(['resolve', owner]); return snapshot; },
            tavernGetRules: async () => { throw new Error('global fallback forbidden'); },
            expandWorkspacePlaceholders: async (text, received) => {
                assert.equal(received, snapshot);
                calls.push(['expand', text]);
                return { success: true, text: text.replaceAll('{{VCPChatWorkSpace}}', 'TREE') };
            },
        },
    };
}

test('normal adapter and alternate entry intents produce identical messages and one expansion each', async () => {
    const f = fixture();
    const history = [{ id: 'u', role: 'user', content: 'hello', timestamp: 42 }];
    const before = structuredClone(history);
    const options = { ...f, tavernEngine: engine, history, context, currentUserMessageId: 'u' };
    const normal = await createSingleChatRequestOrchestrator({ ...f, tavernEngine: engine }).buildRequest({
        ...options, settings: {}, messageId: 'reply',
    });
    for (const mode of ['regenerate', 'continue', 'flowlock']) {
        const result = await assembleRequestMessages({ ...options, mode });
        assert.deepEqual(result.messagesForVCP, normal.messages);
    }
    assert.equal(f.calls.filter(([kind]) => kind === 'expand').length, 4);
    assert.match(normal.messages[0].content, /当前聊天记录文件路径: H:\\Agents\\a\\topics\\t\\history.json/);
    assert.match(normal.messages[0].content, /You are Kerr\. TREE\n\nSUFFIX TREE/);
    assert.deepEqual(history, before);
});

test('rules-only prompts expand once with supplied snapshot and skip global resolution', async () => {
    const f = fixture('');
    f.electronAPI.resolveConversationContext = () => { throw new Error('must reuse snapshot'); };
    const result = await assembleRequestMessages({
        ...f, tavernEngine: engine, context, history: [], conversationSnapshot: f.snapshot,
    });
    assert.equal(result.messagesForVCP[0].content, 'SUFFIX TREE');
    assert.equal(f.calls.length, 1);
});

test('temporary prompt alone receives user suffix; multimodal history and timestamp remain intact', async () => {
    const f = fixture();
    const result = await assembleRequestMessages({
        ...f, tavernEngine: engine, context,
        history: [{ id: 'u', role: 'user', timestamp: 10, content: [
            { type: 'text', text: 'old' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
        ] }],
        temporaryPrompt: 'continue',
    });
    const users = result.messagesForVCP.filter(m => m.role === 'user');
    assert.equal(users[0].content[0].text, 'old');
    assert.equal(users[0].content[1].image_url.url, 'data:image/png;base64,x');
    assert.equal(users[0].__vcpchatTimestampMeta.timestamp, 10);
    assert.equal(users[1].content[0].text, 'continue\n\nUSER');
});

test('checkpoint bypasses builders and suffixes and removes earlier history', async () => {
    const f = fixture();
    const checkpoint = { role: 'user', content: 'RAW $&', contextCompaction: {
        kind: 'vchat-context-checkpoint', version: 1, checkpoint: 'raw',
    } };
    const result = await assembleRequestMessages({
        ...f, tavernEngine: engine, context, history: [{ role: 'user', content: 'OLD' }, checkpoint],
        currentUserMessage: checkpoint,
        buildMessageContent: () => { throw new Error('checkpoint must bypass'); },
    });
    assert.equal(result.messagesForVCP[1].content[0].text, 'RAW $&');
    assert.equal(result.messagesForVCP[1].__vcpContextCheckpoint, true);
});

test('snapshot failure aborts; workspace failure preserves the original prompt', async () => {
    const f = fixture();
    await assert.rejects(assembleRequestMessages({
        ...f, context, history: [], conversationSnapshot: { success: false, error: 'denied' },
    }), /denied/);
    f.electronAPI.expandWorkspacePlaceholders = async () => { throw new Error('offline'); };
    const result = await assembleRequestMessages({ ...f, tavernEngine: engine, context, history: [] });
    assert.match(result.messagesForVCP[0].content, /\{\{VCPChatWorkSpace\}\}/);
});

test('four entry points delegate and cannot own Tavern/system/workspace assembly', () => {
    for (const path of [
        'modules/chat/singleChatRequestOrchestrator.js', 'modules/renderer/messageContextMenu.js',
        'modules/event-listeners.js', 'Flowlockmodules/flowlock-integration.js',
    ]) {
        const source = fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
        assert.match(source, /await assembleRequestMessages\(/, path);
        assert.doesNotMatch(source, /\.applySystemSuffix\(|\.applyContextInject\(|\.expandWorkspacePlaceholders\(/, path);
    }
});

test('agent history window keeps the latest persisted floor, not thinking or temporary prompts', async () => {
    const f = fixture();
    const history = [
        { id: 'old', role: 'user', content: 'outside-window', timestamp: 10 },
        { id: 'new', role: 'user', content: 'current-floor', timestamp: 20 },
        { id: 'thinking', role: 'assistant', content: 'placeholder', isThinking: true },
    ];
    const before = structuredClone(history);
    const options = { ...f, context, history, tavernRules: [],
        agentConfig: { ...f.agentConfig, contextMessageWindowSize: 1 } };
    const manual = await createSingleChatRequestOrchestrator({ electronAPI: f.electronAPI }).buildRequest({
        ...options, settings: {}, messageId: 'out', currentUserMessageId: 'new',
    });
    assert.deepEqual(manual.messages.map(m => m.role), ['system', 'user']);
    assert.equal(manual.messages[1].content[0].text, 'current-floor');
    assert.equal(manual.messages[1].__vcpchatTimestampMeta.timestamp, 20);
    const auto = await assembleRequestMessages({ ...options, temporaryPrompt: 'continue' });
    assert.deepEqual(auto.messagesForVCP.map(m => m.role), ['system', 'user', 'user']);
    assert.equal(auto.messagesForVCP.at(-1).content[0].text, 'continue');
    assert.equal(auto.messagesForVCP.at(-1).__vcpchatTimestampMeta, undefined);
    assert.equal(JSON.stringify(auto.messagesForVCP).includes('outside-window'), false);
    assert.deepEqual(history, before);

    const unlimited = await assembleRequestMessages({ ...options, agentConfig: f.agentConfig });
    assert.equal(unlimited.messagesForVCP[1].content[0].text, 'outside-window');
});

test('window does not cut a tool exchange or include a compacted earlier floor', async () => {
    const f = fixture();
    const history = [
        { role: 'user', content: 'pre-checkpoint' },
        { role: 'user', content: 'checkpoint', contextCompaction: {
            kind: 'vchat-context-checkpoint', version: 1, checkpoint: 'raw',
        } },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call-1' }] },
        { role: 'tool', content: 'result', tool_call_id: 'call-1' },
        { role: 'user', content: 'latest' },
    ];
    const options = { ...f, context, history, tavernRules: [] };
    const run = async size => (await assembleRequestMessages({
        ...options, agentConfig: { ...f.agentConfig, contextMessageWindowSize: size },
    })).messagesForVCP;
    assert.deepEqual((await run(2)).map(m => m.role), ['system', 'user']);
    const fullExchange = await run(3);
    assert.deepEqual(fullExchange.map(m => m.role), ['system', 'assistant', 'tool', 'user']);
    assert.equal(fullExchange[2].tool_call_id, 'call-1');
    assert.equal(JSON.stringify(await run(100)).includes('pre-checkpoint'), false);
});