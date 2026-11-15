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

async function createRendererFixture(messageContent, appearanceProfile, markdown = marked, rendererOptions = {}) {
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
        HTMLElement: globalThis.HTMLElement,
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
    globalThis.HTMLElement = dom.window.HTMLElement;
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
        ...rendererOptions,
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
            async mutate(_context, mutator) {
                const history = mutator([...historyRef.get()]);
                historyRef.set(history);
                return history;
            },
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
        settingsRef,
        selectedRef,
        restoreGlobals() {
            globalThis.window = previousGlobals.window;
            globalThis.document = previousGlobals.document;
            globalThis.Node = previousGlobals.Node;
            globalThis.NodeFilter = previousGlobals.NodeFilter;
            globalThis.HTMLElement = previousGlobals.HTMLElement;
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
        assert.ok(fixture.renderer.getRenderHtmlCacheStats().skips > 0, 'oversized messages still bypass the cache');
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


test('context checkpoint is a closed inert user card and preserves raw content on update', async () => {
    const fixture = await createRendererFixture('', { toolPresentation: 'legacy', toolExpansion: 'none' });
    try {
        const content = '<context_checkpoint>\n$x$ &amp; src/core/kbm.rs\n</context_checkpoint>\n<script>bad()</script>\n' + TRANSCRIPT;
        const message = {
            id: 'checkpoint-card', role: 'user', timestamp: Date.now(), content,
            contextCompaction: {
                kind: 'vchat-context-checkpoint', version: 1,
                checkpoint: '<context_checkpoint>state</context_checkpoint>',
                diaries: [], sourceCount: 12,
            },
        };
        fixture.historyRef.set([message]);
        const item = await fixture.renderer.renderMessage(message);
        await new Promise(resolve => setTimeout(resolve, 40));
        const card = item.querySelector('details.vcp-context-checkpoint');
        assert.ok(card);
        assert.equal(card.open, false);
        assert.equal(card.querySelector('.vcp-context-checkpoint-body').textContent, content);
        assert.equal(item.querySelector('script, .katex, .vcp-tool-use-bubble, .vcp-role-divider'), null);
        message.content = content + '\n更新 $&';
        fixture.renderer.updateMessageContent(message.id, message.content);
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(item.querySelector('.vcp-context-checkpoint-body').textContent, message.content);
        assert.equal(item.querySelector('details').open, false);
    } finally {
        await disposeFixture(fixture);
    }
});


test('atomic batch hides markers, seals HTML, preserves records and excludes all receipt text from TTS', async () => {
    const id = '2026-10-29T12:51:34.979Z';
    const body = '框外机密<style>.batch-evil{color:red}</style><script>bad()</script>\n'
        + '[[VCP调用结果信息汇总:\n- 工具名称: Demo\n- 执行状态: SUCCESS\n- 返回内容: <img src=x onerror="bad()">\n[危险链接](javascript:bad())\nVCP调用结果结束]]\n'
        + '[本轮工具调用摘要:]Demo 调用成功，记录 ID: record-123[本轮工具调用摘要结束]';
    const receipt = `<<<[VCP_TOOL_BATCH_START:${id}]>>>\n${body}\n<<<[VCP_TOOL_BATCH_END:${id}]>>>`;
    const text = '前文\n\n' + receipt + '\n\n后文';
    const fixture = await createRendererFixture(text, { toolPresentation: 'legacy', toolExpansion: 'none' });
    try {
        await new Promise(resolve => setTimeout(resolve, 40));
        const content = fixture.messageItem.querySelector('.md-content');
        assert.doesNotMatch(content.textContent, /VCP_TOOL_BATCH/);
        assert.doesNotMatch(content.textContent, /record-123/);
        assert.ok(content.querySelector('.vcp-tool-call-summary-chip.status-success'));
        assert.equal([...content.querySelectorAll('pre')].filter(node => !node.textContent.trim()).length, 0,
            'batch whitespace must not create empty code cards');
        assert.equal(fixture.dom.window.document.head.querySelector('style[data-vcp-scope-id]'), null);
        assert.equal(content.querySelector('script, style, iframe, [onerror]'), null);
        const result = content.querySelector('.vcp-tool-result-bubble');
        assert.ok(result);
        result.querySelector('.vcp-tool-result-header').click();
        assert.equal(content.querySelector('script, style, iframe, [onerror], a[href^="javascript:"]'), null);
        assert.equal(fixture.renderer.extractSpeakableTextFromContentElement(content), '前文\n\n后文');
        assert.equal(fixture.historyRef.get()[0].content, text);
        result.querySelector('.vcp-tool-result-delete-btn').click();
        assert.match(fixture.historyRef.get()[0].content, /\[HIDDEN\]/);
        assert.match(fixture.historyRef.get()[0].content, /record-123/);
    } finally {
        await disposeFixture(fixture);
    }
});


test('atomic receipts remain transparent to existing tool presentation modes', async () => {
    for (const style of ['compact', 'grouped', 'inline', 'process']) {
        const id = '2026-10-29T12:51:34.979Z';
        const result = '[[VCP调用结果信息汇总:\n- 工具名称: Demo\n- 执行状态: SUCCESS\n- 返回内容: secret\nVCP调用结果结束]]';
        const receipt = `<<<[VCP_TOOL_BATCH_START:${id}]>>>\n${result}\n<<<[VCP_TOOL_BATCH_END:${id}]>>>`;
        const text = REQ('Demo', `command:${S}ReadFile${E}`) + '\n\n' + receipt + '\n\n正文';
        const fixture = await createRendererFixture(text, { toolPresentation: style, toolExpansion: 'none' });
        try {
            await new Promise(resolve => setTimeout(resolve, 40));
            const content = fixture.messageItem.querySelector('.md-content');
            assert.equal(content.querySelectorAll('.vcp-tool-result-bubble').length, 1);
            assert.doesNotMatch(content.textContent, /VCP_TOOL_BATCH/);
            assert.equal(fixture.renderer.extractSpeakableTextFromContentElement(content), '正文');
            if (style === 'inline' || style === 'process') {
                assert.ok(content.querySelector('[data-vcp-tool-merged="true"]'));
            }
            if (style === 'grouped') assert.equal(content.querySelectorAll('.vcp-tool-process').length, 1);
        } finally {
            await disposeFixture(fixture);
        }
    }
});


test('smooth streaming commits an atomic role-wrapped batch without exposing control markers or payload', async () => {
    const fixture = await createRendererFixture('', { toolPresentation: 'legacy', toolExpansion: 'none' });
    const context = { agentId: 'tool-card-agent', topicId: 'tool-card-topic' };
    const id = '2026-10-29T12:51:34.979Z';
    const receipt = `<<<[ROLE_DIVIDE_USER]>>>\n<<<[VCP_TOOL_BATCH_START:${id}]>>>\n`
        + '[[VCP调用结果信息汇总:\n- 工具名称: Demo\n- 执行状态: SUCCESS\n- 返回内容: ```html\n<style>.evil{color:red}</style><script>bad()</script>\nVCP调用结果结束]]\n'
        + `[本轮工具调用摘要:]成功 record-stream[本轮工具调用摘要结束]\n<<<[VCP_TOOL_BATCH_END:${id}]>>>\n<<<[END_ROLE_DIVIDE_USER]>>>\n`;
    try {
        await fixture.streamProjection.startStreamingMessage({
            id: 'tool-card-message', role: 'assistant', content: '', ...context,
        }, fixture.messageItem);
        fixture.dom.window.document.documentElement.dataset.uiMode = 'next';
        // 修改实际设置引用：本测试使用真实投影队列。
        fixture.settingsRef.set({ enableSmoothStreaming: true, enableAiMessageButtons: false });
        fixture.streamProjection.appendStreamChunk('tool-card-message', { content: receipt }, context);
        await new Promise(resolve => setTimeout(resolve, 160));
        const content = fixture.messageItem.querySelector('.md-content');
        assert.ok(content.querySelector('.vcp-tool-result-bubble'));
        assert.doesNotMatch(content.textContent, /VCP_TOOL_BATCH/);
        assert.equal(content.querySelector('script, style'), null);
        assert.equal(fixture.renderer.extractSpeakableTextFromContentElement(content), '');
        fixture.streamProjection.appendStreamChunk('tool-card-message', { content: '\n完成正文。\n\n第二段。\n\n尾部。' }, context);
        await fixture.streamProjection.projectStreamTerminal('tool-card-message', 'completed', context, {
            fullResponse: receipt + '\n完成正文。\n\n第二段。\n\n尾部。',
        });
        assert.match(fixture.renderer.extractSpeakableTextFromContentElement(content), /完成正文/);
        assert.doesNotMatch(fixture.renderer.extractSpeakableTextFromContentElement(content), /record-stream|evil|bad/);
    } finally {
        await disposeFixture(fixture);
    }
});


test('batch boundaries reset Markdown, protocol and HTML parser state in both directions', async () => {
    const id = '2026-10-29T21:25:17.192+08:00';
    const receipt = `<<<[ROLE_DIVIDE_USER]>>>\n<<<[VCP_TOOL_BATCH_START:${id}]>>>\n`
        + '[[VCP调用结果信息汇总:\n- 工具名称: BoundaryDemo\n- 执行状态: SUCCESS\n- 返回内容: ```\n</pre> --> </think> $$\nVCP调用结果结束]]\n'
        + `<<<[VCP_TOOL_BATCH_END:${id}]>>>\n<<<[END_ROLE_DIVIDE_USER]>>>`;
    for (const opener of ['```js\nopen', '<!-- open', '<pre>open', '<div><b>open', '<think>\nopen', '$$\nopen']) {
        const text = opener + '\n' + receipt + '\n\n## 后文独立标题';
        const fixture = await createRendererFixture(text, { toolPresentation: 'legacy', toolExpansion: 'none' });
        try {
            await new Promise(resolve => setTimeout(resolve, 30));
            const content = fixture.messageItem.querySelector('.md-content');
            const card = content.querySelector('.vcp-tool-result-bubble');
            assert.ok(card, opener);
            assert.equal(card.closest('pre, code, think, b'), null, opener);
            assert.equal(content.querySelector('h2')?.textContent, '后文独立标题', opener);
            assert.equal(content.querySelectorAll('.vcp-role-divider').length, 2, opener);
            assert.doesNotMatch(content.textContent, /VCP_TOOL_BATCH|ROLE_DIVIDE/);
            assert.equal(fixture.historyRef.get()[0].content, text);
        } finally {
            await disposeFixture(fixture);
        }
    }
});

test('multiple batch domains keep global result ordinals and independent styles', async () => {
    const receipt = id => `<<<[VCP_TOOL_BATCH_START:${id}]>>>\n`
        + '[[VCP调用结果信息汇总:\n- 工具名称: Demo\n- 执行状态: SUCCESS\n- 返回内容: payload\nVCP调用结果结束]]\n'
        + `<<<[VCP_TOOL_BATCH_END:${id}]>>>`;
    const text = '<style>.before{color:red}</style>\n' + receipt('one')
        + '\n<style>.after{color:blue}</style>\n' + receipt('two') + '\n正文';
    const fixture = await createRendererFixture(text, { toolPresentation: 'legacy', toolExpansion: 'none' });
    try {
        await new Promise(resolve => setTimeout(resolve, 30));
        const content = fixture.messageItem.querySelector('.md-content');
        assert.deepEqual([...content.querySelectorAll('.vcp-tool-result-bubble')].map(node => node.dataset.vcpToolResultIndex), ['0', '1']);
        const styles = fixture.dom.window.document.head.querySelector('style[data-vcp-scope-id]')?.textContent || '';
        assert.match(styles, /\.before/);
        assert.match(styles, /\.after/);
    } finally {
        await disposeFixture(fixture);
    }
});


test('frontend regex and CSS extraction cannot match through a receipt', async () => {
    const batch = '<<<[ROLE_DIVIDE_USER]>>>\n<<<[VCP_TOOL_BATCH_START:rules]>>>\n'
        + '[[VCP调用结果信息汇总:\n- 工具名称: ProtectedTool\n- 执行状态: SUCCESS\n- 返回内容: secret\nVCP调用结果结束]]\n'
        + '<<<[VCP_TOOL_BATCH_END:rules]>>>\n<<<[END_ROLE_DIVIDE_USER]>>>';
    const fixture = await createRendererFixture('', { toolPresentation: 'legacy', toolExpansion: 'none' });
    try {
        await new Promise(resolve => setTimeout(resolve, 40));
        const selected = fixture.selectedRef.get();
        fixture.selectedRef.set({
            ...selected,
            config: {
                stripRegexes: [
                    { findPattern: '/BEGIN[\\s\\S]*END/g', replaceWith: 'CROSSED' },
                    { findPattern: '/ProtectedTool/g', replaceWith: 'CHANGED' },
                ].map(rule => ({ ...rule, applyToFrontend: true, applyToRoles: ['assistant'] })),
            },
        });
        const source = 'BEGIN\n<style>.cross{color:red}\n' + batch + '\n</style>\nEND\n\n## 正文';
        fixture.historyRef.get()[0].content = source;
        fixture.renderer.updateMessageContent('tool-card-message', source);
        await new Promise(resolve => setTimeout(resolve, 40));
        const content = fixture.messageItem.querySelector('.md-content');
        assert.equal(content.querySelector('.vcp-tool-result-name')?.textContent, 'ProtectedTool');
        assert.doesNotMatch(content.textContent, /CROSSED|CHANGED/);
        assert.equal(content.querySelector('h2')?.textContent, '正文');
        assert.equal(fixture.dom.window.document.head.querySelector('style[data-vcp-scope-id]'), null);
        assert.equal(fixture.historyRef.get()[0].content, source);
    } finally {
        await disposeFixture(fixture);
    }
});


test('template cache keeps short tool messages across topic clear and rehydrates released payloads', async () => {
    const source = REQ('Demo', `command:${S}cached-command${E}`) + '\n\n' + RESULT('Demo', 'cached-result');
    assert.ok(source.length < 512);
    let parses = 0;
    const fixture = await createRendererFixture(source, { toolPresentation: 'legacy', toolExpansion: 'none' }, {
        parse(text, options) { parses++; return marked.parse(text, options); },
    });
    try {
        const renderer = fixture.renderer;
        const oldIds = [...fixture.messageItem.querySelectorAll('[data-vcp-lazy-tool-id]')].map(node => node.dataset.vcpLazyToolId);
        const before = renderer.getRenderHtmlCacheStats();
        assert.equal(before.entries, 1);
        const initialParses = parses;
        const message = { ...fixture.historyRef.get()[0] };
        renderer.clearChat();
        assert.equal(renderer.getLazyToolStats().entries, 0);
        assert.equal(renderer.getRenderHtmlCacheStats().entries, 1);
        fixture.historyRef.set([message]);
        const restored = await renderer.renderMessage(message);
        assert.equal(parses, initialParses, 'cache hit must not parse Markdown again');
        assert.equal(renderer.getRenderHtmlCacheStats().hits, before.hits + 1);
        assert.equal(renderer.getLazyToolStats().entries, 2);
        const newIds = [...restored.querySelectorAll('[data-vcp-lazy-tool-id]')].map(node => node.dataset.vcpLazyToolId);
        assert.ok(newIds.every(id => !oldIds.includes(id)));
        restored.querySelector('.vcp-tool-summary').click();
        assert.match(restored.querySelector('.vcp-tool-details').textContent, /cached-command/);
        restored.querySelector('.vcp-tool-result-header').click();
        assert.match(restored.querySelector('.vcp-tool-result-collapsible-content').textContent, /cached-result/);
        renderer.clearRenderHtmlCache();
        assert.equal(renderer.getRenderHtmlCacheStats().bytes, 0);
        restored.querySelector('.vcp-tool-result-header').click();
        restored.querySelector('.vcp-tool-result-header').click();
        assert.match(restored.textContent, /cached-result/, 'evicting templates cannot revoke a mounted tool');
        renderer.clearChat();
        assert.equal(renderer.getLazyToolStats().entries, 0);
    } finally { await disposeFixture(fixture); }
});

test('cache hit projections use independent bindings for repeated blocks and overlapping snapshots', async () => {
    const block = REQ('Demo', `command:${S}duplicate-payload${E}`);
    const fixture = await createRendererFixture(block + '\n\n' + block, { toolPresentation: 'legacy', toolExpansion: 'none' });
    try {
        const renderer = fixture.renderer;
        const message = fixture.historyRef.get()[0];
        const root = fixture.messageItem.parentElement;
        const first = [...fixture.messageItem.querySelectorAll('[data-vcp-lazy-tool-id]')];
        assert.equal(new Set(first.map(node => node.dataset.vcpLazyToolId)).size, 2);
        const secondMessage = { ...message, id: 'same-content-other-message' };
        // Both source projections have the same depth, so the second is a cache hit.
        fixture.historyRef.set([secondMessage]);
        const second = await renderer.renderMessage(secondMessage);
        assert.equal(renderer.getRenderHtmlCacheStats().hits, 1);
        const allIds = [...root.querySelectorAll('[data-vcp-lazy-tool-id]')].map(node => node.dataset.vcpLazyToolId);
        assert.equal(new Set(allIds).size, 4);
        renderer.removeMessageById(message.id);
        assert.equal(renderer.getLazyToolStats().entries, 2);
        for (const tool of second.querySelectorAll('.vcp-tool-use-bubble')) {
            tool.querySelector('.vcp-tool-summary').click();
            assert.match(tool.querySelector('.vcp-tool-details').textContent, /duplicate-payload/);
        }
        // updateMessageUI builds the new snapshot before cleaning up the old one.
        await renderer.updateMessageUI(secondMessage.id, secondMessage);
        assert.equal(renderer.getLazyToolStats().entries, 2);
        const replacement = root.querySelector('[data-message-id="same-content-other-message"]');
        assert.notEqual(replacement, second);
        replacement.querySelector('.vcp-tool-summary').click();
        assert.match(replacement.querySelector('.vcp-tool-details').textContent, /duplicate-payload/);
        renderer.disposeRendererResources();
        assert.equal(renderer.getRenderHtmlCacheStats().entries, 0);
        assert.equal(renderer.getLazyToolStats().entries, 0);
    } finally { await disposeFixture(fixture); }
});

test('cached large result retains truncation expansion and seals executable tool data after restore', async () => {
    const raw = Array.from({ length: 150 }, (_, i) => `cache-line-${i} ${'x'.repeat(400)}`).join('\n')
        + '\n<style>.cache-evil{color:red}</style><script>bad()</script>';
    const source = RESULT('Demo', raw);
    const fixture = await createRendererFixture(source, { toolPresentation: 'legacy', toolExpansion: 'none' });
    try {
        const message = { ...fixture.historyRef.get()[0] };
        fixture.renderer.clearChat();
        fixture.historyRef.set([message]);
        const restored = await fixture.renderer.renderMessage(message);
        assert.equal(fixture.renderer.getRenderHtmlCacheStats().hits, 1);
        const card = restored.querySelector('.vcp-tool-result-bubble');
        card.querySelector('.vcp-tool-result-header').click();
        assert.ok(card.querySelector('.vcp-tool-result-truncated-notice'));
        card.querySelector('.vcp-tool-result-truncated-notice').click();
        assert.match(card.textContent, /cache-line-149/);
        assert.equal(card.querySelector('script, style'), null);
        assert.equal(fixture.dom.window.document.head.querySelector('style[data-vcp-scope-id]'), null);
        card.querySelector('.vcp-tool-result-header').click();
        assert.equal(card.querySelector('.vcp-tool-result-collapsible-content').childNodes.length, 0);
    } finally { await disposeFixture(fixture); }
});

test('atomic batch templates restore global ordinals without parsing collapsed receipts', async () => {
    const receipt = id => `<<<[VCP_TOOL_BATCH_START:${id}]>>>\n`
        + '[[VCP调用结果信息汇总:\n- 工具名称: Demo\n- 返回内容: BATCH_CACHE_PAYLOAD\nVCP调用结果结束]]\n'
        + `<<<[VCP_TOOL_BATCH_END:${id}]>>>`;
    const source = REQ('Demo', `command:${S}Read${E}`) + '\n' + receipt('cache-one') + '\n' + receipt('cache-two');
    const parsed = [];
    const fixture = await createRendererFixture(source, { toolPresentation: 'legacy', toolExpansion: 'none' }, {
        parse(text, options) { parsed.push(text); return marked.parse(text, options); },
    });
    try {
        const message = { ...fixture.historyRef.get()[0] };
        fixture.renderer.clearChat();
        fixture.historyRef.set([message]);
        const count = parsed.length;
        const restored = await fixture.renderer.renderMessage(message);
        assert.equal(parsed.length, count);
        assert.equal(fixture.renderer.getRenderHtmlCacheStats().hits, 1);
        assert.ok(!parsed.some(text => text.includes('BATCH_CACHE_PAYLOAD')));
        assert.deepEqual([...restored.querySelectorAll('.vcp-tool-result-bubble')].map(node => node.dataset.vcpToolResultIndex), ['0', '1']);
        for (const card of restored.querySelectorAll('.vcp-tool-result-bubble')) {
            card.querySelector('.vcp-tool-result-header').click();
            assert.match(card.textContent, /BATCH_CACHE_PAYLOAD/);
        }
    } finally { await disposeFixture(fixture); }
});

test('template cache distinguishes source middle, role, depth and settings', async () => {
    const prefix = 'p'.repeat(70);
    const suffix = 's'.repeat(70);
    const source = prefix + 'middle-A' + suffix;
    let parses = 0;
    const fixture = await createRendererFixture(source, { toolPresentation: 'legacy', toolExpansion: 'none' }, {
        parse(text, options) { parses++; return marked.parse(text, options); },
    });
    try {
        const message = fixture.historyRef.get()[0];
        const initial = parses;
        fixture.renderer.updateMessageContent(message.id, prefix + 'middle-B' + suffix);
        assert.equal(parses, initial + 1);
        assert.match(fixture.messageItem.textContent, /middle-B/);
        fixture.renderer.updateMessageContent(message.id, source);
        assert.equal(parses, initial + 1);
        fixture.settingsRef.set({ ...fixture.settingsRef.get(), enableAiMessageButtons: true });
        fixture.renderer.updateMessageContent(message.id, source);
        assert.equal(parses, initial + 2);
        fixture.historyRef.set([message, { id: 'next-turn', role: 'assistant', content: 'next' }]);
        fixture.renderer.updateMessageContent(message.id, source);
        assert.equal(parses, initial + 3);
        message.role = 'user';
        fixture.renderer.updateMessageContent(message.id, source);
        assert.equal(parses, initial + 4);
    } finally { await disposeFixture(fixture); }
});

test('short prose templates obey LRU entry bounds and explicit invalidation', async () => {
    const fixture = await createRendererFixture('short initial', { toolPresentation: 'legacy', toolExpansion: 'none' });
    try {
        for (let i = 0; i < 505; i++) {
            fixture.renderer.updateMessageContent('tool-card-message', `short-cache-${i}`);
        }
        const stats = fixture.renderer.getRenderHtmlCacheStats();
        assert.equal(stats.entries, 500);
        assert.ok(stats.evictions >= 6);
        assert.ok(stats.bytes > 0 && stats.bytes <= 20 * 1024 * 1024);
        fixture.renderer.clearRenderHtmlCache();
        assert.equal(fixture.renderer.getRenderHtmlCacheStats().entries, 0);
        const misses = fixture.renderer.getRenderHtmlCacheStats().misses;
        fixture.renderer.updateMessageContent('tool-card-message', 'short-cache-504');
        assert.equal(fixture.renderer.getRenderHtmlCacheStats().misses, misses + 1);
    } finally { await disposeFixture(fixture); }
});


test('template byte budget includes lazy payloads and rejects oversized rendered artifacts', async () => {
    const fixture = await createRendererFixture('budget seed', { toolPresentation: 'legacy', toolExpansion: 'none' });
    try {
        fixture.renderer.clearRenderHtmlCache();
        for (let i = 0; i < 60; i++) {
            fixture.renderer.updateMessageContent('tool-card-message',
                REQ('BudgetDemo', `text:${S}${i}:${'x'.repeat(190000)}${E}`));
        }
        const stats = fixture.renderer.getRenderHtmlCacheStats();
        assert.ok(stats.bytes <= 20 * 1024 * 1024);
        assert.ok(stats.entries < 60 && stats.entries > 0, 'raw payload size must trigger byte-based eviction');
        assert.ok(stats.evictions > 0);
        assert.equal(fixture.renderer.getLazyToolStats().entries, 1, 'redraw must release old runtime bindings');
        fixture.renderer.clearRenderHtmlCache();
        assert.equal(fixture.renderer.getRenderHtmlCacheStats().bytes, 0);
        assert.equal(fixture.renderer.getLazyToolStats().entries, 1);
        fixture.renderer.updateMessageContent('tool-card-message', '&'.repeat(150000));
        assert.equal(fixture.renderer.getRenderHtmlCacheStats().entries, 0, 'expanded HTML over 1 MiB is not retained');
        assert.equal(fixture.renderer.getLazyToolStats().entries, 0);
    } finally { await disposeFixture(fixture); }
});

test('template cache and hydrated tool leases are isolated per renderer surface', async () => {
    const source = REQ('Demo', `command:${S}surface-owned${E}`);
    const first = await createRendererFixture(source, { toolPresentation: 'legacy', toolExpansion: 'none' });
    let second;
    try {
        second = await createRendererFixture(source, { toolPresentation: 'legacy', toolExpansion: 'none' });
        const firstId = first.messageItem.querySelector('[data-vcp-lazy-tool-id]').dataset.vcpLazyToolId;
        const secondId = second.messageItem.querySelector('[data-vcp-lazy-tool-id]').dataset.vcpLazyToolId;
        assert.notEqual(firstId, secondId);
        assert.equal(first.renderer.getRenderHtmlCacheStats().misses, 1);
        assert.equal(second.renderer.getRenderHtmlCacheStats().misses, 1);
        second.renderer.clearChat();
        second.renderer.clearRenderHtmlCache();
        assert.equal(first.renderer.getRenderHtmlCacheStats().entries, 1);
        assert.equal(first.renderer.getLazyToolStats().entries, 1);
        first.messageItem.querySelector('.vcp-tool-summary').click();
        assert.match(first.messageItem.querySelector('.vcp-tool-details').textContent, /surface-owned/);
    } finally {
        if (second) await disposeFixture(second);
        await disposeFixture(first);
    }
});


test('parse registration keeps same-shaped source tokens literal in code and lazy fields across cache hydration', async () => {
    const literal = '__VCP_CODE_BLOCK_PLACEHOLDER_0__ <!--VCP_TOOL_RESULT_0--> '
        + '<!--VCP_TOOL_REQUEST_0--> <!--VCP_THOUGHT_CHAIN_0--> <!--VCP_RAW_SCRIPT_0-->';
    const source = '```text\n' + literal + '\n```\n\n'
        + REQ('Demo', `text:${S}${literal}${E}`) + '\n\n' + RESULT('Demo', '`' + literal + '`');
    const parsed = [];
    const fixture = await createRendererFixture(source, { toolPresentation: 'legacy', toolExpansion: 'none' }, {
        parse(text, options) { parsed.push(text); return marked.parse(text, options); },
    });
    try {
        const verify = item => {
            assert.equal(item.querySelector('pre code')?.textContent.trim(), literal);
            assert.equal(item.querySelectorAll('.vcp-tool-use-bubble').length, 1);
            assert.equal(item.querySelectorAll('.vcp-tool-result-bubble').length, 1);
            assert.equal(item.querySelector('.vcp-tool-result-bubble').dataset.vcpToolResultIndex, '0');
            item.querySelector('.vcp-tool-summary').click();
            assert.ok(item.querySelector('.vcp-tool-details').textContent.includes(literal));
            item.querySelector('.vcp-tool-result-header').click();
            const expanded = item.querySelector('.vcp-tool-result-collapsible-content').textContent;
            // Existing safe result rendering seals HTML before parsing inline code;
            // retain that entity-literal behavior rather than changing safety here.
            const sealedLiteral = literal.replaceAll('<', '\x26lt;').replaceAll('>', '\x26gt;');
            assert.equal(expanded, `返回内容: ${sealedLiteral}\n`);
        };
        verify(fixture.messageItem);
        const message = { ...fixture.historyRef.get()[0] };
        fixture.renderer.clearChat();
        fixture.historyRef.set([message]);
        const parses = parsed.length;
        const restored = await fixture.renderer.renderMessage(message);
        assert.equal(parsed.length, parses, 'cache hydration must not rebuild indexes or parse content');
        verify(restored);
        assert.equal(fixture.renderer.getLazyToolStats().entries, 2);
        assert.equal(fixture.historyRef.get()[0].content, source);
    } finally { await disposeFixture(fixture); }
});


test('history worker output populates the real template cache and preserves batch isolation', async () => {
    const { compileRenderJob } = await import('../modules/renderer/renderWorkerRuntime.js');
    const { Marked } = require('marked');
    let jobs = 0;
    const fixture = await createRendererFixture('seed', { toolPresentation: 'legacy', toolExpansion: 'none' },
        new Marked({ gfm: true, breaks: true }), {
            createRenderWorker: () => ({
                async postMessage({ id, job }) {
                    jobs++;
                    try { this.onmessage?.({ data: { id, result: await compileRenderJob(job) } }); }
                    catch (error) { this.onmessage?.({ data: { id, error: error.message } }); }
                },
                terminate() {},
            }),
        });
    try {
        fixture.renderer.clearChat();
        const content = '```js\nopen\n<<<[VCP_TOOL_BATCH_START:worker]>>>\n'
            + '[[VCP调用结果信息汇总:\n- 工具名称: Demo\n- 返回内容: WORKER_PAYLOAD\nVCP调用结果结束]]\n'
            + '<<<[VCP_TOOL_BATCH_END:worker]>>>\n\n## 后文';
        const history = [{ id: 'worker-history', role: 'assistant', content, timestamp: 1 }];
        fixture.historyRef.set(history);
        await fixture.renderer.renderHistory(history);
        const root = fixture.dom.window.document.getElementById('chat');
        assert.equal(jobs, 1);
        assert.equal(fixture.renderer.getRenderWorkerStats().completed, 1);
        assert.equal(root.querySelector('h2')?.textContent, '后文');
        assert.equal(root.querySelector('.vcp-tool-result-bubble').closest('pre, code'), null);
        const ids = [...root.querySelectorAll('[data-vcp-lazy-tool-id]')].map(node => node.dataset.vcpLazyToolId);
        fixture.renderer.clearChat();
        fixture.historyRef.set(history);
        await fixture.renderer.renderHistory(history);
        assert.equal(jobs, 1, 'cache hit must not dispatch or reparse');
        const fresh = [...root.querySelectorAll('[data-vcp-lazy-tool-id]')].map(node => node.dataset.vcpLazyToolId);
        assert.ok(fresh.every(id => !ids.includes(id)));
        root.querySelector('.vcp-tool-result-header').click();
        assert.match(root.textContent, /WORKER_PAYLOAD/);
    } finally { await disposeFixture(fixture); }
});

test('cold content is destroyed and restored with fresh tool leases on the same shell', async () => {
    const fixture = await createRendererFixture(TRANSCRIPT, { toolPresentation: 'compact', toolExpansion: 'none' });
    try {
        await new Promise(resolve => setTimeout(resolve, 50));
        const item = fixture.messageItem;
        const content = item.querySelector('.md-content');
        const scroll = item.closest('.chat-messages-container');
        let top = -6000;
        scroll.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 });
        item.getBoundingClientRect = () => ({ top, bottom: top + 500, height: 500 });
        content.getBoundingClientRect = () => ({ top: top + 50, bottom: top + 450, height: 400 });
        const source = fixture.historyRef.get()[0].content;
        const oldId = content.querySelector('[data-vcp-lazy-tool-id]').dataset.vcpLazyToolId;
        content.querySelector('.vcp-tool-row-toggle').click();
        scroll.dispatchEvent(new fixture.dom.window.Event('scroll'));
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(item.dataset.vcpDomEvicted, 'true');
        assert.equal(content.childNodes.length, 0);
        assert.equal(fixture.renderer.getLazyToolStats().entries, 0);
        assert.equal(item.style.height, '500px');
        top = 100;
        scroll.dispatchEvent(new fixture.dom.window.Event('scroll'));
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(item.dataset.vcpDomEvicted, undefined);
        assert.equal(item.style.height, '');
        assert.ok(item.isConnected);
        assert.notEqual(content.querySelector('[data-vcp-lazy-tool-id]').dataset.vcpLazyToolId, oldId);
        assert.match(content.querySelector('.vcp-tool-details').textContent, /EditCode/);
        assert.equal(fixture.historyRef.get()[0].content, source);
    } finally { await disposeFixture(fixture); }
});

