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

async function createRendererFixture(messageContent, appearanceProfile = null, executeScripts = false) {
    const dom = new JSDOM(
        '<!doctype html><html><head></head><body><div class="chat-messages-container"><div id="chat"></div></div></body></html>',
        {
            url: 'https://vcpchat.local/',
            pretendToBeVisual: true,
            ...(executeScripts ? { runScripts: 'dangerously' } : {}),
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
        historyRef,
        selectedRef,
        settingsRef,
        root,
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

test('message media is manual-only and old players unload on redraw and topic clear', async () => {
    const fixture = await createRendererFixture('<audio controls autoplay loop src="song.mp3"></audio><video autoplay loop src="clip.mp4"></video>');
    const { dom, renderer, messageItem } = fixture;
    const prototype = dom.window.HTMLMediaElement.prototype;
    const previousPause = prototype.pause;
    const previousLoad = prototype.load;
    prototype.pause = function () { this._testPaused = true; };
    prototype.load = function () { this._testUnloaded = true; };
    try {
        for (const media of messageItem.querySelectorAll('audio, video')) {
            assert.equal(media.autoplay, false, 'first synchronous projection must not autoplay');
            assert.equal(media.loop, false);
        }
        await new Promise(resolve => dom.window.setTimeout(resolve, 50));
        const oldAudio = messageItem.querySelector('audio');
        const oldVideo = messageItem.querySelector('video');
        const oldPlayer = messageItem.querySelector('.vcp-audio-player');
        assert.ok(oldPlayer, 'audio controls must be enhanced');
        renderer.updateMessageContent('animation-island-message', '<video controls src="next.mp4"></video>');
        assert.equal(oldAudio._testPaused, true);
        assert.equal(oldAudio._testUnloaded, true);
        assert.equal(oldAudio.hasAttribute('src'), false);
        assert.equal(oldVideo.hasAttribute('src'), false);
        assert.equal(oldPlayer._vcpAudioCleanup, undefined);
        const nextVideo = messageItem.querySelector('video');
        renderer.clearChat();
        assert.equal(nextVideo._testPaused, true);
        assert.equal(nextVideo._testUnloaded, true);
        assert.equal(nextVideo.hasAttribute('src'), false);
        assert.equal(messageItem.isConnected, false);
    } finally {
        prototype.pause = previousPause;
        prototype.load = previousLoad;
        await disposeFixture(fixture);
    }
});

test('initial production renderer reads the saved tool mode from its owner realm', async () => {
    const fixture = await createRendererFixture([
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」ProjectForge「末」',
        'command:「始」GetCode「末」',
        'path:「始」demo/index.html「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n'), {toolPresentation:'compact', toolExpansion:'none'});
    try {
        await new Promise(resolve => fixture.dom.window.requestAnimationFrame(resolve));
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0));
        const button = fixture.messageItem.querySelector('.vcp-tool-row-toggle');
        assert.ok(button, 'saved compact mode must apply on initial rendering without a preview event');
        assert.match(button.textContent, /读取源码/);
        assert.equal(button.getAttribute('aria-expanded'), 'false');
    } finally {
        await disposeFixture(fixture);
    }
});

test('initial postprocessing and heavy activation preserve mounted content and expanded tools', async () => {
    const fixture = await createRendererFixture([
        '[[VCP调用结果信息汇总:',
        '- 工具名称: Demo',
        '- 返回内容: ' + Array.from({ length: 150 }, (_, i) => `line-${i} ${'x'.repeat(400)}`).join('\n'),
        'VCP调用结果结束]]',
        '<div class="identity-probe">keep</div>',
    ].join('\n'));
    try {
        const probe = fixture.messageItem.querySelector('.identity-probe');
        assert.ok(probe);
        const bubble = fixture.messageItem.querySelector('.vcp-tool-result-bubble');
        bubble.querySelector('.vcp-tool-result-header').click();
        const notice = bubble.querySelector('.vcp-tool-result-truncated-notice');
        assert.ok(notice, 'large result must register an expand-all cache entry');
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 60));
        await fixture.messageItem._vcp_activateHeavy();
        assert.equal(fixture.messageItem.querySelector('.identity-probe'), probe);
        assert.equal(fixture.messageItem.querySelector('.vcp-tool-result-bubble'), bubble);
        assert.ok(bubble.classList.contains('expanded'));
        notice.click();
        assert.equal(bubble.querySelector('.vcp-tool-result-truncated-notice'), null);
        assert.match(bubble.textContent, /line-149/);
    } finally {
        await disposeFixture(fixture);
    }
});

