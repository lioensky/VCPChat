/**
 * modules/ui-system/conversation-status-panel/floating.js
 * 会话右上角浮动的「状态」面板：Git 变更（更改 / 分支 / 提交或推送）与 V工程 计划（todo），
 * 也可以收起成一颗迷你胶囊。
 *
 * 结构、交互和样式对照 ZCode 的 ConversationStatusPanel / GitBranchSwitcher / GitActionMenu
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4 与 packages/ui/src），
 * 由 React + Tailwind 改写为原生 DOM + styles/ui-system/status-panel.css。
 * 数据来自现有后端：Git 走 git:* IPC，V工程走 project-forge:* IPC，
 * 工作区选择与侧栏 Git 标签、V工程 Git 页共用同一个 localStorage 键。
 */

'use strict';



export function createStatusPanelFloating({
    button,
    doc,
    h,
    icon,
    portal,
    win
}) {
    const popovers = [];
    const modals = [];
    function placeFloating(node, anchor, { side = 'bottom', offset = 4 } = {}) {
        const a = anchor.getBoundingClientRect();
        const vw = win.innerWidth;
        const vh = win.innerHeight;
        const w = node.offsetWidth;
        const hgt = node.offsetHeight;
        let left;
        let top;
        if (side === 'left' && a.left - w - offset >= 8) {
            left = a.left - w - offset;
            top = a.top;
        } else {
            left = a.left;
            top = a.bottom + offset;
            if (top + hgt > vh - 8 && a.top - hgt - offset >= 8) top = a.top - hgt - offset;
        }
        left = Math.max(8, Math.min(left, vw - w - 8));
        top = Math.max(8, Math.min(top, vh - hgt - 8));
        node.style.left = `${Math.round(left)}px`;
        node.style.top = `${Math.round(top)}px`;
    }

    function closePopover(entry) {
        const index = popovers.indexOf(entry);
        if (index < 0) return;
        popovers.splice(index, 1);
        entry.node.remove();
        entry.cleanup?.();
        entry.onClose?.();
    }

    function closeAllPopovers() {
        [...popovers].reverse().forEach(closePopover);
    }

    function openPopover(node, anchor, { side = 'bottom', className = '', onClose = null, hover = false } = {}) {
        node.classList.add('zc-popover', ...className.split(' ').filter(Boolean));
        portal.appendChild(node);
        placeFloating(node, anchor, { side });
        const entry = { node, anchor, onClose, cleanup: null };
        popovers.push(entry);
        if (!hover) {
            const onDown = event => {
                if (!node.contains(event.target) && !anchor.contains(event.target)) closePopover(entry);
            };
            // 点进侧栏浏览器的 webview 或别的窗口时只会失焦
            const onBlur = () => closePopover(entry);
            doc.addEventListener('mousedown', onDown, true);
            win.addEventListener('blur', onBlur);
            entry.cleanup = () => {
                doc.removeEventListener('mousedown', onDown, true);
                win.removeEventListener('blur', onBlur);
            };
        }
        return entry;
    }

    function openModal({ className = '', onClose = null, showClose = false } = {}) {
        const overlay = h('div', 'zc-overlay');
        const dialog = h('div', `zc-dialog ${className}`.trim());
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.tabIndex = -1;
        overlay.appendChild(dialog);
        const previouslyFocused = doc.activeElement;
        // busy 期间（提交、推送、建分支进行中）Esc、遮罩和右上角关闭都不生效，流程走完由它自己 close；
        // 对齐 ZCode 的 Radix Dialog：流程归父级持有，焦点困在对话框里，关闭后还给打开前的元素
        const entry = { overlay, dialog, closed: false, busy: false };
        entry.close = () => {
            if (entry.closed) return;
            entry.closed = true;
            const index = modals.indexOf(entry);
            if (index >= 0) modals.splice(index, 1);
            const hadFocus = overlay.contains(doc.activeElement);
            overlay.remove();
            onClose?.();
            if ((hadFocus || doc.activeElement === doc.body) && previouslyFocused?.isConnected) {
                previouslyFocused.focus?.({ preventScroll: true });
            }
        };
        entry.dismiss = () => { if (!entry.busy) entry.close(); };
        if (showClose) {
            dialog.appendChild(button('zc-btn zc-btn-ghost zc-btn-icon-sm zc-dialog-close', { label: '关闭', onClick: entry.dismiss }, icon('x')));
        }
        overlay.addEventListener('mousedown', event => { if (event.target === overlay) entry.dismiss(); });
        overlay.addEventListener('keydown', event => {
            if (event.key !== 'Tab') return;
            const focusable = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
                .filter(el => !el.disabled && !el.hidden);
            if (!focusable.length) { event.preventDefault(); dialog.focus({ preventScroll: true }); return; }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = doc.activeElement;
            if (event.shiftKey && (active === first || active === dialog)) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
        });
        portal.appendChild(overlay);
        modals.push(entry);
        dialog.focus({ preventScroll: true });
        return entry;
    }

    return Object.freeze({ placeFloating, closePopover, closeAllPopovers, openPopover, openModal, popovers, modals, dispose() { closeAllPopovers(); [...modals].forEach(modal => modal.close()); } });
}
