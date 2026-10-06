/**
 * modules/ui-system/side-pane/git/git-view.js
 * V工程 计划标签里的 Git 页（原先是单独的 Git 变更标签）
 *
 * 照 ZCode `GitPane` / `GitPaneChangeCard`（zai-org/ZCode，Apache-2.0）复刻，只保留它有的东西：
 * 1. 顶栏：来源下拉（未暂存 / 已暂存 / 上一轮）+ 工作区下拉 + 「刷新」，都是胶囊。
 * 2. 平铺的变更列表，每行一张卡片：文件名 + 暗色目录、`+N -N`、展开时翻转 180° 的箭头。
 * 3. 右键菜单：在文件管理器中打开 / 复制绝对路径 / 复制相对路径。
 * 4. 展开后显示 diff（加载中 / 文本 diff / 无法预览的说明）。
 * 5. 空状态：居中图标 + 标题 + 描述。
 *
 * 和原实现的差别只有数据来源：「上一轮」在 VCPChat 里是 V工程 最近一批施工触碰过的文件。
 * 暂存、提交、推送、分支切换、提交图都留在 ProjectForge 和对话状态面板里，这里不重复做。
 * 视图挂在调用方给的元素里，自己不开标签；计划标签第一次切到 Git 页时才挂载。
 */

'use strict';
import { createGitContextMenu } from './context-menu.js';
import { createGitCards } from './cards.js';

import { computeLineDiff } from '../../line-diff.js';
import { pickProjectsForWorkspace } from '../../project-plan-model.js';
import { toWorkspaceRelative, findStatusItem } from '../../git-file-diff.js';
import { placeMenuAt } from '../menu-position.js';
import { filterAiTouched, latestAiBatch, buildHunkRows } from './diff-model.js';
import { watchProjectForgeChanges } from '../../sources/projectforge-changes.js';
import { createGitChangesFollower } from '../../sources/git-changes.js';
import { readSelectedGitWorkspace, selectGitWorkspace, watchSelectedGitWorkspace } from '../../sources/git-workspace.js';
import { createSidePaneRootScope } from '../side-pane-occurrence.js';
export { filterAiTouched, latestAiBatch, buildHunkRows } from './diff-model.js';

// 工作区选择和 V工程 Git 页（ProjectForgemodules/projectforge-git.js）共用，见 sources/git-workspace.js。
const STORAGE_KEY_SOURCE = 'vcp-side-pane-git-source';
const AI_SOURCE = 'ai-last';
const SELECTION_ORIGIN = 'git-view';

function getStorage(doc) {
    try {
        return doc?.defaultView?.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
    } catch (_e) {
        return null;
    }
}

/** 切话题时跟到该话题的工作区：已挂载的 Git 页马上切，没挂载的下次挂载时用它 */
export function followGitWorkspace(win, workspaceId) {
    selectGitWorkspace(win, workspaceId, { origin: 'topic' });
}

/**
 * 把 Git 页挂到 host 里。返回的 ready 在第一次读完工作区和状态后完成。
 * preferWorkspace：优先用哪个工作区（计划页传当前工程的 { id, alias }），找不到再用上次的选择。
 * scope：宿主的 scope（计划页这次挂载的 scope）；给了就挂成它的子 scope，宿主释放时 Git 页跟着拆。
 */
