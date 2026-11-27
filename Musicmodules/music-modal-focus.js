/*
 * 音乐窗口弹窗的键盘焦点（获取歌词、WebDAV、新建歌单、编辑歌单）。
 *
 * 这几个弹窗关着的时候只是透明，里面的输入框和按钮仍然在 Tab 顺序里：
 * 在主界面按 Tab 会走进看不见的「服务器地址」「密码」框；弹窗开着时 Tab 也会跑到后面去。
 * 这里统一处理：
 * - 关着的弹窗设成 inert，Tab 不会进去；
 * - 开着的弹窗里 Tab / Shift+Tab 在弹窗内循环；
 * - 打开时焦点不在弹窗里，就放到第一个输入框（没有就第一个按钮）；
 * - 关掉后焦点回到打开它的那个控件。
 */
(function (global) {
    'use strict';
    const document = global.document;
    if (!document) return;

    const OVERLAY = '.music-modal-overlay, .dialog-overlay';
    const FOCUSABLE = 'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const openers = new WeakMap();

    // 多数弹窗用 visible 开关，WebDAV 两个弹窗用的是 active：两种都算开着，不然开着的弹窗会被设成 inert，点什么都没反应
    const isOpen = (o) => o.classList.contains('visible') || o.classList.contains('active');
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const focusables = (o) => [...o.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[inert]') && shown(el));
    const topOverlay = () => {
        const open = [...document.querySelectorAll(OVERLAY)].filter(isOpen);
        return open[open.length - 1] || null;
    };

    const focusInside = (o) => {
        if (o.contains(document.activeElement)) return;
        const list = focusables(o);
        const target = list.find((el) => el.matches('[autofocus]')) || list.find((el) => el.matches('input, textarea')) || list[0];
        target?.focus({ preventScroll: true });
    };

    // 关弹窗时列表常会整块重画（编辑歌单关掉后侧栏歌单列表重建），原来那个按钮已经不在页面上。
    // 记下它在最近一个带 id 的容器里、同类按钮中的第几个，重画后按位置找回新的那个。
    const remember = (el) => {
        const root = el.parentElement?.closest('[id]');
        const cls = [...el.classList].filter((c) => /^[\w-]+$/.test(c)).map((c) => '.' + c).join('');
        const sel = el.tagName.toLowerCase() + cls;
        return { el, root, sel, index: root ? [...root.querySelectorAll(sel)].indexOf(el) : -1 };
    };
    const recall = (mark) => {
        if (!mark) return null;
        if (mark.el.isConnected) return mark.el;
        if (!mark.root?.isConnected || mark.index < 0) return null;
        return mark.root.querySelectorAll(mark.sel)[mark.index] || null;
    };

    const sync = (o) => {
        const open = isOpen(o);
        o.inert = !open;
        if (open && !openers.has(o)) {
            const from = document.activeElement;
            openers.set(o, from && from !== document.body && !o.contains(from) ? remember(from) : null);
            // 打开的代码可能在去掉 inert 之前就 focus 过（那次会落空），这里补上
            focusInside(o);
            global.requestAnimationFrame?.(() => { if (isOpen(o)) focusInside(o); });
        } else if (!open && openers.has(o)) {
            const back = recall(openers.get(o));
            openers.delete(o);
            const lost = document.activeElement === document.body || o.contains(document.activeElement);
            if (lost && back && back.isConnected && !back.closest('[inert], [hidden]')) back.focus({ preventScroll: true });
        }
    };

    const watch = () => {
        const overlays = [...document.querySelectorAll(OVERLAY)];
        const observer = new MutationObserver((records) => {
            for (const r of records) if (r.target.matches?.(OVERLAY)) sync(r.target);
        });
        for (const o of overlays) {
            observer.observe(o, { attributes: true, attributeFilter: ['class'] });
            sync(o);
        }
        global.addEventListener?.('beforeunload', () => observer.disconnect(), { once: true });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab' || e.defaultPrevented) return;
            const o = topOverlay();
            if (!o) return;
            const list = focusables(o);
            if (!list.length) { e.preventDefault(); return; }
            const at = list.indexOf(document.activeElement);
            const next = e.shiftKey
                ? (at <= 0 ? list[list.length - 1] : null)
                : (at < 0 || at === list.length - 1 ? list[0] : null);
            if (next) { e.preventDefault(); next.focus({ preventScroll: true }); }
        }, true);
        // Esc 关最上面那个弹窗（按它自己的关闭／取消钮，走原来的关闭逻辑）。
        // WebDAV 两个弹窗和编辑歌单以前按 Esc 没反应；已经自己处理过 Esc 的弹窗，到这里时已经关了。
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
            const o = topOverlay();
            if (!o) return;
            const close = o.querySelector('.music-modal-close-btn, [id$="-cancel"]');
            if (!close || close.disabled) return;
            e.preventDefault();
            close.click();
        });
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true });
    else watch();
})(typeof window !== 'undefined' ? window : globalThis);
