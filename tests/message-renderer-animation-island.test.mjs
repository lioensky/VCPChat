import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { marked } = require('marked');

const BLACK_HOLE_FIXTURE = [
    '1. **扁平化作用域选择器**：使用唯一命名前缀。',
    '2. **规范化 3D 几何与变换链**：修正透视和中心锚点。',
    '3. **自包含封装**：`<style>` 标签依然内敛于 DIV 容器顶层。',
    '',
    '<div class="vcp-bh-container" style="position:relative;overflow:hidden">',
    '  <style>',
    '    .vcp-bh-stage {',
    '      width: 220px;',
    '      height: 180px;',
    '      position: relative;',
    '      display: flex;',
    '      justify-content: center;',
    '      align-items: center;',
    '      perspective: 500px;',
    '    }',
    '    .vcp-bh-disk-outer {',
    '      position: absolute;',
    '      width: 180px;',
    '      height: 180px;',
    '      border-radius: 50%;',
    '      background: conic-gradient(from 45deg, #f59e0b, #ef4444, #8b5cf6, #06b6d4, #f59e0b);',
    '      filter: blur(8px);',
    '      animation: vcpBhSpinOuter 3s linear infinite;',
    '    }',
    '    .vcp-bh-disk-inner {',
    '      position: absolute;',
    '      width: 130px;',
    '      height: 130px;',
    '      border-radius: 50%;',
    '      animation: vcpBhSpinInner 1.4s linear infinite;',
    '    }',
    '    .vcp-bh-photon {',
    '      position: absolute;',
    '      width: 72px;',
    '      height: 72px;',
    '      border-radius: 50%;',
    '      animation: vcpBhPulseRing 1.8s ease-in-out infinite alternate;',
    '    }',
    '    @keyframes vcpBhSpinOuter {',
    '      0% { transform: rotateX(72deg) rotate(0deg); }',
    '      100% { transform: rotateX(72deg) rotate(360deg); }',
    '    }',
    '    @keyframes vcpBhSpinInner {',
    '      0% { transform: rotateX(72deg) rotate(360deg); }',
    '      100% { transform: rotateX(72deg) rotate(0deg); }',
    '    }',
    '    @keyframes vcpBhPulseRing {',
    '      0% { transform: scale(0.96); }',
    '      100% { transform: scale(1.04); }',
    '    }',
    '  </style>',
    '',
    '  <div class="vcp-bh-stage">',
    '    <div class="vcp-bh-disk-outer"></div>',
    '    <div class="vcp-bh-disk-inner"></div>',
    '    <div class="vcp-bh-photon"></div>',
    '  </div>',
    '</div>',
].join('\n');

const TESSERACT_FIXTURE = [
    '正文中的 `<div>`、`</div>` 与 `<style>` 都是代码字面量，不能进入 HTML/CSS 扫描。',
    '',
    '<div class="vcp-tess-container">',
    '  <style>',
    '    .vcp-tess-viewport { width: 200px; height: 200px; perspective: 700px; }',
    '    .vcp-tess-cube {',
    '      width: 100px;',
    '      height: 100px;',
    '      position: relative;',
    '      transform-style: preserve-3d;',
    '      animation: vcpTessRotate 7s linear infinite;',
    '    }',
    '    .vcp-tess-face { position: absolute; width: 100px; height: 100px; }',
    '    @keyframes vcpTessRotate {',
    '      0% { transform: rotateX(0deg) rotateY(0deg); }',
    '      100% { transform: rotateX(360deg) rotateY(720deg); }',
    '    }',
    '  </style>',
    '  <div class="vcp-tess-viewport">',
    '    <div class="vcp-tess-cube">',
    '      <div class="vcp-tess-face"></div>',
    '    </div>',
    '  </div>',
    '</div>',
].join('\n');

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

async function createRendererFixture(messageContent) {
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
        id: 'animation-agent',
        type: 'agent',
        name: 'Animation Agent',
        avatarUrl: 'assets/default_avatar.png',
        config: {},
    });
    const topicRef = createRef('animation-topic');
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
        id: 'animation-island-message',
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

