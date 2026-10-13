import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { marked } = require('marked');

// 服务器回传的真实形态：每个工具结果都包在一对 User 分界里，请求参数里常带引号和反斜杠。
const S = '「始」';
const E = '「末」';
const REQ = (tool, fields) => `<<<[TOOL_REQUEST]>>>\ntool_name:${S}${tool}${E},\n${fields}\n<<<[END_TOOL_REQUEST]>>>`;
const RESULT = (tool, body) => `<<<[ROLE_DIVIDE_USER]>>>\n\n[[VCP调用结果信息汇总:\n- 工具名称: ${tool}\n- 执行状态: ✅ SUCCESS\n- 返回内容: ${body}\nVCP调用结果结束]]\n\n<<<[END_ROLE_DIVIDE_USER]>>>`;
const POWERSHELL = "Set-Location 'H:\\VCP\\VCPChat'; $env:PUPPETEER_EXECUTABLE_PATH='C:\\Program Files (x86)\\Microsoft\\Edge'";
const TRANSCRIPT = [
    '先改代码再跑一下。',
    REQ('ProjectForge', `command:${S}EditCode${E},\npath:${S}src/a.js${E}`),
    RESULT('ProjectForge', '## ✅ 已写入 · `src/a.js`\n### Diff (+1 -1)'),
    REQ('PowerShellExecutor', `command:${S}${POWERSHELL}${E}`),
    RESULT('PowerShellExecutor', 'ok'),
    '都完成了。',
].join('\n\n');

function createRef(initialValue) {
    let value = initialValue;
    return {
        get: () => value,
        set: nextValue => { value = nextValue; },
    };
}

function createVisibilityStub() {
    return {
        initializeVisibilityOptimizer() {},
        observeMessage() {},
        unobserveMessage() {},
        destroyVisibilityOptimizer() {},
        isMessageInHotZone: () => true,
        recheckVisibility() {},
        registerAnimeInstance() {},
        registerThreeContext() {},
        registerCanvasAnimation() {},
        isMessagePaused: () => false,
        createPausableRAF: () => callback => setTimeout(() => callback(Date.now()), 0),
        createPausableTimerAPI: () => ({
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
        }),
    };
}