test('stable stream CSS is regenerated for a recreated message scope', async () => {
    const fixture = await createRendererFixture('');
    try {
        const message = {
            id: 'animation-island-message', role: 'assistant', content: '',
            agentId: 'animation-agent', topicId: 'animation-topic',
            streamOperationId: 'scope-operation',
        };
        await fixture.streamProjection.startStreamingMessage(message, fixture.messageItem);
        fixture.streamProjection.appendStreamChunk(message.id, {
            content: '<div class="scope-test"><style>.scope-test { width: 123px; }</style>stable</div>',
        }, message, 'scope-operation');
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 100));
        const oldScope = fixture.messageItem.id;
        assert.match(fixture.dom.window.document.head.textContent, new RegExp(`#${oldScope}`));
        fixture.renderer.clearChat();
        await fixture.streamProjection.reconcileConversation({
            itemType: 'agent', itemId: 'animation-agent', topicId: 'animation-topic',
        });
        const rebuilt = fixture.root.querySelector('.message-item');
        assert.ok(rebuilt);
        assert.notEqual(rebuilt.id, oldScope);
        const sheet = fixture.dom.window.document.head.querySelector(`style[data-vcp-scope-id="${rebuilt.id}"]`);
        assert.ok(sheet);
        assert.match(sheet.textContent, new RegExp(`#${rebuilt.id}`));
        assert.doesNotMatch(sheet.textContent, new RegExp(`#${oldScope}`));
        assert.equal(fixture.dom.window.getComputedStyle(rebuilt.querySelector('.scope-test')).width, '123px');
    } finally {
        await disposeFixture(fixture);
    }
});


test('new stable CSS is published even when the rendered tail remains empty', async () => {
    const fixture = await createRendererFixture('');
    try {
        const message = {
            id: 'animation-island-message', role: 'assistant', content: '',
            agentId: 'animation-agent', topicId: 'animation-topic', streamOperationId: 'stable-css',
        };
        await fixture.streamProjection.startStreamingMessage(message, fixture.messageItem);
        for (const [name, width] of [['first-rule', 111], ['second-rule', 222]]) {
            fixture.streamProjection.appendStreamChunk(message.id, {
                content: `<style>.${name} { width: ${width}px; }</style>`,
            }, message, 'stable-css');
            await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 90));
        }
        const sheet = fixture.dom.window.document.head.querySelector(`style[data-vcp-scope-id="${fixture.messageItem.id}"]`);
        assert.match(sheet.textContent, /first-rule/);
        assert.match(sheet.textContent, /second-rule/);
        assert.equal(fixture.messageItem.querySelector('.vcp-stream-tail-root').textContent, '');
    } finally { await disposeFixture(fixture); }
});

test('discarded history snapshot releases its scoped styles and lazy tool data', async () => {
    const fixture = await createRendererFixture('initial');
    try {
        const message = {
            id: 'collision-resource', role: 'assistant', timestamp: 1,
            content: '<style>.collision { width: 2px; }</style>\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」Demo「末」\n<<<[END_TOOL_REQUEST]>>>',
        };
        const batch = fixture.renderer.renderMessageBatch([message]);
        // Batch snapshots are built synchronously but committed in the next animation frame.
        await Promise.resolve();
        const live = await fixture.renderer.renderMessage(message);
        await batch;
        assert.equal(fixture.root.querySelectorAll('[data-message-id="collision-resource"]').length, 1);
        assert.equal(fixture.root.querySelector('[data-message-id="collision-resource"]'), live);
        const sheets = [...fixture.dom.window.document.head.querySelectorAll('style[data-vcp-scope-id]')];
        assert.equal(sheets.length, 1);
        assert.equal(sheets[0].dataset.vcpScopeId, live.id);
        assert.equal(fixture.renderer.getLazyToolStats().entries, 1);
        live.querySelector('.vcp-tool-summary').click();
        assert.match(live.querySelector('.vcp-tool-details').textContent, /Demo/);
    } finally { await disposeFixture(fixture); }
});

