/**
 * modules/ui-system/conversation-turn-navigator.js
 * 主聊天左侧的「按提问快速定位」导轨：每条用户提问一根短横条，悬停的那根像山峰一样放大，
 * 悬停卡片里是这条提问和助手回答的开头，点击滚动到对应位置（近处平滑滚动，远处直接到位）。
 *
 * 结构、交互和数值对照 ZCode 的 ConversationTurnNavigator / conversationTurnNavigatorHelpers
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4），
 * 由 React + Tailwind 改写为原生 DOM + styles/ui-system/turn-navigator.css。
 * ZCode 的数据来自虚拟列表的 render unit；这里直接观察主聊天的消息 DOM：
 * 每个 .message-item.user 是一个导航项，它到下一条用户消息之间的助手消息提供回答摘要。
 */

'use strict';

import { bindChatNavigationIdle } from './chat-navigation-idle.js';


export const TURN_NAVIGATOR_MIN_WIDTH_PX = 400; // 左侧导轨仅占 48px，通知栏展开后仍可使用；只在极窄聊天区隐藏
const DEFAULT_MAX_PREVIEW_CHARS = 220;
const DEFAULT_MAX_PREVIEW_PARAGRAPHS = 2;
const HOVER_OPEN_DELAY_MS = 120;
const HOVER_CLOSE_DELAY_MS = 80;
const REFRESH_DEBOUNCE_MS = 150;
const JUMP_TOP_MARGIN_PX = 12;
const JUMP_RELEASE_FOLLOW_MIN_PX = 80;
const JUMP_SMOOTH_MAX_VIEWPORTS = 1.5; // 更远的跳转直接到位：平滑滚过上万像素的长回答会逐条渲染、卡顿，目标也会过期
const JUMP_HOLD_MS = 1200; // 落地后这么久内目标被挤走就拉回来
const JUMP_SMOOTH_STILL_FRAMES = 3; // 平滑滚动连续这么多帧没动才算结束（第一帧它可能还没起步）
const USER_FALLBACK_PREVIEW = '（没有文字内容）';
const ASSISTANT_EMPTY_PREVIEW = '还没有回答';
const ASSISTANT_RUNNING_PREVIEW = '正在回答…';

// ------------------------------------------------------------------ pure helpers

function normalizePreviewParagraphs(text, maxParagraphs) {
    return String(text || '')
        .trim()
        .split(/\n\s*\n/u)
        .map(paragraph => paragraph.replace(/\s+/gu, ' ').trim())
        .filter(Boolean)
        .slice(0, Math.max(1, maxParagraphs));
}

function truncatePreview(text, maxChars) {
    const limit = Math.max(8, maxChars);
    if (text.length <= limit) return text;
    return `${text.slice(0, limit - 3).trimEnd()}...`;
}

export function buildPreviewText(texts, fallback, {
    maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs = DEFAULT_MAX_PREVIEW_PARAGRAPHS
} = {}) {
    const paragraphs = normalizePreviewParagraphs(texts.join('\n\n'), maxPreviewParagraphs);
    if (paragraphs.length === 0) return fallback;
    return truncatePreview(paragraphs.join('\n'), maxPreviewChars);
}

/**
 * entries: [{ id, userText, assistantTexts: string[], running }]，按出现顺序。
 * 没有用户提问就没有导航项；助手摘要取该提问到下一条提问之间的文字。
 */
export function buildTurnNavigatorItems(entries, options = {}) {
    return (entries || []).map((entry, index) => buildTurnNavigatorItem(entry, index, options));
}

