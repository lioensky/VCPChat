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
        const ws = workspaceOf(store.currentWorkspaceId);
        if (!ws) return item.path;
        const sep = ws.path.includes('\\') ? '\\' : '/';
        return ws.path.replace(/[\\/]+$/, '') + sep + item.path.split('/').join(sep);
    }

    async function revealInFileManager(item) {
        try {
            const res = await api.gitRevealPath(store.currentWorkspaceId, item.path);
            if (!res?.success) throw new Error(res?.error || '无法在文件管理器中打开');
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    function closeContextMenu() {
        if (!contextMenu) return;
        contextMenu.remove();
        contextMenu = null;
        doc.removeEventListener('pointerdown', onOutsidePointer, true);
        doc.removeEventListener('keydown', onMenuKey, true);
        win.removeEventListener('blur', closeContextMenu);
    }

    function onOutsidePointer(event) { if (contextMenu && !contextMenu.contains(event.target)) closeContextMenu(); }

    function onMenuKey(event) { if (event.key === 'Escape') closeContextMenu(); }

    function openContextMenu(event, item) {
        event.preventDefault();
        closeContextMenu();
        const menu = doc.createElement('div');
        menu.className = 'side-git-context-menu vcp-ui-scope';
        menu.setAttribute('role', 'menu');
        const entries = [
            { icon: 'folder_open', label: '在文件管理器中打开', disabled: typeof api?.gitRevealPath !== 'function' || item.status === 'D', run: () => revealInFileManager(item) },
            { icon: 'content_copy', label: '复制绝对路径', run: () => copyText(absolutePathOf(item), '绝对路径') },
            { icon: 'content_copy', label: '复制相对路径', run: () => copyText(item.path, '相对路径') }
        ];
        entries.forEach((entry) => {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'side-git-context-item';
            btn.setAttribute('role', 'menuitem');
            btn.disabled = Boolean(entry.disabled);
            btn.innerHTML = `<span class="vcp-ui-icon">${entry.icon}</span><span class="side-git-context-label"></span>`;
            btn.lastElementChild.textContent = entry.label;
            btn.addEventListener('click', () => { closeContextMenu(); entry.run(); });
            menu.appendChild(btn);
        });
        doc.body.appendChild(menu);
        placeMenuAt(menu, event.clientX, event.clientY, win);
        contextMenu = menu;
        doc.addEventListener('pointerdown', onOutsidePointer, true);
        doc.addEventListener('keydown', onMenuKey, true);
        win.addEventListener('blur', closeContextMenu);
    }

    return Object.freeze({ copyText, absolutePathOf, revealInFileManager, closeContextMenu, onOutsidePointer, onMenuKey, openContextMenu, dispose() { closeContextMenu(); } });
}
