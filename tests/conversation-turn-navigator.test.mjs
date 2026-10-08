import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    buildPreviewText,
    buildTurnNavigatorItems,
    collectTurnEntries,
    createConversationTurnNavigator,
    resolveActiveTurnIndex,
    resolveActiveTurnKey,
    resolveBarVisualState
} from '../modules/ui-system/conversation-turn-navigator.js';

const wait = (ms = 220) => new Promise(resolve => setTimeout(resolve, ms));

test('resolveBarVisualState follows the ZCode mountain table', () => {
    assert.deepEqual(resolveBarVisualState({ itemIndex: 3, visualFocusItemIndex: undefined }), { colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' });
    const scales = [0, 1, 2, 3, 4].map(distance => resolveBarVisualState({ itemIndex: 5 + distance, visualFocusItemIndex: 5 }).scaleX);
    assert.deepEqual(scales, [3.9, 2.55, 1.875, 1, 1]);
    assert.equal(resolveBarVisualState({ itemIndex: 4, visualFocusItemIndex: 5 }).opacity, 0.86);
    assert.equal(resolveBarVisualState({ itemIndex: 5, visualFocusItemIndex: 5 }).colorTone, 'focus');
});

test('buildPreviewText keeps two paragraphs, collapses whitespace and truncates', () => {
    assert.equal(buildPreviewText(['  a   b \n\n c\nd \n\n third'], 'x'), 'a b\nc d');
    assert.equal(buildPreviewText(['   '], '空'), '空');
    const long = buildPreviewText(['x'.repeat(400)], '空');
    assert.equal(long.length, 220);
    assert.ok(long.endsWith('...'));
});

test('buildTurnNavigatorItems derives assistant previews and running state', () => {
    const items = buildTurnNavigatorItems([
        { id: 'u1', userText: '你好', assistantTexts: ['第一段\n\n第二段\n\n第三段'], running: false },
        { id: 'u2', userText: '', assistantTexts: [], running: true },
        { id: 'u3', userText: '再问', assistantTexts: ['', '  '], running: false }
    ]);
    assert.equal(items[0].assistantPreview, '第一段\n第二段');
    assert.equal(items[0].assistantPreviewKind, 'text');
    assert.equal(items[1].userPreview, '（没有文字内容）');
    assert.equal(items[1].assistantPreviewKind, 'running');
    assert.equal(items[1].isRunning, true);
    assert.equal(items[2].assistantPreviewKind, 'empty');
    assert.deepEqual(items.map(item => item.key), ['u1', 'u2', 'u3']);
});

test('resolveActiveTurnKey picks the visible query nearest the viewport top, else the nearest above', () => {
    const positions = [
        { key: 'a', start: 0, end: 100 },
        { key: 'b', start: 400, end: 500 },
        { key: 'c', start: 900, end: 1000 }
    ];
    assert.equal(resolveActiveTurnKey({ positions, scrollOffsetPx: 380, viewportHeightPx: 300 }), 'b');
    assert.equal(resolveActiveTurnKey({ positions, scrollOffsetPx: 0, viewportHeightPx: 300 }), 'a');
    assert.equal(resolveActiveTurnKey({ positions, scrollOffsetPx: 600, viewportHeightPx: 200 }), 'b'); // 视口里没有提问：取上方最近的
    assert.equal(resolveActiveTurnKey({ positions: [], scrollOffsetPx: 0, viewportHeightPx: 100 }), undefined);
});

function makeChat(turns) {
    const dom = new JSDOM('<main><div class="chat-messages-container"><div id="chatMessages"></div></div></main>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('chatMessages');
    const add = (role, text, id, extra = '') => {
        const item = doc.createElement('div');
        item.className = `message-item ${role} ${extra}`.trim();
        if (id) item.dataset.messageId = id;
        item.innerHTML = `<div class="md-content">${text}<span class="thinking-indicator">思考中</span></div>`;
        root.appendChild(item);
        return item;
    };
    turns.forEach((turn, index) => {
        add('user', turn.q, `u${index}`);
        if (turn.a !== undefined) add('assistant', turn.a, `a${index}`, turn.streaming ? 'streaming' : '');
    });
    const scroller = doc.querySelector('.chat-messages-container');
    // jsdom 没有布局：每条消息占 100px，容器高 300px、宽 900px
    let top = 0;
    const scrollCalls = [];
    Object.defineProperty(scroller, 'clientWidth', { value: 900, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', { get: () => top, set: (v) => { top = v; }, configurable: true });
    scroller.scrollTo = (options) => { scrollCalls.push(options); top = options.top; scroller.dispatchEvent(new dom.window.Event('scroll')); };
    scroller.getBoundingClientRect = () => ({ top: 0, height: 300 });
    const place = () => [...root.children].forEach((child, index) => {
        child.getBoundingClientRect = () => ({ top: index * 100 - top, height: 100 });
    });
    place();
    return { dom, doc, root, scroller, add, place, scrollCalls };
}

test('collectTurnEntries groups assistant messages under the preceding user message and ignores the thinking indicator', () => {
    const { root } = makeChat([{ q: '问一', a: '答一' }, { q: '问二', a: '答二', streaming: true }]);
    const entries = collectTurnEntries(root);
    assert.deepEqual(entries.map(entry => [entry.id, entry.userText, entry.assistantTexts, entry.running]),
        [['u0', '问一', ['答一'], false], ['u1', '问二', ['答二'], true]]);
});

test('mounts a rail for two or more queries, reflects the active one and jumps on click', async () => {
    const { doc, root, scroller, add, place, scrollCalls, dom } = makeChat([{ q: '问一', a: '答一' }]);
    const navigator = createConversationTurnNavigator({ document: doc, messagesRoot: root });
    const nav = navigator.mount();
    assert.equal(nav.hidden, true, 'a single query needs no rail');

    add('user', '问二', 'u1');
    add('assistant', '答二', 'a1');
    add('user', '问三', 'u2');
    place();
    navigator.refresh();
    assert.equal(nav.hidden, false);
    assert.equal(nav.classList.contains('is-wide'), true);
    const buttons = [...nav.querySelectorAll('.vcp-turn-nav-item')];
    assert.equal(buttons.length, 3);
    assert.equal(buttons[0].getAttribute('aria-label'), '跳转到第 1 条提问');
    await wait(40);
    assert.equal(buttons[0].dataset.active, 'true');

    // 悬停：山峰放大，120ms 后出现卡片
    buttons[1].dispatchEvent(new dom.window.Event('pointerenter'));
    assert.equal(buttons[1].dataset.visualScale, '3.9');
    assert.equal(buttons[2].dataset.visualScale, '2.55');
    assert.equal(nav.querySelector('.vcp-turn-nav-card').hidden, true);
    await wait(180);
    const card = nav.querySelector('.vcp-turn-nav-card');
    assert.equal(card.hidden, false);
    assert.equal(card.querySelector('.vcp-turn-nav-card-user').textContent, '问二');
    assert.equal(card.querySelector('.vcp-turn-nav-card-assistant').textContent, '答二');
    buttons[1].dispatchEvent(new dom.window.Event('pointerleave'));
    assert.equal(buttons[1].dataset.visualScale, '1');
    await wait(150);
    assert.equal(card.hidden, true);

    // 点击：平滑滚到这条提问（留 12px 顶部间距）
    buttons[2].click();
    assert.deepEqual(scrollCalls.at(-1), { top: 388, behavior: 'smooth' });
    await wait(60);
    assert.equal(buttons[2].dataset.active, 'true');
    assert.equal(buttons[2].getAttribute('aria-current'), 'location');
    assert.equal(buttons[0].hasAttribute('aria-current'), false);
    assert.equal(scroller.scrollTop, 388);

    navigator.dispose();
    assert.equal(doc.querySelector('.vcp-turn-nav'), null);
});

test('hides below the minimum width, follows streaming previews and topic switches, and disposes cleanly', async () => {
    const { doc, root, scroller } = makeChat([{ q: '问一', a: '答一' }, { q: '问二', a: '', streaming: true }]);
    Object.defineProperty(scroller, 'clientWidth', { value: 399, configurable: true });
    const navigator = createConversationTurnNavigator({ document: doc, messagesRoot: root });
    const nav = navigator.mount();
    assert.equal(nav.classList.contains('is-wide'), false);
    Object.defineProperty(scroller, 'clientWidth', { value: 400, configurable: true });
    navigator.refresh();
    assert.equal(nav.classList.contains('is-wide'), true);
    assert.equal(nav.style.getPropertyValue('--vcp-turn-nav-card-max-width'), '336px');

    // 通知栏展开将聊天区从宽屏压至 600px，不再触发旧的 864px 隐藏阈值。
    doc.querySelector('main').classList.add('notifications-sidebar-active');
    Object.defineProperty(scroller, 'clientWidth', { value: 600, configurable: true });
    navigator.refresh();
    assert.equal(nav.classList.contains('is-wide'), true);
    assert.equal(nav.hidden, false);

    const buttons = [...nav.querySelectorAll('.vcp-turn-nav-item')];
    assert.equal(navigator.getItems()[1].assistantPreviewKind, 'running');
    assert.equal(buttons[1].dataset.running, 'true');

    // 流式内容到达：DOM 变化被观察到并刷新摘要
    root.children[3].querySelector('.md-content').insertAdjacentText('afterbegin', '流式回答');
    await wait(260);
    assert.equal(navigator.getItems()[1].assistantPreview, '流式回答');
    assert.equal(navigator.getItems()[1].assistantPreviewKind, 'text');

    // 话题切换：清空后导轨消失
    root.textContent = '';
    await wait(260);
    assert.equal(nav.hidden, true);
    assert.equal(nav.querySelectorAll('.vcp-turn-nav-item').length, 0);

    navigator.dispose();
    navigator.dispose();
    root.innerHTML = '<div class="message-item user"><div class="md-content">x</div></div>';
    await wait(200);
    assert.equal(doc.querySelector('.vcp-turn-nav'), null);
});

test('mount is a no-op without a chat container', () => {
    const dom = new JSDOM('<div></div>');
    const navigator = createConversationTurnNavigator({ document: dom.window.document });
    assert.equal(navigator.mount(), null);
    navigator.dispose();
});

test('releases bottom-follow only for jumps that land away from the bottom', () => {
    const { doc, root, scroller, dom } = makeChat([{ q: '问一', a: '答一' }, { q: '问二', a: '答二' }, { q: '问三', a: '答三' }]);
    // 6 条消息 × 100px，容器 300px：最大 scrollTop 为 300
    Object.defineProperty(scroller, 'scrollHeight', { value: 600, configurable: true });
    let released = 0;
    const navigator = createConversationTurnNavigator({ document: doc, messagesRoot: root, releaseFollow: () => { released += 1; } });
    const nav = navigator.mount();
    const buttons = [...nav.querySelectorAll('.vcp-turn-nav-item')];

    buttons[2].click(); // 目标 388 已越过底部：留给跟随
    assert.equal(released, 0);
    buttons[0].click(); // 目标在顶部：先放开跟随
    assert.equal(released, 1);

    navigator.dispose();
    dom.window.close();
});

test('far jumps land at once, then hold the question in place until the user scrolls', async () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ q: `问${i}`, a: `答${i}` }));
    const { doc, root, scroller, scrollCalls, dom } = makeChat(turns);
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
    const heights = [...root.children].map(() => 100);
    const place = () => {
        let offset = 0;
        [...root.children].forEach((child, index) => {
            const start = offset;
            child.getBoundingClientRect = () => ({ top: start - scroller.scrollTop, height: heights[index] });
            offset += heights[index];
        });
    };
    place();
    scroller.scrollTop = 1700;
    let released = 0;
    const navigator = createConversationTurnNavigator({ document: doc, messagesRoot: root, releaseFollow: () => { released += 1; } });
    const buttons = [...navigator.mount().querySelectorAll('.vcp-turn-nav-item')];

    buttons[1].click(); // 1512px 远：不平滑滚动，直接到位
    assert.deepEqual(scrollCalls.at(-1), { top: 188, behavior: 'auto' });
    assert.equal(released, 1);

    // 目标上方的长回答渲染出真实高度，把这条提问往下挤了 500px：下一帧拉回
    heights[1] = 600;
    place();
    await wait(60);
    assert.equal(scroller.scrollTop, 688);

    // 用户自己滚动以后不再守位
    scroller.dispatchEvent(new dom.window.Event('wheel'));
    heights[1] = 700;
    place();
    await wait(60);
    assert.equal(scroller.scrollTop, 688);

    buttons[2].click(); // 近处（一屏半以内）仍然平滑滚动
    assert.deepEqual(scrollCalls.at(-1), { top: 988, behavior: 'smooth' });

    // 跳完马上点聊天区外面的按钮（回到底部、发送）也不再守位
    buttons[5].click();
    assert.equal(scroller.scrollTop, 1588);
    doc.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    scroller.scrollTop = 1000;
    place();
    await wait(60);
    assert.equal(scroller.scrollTop, 1000);

    navigator.dispose();
    dom.window.close();
});

test('resolveActiveTurnIndex agrees with resolveActiveTurnKey while measuring only O(log n) turns', () => {
    let seed = 7;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let round = 0; round < 200; round += 1) {
        const count = 1 + Math.floor(random() * 1500);
        const positions = [];
        let cursor = random() * 50;
        for (let i = 0; i < count; i += 1) {
            const start = cursor + random() * 400; // 提问之间夹着高度不定的回答
            const end = start + 20 + random() * 200;
            positions.push({ key: `k${i}`, start, end });
            cursor = end;
        }
        const scrollOffsetPx = random() * (cursor + 200);
        const viewportHeightPx = 100 + random() * 900;
        let measured = 0;
        const index = resolveActiveTurnIndex({ count, measure: (i) => { measured += 1; return positions[i]; }, scrollOffsetPx, viewportHeightPx });
        assert.equal(positions[index].key, resolveActiveTurnKey({ positions, scrollOffsetPx, viewportHeightPx }), `round ${round}`);
        assert.ok(measured <= 2 * Math.ceil(Math.log2(count + 1)) + 4, `measured ${measured} of ${count}`);
    }
    assert.equal(resolveActiveTurnIndex({ count: 0, measure: () => null, scrollOffsetPx: 0, viewportHeightPx: 100 }), -1);
});

