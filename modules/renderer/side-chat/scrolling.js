/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

const ANCHOR_WAIT_MS = 2000;

export function createSideChatScrolling({
    store,
    doc,
    root
}) {
    const disposeCleanups = [];
    let stickToBottom = true;

    let lastScrollTop = 0;
    // 休眠后重新挂载时停在原来离底部的距离：历史先渲染最新几条，较早的分批插到上面，
    // 按距离底部而不是 scrollTop 定位才不会跳。用户自己一滚就放开
    let anchorFromBottom = null;
    let anchoredTop = null;
    // 最近一次可见时的位置：离底部的距离，和顶上第一条看得见的消息及它离容器顶部的偏移。
    // 休眠总发生在标签隐藏之后，那时容器 display:none，尺寸和 scrollTop 都读成 0，只能用隐藏前记下的值
    let visibleFromBottom = null;
    let visibleAnchor = null;
    // 重挂时按消息定位：没见过的消息高度是估的，光按离底部的距离会偏几十条。
    // 那条消息挂上之前列表先不显示，免得看着它随分批插入一路滚过去
    let anchorMessage = null;
    let anchorTimer = null;
    const win = doc?.defaultView || globalThis;
    const messageItems = () => [...root.children].filter(el => el.dataset?.messageId);
    function firstVisibleMessage() {
        const items = messageItems();
        const top = root.getBoundingClientRect().top;
        let lo = 0, hi = items.length - 1, found = null;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (items[mid].getBoundingClientRect().bottom > top) { found = items[mid]; hi = mid - 1; } else lo = mid + 1;
        }
        return found ? { id: found.dataset.messageId, offset: found.getBoundingClientRect().top - top } : null;
    }
    const rememberPosition = () => {
        if (!root || root.clientHeight === 0) return;
        visibleFromBottom = Math.max(0, root.scrollHeight - root.scrollTop);
        visibleAnchor = stickToBottom ? null : firstVisibleMessage();
    };
    function reveal() {
        if (anchorTimer !== null) win.clearTimeout(anchorTimer);
        anchorTimer = null;
        anchorMessage = null;
        if (root) root.style.visibility = '';
    }
    function placeAnchorMessage() {
        const el = [...root.children].find(item => item.dataset?.messageId === anchorMessage.id);
        if (!el) return false;
        root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - anchorMessage.offset;
        anchorFromBottom = root.scrollHeight - root.scrollTop;
        if (anchorTimer !== null) win.clearTimeout(anchorTimer);
        anchorTimer = null;
        root.style.visibility = '';
        return true;
    }

    function pinToBottomIfSticky() {
        if (store.isDisposed || !root || root.clientHeight === 0) return;
        if (anchorMessage && placeAnchorMessage()) {
            anchoredTop = root.scrollTop;
            lastScrollTop = root.scrollTop;
        } else if (anchorFromBottom !== null) {
            root.scrollTop = Math.max(0, root.scrollHeight - anchorFromBottom);
            anchoredTop = root.scrollTop;
            lastScrollTop = root.scrollTop;
        } else if (stickToBottom) {
            root.scrollTop = root.scrollHeight;
        }
        rememberPosition();
    }

    if (root) {
        const onRootScroll = () => {
            if (root.clientHeight === 0) return;
            rememberPosition();
            if (anchorFromBottom !== null) {
                if (Math.abs(root.scrollTop - anchoredTop) <= 1) return;
                anchorFromBottom = null;
                if (anchorMessage) reveal();
            }
            const distance = root.scrollHeight - root.scrollTop - root.clientHeight;
            const movedUp = root.scrollTop < lastScrollTop - 1;
            // 真正到底（含内容变短被夹回底部）才无条件贴底；往上滚哪怕只滚了一格也算离开，
            // 往下滚回接近底部才恢复。内容增长引起的滚动事件不改变贴底状态
            if (distance < 2) stickToBottom = true;
            else if (movedUp) stickToBottom = false;
            else if (distance < 48 && root.scrollTop > lastScrollTop + 1) stickToBottom = true;
            lastScrollTop = root.scrollTop;
            lastVisible = measure();
        };
        // 用户意图先于 scroll 事件生效：流式期间 ResizeObserver 可能在滚轮产生的 scroll 事件之前
        // 把视图拽回底部，只靠 scroll 判断就会和滚轮打架（ZCode use-stick-to-bottom 同样监听 wheel 立即脱离）
        const escape = () => {
            anchorFromBottom = null;
            if (anchorMessage) reveal();
            if (root.scrollHeight > root.clientHeight) stickToBottom = false;
        };
        const onWheel = (event) => { anchorFromBottom = null; if (anchorMessage) reveal(); if (event.deltaY < 0) escape(); };
        const onKeyDown = (event) => {
            if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) { anchorFromBottom = null; if (anchorMessage) reveal(); }
            if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && !event.target?.closest?.('textarea, input, [contenteditable="true"]')) escape();
        };
        let touchY = null;
        const onTouchStart = (event) => { touchY = event.touches?.[0]?.clientY ?? null; };
        const onTouchMove = (event) => {
            const y = event.touches?.[0]?.clientY;
            anchorFromBottom = null;
            if (anchorMessage) reveal();
            if (touchY !== null && y > touchY + 2) escape(); // 手指下拉 = 内容往上翻
            touchY = y ?? touchY;
        };
        root.addEventListener('scroll', onRootScroll, { passive: true });
        root.addEventListener('wheel', onWheel, { passive: true });
        root.addEventListener('keydown', onKeyDown);
        root.addEventListener('touchstart', onTouchStart, { passive: true });
        root.addEventListener('touchmove', onTouchMove, { passive: true });
        disposeCleanups.push(() => {
            root.removeEventListener('scroll', onRootScroll);
            root.removeEventListener('wheel', onWheel);
            root.removeEventListener('keydown', onKeyDown);
            root.removeEventListener('touchstart', onTouchStart);
            root.removeEventListener('touchmove', onTouchMove);
        });
        const ResizeObserverClass = doc.defaultView?.ResizeObserver || globalThis.ResizeObserver;
        if (ResizeObserverClass) {
            const rootResizeObserver = new ResizeObserverClass(pinToBottomIfSticky);
            rootResizeObserver.observe(root);
            // 也盯着每条消息的高度：流式结束后的整段重排、代码高亮、图片加载都会在最后一次贴底之后
            // 再长高，只看容器尺寸会停在离底部几十像素的地方（ZCode 的 use-stick-to-bottom 同样观察内容尺寸）
            const observeChild = node => { if (node.nodeType === 1) rootResizeObserver.observe(node); };
            root.childNodes.forEach(observeChild);
            const MutationObserverClass = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
            const childObserver = MutationObserverClass ? new MutationObserverClass(records => {
                for (const record of records) {
                    record.addedNodes.forEach(observeChild);
                    record.removedNodes.forEach(node => { if (node.nodeType === 1) rootResizeObserver.unobserve(node); });
                }
            }) : null;
            childObserver?.observe(root, { childList: true });
            disposeCleanups.push(() => {
                childObserver?.disconnect();
                rootResizeObserver.disconnect();
            });
        }
    }

    /** 休眠前存下：贴底的只记贴底，否则记离底部的距离。 */
    function capture() {
        if (!root || stickToBottom) return { stick: true };
        rememberPosition();
        if (visibleFromBottom === null) return { stick: true };
        return visibleAnchor
            ? { stick: false, fromBottom: visibleFromBottom, anchor: { ...visibleAnchor } }
            : { stick: false, fromBottom: visibleFromBottom };
    }

    function capture() {
        if (!root) return { stick: true };
        return root.clientHeight > 0 ? measure() : lastVisible;
    }

    function restore(saved) {
        if (saved?.stick !== false || !Number.isFinite(saved.fromBottom)) return;
        stickToBottom = false;
        anchorFromBottom = saved.fromBottom;
        if (root && typeof saved.anchor?.id === 'string' && Number.isFinite(saved.anchor.offset)) {
            anchorMessage = { id: saved.anchor.id, offset: saved.anchor.offset };
            root.style.visibility = 'hidden';
            // 那条消息被删了或迟迟没挂上：退回按距离定位，列表照常显示
            anchorTimer = win.setTimeout(() => { anchorTimer = null; reveal(); pinToBottomIfSticky(); }, ANCHOR_WAIT_MS);
        }
        pinToBottomIfSticky();
    }

    return Object.freeze({ pinToBottomIfSticky, isSticky: () => stickToBottom, capture, restore, resume() { stickToBottom = true; anchorFromBottom = null; if (anchorMessage) reveal(); }, dispose() { if (anchorTimer !== null) win.clearTimeout(anchorTimer); anchorTimer = null; disposeCleanups.splice(0).forEach(fn => { try { fn(); } catch {} }); } });
}