async function createRendererFixture(messageContent, appearanceProfile, markdown = marked) {
    const dom = new JSDOM(
        '<!doctype html><html><head></head><body><div class="chat-messages-container"><div id="chat"></div></div></body></html>',
        {
            url: 'https://vcpchat.local/',
            pretendToBeVisual: true,
        },
    );
    const previousGlobals = {
        window: globalThis.window,
        document: globalThis.document,
        Node: globalThis.Node,
        NodeFilter: globalThis.NodeFilter,
        MutationObserver: globalThis.MutationObserver,
    };
    if (appearanceProfile) {
        dom.window.document.documentElement.dataset.uiMode = 'next';
        dom.window.VCPAppearance = { getCurrent: () => appearanceProfile };
    }
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.NodeFilter = dom.window.NodeFilter;
    globalThis.MutationObserver = dom.window.MutationObserver;

    const [{ createStreamProjection }, { createStreamTransientHistory }, { createMessageRenderer }] = await Promise.all([
        import('../modules/renderer/streamManager.js'),
        import('../modules/chat/streamTransientHistory.js'),
        import('../modules/messageRenderer.js'),
    ]);

    const historyRef = createRef([]);
    const selectedRef = createRef({
        id: 'tool-card-agent',
        type: 'agent',
        name: 'Tool Card Agent',
        avatarUrl: 'assets/default_avatar.png',
        config: {},
    });
    const topicRef = createRef('tool-card-topic');
    const settingsRef = createRef({
        enableSmoothStreaming: false,
        enableAiMessageButtons: false,
        userAvatarUrl: 'assets/default_user_avatar.png',
    });
    const repository = {
        async getHistory() { return historyRef.get(); },
        async saveHistory() { return { success: true }; },
    };
    const transientStreamHistory = createStreamTransientHistory({
        repository,
        currentHistory: {
            get: historyRef.get,
            replace: historyRef.set,
        },
    });
    const streamProjection = createStreamProjection();
    const renderer = createMessageRenderer({
        streamManager: streamProjection,
        visibilityOptimizer: createVisibilityStub(),
        enableContextMenu: false,
        enableMiddleClick: false,
        exposeGlobalCommands: false,
    });
    const root = dom.window.document.getElementById('chat');
    const electronAPI = {
        async getEmoticonLibrary() { return []; },
        onDesktopStatus() { return () => {}; },
        openImageViewer() {},
        showImageContextMenu() {},
        sovitsStop() {},
        async saveAvatarColor() { return { success: true }; },
    };
    renderer.initializeMessageRenderer({
        chatMessagesDiv: root,
        electronAPI,
        chatRepository: repository,
        historyMutationAuthority: {
            async replace(_context, history) {
                historyRef.set([...history]);
                return history;
            },
        },
        transientStreamHistory,
        markedInstance: markdown,
        morphdom: require('morphdom'),
        uiHelper: {
            scrollToBottom() {},
            showToastNotification() {},
        },
        currentChatHistoryRef: historyRef,
        currentSelectedItemRef: selectedRef,
        currentTopicIdRef: topicRef,
        globalSettingsRef: settingsRef,
        summarizeTopicFromMessages: async () => null,
        handleCreateBranch: async () => null,
        messageCommands: {
            updateSendButtonState() {},
            syncNextUiEmptyStateWithMessages() {},
            handleSendMessage: async () => {},
        },
    });

    const message = {
        id: 'tool-card-message',
        role: 'assistant',
        content: messageContent,
        timestamp: Date.now(),
    };
    historyRef.set([message]);
    const messageItem = await renderer.renderMessage(message, false, true);

    return {
        dom,
        renderer,
        streamProjection,
        messageItem,
        historyRef,
        restoreGlobals() {
            globalThis.window = previousGlobals.window;
            globalThis.document = previousGlobals.document;
            globalThis.Node = previousGlobals.Node;
            globalThis.NodeFilter = previousGlobals.NodeFilter;
            globalThis.MutationObserver = previousGlobals.MutationObserver;
        },
    };
}

async function disposeFixture(fixture) {
    try {
        fixture.renderer.disposeRendererResources();
        await fixture.streamProjection.dispose();
    } finally {
        fixture.restoreGlobals();
        fixture.dom.window.close();
    }
}


