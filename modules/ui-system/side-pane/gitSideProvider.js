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
import { createGitContextMenu } from './git/context-menu.js';
import { createGitCards } from './git/cards.js';

import { computeLineDiff } from '../line-diff.js';
import { pickProjectsForWorkspace } from '../project-plan-model.js';
import { toWorkspaceRelative, findStatusItem } from '../git-file-diff.js';
import { placeMenuAt } from './menu-position.js';
import { filterAiTouched, latestAiBatch, buildHunkRows } from './git/diff-model.js';
export { filterAiTouched, latestAiBatch, buildHunkRows } from './git/diff-model.js';

// 与 V工程 Git 页（ProjectForgemodules/projectforge-git.js）同一个 key，两处跟随同一个工作区选择。
const STORAGE_KEY_WS = 'vcp-projectforge-git-workspace';
const FOLLOW_WORKSPACE_EVENT = 'vcp:git-follow-workspace';
const STORAGE_KEY_SOURCE = 'vcp-side-pane-git-source';
const POLL_INTERVAL_MS = 8000;
const CHANGE_EVENT = 'vcp:git-changed';
const FOCUS_EVENT = 'vcp:git-focus-path';
const AI_SOURCE = 'ai-last';

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

            const store = Object.freeze({
                get currentWorkspaceId() { return currentWorkspaceId; },
                get isDisposed() { return isDisposed; }
            });

            const contextMenuOwner = createGitContextMenu({
                store,
                api,
                doc,
                placeMenuAt,
                toast,
                win,
                workspaceOf
            });
            const { openContextMenu } = contextMenuOwner;

            const cardsOwner = createGitCards({
                store,
                api,
                buildHunkRows,
                computeLineDiff,
                doc,
                keyOf,
                list,
                openContextMenu: (...args) => openContextMenu(...args)
            });
            const { cardFor, buildCard } = cardsOwner;

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

            // ── diff 读取（行上的 +N -N 和展开内容共用一份缓存）──────────

            // ── 卡片 ────────────────────────────────────────────────

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
                cardsOwner.prefetch(items);
            }

            // ── 数据 ────────────────────────────────────────────────
            function resetForStatusChange() {
                cardsOwner.reset();
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
                    if (quiet && statusKey === lastStatusKey && !cardsOwner.hasExpanded()) { skipRender = true; return; }
                    if (statusKey !== lastStatusKey) { cardsOwner.clearDiff(); }
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
                cardsOwner.expand(found);
                render();
                cardFor(found)?.scrollIntoView?.({ block: 'nearest' });
            }
            win.addEventListener(FOCUS_EVENT, applyPendingFocus);

            // ── 事件 ────────────────────────────────────────────────
            sourceSelect.addEventListener('change', async () => {
                currentSource = sourceSelect.value;
                storage?.setItem(STORAGE_KEY_SOURCE, currentSource);
                cardsOwner.clearExpanded();
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

            const handle = {
                focus() {
                    sourceSelect.focus();
                },
                refresh() {
                    return refreshStatus({ quiet: false });
                },
                async dispose() {
                    isDisposed = true;
                    contextMenuOwner.dispose();
                    cardsOwner.dispose();
                    win.removeEventListener(CHANGE_EVENT, onExternalChange);
                    win.removeEventListener(FOCUS_EVENT, applyPendingFocus);
                    win.removeEventListener(FOLLOW_WORKSPACE_EVENT, onFollowWorkspace);
                    try { if (typeof offForge === 'function') offForge(); } catch (_e) { /* 已取消 */ }
                    if (pollTimer) clearInterval(pollTimer);
                    pollTimer = null;
                }
            };

            render();
            // 上面已经挂了监听和轮询；首次加载出错时要先拆掉再往外抛，不然没有句柄可以释放
            try {
                await loadWorkspaces();
                if (pendingFocusPath) await applyPendingFocus();
            } catch (error) {
                await handle.dispose();
                throw error;
            }
            return handle;
        }
    });
}
