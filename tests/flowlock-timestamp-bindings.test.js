const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadFlowlockIntegration({
    history, onSend, continueWritingPrompt = '请继续',
    baseURI = require('node:url').pathToFileURL(path.resolve(__dirname, '../main.html')).href,
    onImport = () => {}
}) {
    let continueWritingForContext;
    const chatAPI = {
        getChatHistory: async () => history,
        getAgentConfig: async () => ({
            name: 'Nova',
            model: 'test-model',
            streamOutput: true,
            systemPrompt: 'You are Nova.'
        }),
        tavernGetRules: async () => ({ success: true, store: { rules: [] } }),
        sendToVCP: async (...args) => {
            onSend(...args);
            return {};
        }
    };
    const window = {
        chatAPI,
        electronAPI: chatAPI,
        VCPMainChatState: {
            snapshot: () => ({ selectedItem: { id: 'agent-1' }, topicId: 'topic-1' })
        },
        flowlockManager: {
            initialize: ({ continueWritingForContext: continuation }) => {
                continueWritingForContext = continuation;
            },
            recoverPendingRequests: async () => {},
            cleanup: () => {}
        },
        addEventListener: () => {}
    };
    const document = {
        baseURI,
        getElementById: () => null,
        addEventListener: () => {}
    };
    const context = vm.createContext({
        console,
        document,
        window,
        setTimeout,
        clearTimeout,
        Promise,
        URL
    });
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'Flowlockmodules', 'flowlock-integration.js'),
        'utf8'
    );
    // Keep the production URL expression intact; only route loading to the host realm.
    context.loadPipeline = specifier => {
        assert.equal(specifier, new URL('modules/chat/chatContextPipeline.js', baseURI).href);
        onImport(specifier);
        return import(require('node:url').pathToFileURL(path.resolve(__dirname, '../modules/chat/chatContextPipeline.js')).href);
    };
    assert.equal((source.match(/\bimport\(/g) || []).length, 1);
    vm.runInContext(source.replace(/\bimport\(/g, 'loadPipeline('), context, {
        filename: new URL('Flowlockmodules/flowlock-integration.js', baseURI).href
    });
    window.initializeFlowlockIntegration({
        chatManager: { loadChatHistory: async () => {}, isReady: () => true },
        historyMutationAuthority: { replace: async () => {} },
        settings: {
            get: () => ({
                vcpServerUrl: 'http://127.0.0.1:6005/v1/chat/completions',
                vcpApiKey: 'test-key',
                continueWritingPrompt
            })
        }
    });

    return async () => continueWritingForContext({
        agentId: 'agent-1',
        topicId: 'topic-1',
        messageId: 'flowlock-request-1'
    });
}

test('Flowlock preserves history timestamps for OneRing and ends with a user heartbeat', async () => {
    const history = [
        { id: 'user-1', role: 'user', content: '开始任务', timestamp: 1000 },
        { id: 'assistant-1', role: 'assistant', content: '第一阶段完成', timestamp: 2000 },
        { id: 'legacy', role: 'assistant', content: '旧消息没有合法时间戳', timestamp: '3000' }
    ];
    let sentMessages;
    const run = loadFlowlockIntegration({
        history,
        onSend: (_url, _key, messages) => {
            sentMessages = messages;
        }
    });

    await run();

    assert.deepEqual(JSON.parse(JSON.stringify(sentMessages[1].__vcpchatTimestampMeta)), {
        messageId: 'user-1',
        role: 'user',
        timestamp: 1000
    });
    assert.deepEqual(JSON.parse(JSON.stringify(sentMessages[2].__vcpchatTimestampMeta)), {
        messageId: 'assistant-1',
        role: 'assistant',
        timestamp: 2000
    });
    assert.equal(sentMessages[3].__vcpchatTimestampMeta, undefined);
    assert.equal(sentMessages.at(-1).role, 'user');
    assert.match(sentMessages.at(-1).content[0].text, /^\[系统提示:\] 请继续$/);
});

test('Flowlock default includes one system prefix and the stop instruction', async () => {
    let sentMessages;
    const run = loadFlowlockIntegration({
        history: [{ role: 'assistant', content: '任务完成' }],
        continueWritingPrompt: '',
        onSend: (_url, _key, messages) => { sentMessages = messages; }
    });
    await run();
    const content = sentMessages.at(-1).content[0].text;
    assert.equal(content, '[系统提示:] 请继续。若当前已无值得继续推进的任务或话题，请输出 [[Flowlock::Stop]] 关闭心流锁心跳。');
    assert.equal(content.split('[系统提示:]').length - 1, 1);
});

test('Flowlock anchors pipeline imports to the document across installation paths', async () => {
    for (const baseURI of [
        'file:///Users/test/VCPChat/main.html',
        'file:///Users/test/My%20Apps/VCPChat/main.html',
        'file:///H:/VCP/VCPMain/VCPChat/main.html'
    ]) {
        const imports = [];
        const run = loadFlowlockIntegration({
            history: [{ role: 'assistant', content: '继续任务' }],
            baseURI,
            onImport: specifier => imports.push(specifier),
            onSend: () => {}
        });
        await run();
        assert.deepEqual(imports, [new URL('modules/chat/chatContextPipeline.js', baseURI).href]);
        assert.ok(!imports[0].includes('/Flowlockmodules/modules/'));
    }
});