async function renderTranscript(toolPresentation) {
    const fixture = await createRendererFixture(TRANSCRIPT, { toolPresentation, toolExpansion: 'none' });
    const content = fixture.messageItem.querySelector('.md-content');
    // 卡片样式在附件等异步步骤之后才套用。
    for (let i = 0; i < 100 && !content.dataset.vcpToolPresentation; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(content.dataset.vcpToolPresentation, toolPresentation);
    return { fixture, content };
}

function visibleDividers(content) {
    return [...content.querySelectorAll('.vcp-role-divider')].filter(node => node.dataset.vcpToolWrapper !== 'true');
}

test('tool request fields reach the card once-escaped: quotes stay quotes in the title and the details', async () => {
    const { fixture, content } = await renderTranscript('compact');
    try {
        const request = [...content.querySelectorAll('[data-vcp-block-type="tool-use"]')].find(node => node.textContent.includes('PowerShellExecutor'));
        assert.ok(request, 'PowerShell request must render as a card');
        const title = request.querySelector('.vcp-tool-row-title').textContent;
        assert.match(title, /Set-Location 'H:\\VCP\\VCPChat'/);
        assert.doesNotMatch(title, /&#039;|&amp;/);
        assert.equal(request.querySelector('template'), null);
        assert.equal(request.querySelector('.vcp-tool-details').textContent, '');
        request.querySelector('.vcp-tool-row-toggle').click();
        const details = request.querySelector('.vcp-tool-details').textContent;
        assert.ok(details.includes(POWERSHELL), 'expanded details must show the original command');
        request.querySelector('.vcp-tool-row-toggle').click();
        assert.equal(request.querySelector('.vcp-tool-details').textContent, '');
    } finally {
        await disposeFixture(fixture);
    }
});

test('grouped style keeps a whole tool run in one group instead of splitting at each result wrapper', async () => {
    const { fixture, content } = await renderTranscript('grouped');
    try {
        const groups = content.querySelectorAll('.vcp-tool-process');
        assert.equal(groups.length, 1);
        assert.match(groups[0].querySelector('.vcp-tool-process-title').textContent, /2 请求 2 结果/);
        assert.equal(visibleDividers(content).length, 0);
    } finally {
        await disposeFixture(fixture);
    }
});

test('single-line style folds each wrapped result into the request row before it', async () => {
    const { fixture, content } = await renderTranscript('inline');
    try {
        const merged = content.querySelectorAll('[data-vcp-block-type="tool-result"][data-vcp-tool-merged="true"]');
        assert.equal(merged.length, 2);
        assert.equal(content.querySelectorAll('[data-vcp-tool-pending="true"]').length, 0);
        assert.equal(visibleDividers(content).length, 0);
    } finally {
        await disposeFixture(fixture);
    }
});

test('legacy style still shows the role dividers around results', async () => {
    const { fixture, content } = await renderTranscript('legacy');
    try {
        assert.equal(content.querySelectorAll('.vcp-role-divider').length, 4);
        assert.equal(content.querySelectorAll('[data-vcp-tool-wrapper]').length, 0);
    } finally {
        await disposeFixture(fixture);
    }
});
test('emoticon before tool results cannot hide role wrappers and summaries in final render', async () => {
    const text = [
        '正文 (`・ω・´)ゞ',
        REQ('Demo', `command:${S}Read${E}`),
        RESULT('Demo', '```js\nconst literal = "`";\n```\n<div>data only</div>').replace(
            '<<<[END_ROLE_DIVIDE_USER]>>>',
            '[本轮工具调用摘要:]\nDemo 调用成功。\n[本轮工具调用摘要结束]\n<<<[END_ROLE_DIVIDE_USER]>>>'),
        '后文 `<style>`。',
        '```js\nx\n```\n',
    ].join('\n\n');
    const fixture = await createRendererFixture(text, {toolPresentation:'legacy', toolExpansion:'none'});
    try {
        await new Promise(resolve => setTimeout(resolve, 30));
        const content = fixture.messageItem.querySelector('.md-content');
        assert.equal(content.querySelectorAll('.vcp-role-divider').length, 2);
        assert.ok(content.querySelector('[data-vcp-block-type="tool-use"]'));
        assert.ok(content.querySelector('[data-vcp-block-type="tool-result"]'));
        assert.doesNotMatch(content.textContent, /<<<\[(?:END_)?ROLE_DIVIDE_USER\]>>>|\[本轮工具调用摘要/);
    } finally {
        await disposeFixture(fixture);
    }
});

test('live stable highlights and request cards survive a split tool result before terminal', async () => {
    const fixture = await createRendererFixture('', {toolPresentation:'legacy', toolExpansion:'none'});
    const {streamProjection: projection, messageItem} = fixture;
    const context = {agentId:'tool-card-agent', topicId:'tool-card-topic'};
    const wait = () => new Promise(resolve => setTimeout(resolve, 160));
    try {
        await projection.startStreamingMessage({
            id:'tool-card-message', role:'assistant', content:'', ...context,
        }, messageItem);
        projection.appendStreamChunk('tool-card-message', {content:'“引用” @测试 @!核心 (`・ω・´)ゞ\n\n第二段。\n\n第三段。\n\n'}, context);
        await wait();
        const stable = messageItem.querySelector('.vcp-stream-stable-block');
        assert.ok(stable, 'ordinary paragraphs must stabilize while stream remains active');
        assert.ok(stable.querySelector('.highlighted-quote'));
        assert.ok(stable.querySelector('.highlighted-tag'));
        assert.ok(stable.querySelector('.highlighted-alert-tag'));
        projection.appendStreamChunk('tool-card-message', {content:REQ('Demo', `command:${S}Read${E}`)+'\n\n'}, context);
        await wait();
        const request = messageItem.querySelector('[data-vcp-block-type="tool-use"]');
        assert.ok(request);
        const result = RESULT('Demo', '```js\nconst face = "`";\n```\n<div>raw</div>');
        const split = result.indexOf('VCP调用结果结束');
        projection.appendStreamChunk('tool-card-message', {content:result.slice(0, split)}, context);
        await wait();
        assert.equal(request.isConnected, true);
        projection.appendStreamChunk('tool-card-message', {content:result.slice(split)+'\n\n完成。\n\n'}, context);
        await wait();
        assert.equal(request.isConnected, true);
        assert.ok(messageItem.querySelector('[data-vcp-block-type="tool-result"]'));
        const stableRoot = messageItem.querySelector('.vcp-stream-stable-blocks');
        assert.doesNotMatch(stableRoot?.textContent || '', /<<<\[(?:END_)?ROLE_DIVIDE_USER\]>>>/);
        assert.equal(projection.isMessageActive('tool-card-message'), true);
    } finally {
        await disposeFixture(fixture);
    }
});


test('ProjectForge topic surface is enabled and revoked by edits and clear', async () => {
    const fixture = await createRendererFixture(TRANSCRIPT, {toolPresentation:'compact', toolExpansion:'none'});
    try {
        const root = fixture.messageItem.parentElement;
        assert.equal(root.dataset.vcpProjectforgeTopic, 'true');
        fixture.renderer.updateMessageContent('tool-card-message', '调用已移除');
        assert.equal(root.hasAttribute('data-vcp-projectforge-topic'), false);
        fixture.renderer.updateMessageContent('tool-card-message', TRANSCRIPT);
        assert.equal(root.dataset.vcpProjectforgeTopic, 'true');
        fixture.renderer.clearChat();
        assert.equal(root.hasAttribute('data-vcp-projectforge-topic'), false);
    } finally {
        await disposeFixture(fixture);
    }
});

test('ProjectForge streaming tool name enables the topic surface before request completion', async () => {
    const fixture = await createRendererFixture('', {toolPresentation:'legacy', toolExpansion:'none'});
    const context = {agentId:'tool-card-agent', topicId:'tool-card-topic'};
    try {
        await fixture.streamProjection.startStreamingMessage({
            id:'tool-card-message', role:'assistant', content:'', ...context,
        }, fixture.messageItem);
        fixture.streamProjection.appendStreamChunk('tool-card-message', {
            content:'<<<[TOOL_REQUEST]>>>\ntool_name:「始」ProjectForge「末」,\n',
        }, context);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(fixture.messageItem.parentElement.dataset.vcpProjectforgeTopic, 'true');
    } finally {
        await disposeFixture(fixture);
    }
});


test('ProjectForge request with valet before tool_name activates the actual renderer root', async () => {
    const content = `<<<[TOOL_REQUEST]>>>
valet:「始」Kerr「末」,
tool_name:「始」ProjectForge「末」,
command:「始」ListProjects「末」,
workspace:「始」vcpchat「末」,
ink:「始」mark_history「末」
<<<[END_TOOL_REQUEST]>>>`;
    const fixture = await createRendererFixture(content, {toolPresentation:'legacy', toolExpansion:'none'});
    try {
        assert.equal(fixture.messageItem.parentElement.dataset.vcpProjectforgeTopic, 'true');
        assert.ok(fixture.messageItem.querySelector('.vcp-tool-use-bubble'));
    } finally {
        await disposeFixture(fixture);
    }
});


test('four-message history with a 600K tool-heavy bubble never parses collapsed payloads', async () => {
    const marker = 'LAZY_PAYLOAD_SENTINEL';
    const payload = marker + '\n' + 'const source = 123456789;\n'.repeat(210);
    const text = Array.from({length:140}, (_, i) =>
        REQ('ProjectForge', `command:${S}${i < 100 ? 'GetCode' : 'EditCode'}${E},\npath:${S}src/file-${i}.js${E},\ncontent:${S}${payload}${E}`) +
        '\n\n' + RESULT('ProjectForge', '```js\n' + payload + '\n```')
    ).join('\n\n') + '\n\n最终回答。';
    assert.ok(text.length > 600000);
    const parsed = [];
    const fixture = await createRendererFixture('', {toolPresentation:'compact', toolExpansion:'none'}, {
        parse(source, options) { parsed.push(source); return marked.parse(source, options); },
    });
    try {
        fixture.renderer.clearChat();
        const history = [
            {id:'u1', role:'user', content:'开始', timestamp:1},
            {id:'a1', role:'assistant', content:'准备好了', timestamp:2},
            {id:'u2', role:'user', content:'读取并修改文件', timestamp:3},
            {id:'a2', role:'assistant', content:text, timestamp:4},
        ];
        fixture.historyRef.set(history);
        const start = performance.now();
        await fixture.renderer.renderHistory(history);
        await new Promise(resolve => setTimeout(resolve, 30));
        const root = fixture.dom.window.document.getElementById('chat');
        const bubble = root.querySelector('[data-message-id="a2"] .md-content');
        assert.equal(root.querySelectorAll('.message-item').length, 4);
        assert.equal(bubble.querySelectorAll('[data-vcp-lazy-tool-id]').length, 280);
        assert.equal(bubble.querySelectorAll('template, .vcp-tool-details pre, .vcp-tool-result-item').length, 0);
        assert.ok(!parsed.some(source => source.includes(marker)), 'no collapsed tool payload may reach Markdown');
        assert.ok(bubble.innerHTML.length < text.length / 2);
        console.log(`[LazyTools] source=${text.length} initialHTML=${bubble.innerHTML.length} loadMs=${Math.round(performance.now()-start)}`);
        const result = bubble.querySelector('.vcp-tool-result-bubble');
        result.querySelector('.vcp-tool-row-toggle').click();
        assert.ok(result.textContent.includes(marker));
        assert.equal(parsed.filter(source => source.includes(marker)).length, 1);
        result.querySelector('.vcp-tool-row-toggle').click();
        assert.equal(result.querySelector('.vcp-tool-result-collapsible-content').childNodes.length, 0);
        assert.equal(fixture.historyRef.get()[3].content, text);
        fixture.renderer.clearChat();
        assert.equal(fixture.renderer.getLazyToolStats().entries, 0);
    } finally {
        await disposeFixture(fixture);
    }
});

test('legacy request and result clicks mount only the selected block and release on collapse', async () => {
    const fixture = await createRendererFixture(TRANSCRIPT, {toolPresentation:'legacy', toolExpansion:'none'});
    try {
        await new Promise(resolve => setTimeout(resolve, 30));
        const content = fixture.messageItem.querySelector('.md-content');
        const request = content.querySelector('.vcp-tool-use-bubble');
        const result = content.querySelector('.vcp-tool-result-bubble');
        request.querySelector('.vcp-tool-summary').click();
        assert.match(request.querySelector('.vcp-tool-details').textContent, /EditCode/);
        assert.equal(result.querySelector('.vcp-tool-result-collapsible-content').childNodes.length, 0);
        result.querySelector('.vcp-tool-result-header').click();
        assert.ok(result.querySelector('.vcp-tool-result-markdown-content'));
        result.querySelector('.vcp-tool-result-header').click();
        assert.equal(result.querySelector('.vcp-tool-result-collapsible-content').childNodes.length, 0);
        request.querySelector('.vcp-tool-summary').click();
        assert.equal(request.querySelector('.vcp-tool-details').childNodes.length, 0);
    } finally {
        await disposeFixture(fixture);
    }
});

test('closed turn keeps even failed result bodies unparsed until its group opens', async () => {
    const text = TRANSCRIPT.replace('✅ SUCCESS', '❌ ERROR');
    const fixture = await createRendererFixture(text, {toolPresentation:'process', toolExpansion:'attention'});
    try {
        await new Promise(resolve => setTimeout(resolve, 30));
        const group = fixture.messageItem.querySelector('.vcp-tool-process');
        assert.ok(group.querySelector('.vcp-tool-process-body').hidden);
        assert.equal(group.querySelectorAll('.vcp-tool-result-item').length, 0);
        group.querySelector('.vcp-tool-process-toggle').click();
        assert.ok(group.querySelector('.vcp-tool-result-item'));
        group.querySelector('.vcp-tool-process-toggle').click();
        assert.equal(group.querySelectorAll('.vcp-tool-result-item').length, 0);
    } finally {
        await disposeFixture(fixture);
    }
});