test('style-looking code, comments and tool payloads stay sealed across stream fragments', async () => {
    const fixture = await createRendererFixture('');
    try {
        const message = {
            id: 'animation-island-message', role: 'assistant', content: '',
            agentId: 'animation-agent', topicId: 'animation-topic', streamOperationId: 'sealed-css',
        };
        await fixture.streamProjection.startStreamingMessage(message, fixture.messageItem);
        for (const content of [
            '~~~html\n<style>.evil { width: 999px; }</style>\n',
            '~~~\n\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」Demo「末」\ntext:「始ESCAPE」<style>.evil2 { width: 999px; }</style>',
            '「末ESCAPE」\n<<<[END_TOOL_REQUEST]>>>\n\n<!-- <style>.evil3 { width: 999px; }</style> -->\n',
            '<style>.safe { width: 12px; }</style>',
        ]) {
            fixture.streamProjection.appendStreamChunk(message.id, { content }, message, 'sealed-css');
            await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 80));
            assert.doesNotMatch(fixture.dom.window.document.head.textContent, /\.evil/);
        }
        assert.match(fixture.dom.window.document.head.textContent, /\.safe/);
    } finally { await disposeFixture(fixture); }
});


test('shared code domains preserve dollar literals while normalizing only safe prose math', async () => {
    const fixture = await createRendererFixture([
        '~~~text',
        '    $x$ and $$ literal',
        '~~~',
        '',
        '````text',
        '```',
        '$y$',
        '````',
        '',
        'inline `$z$` remains code.',
        '',
        'price $19.99',
        'next line $29.99',
        '',
        'safe $a+b$',
    ].join('\n'));
    try {
        const code = [...fixture.messageItem.querySelectorAll('code')].map(node => node.textContent).join('\n');
        assert.match(code, /\$x\$/);
        assert.match(code, /\$y\$/);
        assert.match(code, /\$z\$/);
        assert.match(fixture.messageItem.textContent, /price \$19\.99/);
        assert.match(fixture.messageItem.textContent, /next line \$29\.99/);
        assert.match(fixture.messageItem.textContent, /\\\(a\+b\\\)/);
        assert.doesNotMatch(fixture.messageItem.innerHTML, /LATEX_BLOCK_|CODEFENCE_FOR_LATEX_|VCP_CODE_BLOCK_PLACEHOLDER_/);
    } finally { await disposeFixture(fixture); }
});


test('canvas island script remains valid JavaScript across blank lines and comparison operators', async () => {
    const script = `
    (() => {
      const canvas = container.querySelector('.v5t-canvas');
      if (!canvas) return;

      const modes = [{ speed: 0.055, amp: 0.34 }];
      let phase = 0;

      // 双谐波拓扑线
      for (let x = 0; x &lt;= 480; x += 3) {
        const t = (x / 480) * Math.PI * 4;
        phase += Math.sin(t) * modes[0].amp;
      }
      canvas.dataset.phase = String(phase);
    })();
  `.replace('&lt;', '<');
    const fixture = await createRendererFixture(`<div class="v5t-osc-box">
  <style>.v5t-canvas { height: 76px; }</style>
  <div class="v5t-osc-head"><button type="button">mode</button></div>
  <canvas class="v5t-canvas"></canvas>
  <script>${script}</script>
</div>`);
    try {
        const rendered = fixture.messageItem.querySelector('script')?.textContent;
        assert.ok(rendered);
        assert.doesNotThrow(() => new Function('container', rendered), rendered);
        assert.equal(rendered.trim(), script.trim(), 'render pipeline must not rewrite script source');
    } finally { await disposeFixture(fixture); }
});


test('active stream tool payloads remain expandable after chat DOM recreation', async () => {
    const fixture = await createRendererFixture('');
    try {
        const message = {
            id: 'animation-island-message', role: 'assistant', content: '思考中', isThinking: true,
            agentId: 'animation-agent', topicId: 'animation-topic', streamOperationId: 'tool-restore',
        };
        await fixture.streamProjection.startStreamingMessage(message, fixture.messageItem);
        fixture.streamProjection.appendStreamChunk(message.id, { content: [
            '<<<[TOOL_REQUEST]>>>',
            'tool_name:「始」Demo「末」',
            'query:「始」restored-request「末」',
            '<<<[END_TOOL_REQUEST]>>>',
            '',
            '[[VCP调用结果信息汇总:',
            '- 工具名称: Demo',
            '- 返回内容: ' + Array.from({ length: 150 }, (_, i) => `restored-${i} ${'x'.repeat(400)}`).join('\n'),
            'VCP调用结果结束]]',
            '\n<<<[END_ROLE_DIVIDE_USER]>>>\n',
        ].join('\n') }, message, 'tool-restore');
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 100));
        fixture.renderer.clearChat();
        await fixture.streamProjection.reconcileConversation({
            itemType: 'agent', itemId: 'animation-agent', topicId: 'animation-topic',
        });
        const rebuilt = fixture.root.querySelector('.message-item');
        assert.ok(rebuilt);
        assert.equal(rebuilt.classList.contains('thinking'), false);
        const request = rebuilt.querySelector('.vcp-tool-use-bubble');
        assert.ok(request);
        request.querySelector('.vcp-tool-summary').click();
        assert.match(request.textContent, /restored-request/);
        const result = rebuilt.querySelector('.vcp-tool-result-bubble');
        result.querySelector('.vcp-tool-result-header').click();
        const notice = result.querySelector('.vcp-tool-result-truncated-notice');
        assert.ok(notice);
        notice.click();
        assert.match(result.textContent, /restored-149/);
    } finally { await disposeFixture(fixture); }
});