function assertScopedAnimationIsland(fixture, expectations) {
    const { dom, messageItem } = fixture;
    assert.ok(messageItem, 'assistant message must render');
    assert.ok(messageItem.id, 'assistant message must own a CSS scope id');
    assert.equal(
        messageItem.dataset.vcpScopedStyleState,
        'active',
        'the real island stylesheet must be accepted and injected',
    );

    const styleElement = dom.window.document.head.querySelector(
        `style[data-vcp-scope-id="${messageItem.id}"]`,
    );
    assert.ok(styleElement, 'message-scoped stylesheet must exist in the owner document');
    assert.match(
        styleElement.textContent,
        new RegExp(`#${messageItem.id}\\s+\\.${expectations.animatedClass}`),
        'the scoped stylesheet must contain a selector for the animated node',
    );
    assert.match(styleElement.textContent, new RegExp(`@keyframes\\s+${expectations.keyframes}`));
    assert.doesNotMatch(
        styleElement.textContent,
        /标签依然内敛|代码字面量|不能进入 HTML\/CSS 扫描/,
        'prose surrounding inline code must never be consumed as CSS',
    );

    const island = messageItem.querySelector(`.${expectations.rootClass}`);
    const animated = messageItem.querySelector(`.${expectations.animatedClass}`);
    assert.ok(island, 'animation island DOM must survive Markdown rendering');
    assert.ok(animated, 'animated class node must survive Markdown rendering');
    assert.equal(
        animated.closest('.message-item'),
        messageItem,
        'animated node must remain under the same scope root',
    );

    const computed = dom.window.getComputedStyle(animated);
    assert.equal(computed.width, expectations.width);
    assert.match(
        computed.animationName || computed.animation,
        new RegExp(expectations.keyframes),
        'scoped stylesheet must apply its animation declaration to the final DOM',
    );
}

test('black-hole island survives a preceding inline `<style>` code literal', async () => {
    const fixture = await createRendererFixture(BLACK_HOLE_FIXTURE);
    try {
        assertScopedAnimationIsland(fixture, {
            rootClass: 'vcp-bh-container',
            animatedClass: 'vcp-bh-disk-outer',
            keyframes: 'vcpBhSpinOuter',
            width: '180px',
        });
    } finally {
        await disposeFixture(fixture);
    }
});

test('tesseract island survives preceding inline HTML tag literals', async () => {
    const fixture = await createRendererFixture(TESSERACT_FIXTURE);
    try {
        assertScopedAnimationIsland(fixture, {
            rootClass: 'vcp-tess-container',
            animatedClass: 'vcp-tess-cube',
            keyframes: 'vcpTessRotate',
            width: '100px',
        });
    } finally {
        await disposeFixture(fixture);
    }
});

test('multiple nested style elements survive comment literals and tool-payload style mentions', async () => {
    const content = [
        '<div class="nested-root">',
        '  <style>',
        '    .nested-root { --accent: #00f0ff; }',
        '    .nested-root .grid { display: grid; }',
        '  </style>',
        '  <div class="grid">',
        '    <!-- child A owns an independent <style> tag -->',
        '    <div class="child-a">',
        '      <style>',
        '        .child-a .ring { width: 90px; animation: nestedSpin 3s linear infinite; }',
        '        @keyframes nestedSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
        '      </style>',
        '      <div class="ring"></div>',
        '    </div>',
        '    <!-- child B owns another independent <style> tag -->',
        '    <div class="child-b">',
        '      <style>',
        '        .child-b .bar { height: 70px; animation: signalWave 1s ease-in-out infinite alternate; }',
        '        @keyframes signalWave { from { filter: brightness(.8); } to { filter: brightness(1.3); } }',
        '      </style>',
        '      <div class="bar"></div>',
        '    </div>',
        '  </div>',
        '</div>',
        '',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'Content:「始ESCAPE」说明文字中的 `<style>` 与真实 HTML 注释中的 <style> 都不能参与 CSS 提取。「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');

    const fixture = await createRendererFixture(content);
    try {
        const { dom, messageItem } = fixture;
        assert.equal(messageItem.dataset.vcpScopedStyleState, 'active');

        const styleElement = dom.window.document.head.querySelector(
            `style[data-vcp-scope-id="${messageItem.id}"]`,
        );
        assert.ok(styleElement, 'all real nested styles must merge into one owned scoped sheet');
        assert.match(styleElement.textContent, new RegExp(`#${messageItem.id}\\s+\\.nested-root`));
        assert.match(styleElement.textContent, new RegExp(`#${messageItem.id}\\s+\\.child-a \\.ring`));
        assert.match(styleElement.textContent, new RegExp(`#${messageItem.id}\\s+\\.child-b \\.bar`));
        assert.match(styleElement.textContent, /@keyframes\s+nestedSpin/);
        assert.match(styleElement.textContent, /@keyframes\s+signalWave/);
        assert.doesNotMatch(
            styleElement.textContent,
            /child A owns|child B owns|说明文字/,
            'comment and tool payload literals must never leak into extracted CSS',
        );
        assert.ok(messageItem.querySelector('.child-a .ring'));
        assert.ok(messageItem.querySelector('.child-b .bar'));
    } finally {
        await disposeFixture(fixture);
    }
});