/* side-chat/branch-rail.js
 * 分形拓扑导航轨（Fractal Branch Rail）。
 *
 * 每个辅助对话分支仍是独立 child topic；本轨把同一父话题下的所有侧聊
 * 组织成外露的树，点击节点即在分支间切换（由 surface owner 提供 onSwitch，
 * 内部落到对应 tab）。当前分支高亮，已结晶分支带晶体标记。
 *
 * 渲染一律走 createElement / textContent，避免文件名 / 选中文本注入。
 */
'use strict';

import { buildBranchForest, flattenTree } from './branch-tree.js';
import { openThoughtMapModal } from './thought-map-modal.js';

export function createSideChatBranchRail({
    container,
    doc,
    descriptor,
    listSiblings,
    onSwitch,
    onRename = null,
    onDelete = null,
    onFork,
    onExportNote = null,
    collapsedByDefault = false,
}) {
    if (!container || !doc) throw new TypeError('branch-rail requires container and doc');

    const currentTopicId = descriptor?.child?.topicId || null;
    const cleanups = [];
    let isCollapsed = Boolean(collapsedByDefault);
    let isLoading = false;
    let lastForest = null;

    // ── 骨架 ──
    const rail = doc.createElement('div');
    rail.className = 'side-chat-branch-rail';

    const header = doc.createElement('div');
    header.className = 'branch-rail-header';

    const railTitle = doc.createElement('span');
    railTitle.className = 'branch-rail-title';
    railTitle.innerHTML = `<span class="branch-rail-kicker-icon">◉</span> <span>思路拓扑</span>`;

    const headerActions = doc.createElement('span');
    headerActions.className = 'branch-rail-header-actions';

    const forkBtn = doc.createElement('button');
    forkBtn.type = 'button';
    forkBtn.className = 'branch-rail-icon-btn branch-rail-fork';
    forkBtn.title = '从当前节点新开一条支线';
    forkBtn.setAttribute('aria-label', '新开分支');
    forkBtn.textContent = '＋';

    const mapBtn = doc.createElement('button');
    mapBtn.type = 'button';
    mapBtn.className = 'branch-rail-icon-btn branch-rail-map';
    mapBtn.title = '一张思路地图 (全景预览)';
    mapBtn.setAttribute('aria-label', '思路地图');
    mapBtn.textContent = '✧';

    const collapseBtn = doc.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'branch-rail-icon-btn branch-rail-collapse';
    collapseBtn.title = '折叠 / 展开拓扑';
    collapseBtn.setAttribute('aria-label', '折叠拓扑');
    collapseBtn.textContent = '▾';

    headerActions.append(forkBtn, mapBtn, collapseBtn);
    header.append(railTitle, headerActions);

    async function handleExportNote() {
        if (typeof onExportNote !== 'function') return;
        try {
            await onExportNote();
        } catch (error) {
            console.warn('[BranchRail] export note failed:', error);
            setHint(`固化笔记失败：${error?.message || error}`, true);
        }
    }

    function handleOpenThoughtMap() {
        if (!lastForest) return;
        openThoughtMapModal({
            doc,
            forest: lastForest,
            currentTopicId,
            onSwitch: handleSwitch,
            onRename,
            onDelete: async (topicId) => {
                if (typeof onDelete !== 'function') return;
                try {
                    await onDelete(topicId);
                    await refresh();
                } catch (err) {
                    console.warn('[BranchRail] delete from map failed:', err);
                    setHint(`删除失败：${err?.message || err}`, true);
                }
            },
            onExportNote: handleExportNote,
        });
    }
    mapBtn.addEventListener('click', handleOpenThoughtMap);
    cleanups.push(() => mapBtn.removeEventListener('click', handleOpenThoughtMap));

    const body = doc.createElement('div');
    body.className = 'branch-rail-body';

    const statusHint = doc.createElement('div');
    statusHint.className = 'branch-rail-hint';

    rail.append(header, body, statusHint);
    container.appendChild(rail);

    function setHint(text, isError = false) {
        statusHint.textContent = text || '';
        statusHint.hidden = !text;
        statusHint.classList.toggle('is-error', Boolean(isError));
    }

    function setCollapsed(value) {
        isCollapsed = Boolean(value);
        rail.classList.toggle('is-collapsed', isCollapsed);
        body.hidden = isCollapsed;
        collapseBtn.textContent = isCollapsed ? '▸' : '▾';
        collapseBtn.title = isCollapsed ? '展开拓扑' : '折叠拓扑';
    }

    function makeRow(node) {
        const row = doc.createElement('button');
        row.type = 'button';
        row.className = 'branch-rail-row';
        row.style.setProperty('--branch-depth', String(node.depth || 0));
        row.dataset.topicId = node.topicId;

        if (node.topicId === currentTopicId) row.classList.add('is-active');
        if (node.children.length > 0) row.classList.add('has-children');

        const dot = doc.createElement('span');
        dot.className = 'branch-rail-dot';
        dot.setAttribute('aria-hidden', 'true');

        const label = doc.createElement('span');
        label.className = 'branch-rail-label';
        const text = node.branchTitle || node.title || node.forkLabel || '辅助对话';
        label.textContent = text;
        label.title = `${text} (双击或右键重命名)`;

        const forkRowBtn = doc.createElement('button');
        forkRowBtn.type = 'button';
        forkRowBtn.className = 'branch-rail-row-action branch-rail-row-fork';
        forkRowBtn.title = `从「${text}」分叉萌芽新支线`;
        forkRowBtn.textContent = '＋';
        forkRowBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (typeof onFork !== 'function') return;
            try {
                await onFork({ targetNode: node });
                await refresh();
            } catch (err) {
                console.warn('[BranchRail] fork from node failed:', err);
                setHint(`分叉失败：${err?.message || err}`, true);
            }
        });

        const renameBtn = doc.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'branch-rail-row-action';
        renameBtn.title = '重命名分支';
        renameBtn.textContent = '✎';

        row.append(dot, label, forkRowBtn, renameBtn);

        function triggerInlineRename(event) {
            if (event) event.stopPropagation();
            if (typeof onRename !== 'function') return;

            const input = doc.createElement('input');
            input.type = 'text';
            input.className = 'branch-rail-rename-input';
            input.value = node.branchTitle || node.title || '';
            input.setAttribute('aria-label', '修改分支名称');

            let committed = false;
            async function commit() {
                if (committed) return;
                committed = true;
                const newTitle = input.value.trim();
                input.replaceWith(label);
                renameBtn.hidden = false;
                if (newTitle && newTitle !== (node.branchTitle || node.title)) {
                    label.textContent = newTitle;
                    label.title = `${newTitle} (双击或右键重命名)`;
                    try {
                        await onRename(node.topicId, newTitle);
                        await refresh();
                    } catch (err) {
                        console.warn('[BranchRail] rename failed:', err);
                        setHint(`重命名失败：${err?.message || err}`, true);
                        await refresh();
                    }
                }
            }

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                } else if (e.key === 'Escape') {
                    committed = true;
                    input.replaceWith(label);
                    renameBtn.hidden = false;
                }
            });
            input.addEventListener('blur', commit);

            renameBtn.hidden = true;
            label.replaceWith(input);
            input.focus();
            input.select();
        }

        renameBtn.addEventListener('click', triggerInlineRename);

        row.addEventListener('dblclick', triggerInlineRename);

        row.addEventListener('click', (e) => {
            if (e.target.closest('.branch-rail-row-action') || e.target.closest('.branch-rail-rename-input')) return;
            if (node.topicId === currentTopicId) return;
            handleSwitch(node.topicId);
        });

        // 右键菜单：重命名 + 删除（单一菜单，避免多重注册冲突）
        row.addEventListener('contextmenu', (event) => {
            event.preventDefault();

            doc.querySelector('.branch-rail-context-menu')?.remove();
            const menu = doc.createElement('div');
            menu.className = 'branch-rail-context-menu';
            menu.style.left = `${event.clientX}px`;
            menu.style.top = `${event.clientY}px`;

            const renameItem = doc.createElement('button');
            renameItem.textContent = '✎ 重命名分支';
            renameItem.addEventListener('click', () => {
                menu.remove();
                triggerInlineRename();
            });

            const delItem = doc.createElement('button');
            delItem.textContent = '🗑 删除分支';
            delItem.style.color = 'var(--rail-error)';
            delItem.addEventListener('click', async () => {
                menu.remove();
                // 从当前森林精确统计该节点的子孙数量，级联影响如实告知
                let cascadeNote = '';
                try {
                    const treeNode = lastForest?.nodes?.get?.(node.topicId);
                    if (treeNode) {
                        const subCount = flattenTree(treeNode).length - 1;
                        if (subCount > 0) cascadeNote = `\n其下还有 ${subCount} 个子分支，将被一并删除。`;
                    }
                } catch (err) { void err; }
                if (confirm(`确定要删除分支「${text}」吗？${cascadeNote || '该分支的对话记录将永久消失。'}`)) {
                    await onDelete(node.topicId);
                    await refresh();
                }
            });

            menu.append(renameItem, delItem);
            doc.body.appendChild(menu);

            const closeMenu = () => menu.remove();
            setTimeout(() => doc.addEventListener('click', closeMenu, { once: true }), 0);
        });

        return row;
    }

    function render(metadataList) {
        lastForest = buildBranchForest(metadataList);
        body.replaceChildren();

        const rows = [];
        for (const root of lastForest.roots) {
            for (const node of flattenTree(root)) rows.push(makeRow(node));
        }
        if (rows.length === 0) {
            const empty = doc.createElement('div');
            empty.className = 'branch-rail-empty';
            empty.textContent = '还没有分支，点右上角 ＋ 开支线';
            body.appendChild(empty);
            return;
        }
        body.append(...rows);
    }

    async function refresh() {
        if (isLoading) return;
        isLoading = true;
        rail.classList.add('is-loading');
        try {
            const list = typeof listSiblings === 'function' ? await listSiblings() : [];
            if (!container.isConnected) return;
            render(Array.isArray(list) ? list : []);
            setHint('');
        } catch (error) {
            console.warn('[BranchRail] failed to load siblings:', error);
            setHint('拓扑加载失败，点击重试', true);
        } finally {
            isLoading = false;
            rail.classList.remove('is-loading');
        }
    }

    async function handleSwitch(topicId) {
        if (typeof onSwitch !== 'function') return;
        rail.classList.add('is-switching');
        try {
            await onSwitch(topicId);
        } catch (error) {
            console.warn('[BranchRail] switch failed:', error);
            setHint(`切换失败：${error?.message || error}`, true);
        } finally {
            rail.classList.remove('is-switching');
        }
    }

    async function handleFork() {
        if (typeof onFork !== 'function') return;
        try {
            await onFork();
            await refresh();
        } catch (error) {
            console.warn('[BranchRail] fork failed:', error);
            setHint(`新开分支失败：${error?.message || error}`, true);
        }
    }

    forkBtn.addEventListener('click', handleFork);
    collapseBtn.addEventListener('click', () => setCollapsed(!isCollapsed));
    statusHint.addEventListener('click', () => {
        if (statusHint.classList.contains('is-error')) refresh();
    });
    cleanups.push(() => {
        forkBtn.removeEventListener('click', handleFork);
        collapseBtn.removeEventListener('click', () => setCollapsed(!isCollapsed));
    });

    setCollapsed(isCollapsed);
    refresh();

    return Object.freeze({
        refresh,
        setCollapsed,
        get currentTopicId() { return currentTopicId; },
        dispose() {
            cleanups.splice(0).forEach(fn => { try { fn(); } catch (err) { void err; } });
            rail.remove();
        },
    });
}