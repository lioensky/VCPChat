/**
 * 聊天浮动导航的空闲淡化，不参与滚动位置或粘底跟随状态管理。
 * 保留命中区域，鼠标悬停和键盘聚焦期间始终清晰显示。
 */
export function bindChatNavigationIdle({ element, scroller, delayMs = 1200 }) {
    const doc = element.ownerDocument;
    const win = doc.defaultView;
    const cleanups = [];
    let timer = null;
    let hovered = false;
    let focused = false;
    let hidden = element.hidden;

    function clearTimer() {
        win.clearTimeout(timer);
        timer = null;
    }

    function activate() {
        clearTimer();
        element.classList.remove('is-idle');
        if (element.hidden || hovered || focused) return;
        timer = win.setTimeout(() => {
            timer = null;
            element.classList.add('is-idle');
        }, delayMs);
    }

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
    }

    on(scroller, 'scroll', activate, { passive: true });
    on(element, 'pointerenter', () => { hovered = true; activate(); });
    on(element, 'pointerleave', () => { hovered = false; activate(); });
    on(element, 'pointercancel', () => { hovered = false; activate(); });
    on(element, 'focusin', () => { focused = true; activate(); });
    on(element, 'focusout', (event) => {
        focused = element.contains(event.relatedTarget);
        activate();
    });
    activate();

    return {
        // 只在显隐切换时重置，流式消息刷新不应不断推迟淡化。
        refresh() {
            if (hidden === element.hidden) return;
            hidden = element.hidden;
            if (hidden) { hovered = false; focused = false; }
            activate();
        },
        dispose() {
            clearTimer();
            while (cleanups.length) cleanups.pop()();
            element.classList.remove('is-idle');
        }
    };
}