test('stream projection accumulates desktop-filtered text rather than the raw push payload', async () => {
    const fixture = await createRendererFixture('');
    try {
        const message = {
            id: 'animation-island-message', role: 'assistant', content: '',
            agentId: 'animation-agent', topicId: 'animation-topic', streamOperationId: 'desktop-filter',
        };
        await fixture.streamProjection.startStreamingMessage(message, fixture.messageItem);
        for (const content of ['before<<<[DESK', 'TOP_PUSH]>>><div>desktop-only</div>', '<<<[DESKTOP_PUSH_END]>>>after']) {
            fixture.streamProjection.appendStreamChunk(message.id, { content }, message, 'desktop-filter');
        }
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 80));
        const snapshots = fixture.streamProjection.snapshotConversation({
            itemType: 'agent', itemId: 'animation-agent', topicId: 'animation-topic',
        });
        assert.equal(snapshots[0].accumulatedText, 'beforeafter');
        assert.doesNotMatch(fixture.messageItem.textContent, /desktop-only|DESKTOP_PUSH/);
    } finally { await disposeFixture(fixture); }
});


test('script template literals are restored inside sealed payloads before delayed drawing', async () => {
    const script = [
        'const node = container.querySelector(".template-probe");',
        'const title = `动画 ${1 + 2}`;',
        'function draw(timestamp) {',
        '  const nested = `rgb(${Math.round(timestamp / 10)}, ${`2${3}`}, 4)`;',
        '  node.dataset.color = nested;',
        '  node.textContent = `${title}: ${timestamp >= 1000 ? `仍在运行 ${timestamp}` : "启动"}`;',
        '  if (timestamp < 1100) requestAnimationFrame(draw);',
        '}',
        'requestAnimationFrame(draw);',
    ].join('\n');
    const fixture = await createRendererFixture(
        '<div><span class="template-probe"></span><script>' + script + '</script></div>');
    try {
        const rendered = fixture.messageItem.querySelector('script')?.textContent;
        assert.equal(rendered, script, 'sealed executable source must not retain Markdown code tokens');
        assert.doesNotMatch(rendered, /__VCP_CODE_BLOCK_PLACEHOLDER_\d+__/);
        const callbacks = [];
        new Function('container', 'requestAnimationFrame', rendered)(
            fixture.messageItem, callback => callbacks.push(callback));
        for (const timestamp of [16, 500, 1000, 1100]) {
            assert.equal(callbacks.length, 1);
            assert.doesNotThrow(() => callbacks.shift()(timestamp));
        }
        const node = fixture.messageItem.querySelector('.template-probe');
        assert.equal(node.textContent, '动画 3: 仍在运行 1100');
        assert.equal(node.dataset.color, 'rgb(110, 23, 4)');
        assert.equal(callbacks.length, 0);
    } finally { await disposeFixture(fixture); }
});


