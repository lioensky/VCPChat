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
            // 只有往上滚才算离开底部；内容增长、布局变化引起的滚动事件不改变贴底状态
            if (root.scrollHeight - root.scrollTop - root.clientHeight < 48) stickToBottom = true;
            else if (root.scrollTop < lastScrollTop - 1) stickToBottom = false;
            lastScrollTop = root.scrollTop;
        };
        root.addEventListener('scroll', onRootScroll, { passive: true });
        disposeCleanups.push(() => root.removeEventListener('scroll', onRootScroll));
        const ResizeObserverClass = doc.defaultView?.ResizeObserver || globalThis.ResizeObserver;
        if (ResizeObserverClass) {
            const rootResizeObserver = new ResizeObserverClass(pinToBottomIfSticky);
            rootResizeObserver.observe(root);
            disposeCleanups.push(() => rootResizeObserver.disconnect());
        }
    }

    return Object.freeze({ pinToBottomIfSticky, isSticky: () => stickToBottom, resume() { stickToBottom = true; }, dispose() { disposeCleanups.splice(0).forEach(fn => { try { fn(); } catch {} }); } });
}
