/* Side pane tab context menu: close this tab, the others, or all of them. */
'use strict';

import { placeMenuAt } from './menu-position.js';

/**
 * menu 里的按钮用 data-action 区分：close-tab / close-others / close-all。
 *   getClosableTabs()   当前对话里可关的标签，用来决定哪些项可点
 *   onAction(action, tabId)
 *   onShow()            菜单打开前调用，用来收起别的浮层
 *   focusTab(tabId)     Esc/Tab 关闭或执行后把焦点还给标签；标签已关时由调用方退回当前标签
 */
export function createSidePaneTabMenu({ menu, getClosableTabs, onAction, onShow = () => {}, focusTab = () => {} }) {
    const doc = menu.ownerDocument;
    const cleanups = [];
    let targetTabId = null;

    // 侧栏外壳带 backdrop-filter：留在里面时 fixed 按外壳定位（位置偏），
    // 菜单自己的毛玻璃也会把后面的侧栏内容画空。挂到 body 下，dispose 时放回原处。
    const home = { parent: menu.parentNode, next: menu.nextSibling };
    if (doc.body && home.parent !== doc.body) {
        menu.classList.add('vcp-ui-scope');
        doc.body.appendChild(menu);
        cleanups.push(() => {
            if (home.parent?.isConnected) home.parent.insertBefore(menu, home.next?.parentNode === home.parent ? home.next : null);
        });
    }

    const isOpen = () => !menu.hidden;

    function hide() {
        menu.hidden = true;
        targetTabId = null;
    }

    function show(tabId, x, y) {
        onShow();
        targetTabId = tabId;
        const closable = getClosableTabs();
        const setDisabled = (action, disabled) => {
            const btn = menu.querySelector(`[data-action="${action}"]`);
            if (btn) btn.disabled = disabled;
        };
        setDisabled('close-tab', !closable.some(t => t.id === tabId));
        setDisabled('close-others', !closable.some(t => t.id !== tabId));
        setDisabled('close-all', closable.length === 0);
        menu.hidden = false;
        placeMenuAt(menu, x, y, doc.defaultView, 8);
        menu.querySelector('[role="menuitem"]:not([disabled])')?.focus?.({ preventScroll: true });
    }

    const onClick = async (e) => {
        const actionBtn = e.target.closest('[data-action]');
        if (!actionBtn || actionBtn.disabled) return;
        const action = actionBtn.getAttribute('data-action');
        const tabId = targetTabId;
        hide();
        await onAction(action, tabId);
        // 被点的菜单项已经藏起来了，焦点会掉到 body：还给标签（标签被关了就给当前标签）
        const active = doc.activeElement;
        if (!active || active === doc.body || !active.isConnected || menu.contains(active)) focusTab(tabId);
    };
    menu.addEventListener('click', onClick);
    cleanups.push(() => menu.removeEventListener('click', onClick));

    // 菜单内上下键移动焦点；Tab 和 Radix Menu 一样直接收起，焦点回到标签
    const onMenuKeydown = (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const returnTo = targetTabId;
            hide();
            focusTab(returnTo);
            return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
        const items = Array.from(menu.querySelectorAll('[role="menuitem"]:not([disabled])'));
        if (!items.length) return;
        e.preventDefault();
        const current = items.indexOf(doc.activeElement);
        let next = 0;
        if (e.key === 'End') next = items.length - 1;
        else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
        else if (e.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
        items[next].focus();
    };
    menu.addEventListener('keydown', onMenuKeydown);
    cleanups.push(() => menu.removeEventListener('keydown', onMenuKeydown));

    // 点外面或按 Esc 收起，Esc 时焦点回到右键的那个标签
    const onDocPointerDown = (e) => {
        if (isOpen() && !menu.contains(e.target)) hide();
    };
    const onDocKeydown = (e) => {
        if (e.key !== 'Escape' || !isOpen()) return;
        e.preventDefault();
        const returnTo = targetTabId;
        hide();
        focusTab(returnTo);
    };
    // 点进浏览器标签的 webview 或别的窗口时，主页面收不到 pointerdown，只会失焦
    const win = doc.defaultView;
    const onWindowBlur = () => { if (isOpen()) hide(); };
    doc.addEventListener('pointerdown', onDocPointerDown, true);
    doc.addEventListener('keydown', onDocKeydown);
    win?.addEventListener('blur', onWindowBlur);
    cleanups.push(() => {
        doc.removeEventListener('pointerdown', onDocPointerDown, true);
        doc.removeEventListener('keydown', onDocKeydown);
        win?.removeEventListener('blur', onWindowBlur);
    });

    return Object.freeze({
        isOpen,
        hide,
        show,
        dispose() {
            cleanups.forEach(cleanup => cleanup());
            cleanups.length = 0;
        }
    });
}
