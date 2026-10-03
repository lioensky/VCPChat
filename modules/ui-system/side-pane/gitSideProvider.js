/**
 * modules/ui-system/side-pane/gitSideProvider.js
 * VCPChat Universal Sub-screen - Git 变更 Provider
 *
 * 照 ZCode `GitPane` / `GitPaneChangeCard`（zai-org/ZCode，Apache-2.0）复刻，只保留它有的东西：
 * 1. 顶栏：来源下拉（未暂存 / 已暂存 / 上一轮）+ 幽灵「刷新」按钮。
 * 2. 平铺的变更列表，每行一张卡片：文件名 + 暗色目录、`+N -N`、展开时翻转 180° 的箭头。
 * 3. 右键菜单：在文件管理器中打开 / 复制绝对路径 / 复制相对路径。
 * 4. 展开后显示 diff（加载中 / 文本 diff / 无法预览的说明）。
 * 5. 空状态：居中图标 + 标题 + 描述。
 *
 * 和 ZCode 的差别只有数据来源：「上一轮」在 VCPChat 里是 V工程 最近一批施工触碰过的文件。
 * 暂存、提交、推送、分支切换、提交图都留在 ProjectForge 和对话状态面板里，这里不重复做。
 */

'use strict';

import { computeLineDiff } from './codeViewerSideProvider.js';
import { pickProjectsForWorkspace } from '../project-plan-model.js';
import { toWorkspaceRelative, findStatusItem } from '../git-file-diff.js';
import { placeMenuAt } from './menu-position.js';

// 与 V工程 Git 页（ProjectForgemodules/projectforge-git.js）同一个 key，两处跟随同一个工作区选择。
const STORAGE_KEY_WS = 'vcp-projectforge-git-workspace';
const FOLLOW_WORKSPACE_EVENT = 'vcp:git-follow-workspace';
const STORAGE_KEY_SOURCE = 'vcp-side-pane-git-source';
const POLL_INTERVAL_MS = 8000;
const CHANGE_EVENT = 'vcp:git-changed';
const FOCUS_EVENT = 'vcp:git-focus-path';
const AI_SOURCE = 'ai-last';
const COUNT_PREFETCH_LIMIT = 80;
const COUNT_PREFETCH_CONCURRENCY = 3;
const DIFF_CONTEXT_LINES = 3;
const DIFF_MAX_ROWS = 600;

const normalizePath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

/**
 * 「上一轮」来源：V工程最近一批施工触碰过的文件里，仍有未提交改动的那些。
 * V工程记的路径可能是绝对路径也可能是相对路径，Git 状态里是相对仓库根的路径，所以按路径后缀对齐。
 */
export function filterAiTouched(items, batchFiles) {
    const wanted = (batchFiles || []).map(normalizePath).filter(Boolean);
    if (!wanted.length) return [];
    return (items || []).filter((item) => {
        const path = normalizePath(item.path);
        return wanted.some((file) => file === path || file.endsWith('/' + path) || path.endsWith('/' + file));
    });
}

/** 从 project-forge:get-project 的返回取最近一批施工（时间线已按新到旧排列）。 */
export function latestAiBatch(detail) {
    const timeline = Array.isArray(detail?.timeline) ? detail.timeline : [];
    const batch = timeline.reduce((best, row) => (!best || Number(row.id) > Number(best.id) ? row : best), null);
    if (!batch) return null;
    return {
        id: batch.id,
        kind: batch.kind,
        reason: batch.reason || '',
        maid: batch.maid || '',
        createdAt: batch.created_at || '',
        files: Array.isArray(batch.files) ? batch.files : [],
        projectName: detail?.project?.name || ''
    };
}

/** 把整文件对比的行裁成带 3 行上下文的 hunk 列表，跳过的部分用 hunk 分隔行表示。 */
export function buildHunkRows(rows, contextLines = DIFF_CONTEXT_LINES) {
    const keep = new Array(rows.length).fill(false);
    rows.forEach((row, index) => {
        if (row.type === 'same') return;
        for (let i = Math.max(0, index - contextLines); i <= Math.min(rows.length - 1, index + contextLines); i++) keep[i] = true;
    });
    const out = [];
    let skipped = false;
    rows.forEach((row, index) => {
        if (!keep[index]) {
            skipped = true;
            return;
        }
        if (skipped && out.length) out.push({ type: 'hunk', text: '···' });
        skipped = false;
        out.push(row);
    });
    return out;
}