test('editing cold content revokes the tombstone and cannot restore its stale source', async () => {
    const fixture = await createRendererFixture('old body', { toolPresentation: 'legacy', toolExpansion: 'none' });
    try {
        await new Promise(resolve => setTimeout(resolve, 40));
        const item = fixture.messageItem;
        const content = item.querySelector('.md-content');
        const scroll = item.closest('.chat-messages-container');
        scroll.getBoundingClientRect = () => ({ top: 0, bottom: 600 });
        item.getBoundingClientRect = () => ({ top: -6000, bottom: -5500, height: 500 });
        content.getBoundingClientRect = () => ({ height: 400 });
        scroll.dispatchEvent(new fixture.dom.window.Event('scroll'));
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(item.dataset.vcpDomEvicted, 'true');
        fixture.historyRef.get()[0].content = 'new body';
        fixture.renderer.updateMessageContent(item.dataset.messageId, 'new body');
        assert.equal(item.dataset.vcpDomEvicted, undefined);
        assert.match(content.textContent, /new body/);
        assert.equal(item.style.height, '');
    } finally { await disposeFixture(fixture); }
});


test('pending worker is revoked on renderer dispose without synchronous fallback or tool leases', async () => {
    const { Marked } = require('marked');
    let sent = null;
    const fixture = await createRendererFixture('seed', null, new Marked({ gfm: true, breaks: true }), {
        createRenderWorker: () => ({
            postMessage(data) { sent = data; },
            terminate() {},
        }),
    });
    try {
        fixture.renderer.clearChat();
        const history = [{ id: 'pending-worker', role: 'assistant', content: REQ('Demo', `text:${S}pending${E}`) }];
        fixture.historyRef.set(history);
        const pending = fixture.renderer.renderHistory(history);
        for (let i = 0; i < 50 && !sent; i++) await new Promise(resolve => setTimeout(resolve, 1));
        assert.ok(sent);
        fixture.renderer.disposeRendererResources();
        await pending;
        assert.equal(fixture.renderer.getLazyToolStats().entries, 0);
        assert.equal(fixture.dom.window.document.querySelectorAll('.message-item').length, 0);
        assert.equal(fixture.renderer.getRenderWorkerStats().pending, 0);
    } finally { await disposeFixture(fixture); }
});

