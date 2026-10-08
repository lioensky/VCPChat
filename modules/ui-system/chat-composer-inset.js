/**
 * modules/ui-system/chat-composer-inset.js
 * 让主聊天的滚动区一直延伸到窗口底部，输入区浮在它的底部之上（滚动条也随之到底）。
 *
 * 叠放布局参考 ZCode 的 composer dock（https://github.com/zai-org/ZCode ，Apache-2.0，
 * packages/ui/src/v4/ConversationTimeline.tsx）。气泡模式的底部淡出使用同级背景副本，
 * 不在消息祖先上加遮罩，避免阻断气泡的背景模糊采样。输入区的实时高度写成
 * <main> 上的 CSS 变量，由 styles/ui-system/chat-composer-inset.css 叠放和留白；
 * 脚本没有挂载时布局与原来完全一样。
 */

'use strict';

const OVERLAY_CLASS = 'vcp-chat-composer-overlay';
const INSET_VAR = '--vcp-chat-composer-inset';
const SCROLLBAR_VAR = '--vcp-chat-scrollbar-size';

export function createChatComposerInset({
    document: doc = document,
    uiHelper = null,
    root = null,
    scroller = null,
    dock = null
} = {}) {
    const cleanups = [];
    let mounted = false;
    let lastInset = -1;
    let lastScrollbar = -1;

    let fade = null;
    let backgroundPlanes = [];
    const win = doc.defaultView;

    function syncBackdrop() {
        if (!fade) return;
        const rootRect = root.getBoundingClientRect();
        for (const { source, plane } of backgroundPlanes) {
            const style = win.getComputedStyle(source);
            const rect = source === doc.body
                ? { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight }
                : source.getBoundingClientRect();
            Object.assign(plane.style, {
                left: `${rect.left - rootRect.left - (root.clientLeft || 0)}px`,
                top: `${rect.top - rootRect.top - (root.clientTop || 0)}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
                backgroundColor: style.backgroundColor,
                backgroundImage: style.backgroundImage,
                backgroundSize: style.backgroundSize,
                backgroundPosition: style.backgroundPosition,
                backgroundRepeat: style.backgroundRepeat,
                backgroundOrigin: style.backgroundOrigin,
                backgroundClip: style.backgroundClip,
                backgroundBlendMode: style.backgroundBlendMode,
                // 背景副本不滚动，使用原背景面的完整尺寸定位，避免 fixed 二次偏移。
                backgroundAttachment: 'scroll'
            });
        }
    }

    function sync() {
        syncBackdrop();
        const inset = Math.ceil(dock.getBoundingClientRect().height);
        const scrollbar = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
        if (scrollbar !== lastScrollbar) {
            lastScrollbar = scrollbar;
            root.style.setProperty(SCROLLBAR_VAR, `${scrollbar}px`);
        }
        if (inset === lastInset) return;
        // 输入框变高时留白跟着变，原本贴底的视图要继续贴底，否则最后一条会被盖住
        const following = uiHelper?.captureChatScrollFollow?.().followBottom === true;
        lastInset = inset;
        root.style.setProperty(INSET_VAR, `${inset}px`);
        if (following) uiHelper.scrollToBottom?.({ force: true, immediate: true });
    }

    function mount() {
        if (mounted) return true;
        root = root || doc.querySelector('main.main-content');
        scroller = scroller || root?.querySelector(':scope > .chat-messages-container');
        dock = dock || root?.querySelector(':scope > .chat-input-area');
        const ResizeObserverCtor = doc.defaultView?.ResizeObserver;
        if (!root || !scroller || !dock || typeof ResizeObserverCtor !== 'function') return false;

        mounted = true;
        root.classList.add(OVERLAY_CLASS);
        // 副本是消息容器的同级节点，不成为任何气泡的 backdrop root。
        fade = doc.createElement('div');
        fade.className = 'vcp-chat-composer-backdrop-fade vcp-ui-scope';
        fade.setAttribute('aria-hidden', 'true');
        const sources = [];
        for (let source = root; source; source = source.parentElement) {
            sources.unshift(source);
            if (source === doc.body) break;
        }
        backgroundPlanes = sources.map(source => {
            const plane = doc.createElement('div');
            plane.className = 'vcp-chat-composer-backdrop-plane';
            fade.appendChild(plane);
            return { source, plane };
        });
        root.insertBefore(fade, dock);
        sync();
        win.addEventListener('resize', syncBackdrop);
        doc.addEventListener('load', syncBackdrop, true);
        cleanups.push(() => win.removeEventListener('resize', syncBackdrop));
        cleanups.push(() => doc.removeEventListener('load', syncBackdrop, true));
        const MutationObserverCtor = win.MutationObserver;
        if (typeof MutationObserverCtor === 'function') {
            const appearanceObserver = new MutationObserverCtor(syncBackdrop);
            for (const source of [...sources, doc.documentElement]) {
                appearanceObserver.observe(source, { attributes: true, attributeFilter: ['class', 'style', 'data-vcp-theme', 'data-vcp-wallpaper-scope', 'data-vcp-surface', 'data-vcp-surface-effect'] });
            }
            cleanups.push(() => appearanceObserver.disconnect());
        }
        const observer = new ResizeObserverCtor(sync);
        observer.observe(dock);
        observer.observe(scroller);
        cleanups.push(() => observer.disconnect());
        return true;
    }

    function dispose() {
        while (cleanups.length) cleanups.pop()();
        if (!mounted) return;
        mounted = false;
        fade?.remove();
        fade = null;
        backgroundPlanes = [];
        root.classList.remove(OVERLAY_CLASS);
        root.style.removeProperty(INSET_VAR);
        root.style.removeProperty(SCROLLBAR_VAR);
        lastInset = -1;
        lastScrollbar = -1;
    }

    return { mount, dispose };
}
