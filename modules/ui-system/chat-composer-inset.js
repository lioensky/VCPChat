/**
 * modules/ui-system/chat-composer-inset.js
 * 让主聊天的滚动区一直延伸到窗口底部，输入区浮在它的底部之上（滚动条也随之到底）。
 *
 * 做法照 ZCode 的 composer dock（https://github.com/zai-org/ZCode ，Apache-2.0，
 * packages/ui/src/v4/ConversationTimeline.tsx）：消息层在输入区所在的底部一段完全透明，
 * 其上淡出一小段，滚动条不受遮罩影响。这里不改 DOM 结构，只把输入区的实时高度写成
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

    function sync() {
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
        sync();
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
        root.classList.remove(OVERLAY_CLASS);
        root.style.removeProperty(INSET_VAR);
        root.style.removeProperty(SCROLLBAR_VAR);
        lastInset = -1;
        lastScrollbar = -1;
    }

    return { mount, dispose };
}