function getStorage(doc) {
    try {
        return doc?.defaultView?.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
    } catch (_e) {
        return null;
    }
}

export function createGitSideProvider({
    electronAPI = null,
    sidePaneController = null,
    uiHelper = null
} = {}) {
    const api = electronAPI || (typeof window !== 'undefined' ? (window.electronAPI || window.utilityAPI) : null);

    // 回答里「本轮改动」点 +N -N 时请求定位到某个文件；标签还没挂载就先存着，挂载完成后取走
    let pendingFocusPath = null;

    return Object.freeze({
        kind: 'git',

        async openGitTab({ focusPath = null, ...options } = {}) {
            if (!sidePaneController) return null;
            if (focusPath) pendingFocusPath = focusPath;
            const tabDesc = {
                id: options.id || 'side-pane-git',
                kind: 'git',
                title: options.title || 'Git 变更',
                icon: 'branch',
                closable: true,
                scopeMode: 'global',
                ...options
            };
            const handle = await sidePaneController.openTab(tabDesc);
            sidePaneController.setVisible(true);
            handle?.focus?.();
            // 已经挂载的标签不会再走 mountTab，用事件通知它去定位；新挂载的标签自己在加载完后取 pendingFocusPath
            if (focusPath && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('vcp:git-focus-path'));
            return handle;
        },

        /** 切话题时跟到该话题的工作区：已打开的标签马上切，没打开的下次打开时用它 */
        followWorkspace(workspaceId) {
            if (!workspaceId || typeof window === 'undefined') return;
            try { window.localStorage?.setItem(STORAGE_KEY_WS, workspaceId); } catch (_e) { /* 存不了就只通知已打开的标签 */ }
            window.dispatchEvent(new CustomEvent(FOLLOW_WORKSPACE_EVENT, { detail: { workspaceId } }));
        },

        async mountTab(tabDescriptor, viewElement) {
            if (!viewElement) return null;

            const doc = viewElement.ownerDocument || document;
            const win = doc.defaultView || window;
            const storage = getStorage(doc);

            viewElement.innerHTML = '';
            viewElement.classList.add('side-git-view');

            // ── 状态 ────────────────────────────────────────────────
            let workspaces = [];
            let currentWorkspaceId = storage?.getItem(STORAGE_KEY_WS) || null;
            let currentSource = storage?.getItem(STORAGE_KEY_SOURCE) || 'unstaged';
            if (currentSource === 'all') currentSource = 'unstaged'; // 旧版本的「全部更改」
            let aiBatch = null;
            let aiBatchLoaded = false;
            let aiLoadSeq = 0;
            let currentStatus = null;
            let loadError = null;
            let loading = false;
            let pollTimer = null;
            let isDisposed = false;
            let lastStatusKey = null;
            const expanded = new Set();          // `${staged}:${path}`，最多一个
            const diffCache = new Map();         // key -> { state:'loading'|'ready'|'unavailable', ... }
            let countQueue = [];
            let countWorkers = 0;
            let contextMenu = null;

            // ── 骨架：顶栏 + 列表 ────────────────────────────────────
            const root = doc.createElement('section');
            root.className = 'side-git-container';

            const header = doc.createElement('div');
            header.className = 'side-git-header';

            const sourceSelect = doc.createElement('select');
            sourceSelect.className = 'side-git-source-select';
            sourceSelect.setAttribute('aria-label', '选择变更来源');
            [['unstaged', '未暂存'], ['staged', '已暂存']].forEach(([value, label]) => {
                const opt = doc.createElement('option');
                opt.value = value;
                opt.textContent = label;
                sourceSelect.appendChild(opt);
            });
            // ZCode 的「上一轮」：VCPChat 里一轮 = V工程 的一批施工
            if (api?.projectForgeGetProject && api?.projectForgeListProjects) {
                const opt = doc.createElement('option');
                opt.value = AI_SOURCE;
                opt.textContent = '上一轮';
                sourceSelect.appendChild(opt);
            }
            if (!Array.from(sourceSelect.options).some(o => o.value === currentSource)) currentSource = 'unstaged';
            sourceSelect.value = currentSource;

            // 只有登记了多个工作区才需要选；一个时自动使用，不占位置。
            const wsSelect = doc.createElement('select');
            wsSelect.className = 'side-git-ws-select';
            wsSelect.setAttribute('aria-label', '选择 Git 工作区');
            wsSelect.hidden = true;

            const refreshBtn = doc.createElement('button');
            refreshBtn.type = 'button';
            refreshBtn.className = 'side-git-refresh-btn';
            refreshBtn.innerHTML = '<span class="vcp-ui-icon">refresh</span><span>刷新</span>';

            header.append(sourceSelect, wsSelect, refreshBtn);

            const body = doc.createElement('div');
            body.className = 'side-git-body';
            const list = doc.createElement('div');
            list.className = 'side-git-list';
            const empty = doc.createElement('div');
            empty.className = 'side-git-empty';
            empty.hidden = true;
            body.append(list, empty);

            root.append(header, body);
            viewElement.appendChild(root);

            // ── 工具 ────────────────────────────────────────────────
            const toast = (text, type = 'info') => uiHelper?.showToastNotification?.(text, type);
            const workspaceOf = (id) => workspaces.find(ws => ws.id === id) || null;
            const keyOf = (item) => `${item.staged ? 1 : 0}:${item.path}`;

            function visibleItems() {
                if (!currentStatus?.isRepo) return [];
                const staged = (currentStatus.staged || []).map(i => ({ ...i, staged: true }));
                const unstaged = [...(currentStatus.conflicts || []), ...(currentStatus.changes || [])].map(i => ({ ...i, staged: false }));
                if (currentSource === 'staged') return staged;
                if (currentSource === AI_SOURCE) {
                    const files = aiBatch?.files || [];
                    return [...filterAiTouched(staged, files).map(i => ({ ...i, staged: true })), ...filterAiTouched(unstaged, files).map(i => ({ ...i, staged: false }))];
                }
                return unstaged;
            }

            function showEmpty({ icon = 'description', title, description, action = null }) {
                list.innerHTML = '';
                empty.hidden = false;
                empty.innerHTML = '';
                const iconEl = doc.createElement('span');
                iconEl.className = 'vcp-ui-icon side-git-empty-icon';
                iconEl.textContent = icon;
                const titleEl = doc.createElement('p');
                titleEl.className = 'side-git-empty-title';
                titleEl.textContent = title;
                const descEl = doc.createElement('p');
                descEl.className = 'side-git-empty-desc';
                descEl.textContent = description;
                empty.append(iconEl, titleEl, descEl);
                if (action) {
                    const btn = doc.createElement('button');
                    btn.type = 'button';
                    btn.className = 'side-git-empty-add';
                    btn.textContent = action.label;
                    btn.addEventListener('click', action.run);
                    empty.appendChild(btn);
                }
            }

            function emptyCopy() {
                if (currentSource === AI_SOURCE) {
                    return aiBatch
                        ? { title: '上一轮的改动已经没有未提交内容', description: '这一批涉及的文件都已提交或还原。' }
                        : { title: '当前工作区还没有上一轮文件改动', description: '这个工作区没有 V工程 工程，或工程里还没有施工批次。' };
                }
                return { title: '当前来源下没有可展示的改动', description: '可以切换其它来源，或等当前工作区产生新的 Git 改动后再查看。' };
            }

            // ── 复制 / 定位 ─────────────────────────────────────────
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
                const ws = workspaceOf(currentWorkspaceId);
                if (!ws) return item.path;
                const sep = ws.path.includes('\\') ? '\\' : '/';
                return ws.path.replace(/[\\/]+$/, '') + sep + item.path.split('/').join(sep);
            }

            async function revealInFileManager(item) {
                try {
                    const res = await api.gitRevealPath(currentWorkspaceId, item.path);
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

            // ── diff 读取（行上的 +N -N 和展开内容共用一份缓存）──────────
            async function fetchDiff(item) {
                const key = keyOf(item);
                const cached = diffCache.get(key);
                if (cached && cached.state !== 'loading') return cached;
                if (cached?.promise) return cached.promise;
                const requestedWorkspace = currentWorkspaceId;
                const promise = (async () => {
                    let result;
                    try {
                        const res = await api.gitDiff(requestedWorkspace, item.path, { staged: item.staged, origPath: item.origPath || undefined });
                        if (!res?.success) throw new Error(res?.error || '获取差异失败');
                        const { before, after } = res.data || {};
                        if ([before, after].some(side => side?.binary)) {
                            const tooLarge = [before, after].some(side => side?.tooLarge);
                            result = { state: 'unavailable', message: tooLarge ? '文件过大，无法预览这个 Diff。' : '二进制文件，无法预览文本 Diff。' };
                        } else {
                            const lcs = computeLineDiff(before?.text || '', after?.text || '');
                            result = {
                                state: 'ready',
                                rows: buildHunkRows(lcs.rows),
                                added: lcs.addedCount,
                                removed: lcs.deletedCount,
                                approximate: lcs.approximate,
                                truncated: Boolean(before?.truncated || after?.truncated)
                            };
                        }
                    } catch (err) {
                        result = { state: 'unavailable', message: err.message || '暂时无法预览这个 Diff。' };
                    }
                    if (requestedWorkspace === currentWorkspaceId && !isDisposed) diffCache.set(key, result);
                    return result;
                })();
                diffCache.set(key, { state: 'loading', promise });
                return promise;
            }

            function paintCounts(item, card) {
                const cached = diffCache.get(keyOf(item));
                const countsEl = card.querySelector('.side-git-counts');
                if (!countsEl || cached?.state !== 'ready') return;
                countsEl.innerHTML = '';
                const add = doc.createElement('span');
                add.className = 'text-diff-added';
                add.textContent = `${cached.approximate ? '~' : ''}+${cached.added}`;
                const del = doc.createElement('span');
                del.className = 'text-diff-removed';
                del.textContent = `${cached.approximate ? '~' : ''}-${cached.removed}`;
                countsEl.append(add, del);
            }

            function cardFor(item) {
                return [...list.querySelectorAll('.side-git-card')].find(el => el.dataset.key === keyOf(item)) || null;
            }

            function pumpCountQueue() {
                while (countWorkers < COUNT_PREFETCH_CONCURRENCY && countQueue.length) {
                    const item = countQueue.shift();
                    countWorkers += 1;
                    fetchDiff(item).then(() => {
                        if (isDisposed) return;
                        const card = cardFor(item);
                        if (card) paintCounts(item, card);
                    }).finally(() => {
                        countWorkers -= 1;
                        pumpCountQueue();
                    });
                }
            }

            // ── 卡片 ────────────────────────────────────────────────
            function renderDiffBody(item, container) {
                const cached = diffCache.get(keyOf(item));
                container.innerHTML = '';
                if (!cached || cached.state === 'loading') {
                    container.innerHTML = '<div class="side-git-diff-loading">加载中…</div>';
                    return;
                }
                if (cached.state !== 'ready') {
                    const msg = doc.createElement('div');
                    msg.className = 'side-git-diff-message';
                    msg.textContent = cached.message;
                    container.appendChild(msg);
                    return;
                }
                if (!cached.rows.length) {
                    const msg = doc.createElement('div');
                    msg.className = 'side-git-diff-message';
                    msg.textContent = '这个文件没有文本层面的改动。';
                    container.appendChild(msg);
                    return;
                }
                const table = doc.createElement('table');
                table.className = 'side-git-diff-table';
                cached.rows.slice(0, DIFF_MAX_ROWS).forEach((row) => {
                    const tr = doc.createElement('tr');
                    if (row.type === 'hunk') {
                        tr.className = 'diff-line hunk';
                        const cell = doc.createElement('td');
                        cell.colSpan = 3;
                        cell.className = 'diff-content';
                        cell.textContent = row.text;
                        tr.appendChild(cell);
                    } else {
                        tr.className = `diff-line ${row.type}`;
                        const oldNum = doc.createElement('td');
                        oldNum.className = 'diff-num';
                        oldNum.textContent = row.oldLine !== null ? String(row.oldLine) : '';
                        const newNum = doc.createElement('td');
                        newNum.className = 'diff-num';
                        newNum.textContent = row.newLine !== null ? String(row.newLine) : '';
                        const content = doc.createElement('td');
                        content.className = 'diff-content';
                        content.textContent = `${row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}${row.text}`;
                        tr.append(oldNum, newNum, content);
                    }
                    table.appendChild(tr);
                });
                container.appendChild(table);
                const notes = [];
                if (cached.rows.length > DIFF_MAX_ROWS) notes.push(`还有 ${cached.rows.length - DIFF_MAX_ROWS} 行未显示`);
                if (cached.truncated) notes.push('文件较大，只对比了前面一部分');
                if (notes.length) {
                    const note = doc.createElement('div');
                    note.className = 'side-git-diff-message';
                    note.textContent = notes.join('；');
                    container.appendChild(note);
                }
            }

            function buildCard(item) {
                const key = keyOf(item);
                const card = doc.createElement('div');
                card.className = 'side-git-card';
                card.dataset.key = key;
                card.dataset.path = item.path;

                const row = doc.createElement('button');
                row.type = 'button';
                row.className = 'side-git-row';
                const isOpen = expanded.has(key);
                row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
                row.classList.toggle('is-expanded', isOpen);

                const slash = item.path.lastIndexOf('/');
                const name = doc.createElement('span');
                name.className = 'side-git-file-name';
                name.textContent = slash >= 0 ? item.path.slice(slash + 1) : item.path;
                const label = doc.createElement('span');
                label.className = 'side-git-file-label';
                label.title = item.path;
                label.appendChild(name);
                if (slash > 0) {
                    const dir = doc.createElement('span');
                    dir.className = 'side-git-file-dir';
                    dir.textContent = item.path.slice(0, slash);
                    label.appendChild(dir);
                }

                const meta = doc.createElement('span');
                meta.className = 'side-git-row-meta';
                const counts = doc.createElement('span');
                counts.className = 'side-git-counts';
                const chevron = doc.createElement('span');
                chevron.className = 'vcp-ui-icon side-git-chevron';
                chevron.textContent = 'expand_more';
                meta.append(counts, chevron);
                row.append(label, meta);
                card.appendChild(row);

                const diffBox = doc.createElement('div');
                diffBox.className = 'side-git-diff';
                diffBox.hidden = !isOpen;
                card.appendChild(diffBox);

                const open = () => {
                    renderDiffBody(item, diffBox);
                    fetchDiff(item).then(() => {
                        if (isDisposed || !expanded.has(key)) return;
                        renderDiffBody(item, diffBox);
                        paintCounts(item, card);
                    });
                };

                row.addEventListener('click', () => {
                    const nowOpen = !expanded.has(key);
                    // 同一时间只展开一个文件（ZCode expandedPath），打开新的就收起旧的
                    expanded.forEach((otherKey) => {
                        if (otherKey === key) return;
                        const other = [...list.querySelectorAll('.side-git-card')].find(el => el.dataset.key === otherKey);
                        other?.querySelector('.side-git-row')?.setAttribute('aria-expanded', 'false');
                        other?.querySelector('.side-git-row')?.classList.remove('is-expanded');
                        const otherDiff = other?.querySelector('.side-git-diff');
                        if (otherDiff) otherDiff.hidden = true;
                    });
                    expanded.clear();
                    if (nowOpen) expanded.add(key);
                    row.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
                    row.classList.toggle('is-expanded', nowOpen);
                    diffBox.hidden = !nowOpen;
                    if (nowOpen) open();
                });
                row.addEventListener('contextmenu', (event) => openContextMenu(event, item));

                paintCounts(item, card);
                if (isOpen) open();
                return card;
            }

            // ── 渲染 ────────────────────────────────────────────────
            function render() {
                if (isDisposed) return;
                refreshBtn.disabled = loading;
                refreshBtn.classList.toggle('spinning', loading);
                if (!workspaces.length) {
                    showEmpty({
                        icon: 'folder_x',
                        title: '还没有工作区',
                        description: '添加一个 Git 项目目录后，就能在这里查看它的改动。',
                        action: { label: '添加工作区', run: () => addWorkspaceFlow() }
                    });
                    return;
                }
                if (loadError) {
                    showEmpty({ icon: 'error', title: '无法加载 Git 改动', description: `Git 返回错误：${loadError}` });
                    return;
                }
                if (!currentStatus) {
                    showEmpty({ title: '加载中', description: '正在读取当前工作区的 Git 状态和文件改动。' });
                    return;
                }
                if (currentStatus.isRepo === false) {
                    showEmpty({ icon: 'folder_x', title: '当前工作区不在 Git 仓库中', description: '请切换到包含 .git 的工作区目录，或先在该目录执行 git init。' });
                    return;
                }
                const items = visibleItems();
                if (!items.length) {
                    showEmpty({ ...emptyCopy() });
                    return;
                }
                empty.hidden = true;
                list.innerHTML = '';
                items.forEach(item => list.appendChild(buildCard(item)));
                countQueue = items.slice(0, COUNT_PREFETCH_LIMIT).filter(item => !diffCache.has(keyOf(item)));
                pumpCountQueue();
            }

            // ── 数据 ────────────────────────────────────────────────
            function resetForStatusChange() {
                expanded.clear();
                diffCache.clear();
                countQueue = [];
                lastStatusKey = null;
            }

            async function loadAiBatch() {
                const seq = ++aiLoadSeq;
                let batch = null;
                try {
                    const workspace = workspaceOf(currentWorkspaceId);
                    const listed = workspace ? await api.projectForgeListProjects({}) : null;
                    const projects = pickProjectsForWorkspace((listed?.success ? listed.data : []).filter(p => !p.deleted_at), workspace);
                    // 最近更新的工程优先；没有施工批次就顺延到下一个
                    for (const project of projects) {
                        const detail = await api.projectForgeGetProject(project.id);
                        batch = detail?.success ? latestAiBatch(detail.data) : null;
                        if (batch) break;
                    }
                } catch (_e) { batch = null; }
                if (seq !== aiLoadSeq || isDisposed) return;
                aiBatch = batch;
                aiBatchLoaded = true;
            }

            async function refreshStatus({ quiet = false } = {}) {
                if (!api?.gitStatus || !currentWorkspaceId || isDisposed) return;
                if (!quiet) { loading = true; render(); }
                let skipRender = false;
                try {
                    const requestedId = currentWorkspaceId;
                    const res = await api.gitStatus(requestedId);
                    if (isDisposed || requestedId !== currentWorkspaceId) return;
                    if (!res?.success) throw new Error(res?.error || '获取 Git 状态失败');
                    loadError = null;
                    currentStatus = res.data;
                    if (currentSource === AI_SOURCE && !aiBatchLoaded) await loadAiBatch();
                    if (isDisposed || requestedId !== currentWorkspaceId) return;
                    // 后台轮询：状态没变就不重绘（避免闪烁、丢 hover），有展开的 diff 时照常重绘。
                    const statusKey = JSON.stringify(res.data);
                    if (quiet && statusKey === lastStatusKey && expanded.size === 0) { skipRender = true; return; }
                    if (statusKey !== lastStatusKey) { expanded.clear(); diffCache.clear(); }
                    lastStatusKey = statusKey;
                } catch (err) {
                    if (quiet) return;
                    loadError = err.message;
                } finally {
                    if (!isDisposed) { loading = false; if (!skipRender || !quiet) render(); }
                }
            }

            async function addWorkspaceFlow() {
                if (!api?.selectWorkspaceDirectory || !api?.addWorkspace) {
                    toast('当前窗口不支持添加工作区', 'error');
                    return;
                }
                try {
                    const picked = await api.selectWorkspaceDirectory();
                    if (!picked?.success || !picked.path) return;
                    const added = await api.addWorkspace(picked.path);
                    if (!added?.success) throw new Error(added?.error || '添加工作区失败');
                    await loadWorkspaces({ preferPath: picked.path });
                } catch (err) {
                    toast(err.message, 'error');
                }
            }

            async function loadWorkspaces({ preferPath = null } = {}) {
                if (!api?.gitListWorkspaces) return;
                try {
                    const res = await api.gitListWorkspaces();
                    if (!res?.success) throw new Error(res?.error || '加载工作区失败');
                    workspaces = Array.isArray(res.data?.workspaces) ? res.data.workspaces : [];
                    const activeId = res.data?.activeWorkspaceId || null;
                    wsSelect.innerHTML = '';
                    workspaces.forEach(ws => {
                        const opt = doc.createElement('option');
                        opt.value = ws.id;
                        opt.textContent = ws.alias || ws.path;
                        opt.title = ws.path;
                        wsSelect.appendChild(opt);
                    });
                    wsSelect.hidden = workspaces.length < 2;
                    const preferred = preferPath ? workspaces.find(ws => ws.path === preferPath) : null;
                    if (preferred) currentWorkspaceId = preferred.id;
                    else if (!workspaces.some(ws => ws.id === currentWorkspaceId)) {
                        currentWorkspaceId = (workspaces.find(ws => ws.id === activeId) || workspaces[0])?.id || null;
                    }
                    if (currentWorkspaceId) {
                        wsSelect.value = currentWorkspaceId;
                        storage?.setItem(STORAGE_KEY_WS, currentWorkspaceId);
                    } else {
                        currentStatus = null;
                        render();
                        return;
                    }
                    resetForStatusChange();
                    aiBatchLoaded = false;
                    await refreshStatus({ quiet: false });
                } catch (err) {
                    loadError = err.message;
                    render();
                }
            }

            // ── 定位到某个文件：切到有它的工作区 / 来源，展开它的 diff，滚到可见 ──
            async function applyPendingFocus() {
                const target = pendingFocusPath;
                if (!target || isDisposed) return;
                pendingFocusPath = null;
                const located = toWorkspaceRelative(target, workspaces);
                if (located && located.workspace.id !== currentWorkspaceId) {
                    currentWorkspaceId = located.workspace.id;
                    wsSelect.value = currentWorkspaceId;
                    storage?.setItem(STORAGE_KEY_WS, currentWorkspaceId);
                    currentStatus = null;
                    resetForStatusChange();
                    aiBatchLoaded = false;
                }
                await refreshStatus({ quiet: false });
                if (isDisposed) return;
                const found = findStatusItem(currentStatus, located ? located.relPath : target);
                if (!found) {
                    toast('这个文件在当前工作区里已经没有未提交的改动。', 'info');
                    return;
                }
                currentSource = found.staged ? 'staged' : 'unstaged';
                sourceSelect.value = currentSource;
                storage?.setItem(STORAGE_KEY_SOURCE, currentSource);
                expanded.clear();
                expanded.add(keyOf(found));
                render();
                cardFor(found)?.scrollIntoView?.({ block: 'nearest' });
            }
            win.addEventListener(FOCUS_EVENT, applyPendingFocus);

            // ── 事件 ────────────────────────────────────────────────
            sourceSelect.addEventListener('change', async () => {
                currentSource = sourceSelect.value;
                storage?.setItem(STORAGE_KEY_SOURCE, currentSource);
                expanded.clear();
                if (currentSource === AI_SOURCE) {
                    aiBatchLoaded = false;
                    await loadAiBatch();
                }
                render();
            });

            const switchWorkspace = (workspaceId) => {
                currentWorkspaceId = workspaceId;
                wsSelect.value = workspaceId;
                storage?.setItem(STORAGE_KEY_WS, currentWorkspaceId);
                currentStatus = null;
                resetForStatusChange();
                aiBatchLoaded = false;
                refreshStatus({ quiet: false });
            };
            wsSelect.addEventListener('change', () => switchWorkspace(wsSelect.value));

            const onFollowWorkspace = (event) => {
                const id = event.detail?.workspaceId;
                if (isDisposed || !id || id === currentWorkspaceId) return;
                if (!workspaces.some(ws => ws.id === id)) return;
                switchWorkspace(id);
            };
            win.addEventListener(FOLLOW_WORKSPACE_EVENT, onFollowWorkspace);

            refreshBtn.addEventListener('click', () => refreshStatus({ quiet: false }));

            // 状态面板里提交 / 推送 / 切分支后，这里马上跟上；V工程 记下新一批施工时刷新「上一轮」
            const onExternalChange = (event) => {
                if (event.detail?.source === 'git-tab' || isDisposed) return;
                resetForStatusChange();
                refreshStatus({ quiet: true });
            };
            win.addEventListener(CHANGE_EVENT, onExternalChange);
            const offForge = api?.onProjectForgeChanged?.(() => {
                aiBatchLoaded = false;
                if (currentSource === AI_SOURCE && !isDisposed) { lastStatusKey = null; refreshStatus({ quiet: true }); }
            });

            pollTimer = setInterval(() => {
                if (!isDisposed && viewElement.offsetParent !== null) refreshStatus({ quiet: true });
            }, POLL_INTERVAL_MS);

            render();
            await loadWorkspaces();
            if (pendingFocusPath) await applyPendingFocus();

            return {
                focus() {
                    sourceSelect.focus();
                },
                refresh() {
                    return refreshStatus({ quiet: false });
                },
                async dispose() {
                    isDisposed = true;
                    closeContextMenu();
                    win.removeEventListener(CHANGE_EVENT, onExternalChange);
                    win.removeEventListener(FOCUS_EVENT, applyPendingFocus);
                    win.removeEventListener(FOLLOW_WORKSPACE_EVENT, onFollowWorkspace);
                    try { if (typeof offForge === 'function') offForge(); } catch (_e) { /* 已取消 */ }
                    if (pollTimer) clearInterval(pollTimer);
                    pollTimer = null;
                }
            };
        }
    });
}
