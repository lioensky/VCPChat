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

    function pinToBottomIfSticky() {
        if (!store.isDisposed && stickToBottom && root && root.clientHeight > 0) {
            root.scrollTop = root.scrollHeight;
        }
    }

    if (root) {
        const onRootScroll = () => {
            if (root.clientHeight === 0) return;
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
        // 把视图拽回底部，只靠 scroll 判断就会和滚轮打架，所以滚轮一动就立即脱离
        const escape = () => {
            if (root.scrollHeight > root.clientHeight) stickToBottom = false;
        };
        const onWheel = (event) => { if (event.deltaY < 0) escape(); };
        const onKeyDown = (event) => {
            if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && !event.target?.closest?.('textarea, input, [contenteditable="true"]')) escape();
        };
        let touchY = null;
        const onTouchStart = (event) => { touchY = event.touches?.[0]?.clientY ?? null; };
        const onTouchMove = (event) => {
            const y = event.touches?.[0]?.clientY;
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
            // 再长高，只看容器尺寸会停在离底部几十像素的地方
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

    return Object.freeze({ pinToBottomIfSticky, isSticky: () => stickToBottom, resume() { stickToBottom = true; }, dispose() { disposeCleanups.splice(0).forEach(fn => { try { fn(); } catch {} }); } });
}