test('rendered animation executes template literals after one second without losing later frames', async () => {
    const script = [
        'const output = container.querySelector(".late-template");',
        'setTimeout(() => {',
        '  let frameCount = 0;',
        '  function draw() {',
        '    output.textContent = `延迟动画 ${++frameCount}`;',
        '    if (frameCount < 3) window.requestAnimationFrame(draw);',
        '  }',
        '  globalThis.requestAnimationFrame(draw);',
        '}, 1050);',
    ].join('\n');
    const fixture = await createRendererFixture(
        '<div><span class="late-template">等待</span><script>' + script + '</script></div>', null, true);
    try {
        const errors = [];
        fixture.dom.window.addEventListener('error', event => errors.push(event.error || event.message));
        await fixture.messageItem._vcp_activateHeavy();
        await new Promise(resolve => setTimeout(resolve, 1200));
        assert.equal(fixture.messageItem.querySelector('.late-template').textContent, '延迟动画 3');
        assert.deepEqual(errors, []);
        assert.doesNotMatch(fixture.messageItem.innerHTML, /__VCP_CODE_BLOCK_PLACEHOLDER_\d+__/);
    } finally { await disposeFixture(fixture); }
});


test('cached HTML island reapplies styles to its new scope after topic navigation', async () => {
    const source = '<div class="cache-island"><style>.cache-island { width: 137px; }</style>cached island</div>';
    const fixture = await createRendererFixture(source);
    try {
        const oldScope = fixture.messageItem.id;
        const message = { ...fixture.historyRef.get()[0] };
        const before = fixture.renderer.getRenderHtmlCacheStats();
        assert.equal(before.entries, 1, 'short HTML is eligible for the pure template cache');
        fixture.renderer.clearChat();
        assert.equal(fixture.dom.window.document.head.querySelector('style[data-vcp-scope-id]'), null);
        fixture.historyRef.set([message]);
        const restored = await fixture.renderer.renderMessage(message);
        assert.notEqual(restored.id, oldScope);
        assert.equal(fixture.renderer.getRenderHtmlCacheStats().hits, before.hits + 1);
        const sheet = fixture.dom.window.document.head.querySelector('style[data-vcp-scope-id]');
        assert.equal(sheet.dataset.vcpScopeId, restored.id);
        assert.doesNotMatch(sheet.textContent, new RegExp(`#${oldScope}`));
        assert.equal(fixture.dom.window.getComputedStyle(restored.querySelector('.cache-island')).width, '137px');
        fixture.renderer.updateMessageContent(message.id, '<div class="cache-island">no styles</div>');
        assert.equal(fixture.dom.window.document.head.querySelector('style[data-vcp-scope-id]'), null);
    } finally { await disposeFixture(fixture); }
});

test('cached script templates remount fresh DOM and execute through normal postprocessing', async () => {
    const source = '<div><span class="cache-script">pending</span><script>'
        + 'container.querySelector(".cache-script").textContent = `mounted ${1 + 2}`;'
        + '</script></div>';
    const fixture = await createRendererFixture(source, null, true);
    try {
        await fixture.messageItem._vcp_activateHeavy();
        const oldNode = fixture.messageItem.querySelector('.cache-script');
        assert.equal(oldNode.textContent, 'mounted 3');
        const message = { ...fixture.historyRef.get()[0] };
        fixture.renderer.clearChat();
        fixture.historyRef.set([message]);
        const restored = await fixture.renderer.renderMessage(message);
        assert.equal(fixture.renderer.getRenderHtmlCacheStats().hits, 1);
        const newNode = restored.querySelector('.cache-script');
        assert.notEqual(newNode, oldNode);
        assert.equal(newNode.textContent, 'pending', 'cache stores pre-execution HTML, not mutated DOM');
        await restored._vcp_activateHeavy();
        assert.equal(newNode.textContent, 'mounted 3');
    } finally { await disposeFixture(fixture); }
});


