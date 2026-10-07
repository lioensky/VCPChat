/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

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

    function pinToBottomIfSticky() {
        if (store.isDisposed || !root || root.clientHeight === 0) return;
        if (anchorFromBottom !== null) {
            root.scrollTop = Math.max(0, root.scrollHeight - anchorFromBottom);
            anchoredTop = root.scrollTop;
            lastScrollTop = root.scrollTop;
        } else if (stickToBottom) {
            root.scrollTop = root.scrollHeight;
        }
    }

    if (root) {
        const onRootScroll = () => {
            if (root.clientHeight === 0) return;
            if (anchorFromBottom !== null) {
                if (Math.abs(root.scrollTop - anchoredTop) <= 1) return;
                anchorFromBottom = null;
            }
            const distance = root.scrollHeight - root.scrollTop - root.clientHeight;
            const movedUp = root.scrollTop < lastScrollTop - 1;
            // 真正到底（含内容变短被夹回底部）才无条件贴底；往上滚哪怕只滚了一格也算离开，
            // 往下滚回接近底部才恢复。内容增长引起的滚动事件不改变贴底状态
            if (distance < 2) stickToBottom = true;
            else if (movedUp) stickToBottom = false;
            else if (distance < 48 && root.scrollTop > lastScrollTop + 1) stickToBottom = true;
            lastScrollTop = root.scrollTop;
        };
        // 用户意图先于 scroll 事件生效：流式期间 ResizeObserver 可能在滚轮产生的 scroll 事件之前
        // 把视图拽回底部，只靠 scroll 判断就会和滚轮打架（ZCode use-stick-to-bottom 同样监听 wheel 立即脱离）
        const escape = () => {
            anchorFromBottom = null;
            if (root.scrollHeight > root.clientHeight) stickToBottom = false;
        };
        const onWheel = (event) => { anchorFromBottom = null; if (event.deltaY < 0) escape(); };
        const onKeyDown = (event) => {
            if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) anchorFromBottom = null;
            if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && !event.target?.closest?.('textarea, input, [contenteditable="true"]')) escape();
        };
        let touchY = null;
        const onTouchStart = (event) => { touchY = event.touches?.[0]?.clientY ?? null; };
        const onTouchMove = (event) => {
            const y = event.touches?.[0]?.clientY;
            anchorFromBottom = null;
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
        return { stick: false, fromBottom: Math.max(0, root.scrollHeight - root.scrollTop) };
    }

    function restore(saved) {
        if (saved?.stick !== false || !Number.isFinite(saved.fromBottom)) return;
        stickToBottom = false;
        anchorFromBottom = saved.fromBottom;
        pinToBottomIfSticky();
    }

    return Object.freeze({ pinToBottomIfSticky, isSticky: () => stickToBottom, capture, restore, resume() { stickToBottom = true; anchorFromBottom = null; }, dispose() { disposeCleanups.splice(0).forEach(fn => { try { fn(); } catch {} }); } });
}
