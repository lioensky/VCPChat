import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// 隐藏页面（最小化 / 被遮挡）里 requestAnimationFrame 不触发。流式帧循环必须改走定时器继续排空，
// 页面重新可见时换回 rAF。这是撤回全局 background-throttling 开关的前提。

const originalWindow = global.window;
const bootstrapDom = new JSDOM('<!doctype html>');
global.window = bootstrapDom.window;
test.after(() => {
    global.window = originalWindow;
    bootstrapDom.window.close();
});

async function loadFactory() {
    const module = await import('../modules/renderer/streamManager.js');
    const historyModule = await import('../modules/chat/streamTransientHistory.js');
    return { createStreamProjection: module.createStreamProjection, createStreamTransientHistory: historyModule.createStreamTransientHistory };
}

function createHarness(dom, createStreamTransientHistory) {
    const history = [];
    const dependencies = {
        chatRepository: { getHistory: async () => [], saveHistory: async () => ({ success: true }) },
        currentSelectedItemRef: { get: () => ({ id: 'visible-agent', type: 'agent' }) },
        currentTopicIdRef: { get: () => 'visible-topic' },
        currentChatHistoryRef: { get: () => history, set: value => { history.splice(0, history.length, ...value); } },
        viewAuthority: { isCurrent: context => context?.agentId === 'visible-agent' && context?.topicId === 'visible-topic' },
        globalSettingsRef: { get: () => ({ enableSmoothStreaming: true, minChunkBufferSize: 1 }) },
        chatMessagesDiv: dom.window.document.getElementById('chat'),
        renderMessage: () => null,
        uiHelper: { scrollToBottom() {} },
        electronAPI: { onDesktopStatus: () => () => {} },
        prepareFinalTextForRender: (_messageId, text, role) => ({ text, role, depth: 0 }),
        renderPostProcessedHtml: async (content, html) => { content.textContent = html; },
    };
    dependencies.transientStreamHistory = createStreamTransientHistory({
        repository: dependencies.chatRepository,
        currentHistory: {
            get: () => dependencies.currentChatHistoryRef.get(),
            replace: value => dependencies.currentChatHistoryRef.set(value),
        },
    });
    return dependencies;
}

function installVisibilityControl(dom) {
    let state = 'hidden';
    Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => state });
    Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => state === 'hidden' });
    const rafCalls = [];
    const pendingFrames = [];
    // 模拟隐藏页面：rAF 可以申请，但只有测试主动 flushFrames() 才回调。
    dom.window.requestAnimationFrame = callback => { rafCalls.push(callback); pendingFrames.push(callback); return rafCalls.length; };
    dom.window.cancelAnimationFrame = () => {};
    return {
        rafCalls,
        // 全局帧循环的第一帧只记录时间戳，第二帧（间隔 ≥ 1000/30 ms）才真正排空，所以测试显式给出时间戳。
        flushFrames(timestamp = dom.window.performance.now()) {
            const frames = pendingFrames.splice(0);
            for (const frame of frames) frame(timestamp);
            return frames.length;
        },
        set(next) {
            state = next;
            dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
        },
    };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a hidden document still drains queued stream text through timers, and goes back to rAF when visible', async () => {
    const { createStreamProjection, createStreamTransientHistory } = await loadFactory();
    const dom = new JSDOM(
        '<!doctype html><div id="chat"><article class="message-item" data-message-id="hidden-stream"><div class="md-content"></div></article></div>',
        { url: 'https://vcpchat.local/', pretendToBeVisual: true }
    );
    const visibility = installVisibilityControl(dom);
    const projection = createStreamProjection();
    projection.attachStreamProjection(createHarness(dom, createStreamTransientHistory));

    const item = dom.window.document.querySelector('.message-item');
    await projection.startStreamingMessage({
        id: 'hidden-stream',
        agentId: 'visible-agent',
        topicId: 'visible-topic',
        content: '',
        streamOperationId: 'hidden-op',
    }, item);

    const longText = Array.from({ length: 40 }, (_, index) => `segment-${index} `).join('');
    projection.appendStreamChunk('hidden-stream', { content: longText }, { agentId: 'visible-agent', topicId: 'visible-topic' }, 'hidden-op');

    await sleep(250);
    const content = item.querySelector('.md-content').textContent;
    assert.match(content, /segment-39/, 'the whole backlog must be rendered while hidden, not one typewriter step per frame');
    assert.equal(visibility.rafCalls.length, 0, 'a hidden document must not wait on requestAnimationFrame');

    visibility.set('visible');
    projection.appendStreamChunk('hidden-stream', { content: 'after-visible' }, { agentId: 'visible-agent', topicId: 'visible-topic' }, 'hidden-op');
    await sleep(100);
    assert.ok(visibility.rafCalls.length >= 1, 'once visible the frame loop must request animation frames again');

    await projection.dispose();
    dom.window.close();
});

