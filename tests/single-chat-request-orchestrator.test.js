'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const engine = require('../modules/tavernRulesEngine');

let modulePromise = null;

async function loadOrchestratorModule() {
    if (!modulePromise) {
        globalThis.TavernRulesEngine = engine;
        const source = fs.readFileSync(
            'modules/chat/singleChatRequestOrchestrator.js',
            'utf8'
        ).replace(/^import\s+['"]\.\.\/tavernRulesEngine\.js['"];\s*/m, '')
            // data: URL 没有基准路径，相对 import 要换成绝对文件 URL 才能解析。
            .replace(
                /(['"])\.\.\/renderer\/toolResultRegions\.js\1/,
                JSON.stringify(pathToFileURL(path.resolve('modules/renderer/toolResultRegions.js')).href)
            ).replace(
                /(['"])\.\/contextCompactionState\.js\1/,
                JSON.stringify(pathToFileURL(path.resolve('modules/chat/contextCompactionState.js')).href)
            );
        modulePromise = import(
            `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
        );
    }
    return modulePromise;
}

function createRules() {
    return [
        {
            id: 'system',
            type: 'system_suffix',
            enabled: true,
            scope: 'agent',
            wrap: false,
            content: 'SYSTEM_RULE',
        },
        {
            id: 'user',
            type: 'user_suffix',
            enabled: true,
            scope: 'agent',
            wrap: false,
            content: 'USER_RULE',
        },
        {
            id: 'context',
            type: 'context_inject',
            enabled: true,
            scope: 'agent',
            wrap: false,
            role: 'assistant',
            depth: 0,
            content: 'CONTEXT_RULE',
        },
    ];
}

function createApi(overrides = {}) {
    const sent = [];
    return {
        sent,
        api: {
            tavernGetRules: async () => ({
                success: true,
                store: { version: 3, rules: createRules() },
            }),
            getFileAsBase64: async () => ({
                success: true,
                base64Frames: ['jpeg-frame'],
            }),
            sendToVCP: async (...args) => {
                sent.push(args);
                return { streamingStarted: true };
            },
            ...overrides,
        },
    };
}

test('central single-chat orchestration applies all Tavern rules and timestamp metadata', async () => {
    const { createSingleChatRequestOrchestrator } = await loadOrchestratorModule();
    const { api } = createApi();
    const orchestrator = createSingleChatRequestOrchestrator({
        electronAPI: api,
        tavernEngine: engine,
    });

    const request = await orchestrator.buildRequest({
        settings: {
            vcpServerUrl: 'http://fixture.local/v1/chat',
            vcpApiKey: 'secret',
        },
        agentConfig: {
            name: 'Nova',
            model: 'fixture-model',
            systemPrompt: 'You are {{AgentName}}.',
        },
        history: [
            {
                id: 'assistant-1',
                role: 'assistant',
                content: 'prior',
                timestamp: 100,
            },
            {
                id: 'user-1',
                role: 'user',
                content: 'hello',
                timestamp: 200,
            },
        ],
        messageId: 'request-1',
        currentUserMessageId: 'user-1',
        context: {
            agentId: 'agent-1',
            topicId: 'topic-1',
        },
    });

    assert.equal(request.messages[0].role, 'system');
    assert.match(request.messages[0].content, /You are Nova\./);
    assert.match(request.messages[0].content, /SYSTEM_RULE/);

    const sentUser = request.messages.find(message =>
        message.__vcpchatTimestampMeta?.messageId === 'user-1'
    );
    assert.ok(sentUser);
    assert.match(sentUser.content[0].text, /^hello/);
    assert.match(sentUser.content[0].text, /USER_RULE/);
    assert.deepEqual(sentUser.__vcpchatTimestampMeta, {
        messageId: 'user-1',
        role: 'user',
        timestamp: 200,
    });

    const injected = request.messages.find(message => message.__tavernInjected);
    assert.equal(injected.role, 'assistant');
    assert.equal(injected.content[0].text, 'CONTEXT_RULE');
    assert.equal(injected.__vcpchatTimestampMeta, undefined);
});

test('every attachment type exposes its complete file URL and preserves extracted content', async () => {
    const { createSingleChatRequestOrchestrator } = await loadOrchestratorModule();
    const { api } = createApi({
        tavernGetRules: async () => ({
            success: true,
            store: { version: 3, rules: [] },
        }),
    });
    const orchestrator = createSingleChatRequestOrchestrator({
        electronAPI: api,
        tavernEngine: engine,
    });

    const request = await orchestrator.buildRequest({
        settings: { vcpServerUrl: 'http://fixture.local/v1/chat' },
        agentConfig: { name: 'Nova', model: 'fixture-model' },
        history: [{
            id: 'user-files',
            role: 'user',
            content: 'inspect',
            timestamp: 300,
            attachments: [
                {
                    name: 'image.png',
                    type: 'image/png',
                    src: 'file:///data/image.png',
                },
                {
                    name: 'slides.pptx',
                    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                    _fileManagerData: {
                        internalPath: 'file:///data/slides.pptx',
                        extractedText: 'slide text',
                    },
                },
                {
                    name: 'archive.bin',
                    type: 'application/octet-stream',
                    internalPath: 'file:///data/archive.bin',
                },
            ],
        }],
        messageId: 'request-files',
        currentUserMessageId: 'user-files',
        context: { agentId: 'agent-1', topicId: 'topic-files' },
    });

    const user = request.messages.find(message =>
        message.__vcpchatTimestampMeta?.messageId === 'user-files'
    );
    const text = user.content.find(part => part.type === 'text').text;

    assert.match(text, /file:\/\/\/data\/image\.png/);
    assert.match(text, /file:\/\/\/data\/slides\.pptx/);
    assert.match(text, /slide text/);
    assert.match(text, /file:\/\/\/data\/archive\.bin/);
    assert.ok(user.content.some(part =>
        part.type === 'image_url'
        && part.image_url.url === 'data:image/jpeg;base64,jpeg-frame'
    ));
});

test('unset optional model parameters are omitted instead of receiving client defaults', async () => {
    const {
        buildModelConfig,
        createSingleChatRequestOrchestrator,
    } = await loadOrchestratorModule();

    const config = buildModelConfig({
        model: 'fixture-model',
        temperature: '',
        maxOutputTokens: '',
        contextTokenLimit: null,
        top_p: undefined,
        top_k: '',
    });

    assert.equal(config.model, 'fixture-model');
    assert.equal(config.stream, true);
    assert.equal(Object.hasOwn(config, 'temperature'), false);
    assert.equal(Object.hasOwn(config, 'max_tokens'), false);
    assert.equal(Object.hasOwn(config, 'contextTokenLimit'), false);
    assert.equal(Object.hasOwn(config, 'top_p'), false);
    assert.equal(Object.hasOwn(config, 'top_k'), false);

    const { api } = createApi();
    const orchestrator = createSingleChatRequestOrchestrator({
        electronAPI: api,
        tavernEngine: engine,
    });
    const explicit = await orchestrator.buildRequest({
        settings: { vcpServerUrl: 'http://fixture.local/v1/chat' },
        agentConfig: {
            model: 'fixture-model',
            temperature: '0',
            top_p: '0.8',
        },
        history: [],
        messageId: 'request-model',
        context: { agentId: 'agent-1', topicId: 'topic-model' },
    });
    assert.equal(explicit.modelConfig.temperature, 0);
    assert.equal(explicit.modelConfig.top_p, 0.8);
});

test('send delegates the prepared request to the single low-level POST gateway', async () => {
    const { createSingleChatRequestOrchestrator } = await loadOrchestratorModule();
    const { api, sent } = createApi();
    const orchestrator = createSingleChatRequestOrchestrator({
        electronAPI: api,
        tavernEngine: engine,
    });

    const result = await orchestrator.send({
        settings: {
            vcpServerUrl: 'http://fixture.local/v1/chat',
            vcpApiKey: 'secret',
        },
        agentConfig: { name: 'Nova', model: 'fixture-model' },
        history: [{
            id: 'user-send',
            role: 'user',
            content: 'send me',
            timestamp: 400,
        }],
        messageId: 'request-send',
        currentUserMessageId: 'user-send',
        context: { agentId: 'agent-1', topicId: 'topic-send' },
        modelConfigOverrides: { stream: true },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'http://fixture.local/v1/chat');
    assert.equal(sent[0][1], 'secret');
    assert.equal(sent[0][4], 'request-send');
    assert.equal(sent[0][5], false);
    assert.equal(sent[0][6].agentId, 'agent-1');
    assert.equal(sent[0][6].topicId, 'topic-send');
    assert.equal(result.request.messageId, 'request-send');
});

test('latest checkpoint replaces earlier outbound context and bypasses message text processors', async () => {
    const { createSingleChatRequestOrchestrator } = await loadOrchestratorModule();
    const { api } = createApi({ tavernGetRules: async () => ({ success: true, store: { version: 3, rules: [] } }) });
    const orchestrator = createSingleChatRequestOrchestrator({ electronAPI: api, tavernEngine: engine });
    const checkpoint = (id, content) => ({
        id, role: 'user', content,
        contextCompaction: { kind: 'vchat-context-checkpoint', version: 1, checkpoint: '<context_checkpoint>state</context_checkpoint>' },
    });
    const raw = '<context_checkpoint>\n$x$ src/core/kbm.rs\n</context_checkpoint>\n日记原文';
    const request = await orchestrator.buildRequest({
        settings: {}, agentConfig: { model: 'main' },
        history: [
            { role: 'user', content: 'OLD' },
            checkpoint('first', 'OLD_CHECKPOINT'),
            { role: 'assistant', content: 'OLD_MIDDLE' },
            checkpoint('latest', raw),
            { id: 'new', role: 'user', content: '继续' },
        ],
        currentUserMessageId: 'new', messageId: 'reply',
        context: { agentId: 'a', topicId: 't' },
        transformMessageText: ({ text }) => `processed:${text}`,
        postProcessMessageContent: async ({ content }) => content.map(part => ({ ...part, text: `post:${part.text}` })),
    });
    assert.equal(request.messages.length, 2);
    assert.equal(request.messages[0].content[0].text, raw);
    assert.equal(request.messages[0].__vcpContextCheckpoint, true);
    assert.equal(JSON.stringify(request.messages).includes('OLD'), false);
});
test('parallel window requests resolve their own agent and carry the same workspace snapshot', async () => {
    const { createSingleChatRequestOrchestrator } = await loadOrchestratorModule();
    const { api } = createApi({
        resolveConversationContext: async owner => {
            await new Promise(resolve => setTimeout(resolve, owner.id === 'a' ? 4 : 1));
            return {
                success: true, activeWorkspaceId: owner.id,
                rules: [{ id: 'local', type: 'system_suffix', scope: 'agent', enabled: true, wrap: false, content: `RULE_${owner.id}` }],
            };
        },
        expandWorkspacePlaceholders: async (text, snapshot) => ({
            success: true, text: text.replace('{{VCPChatWorkSpace}}', `TREE_${snapshot.activeWorkspaceId}`),
        }),
        tavernGetRules: async () => { throw new Error('must not read global rules'); },
    });
    const orchestrator = createSingleChatRequestOrchestrator({ electronAPI: api, tavernEngine: engine });
    const requests = await Promise.all(['a', 'b'].map(id => orchestrator.buildRequest({
        settings: {}, agentConfig: { name: id, systemPrompt: '{{VCPChatWorkSpace}}' },
        history: [], messageId: `m_${id}`, context: { agentId: id, topicId: `voicechat_${id}` },
    })));
    assert.equal(requests[0].messages[0].content, 'TREE_a\n\nRULE_a');
    assert.equal(requests[1].messages[0].content, 'TREE_b\n\nRULE_b');
});