test('settings changed during worker compilation rebuild current history instead of dropping a bubble', async () => {
    const { Marked } = require('marked');
    const { compileRenderJob } = await import('../modules/renderer/renderWorkerRuntime.js');
    let sent = null;
    let worker;
    const fixture = await createRendererFixture('seed', null, new Marked({ gfm: true, breaks: true }), {
        createRenderWorker: () => (worker = {
            postMessage(data) { sent = data; },
            terminate() {},
        }),
    });
    try {
        fixture.renderer.clearChat();
        const history = [{ id: 'changed-worker', role: 'assistant', content: 'current body' }];
        fixture.historyRef.set(history);
        const pending = fixture.renderer.renderHistory(history);
        for (let i = 0; i < 50 && !sent; i++) await new Promise(resolve => setTimeout(resolve, 1));
        assert.ok(sent);
        fixture.settingsRef.set({ ...fixture.settingsRef.get(), enableAiMessageButtons: true });
        worker.onmessage({ data: { id: sent.id, result: await compileRenderJob(sent.job) } });
        await pending;
        assert.match(fixture.dom.window.document.querySelector('[data-message-id="changed-worker"]').textContent, /current body/);
        assert.equal(fixture.renderer.getRenderWorkerStats().pending, 0);
    } finally { await disposeFixture(fixture); }
});

test('cold message with an active text selection remains mounted until selection is released', async () => {
    const fixture = await createRendererFixture('selected body', { toolPresentation: 'legacy', toolExpansion: 'none' });
    try {
        await new Promise(resolve => setTimeout(resolve, 40));
        const item = fixture.messageItem;
        const content = item.querySelector('.md-content');
        const scroll = item.closest('.chat-messages-container');
        scroll.getBoundingClientRect = () => ({ top: 0, bottom: 600 });
        item.getBoundingClientRect = () => ({ top: -6000, bottom: -5500, height: 500 });
        content.getBoundingClientRect = () => ({ height: 400 });
        const range = fixture.dom.window.document.createRange();
        range.selectNodeContents(content);
        fixture.dom.window.getSelection().addRange(range);
        scroll.dispatchEvent(new fixture.dom.window.Event('scroll'));
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(item.dataset.vcpDomEvicted, undefined);
        assert.match(content.textContent, /selected body/);
        fixture.dom.window.getSelection().removeAllRanges();
        scroll.dispatchEvent(new fixture.dom.window.Event('scroll'));
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(item.dataset.vcpDomEvicted, 'true');
    } finally { await disposeFixture(fixture); }
});