test('stream source replacement retires old stable CSS, DOM and lazy tool leases before canonical terminal render', async () => {
    const fixture = await createRendererFixture('');
    try {
        const message = {
            id: 'animation-island-message', role: 'assistant', content: '',
            agentId: 'animation-agent', topicId: 'animation-topic', streamOperationId: 'source-revision',
        };
        await fixture.streamProjection.startStreamingMessage(message, fixture.messageItem);
        const original = '<style>.old-rule { width: 999px; }</style>\n'
            + '<<<[TOOL_REQUEST]>>>tool_name:「始」Demo「末」<<<[END_TOOL_REQUEST]>>>';
        fixture.streamProjection.appendStreamChunk(message.id, { content: original }, message, message.streamOperationId);
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 100));
        assert.equal(fixture.renderer.getLazyToolStats().entries, 1);
        assert.match(fixture.dom.window.document.head.textContent, /old-rule/);
        // Reinitialization with a longer corrected seed is an existing source replacement path.
        const corrected = 'corrected-source '.repeat(20) + '\n\nB\n\nC';
        await fixture.streamProjection.startStreamingMessage({
            ...message, isThinking: true, content: corrected,
        }, fixture.messageItem);
        fixture.streamProjection.appendStreamChunk(message.id, { content: ' tail' }, message, message.streamOperationId);
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 100));
        assert.doesNotMatch(fixture.messageItem.textContent, /Demo/);
        assert.match(fixture.messageItem.textContent, /corrected-source/);
        assert.doesNotMatch(fixture.dom.window.document.head.textContent, /old-rule/);
        assert.equal(fixture.renderer.getLazyToolStats().entries, 0);
        await fixture.streamProjection.projectStreamTerminal(message.id, 'stop', message, {
            streamOperationId: message.streamOperationId,
            fullResponse: 'canonical shorter final',
        });
        assert.equal(fixture.messageItem.querySelector('.md-content').textContent.trim(), 'canonical shorter final');
        assert.equal(fixture.messageItem.querySelector('.vcp-stream-stable-root'), null);
        assert.equal(fixture.streamProjection.getDiagnostics().contexts, 0);
    } finally { await disposeFixture(fixture); }
});

test('stream inline code cannot inject CSS before closing, while terminal reparse releases orphan delimiters', async () => {
    const fixture = await createRendererFixture('');
    try {
        const message = {
            id: 'animation-island-message', role: 'assistant', content: '',
            agentId: 'animation-agent', topicId: 'animation-topic', streamOperationId: 'inline-css',
        };
        await fixture.streamProjection.startStreamingMessage(message, fixture.messageItem);
        const content = 'unfinished `<style>.orphan-rule { width: 33px; }</style>';
        fixture.streamProjection.appendStreamChunk(message.id, { content }, message, message.streamOperationId);
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 100));
        assert.doesNotMatch(fixture.dom.window.document.head.textContent, /orphan-rule/);
        await fixture.streamProjection.projectStreamTerminal(message.id, 'stop', message, {
            streamOperationId: message.streamOperationId, fullResponse: content,
        });
        assert.match(fixture.dom.window.document.head.textContent, /orphan-rule/);
    } finally { await disposeFixture(fixture); }
});


test('a blank-line append releases old inline-protected CSS without requiring a new style marker', async () => {
    const fixture = await createRendererFixture('');
    try {
        const message = {
            id: 'animation-island-message', role: 'assistant', content: '',
            agentId: 'animation-agent', topicId: 'animation-topic', streamOperationId: 'released-css',
        };
        await fixture.streamProjection.startStreamingMessage(message, fixture.messageItem);
        fixture.streamProjection.appendStreamChunk(message.id, {
            content: 'unfinished `<style>.released-rule { width: 37px; }</style>',
        }, message, message.streamOperationId);
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 100));
        assert.doesNotMatch(fixture.dom.window.document.head.textContent, /released-rule/);
        fixture.streamProjection.appendStreamChunk(message.id, { content: '\n\n' }, message, message.streamOperationId);
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 100));
        assert.match(fixture.dom.window.document.head.textContent, /released-rule/);
        await fixture.streamProjection.projectStreamTerminal(message.id, 'stop', message, {
            streamOperationId: message.streamOperationId, fullResponse: 'canonical final without CSS',
        });
        assert.doesNotMatch(fixture.dom.window.document.head.textContent, /released-rule/);
        assert.equal(fixture.messageItem.querySelector('.md-content').textContent.trim(), 'canonical final without CSS');
    } finally { await disposeFixture(fixture); }
});


test('body redraw revokes managed callbacks without removing the shell', async () => {
    const fixture = await createRendererFixture('<div><script>setTimeout(() => { window.staleBodyWrites = true; }, 20);</script></div>', null, true);
    try {
        await fixture.messageItem._vcp_activateHeavy();
        const shell = fixture.messageItem;
        fixture.renderer.updateMessageContent('animation-island-message', 'new body');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(shell.isConnected, true);
        assert.equal(shell.textContent.includes('new body'), true);
        assert.equal(fixture.dom.window.staleBodyWrites, undefined);
    } finally { await disposeFixture(fixture); }
});

test('renderer disposal cancels animation callbacks on retained message DOM', async () => {
    const fixture = await createRendererFixture('<div><script>setInterval(() => { window.staleRendererWrites = true; }, 10);</script></div>', null, true);
    try {
        await fixture.messageItem._vcp_activateHeavy();
        fixture.renderer.disposeRendererResources();
        assert.equal(fixture.messageItem.isConnected, true);
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(fixture.dom.window.staleRendererWrites, undefined);
    } finally { await disposeFixture(fixture); }
});