test('loading older turns reuses the existing bars and keeps the hover card on the same question', async () => {
    const { doc, root, place, dom } = makeChat([{ q: '问三', a: '答三' }, { q: '问四', a: '答四' }]);
    const navigator = createConversationTurnNavigator({ document: doc, messagesRoot: root });
    const nav = navigator.mount();
    const before = [...nav.querySelectorAll('.vcp-turn-nav-item')];
    before[1].dispatchEvent(new dom.window.Event('pointerenter'));
    await wait(180);
    const card = nav.querySelector('.vcp-turn-nav-card');
    assert.equal(card.querySelector('.vcp-turn-nav-card-user').textContent, '问四');

    // 分批渲染历史时更早的消息插在最前面
    const older = doc.createDocumentFragment();
    for (const [role, text, id] of [['user', '问一', 'u-1'], ['assistant', '答一', 'a-1'], ['user', '问二', 'u-2'], ['assistant', '答二', 'a-2']]) {
        const item = doc.createElement('div');
        item.className = `message-item ${role}`;
        item.dataset.messageId = id;
        item.innerHTML = `<div class="md-content">${text}</div>`;
        older.appendChild(item);
    }
    root.prepend(older);
    place();
    navigator.refresh();

    const after = [...nav.querySelectorAll('.vcp-turn-nav-item')];
    assert.equal(after.length, 4);
    assert.equal(after[2], before[0], 'existing bars are moved, not rebuilt');
    assert.equal(after[3], before[1]);
    assert.deepEqual(after.map(button => button.dataset.turnKey), ['u-1', 'u-2', 'u0', 'u1']);
    assert.equal(after[3].getAttribute('aria-label'), '跳转到第 4 条提问');
    assert.equal(after[3].getAttribute('aria-setsize'), '4');
    assert.equal(card.hidden, false);
    assert.equal(card.querySelector('.vcp-turn-nav-card-user').textContent, '问四');
    assert.equal(after[3].dataset.visualScale, '3.9', 'the hovered bar stays the peak');

    after[0].click();
    await wait(60);
    assert.equal(after[0].dataset.active, 'true');

    navigator.dispose();
    dom.window.close();
});
