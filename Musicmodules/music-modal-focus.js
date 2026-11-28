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
    const OPEN_OVERLAY = '.music-modal-overlay.visible, .music-modal-overlay.active, .dialog-overlay.visible, .dialog-overlay.active';
    const FOCUSABLE = 'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
    const VALID_CLS_RE = /^[\w-]+$/;
    const openers = new WeakMap();
    const focusRafs = new WeakMap();
    const openOverlays = new Set();

    // 多数弹窗用 visible 开关，WebDAV 两个弹窗用的是 active：两种都算开着，不然开着的弹窗会被设成 inert，点什么都没反应
    const isOpen = (o) => o.classList.contains('visible') || o.classList.contains('active');
    const shown = (el) => !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const isVisibleFocusable = (el) => !el.hidden && !el.closest('[inert]') && shown(el);
    const focusables = (o) => {
        const nodes = o.querySelectorAll(FOCUSABLE);
        const out = [];
        for (let i = 0; i < nodes.length; i += 1) {
            const el = nodes[i];
            if (isVisibleFocusable(el)) out.push(el);
        }
        return out;
    };
    const topOverlay = () => {
        const open = document.querySelectorAll(OPEN_OVERLAY);
        return open.length ? open[open.length - 1] : null;
    };

    const focusInside = (o) => {
        if (o.contains(document.activeElement)) return;
        // 先定向查 [autofocus]，再按需扫描至首个可见输入框即提前退出，避免大列表弹窗对数百按钮全量跑 getClientRects + getComputedStyle。
        const autoNodes = o.querySelectorAll('[autofocus]');
        for (let i = 0; i < autoNodes.length; i += 1) {
            const el = autoNodes[i];
            if (el.matches(FOCUSABLE) && isVisibleFocusable(el)) {
                el.focus({ preventScroll: true });
                return;
            }
        }
        const nodes = o.querySelectorAll(FOCUSABLE);
        let fallback = null;
        for (let i = 0; i < nodes.length; i += 1) {
            const el = nodes[i];
            if (!isVisibleFocusable(el)) continue;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.focus({ preventScroll: true });
                return;
            }
            if (!fallback) fallback = el;
        }
        fallback?.focus({ preventScroll: true });
    };

    // 关弹窗时列表常会整块重画（编辑歌单关掉后侧栏歌单列表重建），原来那个按钮已经不在页面上。
    // 记下它在最近一个带 id 的容器里、同类按钮中的第几个，重画后按位置找回新的那个。
    const remember = (el) => {
        const root = el.parentElement?.closest('[id]');
        let cls = '';
        for (let i = 0; i < el.classList.length; i += 1) {
            const c = el.classList[i];
            if (VALID_CLS_RE.test(c)) cls += '.' + c;
        }
        const sel = el.tagName.toLowerCase() + cls;
        let index = -1;
        if (root) {
            const all = root.querySelectorAll(sel);
            for (let i = 0; i < all.length; i += 1) {
                if (all[i] === el) { index = i; break; }
            }
        }
        return { el, root, sel, index };
    };
    const recall = (mark) => {
        if (!mark) return null;
        if (mark.el.isConnected) return mark.el;
        if (!mark.root?.isConnected || mark.index < 0) return null;
        return mark.root.querySelectorAll(mark.sel)[mark.index] || null;
    };

    const cancelFocusRaf = (o) => {
        const id = focusRafs.get(o);
        if (id) {
            global.cancelAnimationFrame?.(id);
            focusRafs.delete(o);
        }
    };

    const sync = (o) => {
        const open = isOpen(o);
        if (open) openOverlays.add(o); else openOverlays.delete(o);
        if (open) {
            if (o.inert !== false) o.inert = false;
            if (!openers.has(o)) {
                const from = document.activeElement;
                openers.set(o, from && from !== document.body && !o.contains(from) ? remember(from) : null);
                // 打开的代码可能在去掉 inert 之前就 focus 过（那次会落空），这里补上
                focusInside(o);
                cancelFocusRaf(o);
                const id = global.requestAnimationFrame?.(() => {
                    focusRafs.delete(o);
                    if (isOpen(o)) focusInside(o);
                });
                if (id) focusRafs.set(o, id);
            }
            return;
        }
        // 关闭时先恢复焦点（或 blur 弹窗内焦点），再设 inert=true，避免浏览器因 inert 先清空焦点导致闪烁
        if (openers.has(o)) {
            cancelFocusRaf(o);
            const back = recall(openers.get(o));
            openers.delete(o);
            const inside = o.contains(document.activeElement);
            const lost = document.activeElement === document.body || inside;
            if (lost) {
                const canRestore = back && back !== document.body && back.isConnected
                    && !o.contains(back) && !back.closest('[inert], [hidden]');
                if (canRestore) back.focus({ preventScroll: true });
                else if (inside) document.activeElement?.blur?.();
            }
        }
        if (o.inert !== true) o.inert = true;
    };

    const watch = () => {
        const overlays = document.querySelectorAll(OVERLAY);
        const observer = new MutationObserver((records) => {
            for (const r of records) if (r.target.matches?.(OVERLAY)) sync(r.target);
        });
        // 弹窗开着时截住方向键/翻页键和单键快捷键，免得透到后面的档案目录或播放控制；
        // 放在弹窗根节点冒泡阶段，保留弹窗内输入框和按钮的原生键盘行为，也不拦 Esc/Tab。
        const onOverlayKey = (e) => {
            if (!isOpen(e.currentTarget) || e.key === 'Escape' || e.key === 'Tab') return;
            if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                if (NAV_KEYS.has(e.key) || e.key.length === 1) e.stopPropagation();
            }
        };
        for (const o of overlays) {
            observer.observe(o, { attributes: true, attributeFilter: ['class'] });
            o.addEventListener('keydown', onOverlayKey);
            sync(o);
        }
        const onDocCaptureKey = (e) => {
            if (e.defaultPrevented) return;
            const isTab = e.key === 'Tab';
            const isNav = !e.ctrlKey && !e.metaKey && !e.altKey && NAV_KEYS.has(e.key);
            const isSingle = !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1;
            // 无静态弹窗打开时，单键与普通键零查询；静态弹窗打开时同时拦住焦点落在弹窗外的单键快捷键防穿透
            if (!isTab && !isNav && !(isSingle && openOverlays.size > 0)) return;
            if (!isTab && openOverlays.size === 0) return;
            const o = topOverlay();
            if (!o) return;
            if (isTab) {
                const list = focusables(o);
                if (!list.length) { e.preventDefault(); return; }
                const at = list.indexOf(document.activeElement);
                const next = e.shiftKey
                    ? (at <= 0 ? list[list.length - 1] : null)
                    : (at < 0 || at === list.length - 1 ? list[0] : null);
                if (next) { e.preventDefault(); next.focus({ preventScroll: true }); }
                return;
            }
            if (!o.contains(e.target)) {
                e.stopPropagation();
            }
        };
        // Esc 关最上面那个弹窗（按它自己的关闭／取消钮，走原来的关闭逻辑）。
        // WebDAV 两个弹窗和编辑歌单以前按 Esc 没反应；已经自己处理过 Esc 的弹窗，到这里时已经关了。
        const onDocEscape = (e) => {
            if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || openOverlays.size === 0) return;
            const o = topOverlay();
            if (!o) return;
            const close = o.querySelector('.music-modal-close-btn, [id$="-cancel"]');
            if (!close || close.disabled) return;
            e.preventDefault();
            close.click();
        };
        document.addEventListener('keydown', onDocCaptureKey, true);
        document.addEventListener('keydown', onDocEscape);
        global.addEventListener?.('beforeunload', () => {
            observer.disconnect();
            for (const o of overlays) {
                cancelFocusRaf(o);
                o.removeEventListener('keydown', onOverlayKey);
            }
            document.removeEventListener('keydown', onDocCaptureKey, true);
            document.removeEventListener('keydown', onDocEscape);
        }, { once: true });
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true });
    else watch();
})(typeof window !== 'undefined' ? window : globalThis);