export function buildTurnNavigatorItem(entry, index, options = {}) {
    const assistantTexts = (entry.assistantTexts || []).filter(text => String(text || '').trim());
    let assistantPreview;
    let assistantPreviewKind;
    if (assistantTexts.length > 0) {
        assistantPreview = buildPreviewText(assistantTexts, ASSISTANT_EMPTY_PREVIEW, options);
        assistantPreviewKind = 'text';
    } else if (entry.running) {
        assistantPreview = ASSISTANT_RUNNING_PREVIEW;
        assistantPreviewKind = 'running';
    } else {
        assistantPreview = ASSISTANT_EMPTY_PREVIEW;
        assistantPreviewKind = 'empty';
    }
    return {
        key: String(entry.id ?? index),
        index,
        userPreview: buildPreviewText([entry.userText || ''], USER_FALLBACK_PREVIEW, options),
        assistantPreview,
        assistantPreviewKind,
        isRunning: Boolean(entry.running)
    };
}

function finiteNonNegative(value) {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * positions: [{ key, start, end }]（相对滚动容器内容的像素）。
 * 视口里可见的提问中取离视口顶部最近的；一个都看不见就取视口上方最近的一条，再不行取下方第一条。
 */
export function resolveActiveTurnKey({ positions, scrollOffsetPx, viewportHeightPx }) {
    if (!positions?.length) return undefined;
    const viewportStart = finiteNonNegative(scrollOffsetPx);
    const viewportEnd = viewportStart + Math.max(1, finiteNonNegative(viewportHeightPx));
    const normalized = positions
        .map(position => {
            const start = finiteNonNegative(position.start);
            return { key: position.key, start, end: Math.max(start, finiteNonNegative(position.end)) };
        })
        .sort((left, right) => left.start - right.start);

    const visible = normalized.filter(position => position.end >= viewportStart && position.start <= viewportEnd);
    if (visible.length > 0) {
        return visible.reduce((nearest, candidate) =>
            Math.abs(candidate.start - viewportStart) < Math.abs(nearest.start - viewportStart) ? candidate : nearest).key;
    }
    const above = normalized.filter(position => position.start <= viewportStart);
    return above.length ? above[above.length - 1].key : normalized.find(position => position.start > viewportStart)?.key;
}

/**
 * resolveActiveTurnKey 的长话题版本：提问在 DOM 里按顺序排列、互不重叠，起点单调递增，
 * 所以二分查找视口顶部附近的两条就够了，measure(index) 只会被调用 O(log n) 次（上千条提问时每帧不必量遍全部）。
 * 返回导航项下标，没有提问时为 -1。
 */
export function resolveActiveTurnIndex({ count, measure, scrollOffsetPx, viewportHeightPx }) {
    if (!(count > 0)) return -1;
    const viewportStart = finiteNonNegative(scrollOffsetPx);
    const viewportEnd = viewportStart + Math.max(1, finiteNonNegative(viewportHeightPx));
    const read = (index) => {
        const position = measure(index) || {};
        const start = finiteNonNegative(position.start);
        return { start, end: Math.max(start, finiteNonNegative(position.end)) };
    };
    let low = 0;
    let high = count; // 找第一条起点在视口顶部之下的提问
    while (low < high) {
        const middle = (low + high) >> 1;
        if (read(middle).start > viewportStart) high = middle;
        else low = middle + 1;
    }
    const above = low - 1;
    const aboveVisible = above >= 0 && read(above).end >= viewportStart;
    const belowVisible = low < count && read(low).start <= viewportEnd;
    if (aboveVisible && belowVisible) {
        return read(low).start - viewportStart < viewportStart - read(above).start ? low : above;
    }
    if (aboveVisible) return above;
    if (belowVisible) return low;
    return above >= 0 ? above : low;
}

/** 悬停/聚焦的那根放大成「山峰」，左右邻居依次递减。 */
export function resolveBarVisualState({ itemIndex, visualFocusItemIndex }) {
    if (visualFocusItemIndex === undefined) return { colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' };
    const distance = Math.abs(itemIndex - visualFocusItemIndex);
    // 横条平时 8px 宽（ZCode 是 12px）；放大后的长度仍同 ZCode：约 31 / 20 / 15px
    if (distance === 0) return { colorTone: 'focus', opacity: 1, scaleX: 3.9, tone: 'peak' };
    if (distance === 1) return { colorTone: 'muted', opacity: 0.86, scaleX: 2.55, tone: 'near' };
    if (distance === 2) return { colorTone: 'muted', opacity: 0.72, scaleX: 1.875, tone: 'mid' };
    return { colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' };
}

// ------------------------------------------------------------------ DOM reading

function readMessageText(messageItem) {
    const content = messageItem.querySelector('.md-content');
    if (!content) return '';
    const clone = content.cloneNode(true);
    clone.querySelectorAll('.thinking-indicator, style, script, .vcp-tool-use-bubble, details').forEach(node => node.remove());
    return clone.textContent || '';
}

/**
 * 把消息列表读成 buildTurnNavigatorItems 需要的 entries。
 * textCache（WeakMap）+ dirty（WeakSet，不留住已经移出列表的消息）让没有变化的消息不必每次都克隆一遍 DOM：
 * 只有被标记为 dirty 的消息才会重新读取文字。
 */
export function collectTurnEntries(messagesRoot, { textCache = null, dirty = null } = {}) {
    const textOf = (element) => {
        if (!textCache) return readMessageText(element);
        if (!dirty?.has(element) && textCache.has(element)) return textCache.get(element);
        const text = readMessageText(element);
        textCache.set(element, text);
        dirty?.delete(element);
        return text;
    };
    const entries = [];
    let current = null;
    for (const child of Array.from(messagesRoot?.children || [])) {
        if (!child.classList?.contains('message-item')) continue;
        if (child.classList.contains('user')) {
            current = {
                id: child.dataset.messageId || `idx-${entries.length}`,
                element: child,
                userText: textOf(child),
                assistantTexts: [],
                running: false
            };
            entries.push(current);
        } else if (child.classList.contains('assistant') && current) {
            current.assistantTexts.push(textOf(child));
            if (child.classList.contains('streaming')) current.running = true;
        }
    }
    return entries;
}

// ------------------------------------------------------------------ controller

export function createConversationTurnNavigator({
    document: doc = document,
    messagesRoot = null,
    scrollRoot = null,
    minWidthPx = TURN_NAVIGATOR_MIN_WIDTH_PX,
    releaseFollow = null // 主聊天传 uiHelperFunctions.releaseChatScrollFollow
} = {}) {
    const win = doc.defaultView;
    const cleanups = [];
    let disposed = false;
    let mounted = false;
    let nav = null;
    let idleControl = null;
    let railScroll = null;
    let railInner = null;
    let card = null;
    let cardUser = null;
    let cardAssistant = null;
    let messages = messagesRoot;
    let scroller = scrollRoot;
    let entries = [];
    let items = [];
    let signature = '';
    let buttons = [];
    let buttonsByKey = new Map();
    let itemCache = new Map(); // 导航项 key → { entry, item }：文字没变就不重算摘要
    const appliedVisuals = new WeakMap();
    let activeKey;
    let interactionIndex;
    let cardIndex = -1;
    let openTimer = null;
    let closeTimer = null;
    let refreshTimer = null;
    let jumpHold = null;
    let frame = null;
    let reducedMotion = false;
    const textCache = new WeakMap();
    const dirty = new WeakSet();

    const h = (tag, className) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        return node;
    };

    function activeIndex() {
        return items.findIndex(item => item.key === activeKey);
    }

    // 上千根时只改真正变了的那几根，悬停移动不必每次重写全部样式
    function applyVisuals() {
        const active = activeIndex();
        buttons.forEach((button, index) => {
            const item = items[index];
            const state = resolveBarVisualState({ itemIndex: index, visualFocusItemIndex: interactionIndex });
            const scrollActive = interactionIndex === undefined && index === active;
            const applied = `${state.tone}|${scrollActive}|${index === active}|${item.isRunning}`;
            if (appliedVisuals.get(button) === applied) return;
            appliedVisuals.set(button, applied);
            const bar = button.firstChild;
            bar.style.opacity = String(scrollActive ? 0.9 : item.isRunning ? Math.max(state.opacity, 0.72) : state.opacity);
            bar.style.transform = `scaleX(${state.scaleX})`;
            bar.classList.toggle('is-strong', state.colorTone === 'focus' || scrollActive);
            button.dataset.visualTone = state.tone;
            button.dataset.visualScale = String(state.scaleX);
            button.dataset.active = index === active ? 'true' : 'false';
            button.dataset.running = item.isRunning ? 'true' : 'false';
            if (index === active) button.setAttribute('aria-current', 'location');
            else button.removeAttribute('aria-current');
        });
    }

    function setInteraction(index) {
        interactionIndex = index;
        applyVisuals();
    }

    // -------------------------------------------------------------- hover card

    function showCard(index) {
        const item = items[index];
        const button = buttons[index];
        if (!item || !button) return;
        cardIndex = index;
        cardUser.textContent = item.userPreview;
        cardAssistant.textContent = item.assistantPreview;
        cardAssistant.classList.toggle('is-muted', item.assistantPreviewKind !== 'text');
        const navRect = nav.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        card.style.top = `${Math.round(buttonRect.top - navRect.top + buttonRect.height / 2)}px`;
        card.hidden = false;
        card.dataset.key = item.key;
    }

    function hideCard() {
        cardIndex = -1;
        card.hidden = true;
    }

    function scheduleCard(index) {
        win.clearTimeout(closeTimer);
        closeTimer = null;
        if (!card.hidden) { // 已经开着：直接换成这一条，不再等待
            win.clearTimeout(openTimer);
            showCard(index);
            return;
        }
        win.clearTimeout(openTimer);
        openTimer = win.setTimeout(() => showCard(index), HOVER_OPEN_DELAY_MS);
    }

    function scheduleHideCard() {
        win.clearTimeout(openTimer);
        openTimer = null;
        win.clearTimeout(closeTimer);
        closeTimer = win.setTimeout(hideCard, HOVER_CLOSE_DELAY_MS);
    }

    // -------------------------------------------------------------- rendering

    function createButton(key) {
        const button = h('button', 'vcp-turn-nav-item');
        button.type = 'button';
        button.dataset.turnKey = key;
        button.appendChild(h('span', 'vcp-turn-nav-bar'));
        // 加载更早的消息时下标会整体后移，所以事件触发时再读当前下标
        const indexOf = () => Number(button.dataset.itemIndex);
        button.addEventListener('pointerenter', () => { setInteraction(indexOf()); scheduleCard(indexOf()); });
        button.addEventListener('pointerleave', () => { setInteraction(undefined); scheduleHideCard(); });
        button.addEventListener('focus', () => { setInteraction(indexOf()); scheduleCard(indexOf()); });
        button.addEventListener('blur', () => { setInteraction(undefined); scheduleHideCard(); });
        button.addEventListener('click', () => jumpTo(indexOf(), reducedMotion ? 'auto' : 'smooth'));
        return button;
    }

    // 按 key 复用已有的横条，只增删变化的部分：长话题分批加载时不必每批重建上千个按钮
    function syncButtons() {
        const nextByKey = new Map();
        const setSize = String(items.length);
        buttons = items.map((item, index) => {
            const button = buttonsByKey.get(item.key) || createButton(item.key);
            nextByKey.set(item.key, button);
            if (button.dataset.itemIndex !== String(index)) {
                button.dataset.itemIndex = String(index);
                button.setAttribute('aria-label', `跳转到第 ${index + 1} 条提问`);
                button.setAttribute('aria-posinset', String(index + 1));
            }
            if (button.getAttribute('aria-setsize') !== setSize) button.setAttribute('aria-setsize', setSize);
            return button;
        });
        buttonsByKey.forEach((button, key) => { if (!nextByKey.has(key)) button.remove(); });
        buttonsByKey = nextByKey;
        let cursor = railInner.firstChild;
        for (const button of buttons) {
            if (button === cursor) cursor = cursor.nextSibling;
            else railInner.insertBefore(button, cursor);
        }
        nav.dataset.itemCount = setSize;
    }

    function buildItems(nextEntries) {
        const nextCache = new Map();
        const built = nextEntries.map((entry, index) => {
            const key = String(entry.id ?? index);
            const cached = itemCache.get(key)?.entry;
            const same = cached
                && cached.userText === entry.userText
                && cached.running === entry.running
                && cached.assistantTexts.length === entry.assistantTexts.length
                && cached.assistantTexts.every((text, i) => text === entry.assistantTexts[i]);
            const item = same ? { ...itemCache.get(key).item, index } : buildTurnNavigatorItem(entry, index);
            nextCache.set(key, { entry, item });
            return item;
        });
        itemCache = nextCache;
        return built;
    }

    function revealActiveBar() {
        const index = activeIndex();
        const button = buttons[index];
        if (!button || !railScroll.clientHeight) return;
        const top = button.offsetTop;
        const bottom = top + button.offsetHeight;
        if (top < railScroll.scrollTop) railScroll.scrollTop = top;
        else if (bottom > railScroll.scrollTop + railScroll.clientHeight) railScroll.scrollTop = bottom - railScroll.clientHeight;
    }

    // 输入区叠放在滚动区底部时（chat-composer-inset.js），底部留白那段被输入区挡住，不算可视区
    function visibleHeight() {
        const inset = parseFloat(win.getComputedStyle(scroller).paddingBottom) || 0;
        return Math.max(0, scroller.clientHeight - inset);
    }

    function measureOverlay() {
        if (!nav || !scroller) return;
        nav.style.top = `${scroller.offsetTop}px`;
        nav.style.height = `${visibleHeight()}px`;
        nav.style.setProperty('--vcp-turn-nav-card-max-width', `${Math.max(0, scroller.clientWidth - 64)}px`);
        const wide = scroller.clientWidth >= minWidthPx;
        nav.classList.toggle('is-wide', wide);
        if (!wide) hideCard();
    }

    function updateActive() {
        frame = null;
        if (disposed || !scroller) return;
        const scrollerTop = scroller.getBoundingClientRect().top;
        const scrollTop = scroller.scrollTop;
        const measured = new Map();
        const index = resolveActiveTurnIndex({
            count: entries.length,
            measure: (i) => {
                if (!measured.has(i)) {
                    const rect = entries[i].element.getBoundingClientRect();
                    const start = rect.top - scrollerTop + scrollTop;
                    measured.set(i, { start, end: start + rect.height });
                }
                return measured.get(i);
            },
            scrollOffsetPx: scrollTop,
            viewportHeightPx: visibleHeight()
        });
        const next = items[index]?.key;
        if (next === activeKey) return;
        activeKey = next;
        applyVisuals();
        revealActiveBar();
    }

    function scheduleActiveUpdate() {
        if (frame !== null || disposed) return;
        frame = win.requestAnimationFrame(updateActive);
    }

    function refresh() {
        refreshTimer = null;
        if (disposed || !mounted) return;
        const cardKey = items[cardIndex]?.key;
        const interactionKey = items[interactionIndex]?.key;
        entries = collectTurnEntries(messages, { textCache, dirty });
        items = buildItems(entries);
        const nextSignature = items.map(item => item.key).join('|');
        const show = items.length >= 2;
        nav.hidden = !show;
        idleControl?.refresh();
        if (!show) {
            signature = '';
            buttons = [];
            buttonsByKey = new Map();
            railInner.textContent = '';
            interactionIndex = undefined;
            hideCard();
            return;
        }
        if (nextSignature !== signature) {
            signature = nextSignature;
            syncButtons();
            if (!items.some(item => item.key === activeKey)) activeKey = undefined;
            if (interactionKey !== undefined) {
                const index = items.findIndex(item => item.key === interactionKey);
                interactionIndex = index >= 0 ? index : undefined;
            }
        }
        // 流式回答时悬停卡片里的摘要跟着更新；前面插入了更早的消息时按 key 找回原来那条
        const nextCardIndex = cardKey === undefined ? -1 : items.findIndex(item => item.key === cardKey);
        if (nextCardIndex >= 0) showCard(nextCardIndex);
        else if (cardIndex >= 0) hideCard();
        measureOverlay();
        applyVisuals();
        updateActive();
    }

    function markDirty(records) {
        for (const record of records) {
            const node = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
            const item = node?.closest?.('.message-item');
            if (item) dirty.add(item);
        }
    }

    function onMutations(records) {
        markDirty(records);
        scheduleRefresh();
    }

    function scheduleRefresh() {
        if (disposed || refreshTimer !== null) return;
        refreshTimer = win.setTimeout(refresh, REFRESH_DEBOUNCE_MS);
    }

    function jumpTargetTop(entry) {
        const scrollerTop = scroller.getBoundingClientRect().top;
        return Math.max(0, entry.element.getBoundingClientRect().top - scrollerTop + scroller.scrollTop - JUMP_TOP_MARGIN_PX);
    }

    function stopJumpHold() {
        if (!jumpHold) return;
        win.cancelAnimationFrame(jumpHold.frame);
        jumpHold = null;
    }

    // 把正在守位的提问拉回目标位置；越过动画以后才做，避免打断平滑滚动
    function holdJumpTarget() {
        const hold = jumpHold;
        if (!hold || hold.smoothing) return;
        if (disposed || !hold.entry.element.isConnected) { stopJumpHold(); return; }
        // 夹到可滚动范围内，否则贴底时每帧都在写一个无效值、守位永远不结束
        const want = Math.min(jumpTargetTop(hold.entry), Math.max(0, scroller.scrollHeight - scroller.clientHeight));
        if (Math.abs(want - scroller.scrollTop) < 1) return;
        scroller.scrollTop = want;
        hold.until = win.performance.now() + JUMP_HOLD_MS; // 还在变就继续守
    }

    /**
     * 长话题里（content-visibility: auto）屏幕外的消息进入视口才渲染出真实高度，一次算出的目标位置会过期；
     * 聊天区的「粘底跟随」也会把跳转拽回底部（见 ui-helpers.js 的 releaseChatScrollFollow）。
     * 所以：远处直接跳到位、近处才平滑滚动（ZCode 的 scrollToQuery 也是这样分的）；
     * 落地后消息列表每次变高都在绘制前把这条提问拉回原位（目标上方紧挨着的长回答渲染出来会把它往下挤，
     * 浏览器的滚动锚定管不到），直到稳定一段时间或用户自己滚动。
     */
    function jumpTo(index, behavior) {
        const entry = entries[index];
        if (!entry?.element || !scroller) return;
        stopJumpHold();
        const top = jumpTargetTop(entry);
        const maxTop = scroller.scrollHeight - scroller.clientHeight;
        const released = maxTop - top > JUMP_RELEASE_FOLLOW_MIN_PX;
        if (released) releaseFollow?.();
        const smooth = behavior === 'smooth'
            && Math.abs(top - scroller.scrollTop) <= scroller.clientHeight * JUMP_SMOOTH_MAX_VIEWPORTS;
        scroller.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
        if (!released) return; // 落在底部附近的交给粘底跟随，两边不能抢

        // until 从第一帧算起：跳过去后渲染长回答的那一帧本身可能就超过一秒
        const hold = { entry, frame: null, smoothing: smooth, still: 0, lastTop: scroller.scrollTop, until: null };
        const tick = () => {
            if (jumpHold !== hold) return;
            const now = win.performance.now();
            if (hold.until === null) hold.until = now + JUMP_HOLD_MS;
            if (now > hold.until) { jumpHold = null; return; }
            if (hold.smoothing) {
                // 平滑动画还在走就不打断，停下来再开始守位
                const current = scroller.scrollTop;
                hold.still = current === hold.lastTop ? hold.still + 1 : 0;
                hold.lastTop = current;
                if (hold.still >= JUMP_SMOOTH_STILL_FRAMES) hold.smoothing = false;
                hold.until = now + JUMP_HOLD_MS;
            }
            holdJumpTarget();
            if (jumpHold === hold) hold.frame = win.requestAnimationFrame(tick);
        };
        jumpHold = hold;
        hold.frame = win.requestAnimationFrame(tick);
    }

    // -------------------------------------------------------------- lifecycle

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
    }

    function mount() {
        if (mounted || disposed) return nav;
        messages = messages || doc.getElementById('chatMessages');
        scroller = scroller || messages?.closest('.chat-messages-container') || null;
        const host = scroller?.parentElement;
        if (!messages || !scroller || !host) return null;
        if (win.getComputedStyle(host).position === 'static') host.style.position = 'relative';

        nav = h('nav', 'vcp-turn-nav vcp-ui-scope'); // 挂在 <main> 下，自身带作用域类才能命中 ui-system 样式
        nav.setAttribute('aria-label', '提问目录');
        nav.hidden = true;
        railScroll = h('div', 'vcp-turn-nav-scroll');
        railInner = h('div', 'vcp-turn-nav-inner');
        railScroll.appendChild(railInner);
        card = h('div', 'vcp-turn-nav-card');
        card.hidden = true;
        card.setAttribute('role', 'tooltip');
        cardUser = h('p', 'vcp-turn-nav-card-user');
        cardAssistant = h('p', 'vcp-turn-nav-card-assistant');
        card.append(cardUser, cardAssistant);
        nav.append(railScroll, card);
        host.appendChild(nav);
        mounted = true;
        idleControl = bindChatNavigationIdle({ element: nav, scroller });
        cleanups.push(() => { idleControl.dispose(); idleControl = null; });

        on(railScroll, 'pointerleave', () => setInteraction(undefined));
        on(railScroll, 'scroll', () => { setInteraction(undefined); hideCard(); });
        on(scroller, 'scroll', scheduleActiveUpdate, { passive: true });
        // 用户自己滚动、按键或点了别处（回到底部、发送）就不再守位
        on(scroller, 'wheel', stopJumpHold, { passive: true });
        on(scroller, 'touchstart', stopJumpHold, { passive: true });
        on(doc, 'pointerdown', stopJumpHold, { capture: true, passive: true });
        on(doc, 'keydown', stopJumpHold, { capture: true });
        on(card, 'pointerenter', () => { win.clearTimeout(closeTimer); closeTimer = null; });
        on(card, 'pointerleave', scheduleHideCard);

        if (typeof win.MutationObserver === 'function') {
            const observer = new win.MutationObserver(onMutations);
            observer.observe(messages, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
            cleanups.push(() => observer.disconnect());
        }
        if (typeof win.ResizeObserver === 'function') {
            const resizeObserver = new win.ResizeObserver(() => { measureOverlay(); scheduleActiveUpdate(); });
            resizeObserver.observe(scroller);
            cleanups.push(() => resizeObserver.disconnect());
            // ResizeObserver 在布局之后、绘制之前回调，在这里拉回不会先画出被挤走的那一帧
            const contentObserver = new win.ResizeObserver(holdJumpTarget);
            contentObserver.observe(messages);
            cleanups.push(() => contentObserver.disconnect());
        }
        if (typeof win.matchMedia === 'function') {
            const query = win.matchMedia('(prefers-reduced-motion: reduce)');
            const update = () => { reducedMotion = query.matches; };
            update();
            query.addEventListener?.('change', update);
            cleanups.push(() => query.removeEventListener?.('change', update));
        }

        refresh();
        return nav;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        win.clearTimeout(openTimer);
        win.clearTimeout(closeTimer);
        win.clearTimeout(refreshTimer);
        stopJumpHold();
        if (frame !== null) win.cancelAnimationFrame(frame);
        while (cleanups.length) cleanups.pop()();
        nav?.remove();
        nav = null;
    }

    return {
        mount,
        dispose,
        refresh: () => { win.clearTimeout(refreshTimer); refresh(); },
        jumpTo,
        getItems: () => items.slice()
    };
}
