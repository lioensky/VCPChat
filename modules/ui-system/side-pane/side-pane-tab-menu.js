/* Side pane tab context menu: close this tab, the others, or all of them. */
'use strict';

import { placeMenuAt } from './menu-position.js';

/**
 * menu 里的按钮用 data-action 区分：close-tab / close-others / close-all。
 *   getClosableTabs()   当前对话里可关的标签，用来决定哪些项可点
 *   onAction(action, tabId)
 *   onShow()            菜单打开前调用，用来收起别的浮层
 *   focusTab(tabId)     Esc 关闭后把焦点还给标签
 */
export function createSidePaneTabMenu({ menu, getClosableTabs, onAction, onShow = () => {}, focusTab = () => {} }) {
    const doc = menu.ownerDocument;
    const cleanups = [];
    let targetTabId = null;

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
        menu.querySelector('[role="menuitem"]:not([disabled])')?.focus?.();
    }

    const onClick = async (e) => {
        const actionBtn = e.target.closest('[data-action]');
        if (!actionBtn || actionBtn.disabled) return;
        const action = actionBtn.getAttribute('data-action');
        const tabId = targetTabId;
        hide();
        await onAction(action, tabId);
    };
    menu.addEventListener('click', onClick);
    cleanups.push(() => menu.removeEventListener('click', onClick));

    // 菜单内上下键移动焦点
    const onMenuKeydown = (e) => {
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
    doc.addEventListener('pointerdown', onDocPointerDown, true);
    doc.addEventListener('keydown', onDocKeydown);
    cleanups.push(() => {
        doc.removeEventListener('pointerdown', onDocPointerDown, true);
        doc.removeEventListener('keydown', onDocKeydown);
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