export function mountGitView(host, {
    api = null,
    uiHelper = null,
    preferWorkspace = null,
    scope = null
} = {}) {
    if (!host) return null;
    const doc = host.ownerDocument || document;
    const win = doc.defaultView || window;
    const storage = getStorage(doc);
    api = api || win.electronAPI || win.utilityAPI || null;

    host.innerHTML = '';

    // ── 状态 ────────────────────────────────────────────────
    let workspaces = [];
    let currentWorkspaceId = readSelectedGitWorkspace(win);
    let currentSource = storage?.getItem(STORAGE_KEY_SOURCE) || 'unstaged';
    if (currentSource === 'all') currentSource = 'unstaged'; // 旧版本的「全部更改」
    let aiBatch = null;
    let aiBatchLoaded = false;
    let aiLoadSeq = 0;
    let currentStatus = null;
    let loadError = null;
    let loading = false;
    // 监听、推送订阅、右键菜单都归 own；宿主释放 scope 或调用 dispose 时一起拆掉
    const own = createSidePaneRootScope(scope, 'git-view');
    const disposed = () => !own.active;
    // 看不见时收到的变化先记着，重新露出来再读
    let stale = false;
    let lastStatusKey = null;
    // 回答里「本轮改动」点 +N -N 时要定位的文件；首次加载完之前先存着
    let pendingFocusPath = null;
    let preferred = preferWorkspace;

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
    // 「上一轮」：VCPChat 里一轮 = V工程 的一批施工
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

    // 下拉做成胶囊（和浏览器工具栏一套）：select 本身去掉原生外观，箭头由外层补上
    const pill = (select, extra) => {
        const wrap = doc.createElement('span');
        wrap.className = `side-git-select-pill ${extra}`;
        const chevron = doc.createElement('span');
        chevron.className = 'vcp-ui-icon side-git-select-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = 'expand_more';
        wrap.append(select, chevron);
        return wrap;
    };
    header.append(pill(sourceSelect, 'is-source'), pill(wsSelect, 'is-workspace'), refreshBtn);

    const body = doc.createElement('div');
    body.className = 'side-git-body';
    const list = doc.createElement('div');
    list.className = 'side-git-list';
    const empty = doc.createElement('div');
    empty.className = 'side-git-empty';
    empty.hidden = true;
    body.append(list, empty);

    root.append(header, body);
    host.appendChild(root);

    // ── 工具 ────────────────────────────────────────────────
    const toast = (text, type = 'info') => uiHelper?.showToastNotification?.(text, type);
    const workspaceOf = (id) => workspaces.find(ws => ws.id === id) || null;
    const keyOf = (item) => `${item.staged ? 1 : 0}:${item.path}`;

    const store = Object.freeze({
        get currentWorkspaceId() { return currentWorkspaceId; },
        get isDisposed() { return disposed(); }
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
            // 空状态每次重画都重建按钮，监听跟着旧按钮一起丢弃
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
        if (disposed()) return;
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
        if (seq !== aiLoadSeq || disposed()) return;
        aiBatch = batch;
        aiBatchLoaded = true;
    }

    async function refreshStatus({ quiet = false } = {}) {
        // 已经拆掉就不再跟：否则迟到的刷新会把刚退掉的推送重新订上
        if (disposed()) return;
        // 每次读都对准当前工作区的变更推送（换了工作区就换订阅）
        changes.follow(currentWorkspaceId);
        if (!api?.gitStatus || !currentWorkspaceId || disposed()) return;
        stale = false;
        if (!quiet) { loading = true; render(); }
        let skipRender = false;
        try {
            const requestedId = currentWorkspaceId;
            const res = await api.gitStatus(requestedId);
            if (disposed() || requestedId !== currentWorkspaceId) return;
            if (!res?.success) throw new Error(res?.error || '获取 Git 状态失败');
            loadError = null;
            currentStatus = res.data;
            if (currentSource === AI_SOURCE && !aiBatchLoaded) await loadAiBatch();
            if (disposed() || requestedId !== currentWorkspaceId) return;
            // 推送触发的静默刷新：状态没变就不重绘（避免闪烁、丢 hover），有展开的 diff 时照常重绘。
            const statusKey = JSON.stringify(res.data);
            if (quiet && statusKey === lastStatusKey && !cardsOwner.hasExpanded()) { skipRender = true; return; }
            if (statusKey !== lastStatusKey) { cardsOwner.clearDiff(); }
            lastStatusKey = statusKey;
        } catch (err) {
            if (quiet) return;
            loadError = err.message;
        } finally {
            if (!disposed()) { loading = false; if (!skipRender || !quiet) render(); }
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
            const chosen = (preferPath ? workspaces.find(ws => ws.path === preferPath) : null) || matchWorkspace(preferred);
            preferred = null;
            if (chosen) currentWorkspaceId = chosen.id;
            else if (!workspaces.some(ws => ws.id === currentWorkspaceId)) {
                currentWorkspaceId = (workspaces.find(ws => ws.id === activeId) || workspaces[0])?.id || null;
            }
            if (currentWorkspaceId) {
                wsSelect.value = currentWorkspaceId;
                selectGitWorkspace(win, currentWorkspaceId, { origin: SELECTION_ORIGIN });
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

    function matchWorkspace(want) {
        if (!want) return null;
        return workspaces.find(ws => want.id && ws.id === want.id)
            || workspaces.find(ws => want.alias && ws.alias === want.alias)
            || null;
    }

    // ── 定位到某个文件：切到有它的工作区 / 来源，展开它的 diff，滚到可见 ──
    async function applyPendingFocus() {
        const target = pendingFocusPath;
        if (!target || disposed()) return;
        pendingFocusPath = null;
        const located = toWorkspaceRelative(target, workspaces);
        if (located && located.workspace.id !== currentWorkspaceId) {
            currentWorkspaceId = located.workspace.id;
            wsSelect.value = currentWorkspaceId;
            selectGitWorkspace(win, currentWorkspaceId, { origin: SELECTION_ORIGIN });
            currentStatus = null;
            resetForStatusChange();
            aiBatchLoaded = false;
        }
        await refreshStatus({ quiet: false });
        if (disposed()) return;
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

    // ── 事件 ────────────────────────────────────────────────
    own.listen(sourceSelect, 'change', async () => {
        currentSource = sourceSelect.value;
        storage?.setItem(STORAGE_KEY_SOURCE, currentSource);
        cardsOwner.clearExpanded();
        if (currentSource === AI_SOURCE) {
            aiBatchLoaded = false;
            await loadAiBatch();
            if (disposed()) return;
        }
        render();
    });

    const switchWorkspace = (workspaceId) => {
        currentWorkspaceId = workspaceId;
        wsSelect.value = workspaceId;
        selectGitWorkspace(win, currentWorkspaceId, { origin: SELECTION_ORIGIN });
        currentStatus = null;
        resetForStatusChange();
        aiBatchLoaded = false;
        refreshStatus({ quiet: false });
    };
    own.listen(wsSelect, 'change', () => switchWorkspace(wsSelect.value));

    own.subscribe(() => watchSelectedGitWorkspace(win, ({ id, origin }) => {
        if (disposed() || origin === SELECTION_ORIGIN || !id || id === currentWorkspaceId) return;
        if (!workspaces.some(ws => ws.id === id)) return;
        switchWorkspace(id);
    }), 'selected-workspace');

    own.listen(refreshBtn, 'click', () => refreshStatus({ quiet: false }));

    // 收起侧栏只把宽度压成 0 并设 visibility:hidden，offsetParent 仍存在。
    const isShown = () => root.offsetParent !== null && !root.closest('.vcp-side-pane[aria-hidden="true"]');
    const refreshIfStale = () => {
        if (stale && !disposed() && isShown()) refreshStatus({ quiet: true });
    };
    // 仓库变了（这个或别的窗口提交 / 暂存 / 切分支，或者文件改了）主进程推过来，不再定时轮询。
    // Linux 上主进程只看 .git，文件内容的改动靠窗口回到前台时补一次。
    const changes = createGitChangesFollower(api, () => {
        if (disposed()) return;
        if (isShown()) refreshStatus({ quiet: true });
        else stale = true;
    }, { label: 'git-view' });
    own.own(() => changes.release(), 'git-changes', 'subscription');
    const onWindowFocus = () => {
        if (!disposed() && isShown()) refreshStatus({ quiet: true });
    };
    own.listen(win, 'focus', onWindowFocus, undefined, 'window-focus');
    own.listen(root, 'pointerenter', refreshIfStale);
    // 被别的应用标签整个挡住（祖先 display:none）再切回来时，上面几个事件都不触发；
    // 尺寸从 0 恢复会回调这里，没积压的变化就什么也不做
    if (typeof win.ResizeObserver === 'function') {
        own.observe(new win.ResizeObserver(refreshIfStale), root, undefined, 'reveal-observer');
    }
    // V工程 记下新一批施工时刷新「上一轮」
    own.subscribe(() => watchProjectForgeChanges(api, () => {
        aiBatchLoaded = false;
        if (currentSource === AI_SOURCE && !disposed()) { lastStatusKey = null; refreshStatus({ quiet: true }); }
    }, { label: 'git-view' }), 'projectforge-changes');
    // 右键菜单挂在 body 上；先登记的后释放，所以卡片缓存最后清
    own.own(() => cardsOwner.dispose(), 'cards');
    own.own(() => contextMenuOwner.dispose(), 'context-menu');

    render();
    // 首次加载：读工作区，再按需定位到某个文件。出错画在空状态里，不往外抛
    const ready = loadWorkspaces()
        .then(() => (pendingFocusPath ? applyPendingFocus() : null))
        .catch((err) => { loadError = err?.message || String(err); render(); });

    return Object.freeze({
        element: root,
        ready,
        focus() {
            sourceSelect.focus();
        },
        refresh() {
            return refreshStatus({ quiet: false });
        },
        /** 重新露出来时调：看不见期间仓库变过就静默重读一次 */
        refreshIfStale,
        /** 展开某个文件的 diff（绝对路径或工作区内的相对路径） */
        async focusPath(target) {
            if (!target || disposed()) return;
            pendingFocusPath = target;
            await ready;
            await applyPendingFocus();
        },
        /** 换到工程所在的工作区（{ id, alias }）；没登记这个工作区就不动 */
        async useWorkspace(want) {
            if (disposed() || !want) return;
            await ready;
            const match = matchWorkspace(want);
            if (!disposed() && match && match.id !== currentWorkspaceId) switchWorkspace(match.id);
        },
        dispose() {
            // DOM 同步清掉：scope 的释放是异步的，不能等它
            if (!disposed()) host.innerHTML = '';
            return own.dispose('git-view-disposed');
        }
    });
}