test('a frame scheduled through rAF is re-armed as a timer when the document becomes hidden', async () => {
    const { createStreamProjection, createStreamTransientHistory } = await loadFactory();
    const dom = new JSDOM(
        '<!doctype html><div id="chat"><article class="message-item" data-message-id="goes-hidden"><div class="md-content"></div></article></div>',
        { url: 'https://vcpchat.local/', pretendToBeVisual: true }
    );
    const visibility = installVisibilityControl(dom);
    visibility.set('visible');
    const projection = createStreamProjection();
    projection.attachStreamProjection(createHarness(dom, createStreamTransientHistory));

    const item = dom.window.document.querySelector('.message-item');
    await projection.startStreamingMessage({
        id: 'goes-hidden',
        agentId: 'visible-agent',
        topicId: 'visible-topic',
        content: '',
        streamOperationId: 'goes-hidden-op',
    }, item);
    projection.appendStreamChunk('goes-hidden', { content: 'first-part second-part third-part' }, { agentId: 'visible-agent', topicId: 'visible-topic' }, 'goes-hidden-op');
    await sleep(50);
    assert.ok(visibility.rafCalls.length >= 1, 'visible document schedules frames through rAF');
    assert.doesNotMatch(item.querySelector('.md-content').textContent, /third-part/, 'the stubbed rAF never fires, so nothing renders yet');

    visibility.set('hidden');
    await sleep(250);
    assert.match(item.querySelector('.md-content').textContent, /third-part/, 'the pending frame must be re-armed as a timer and drain the queue');

    await projection.dispose();
    dom.window.close();
});

test('text that arrived while hidden is rendered in the first frame after the document becomes visible', async () => {
    const { createStreamProjection, createStreamTransientHistory } = await loadFactory();
    const dom = new JSDOM(
        '<!doctype html><div id="chat"><article class="message-item" data-message-id="catch-up"><div class="md-content"></div></article></div>',
        { url: 'https://vcpchat.local/', pretendToBeVisual: true }
    );
    const visibility = installVisibilityControl(dom);
    const projection = createStreamProjection();
    projection.attachStreamProjection(createHarness(dom, createStreamTransientHistory));
    try {
        const item = dom.window.document.querySelector('.message-item');
        await projection.startStreamingMessage({
            id: 'catch-up',
            agentId: 'visible-agent',
            topicId: 'visible-topic',
            content: '',
            streamOperationId: 'catch-up-op',
        }, item);

        // 隐藏期间攒下一大段文本，还没等到隐藏定时器就切回前台。
        const backlog = Array.from({ length: 40 }, (_, index) => `late-${index} `).join('');
        projection.appendStreamChunk('catch-up', { content: backlog }, { agentId: 'visible-agent', topicId: 'visible-topic' }, 'catch-up-op');
        visibility.set('visible');
        assert.ok(visibility.flushFrames(1000) >= 1, 'the pending hidden-timer frame must be re-armed as a rAF frame');
        visibility.flushFrames(1100);
        await sleep(10);
        assert.match(item.querySelector('.md-content').textContent, /late-39/, 'the first visible frame must show the whole backlog, not one typewriter step');
    } finally {
        await projection.dispose();
        dom.window.close();
    }
});
