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

async function createRendererFixture(messageContent, appearanceProfile) {
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
        markedInstance: marked,
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
        const details = request.querySelector('template').content.textContent;
        assert.ok(details.includes(POWERSHELL), 'expanded details must show the original command');
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
