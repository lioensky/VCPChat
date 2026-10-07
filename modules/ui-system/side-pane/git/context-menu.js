/**
 * modules/ui-system/side-pane/git/context-menu.js
 * V工程 计划标签里的 Git 页（git-view.js）的一部分
 *
 * 照 ZCode `GitPane` / `GitPaneChangeCard`（zai-org/ZCode，Apache-2.0）复刻，只保留它有的东西：
 * 1. 顶栏：来源下拉（未暂存 / 已暂存 / 上一轮）+ 幽灵「刷新」按钮。
 * 2. 平铺的变更列表，每行一张卡片：文件名 + 暗色目录、`+N -N`、展开时翻转 180° 的箭头。
 * 3. 右键菜单：在文件管理器中打开 / 复制绝对路径 / 复制相对路径。
 * 4. 展开后显示 diff（加载中 / 文本 diff / 无法预览的说明）。
 * 5. 空状态：居中图标 + 标题 + 描述。
 *
 * 和原实现的差别只有数据来源：「上一轮」在 VCPChat 里是 V工程 最近一批施工触碰过的文件。
 * 暂存、提交、推送、分支切换、提交图都留在 ProjectForge 和对话状态面板里，这里不重复做。
 */

'use strict';

import { moveMenuFocus } from '../menu-position.js';


export function createGitContextMenu({
    store,
    api,
    doc,
    placeMenuAt,
    toast,
    win,
    workspaceOf
}) {
    let contextMenu = null;
    // 打开菜单的那一行：Esc、Tab 或执行完菜单项后焦点回到这里
    let returnFocusTo = null;

    async function copyText(text, label) {
        try {
            if (win.navigator?.clipboard?.writeText) await win.navigator.clipboard.writeText(text);
            else if (api?.writeTextToClipboard) await api.writeTextToClipboard(text);
            else throw new Error('当前环境不支持写入剪贴板');
            toast(`已复制${label}`, 'success');
        } catch (err) {
            toast(`复制失败：${err.message}`, 'error');
        }
    }

    function absolutePathOf(item) {
        // 条目路径相对仓库根（工作区可能是子目录），用仓库根拼；拿不到时才退回工作区根
        const base = store.currentToplevel || workspaceOf(store.currentWorkspaceId)?.path;
        if (!base) return item.path;
        const sep = base.includes('\\') ? '\\' : '/';
        return base.replace(/[\\/]+$/, '') + sep + item.path.split('/').join(sep);
    }

    async function revealInFileManager(item) {
        try {
            const res = await api.gitRevealPath(store.currentWorkspaceId, item.path);
            if (!res?.success) throw new Error(res?.error || '无法在文件管理器中打开');
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    function closeContextMenu({ restoreFocus = false } = {}) {
        if (!contextMenu) return;
        contextMenu.remove();
        contextMenu = null;
        const target = returnFocusTo;
        returnFocusTo = null;
        if (restoreFocus && target?.isConnected) target.focus?.({ preventScroll: true });
        doc.removeEventListener('pointerdown', onOutsidePointer, true);
        doc.removeEventListener('keydown', onMenuKey, true);
        win.removeEventListener('blur', closeContextMenu);
    }

    function onOutsidePointer(event) { if (contextMenu && !contextMenu.contains(event.target)) closeContextMenu(); }

    // 和 ZCode GitPaneChangeCard 用的 Radix ContextMenu 一样：上下键 / Home / End 在菜单项间移动，Esc 或 Tab 收起并把焦点还给那一行
    function onMenuKey(event) {
        if (!contextMenu) return;
        if (event.key === 'Escape' || event.key === 'Tab') {
            event.preventDefault();
            closeContextMenu({ restoreFocus: true });
            return;
        }
        if (!contextMenu.contains(doc.activeElement)) return;
        moveMenuFocus(event, [...contextMenu.querySelectorAll('[role="menuitem"]:not([disabled])')]);
    }

    function openContextMenu(event, item) {
        event.preventDefault();
        closeContextMenu();
        const menu = doc.createElement('div');
        menu.className = 'side-git-context-menu vcp-ui-scope';
        menu.setAttribute('role', 'menu');
        const entries = [
            { action: 'reveal', icon: 'folder_open', label: '在文件管理器中打开', disabled: typeof api?.gitRevealPath !== 'function' || item.status === 'D', run: () => revealInFileManager(item) },
            { action: 'copy-abs', icon: 'content_copy', label: '复制绝对路径', run: () => copyText(absolutePathOf(item), '绝对路径') },
            { action: 'copy-rel', icon: 'content_copy', label: '复制相对路径', run: () => copyText(item.path, '相对路径') }
        ];
        entries.forEach((entry) => {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'side-git-context-item';
            btn.setAttribute('role', 'menuitem');
            btn.dataset.action = entry.action;
            btn.disabled = Boolean(entry.disabled);
            btn.innerHTML = `<span class="vcp-ui-icon" aria-hidden="true">${entry.icon}</span><span class="side-git-context-label"></span>`;
            btn.lastElementChild.textContent = entry.label;
            btn.addEventListener('click', () => { closeContextMenu({ restoreFocus: true }); entry.run(); });
            menu.appendChild(btn);
        });
        doc.body.appendChild(menu);
        // 键盘（Shift+F10 / 菜单键）打开时没有指针坐标，贴着那一行出菜单
        const anchor = typeof event.currentTarget?.getBoundingClientRect === 'function' ? event.currentTarget : null;
        let { clientX: x, clientY: y } = event;
        if (!x && !y && anchor?.getBoundingClientRect) {
            const rect = anchor.getBoundingClientRect();
            x = rect.left + 8;
            y = rect.bottom;
        }
        placeMenuAt(menu, x, y, win);
        contextMenu = menu;
        returnFocusTo = anchor || (doc.activeElement !== doc.body ? doc.activeElement : null);
        menu.querySelector('[role="menuitem"]:not([disabled])')?.focus?.({ preventScroll: true });
        doc.addEventListener('pointerdown', onOutsidePointer, true);
        doc.addEventListener('keydown', onMenuKey, true);
        win.addEventListener('blur', closeContextMenu);
    }

    return Object.freeze({ copyText, absolutePathOf, revealInFileManager, closeContextMenu, onOutsidePointer, onMenuKey, openContextMenu, dispose() { closeContextMenu(); } });
}