test('root disposal revokes animation callbacks before replacing its children', async () => {
    const fixture = await createRendererFixture('<div><script>setTimeout(() => { window.staleRootWrites = true; }, 10);</script></div>', null, true);
    try {
        await fixture.messageItem._vcp_activateHeavy();
        await fixture.renderer.disposeRootResources(fixture.root);
        await new Promise(resolve => setTimeout(resolve, 35));
        assert.equal(fixture.root.childElementCount, 0);
        assert.equal(fixture.dom.window.staleRootWrites, undefined);
    } finally { await disposeFixture(fixture); }
});


test('history presentation reveals the first batch without waiting for older history', async () => {
    const fixture = await createRendererFixture('initial');
    try {
        fixture.renderer.clearChat();
        const messages = Array.from({ length: 3 }, (_, index) => ({
            id: `presentation-${index}`, role: 'assistant', content: `message ${index}`, timestamp: index,
        }));
        fixture.historyRef.set(messages);
        const frames = new Map();
        let sequence = 0;
        fixture.dom.window.requestAnimationFrame = callback => {
            frames.set(++sequence, callback);
            return sequence;
        };
        fixture.dom.window.cancelAnimationFrame = id => frames.delete(id);
        // Keep older batches pending without using wall-clock delays.
        fixture.dom.window.requestIdleCallback = () => ++sequence;
        fixture.dom.window.cancelIdleCallback = () => {};
        const loading = fixture.renderer.renderHistory(messages, { initialBatch: 1, batchSize: 1, batchDelay: 0 });
        assert.equal(fixture.root.dataset.vcpHistoryPresentation, 'preparing');
        for (let i = 0; i < 20 && fixture.root.dataset.vcpHistoryPresentation !== 'ready'; i++) {
            await new Promise(resolve => setImmediate(resolve));
            const callbacks = [...frames.values()];
            frames.clear();
            callbacks.forEach(callback => callback(Date.now()));
        }
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(fixture.root.dataset.vcpHistoryPresentation, 'ready');
        assert.deepEqual([...fixture.root.querySelectorAll('.message-item')].map(el => el.dataset.messageId),
            ['presentation-2'], 'only the latest batch is needed for reveal');
        fixture.renderer.clearChat();
        await loading;
        assert.equal(fixture.root.dataset.vcpHistoryPresentation, undefined);
    } finally { await disposeFixture(fixture); }
});

test('small history reveals once and empty history leaves no hidden presentation', async () => {
    const fixture = await createRendererFixture('initial');
    try {
        const message = { ...fixture.historyRef.get()[0] };
        fixture.renderer.clearChat();
        fixture.historyRef.set([message]);
        await fixture.renderer.renderHistory([message]);
        assert.equal(fixture.root.dataset.vcpHistoryPresentation, 'ready');
        assert.equal(fixture.root.querySelectorAll('.message-item').length, 1);
        fixture.renderer.clearChat();
        await fixture.renderer.renderHistory([]);
        assert.equal(fixture.root.dataset.vcpHistoryPresentation, undefined);
    } finally { await disposeFixture(fixture); }
});

test('revoked history cannot restore presentation state after chat clear', async () => {
    const fixture = await createRendererFixture('initial');
    try {
        const message = { ...fixture.historyRef.get()[0] };
        fixture.renderer.clearChat();
        const loading = fixture.renderer.renderHistory([message]);
        assert.equal(fixture.root.dataset.vcpHistoryPresentation, 'preparing');
        fixture.renderer.clearChat();
        await loading;
        assert.equal(fixture.root.dataset.vcpHistoryPresentation, undefined);
        assert.equal(fixture.root.childElementCount, 0);
    } finally { await disposeFixture(fixture); }
});

test('history preparation failure leaves the message root visible', async () => {
    const fixture = await createRendererFixture('initial');
    try {
        fixture.renderer.clearChat();
        const invalid = { role: 'assistant', get content() { throw new Error('controlled history failure'); } };
        await assert.rejects(fixture.renderer.renderHistory([invalid]), /controlled history failure/);
        assert.equal(fixture.root.dataset.vcpHistoryPresentation, undefined);
    } finally { await disposeFixture(fixture); }
});
