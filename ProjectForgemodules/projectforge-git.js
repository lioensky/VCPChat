// ProjectForgemodules/projectforge-git.js
// 侧栏滑动分页（工程 / Git）与 Git 源代码管理视图。
// 与 projectforge.js 同为经典脚本，直接复用其顶层工具：
//   api、$、escapeHtml、toast、confirmDialog、modeForPath、isLightTheme、state、DIFF_WRAP_KEY、syncDiffWrapButton
// Git 操作全部在主进程执行（modules/ipc/gitHandlers.js），这里只传工作区 id 与仓库相对路径。
'use strict';

(() => {
    const SIDE_TAB_KEY = 'vcp-projectforge-side-tab';
    const GIT_WS_KEY = 'vcp-projectforge-git-workspace';
    const POLL_MS = 8000;
    const MAX_CONFIRM_LIST = 8;

    const GROUPS = [
        { key: 'conflicts', title: '合并冲突' },
        { key: 'staged', title: '暂存的更改' },
        { key: 'changes', title: '更改' },
    ];
    const GROUP_TITLE = Object.fromEntries(GROUPS.map(g => [g.key, g.title]));
    const STATUS_TEXT = { M: '已修改', A: '已添加', D: '已删除', R: '已重命名', C: '已复制', T: '类型变更', U: '未跟踪' };
    const LEGEND = { staged: ['HEAD', '暂存区'], changes: ['暂存区', '工作区'], conflicts: ['暂存区（ours）', '工作区'] };
    const OP_LABEL = { stage: '暂存', unstage: '取消暂存', discard: '放弃更改', commit: '提交', push: '推送' };

    const git = {
        enabled: false,
        workspaces: [],
        workspaceId: null,
        status: null,
        selected: { conflicts: new Set(), staged: new Set(), changes: new Set() },
        anchor: null,
        collapsed: new Set(),
        drafts: new Map(),
        busy: false,
        busyOp: null,
        loading: false,
        statusSeq: 0,
        diffSeq: 0,
        current: null,
        diffData: null,
        diffView: null,
        pollTimer: null,
    };

    // ============================ 基础工具 ============================

    async function gitCall(promise) {
        const result = await promise;
        if (!result?.success) {
            const error = new Error(result?.error || '未知错误');
            error.code = result?.code || null;
            throw error;
        }
        return result.data;
    }

    const isGitTab = () => $('project-sidebar').dataset.sideActive === 'git';
    const entriesOf = group => (git.status?.isRepo ? (git.status[group] || []) : []);
    const findEntry = (group, relPath) => entriesOf(group).find(e => e.path === relPath) || null;
    const sectionOf = group => $('git-groups').querySelector(`.git-group[data-group="${group}"]`);
    const rowsOf = section => (section ? [...section.querySelectorAll('.git-row')] : []);

    function displayPath(relPath) {
        const prefix = git.status?.prefix;
        return prefix && relPath.startsWith(`${prefix}/`) ? relPath.slice(prefix.length + 1) : relPath;
    }

    function statusInfo(group, entry) {
        if (group === 'conflicts') return { letter: '!', cls: 'conflict', label: `冲突（${entry.status}）` };
        const letter = entry.status || '?';
        return { letter, cls: letter.toLowerCase(), label: STATUS_TEXT[letter] || letter };
    }

    function actionsFor(group) {
        if (group === 'staged') return [{ action: 'unstage', label: '取消暂存', icon: '−' }];
        if (group === 'conflicts') return [{ action: 'stage', label: '标记为已解决', icon: '✓' }];
        return [
            { action: 'discard', label: '放弃更改', icon: '↺', danger: true },
            { action: 'stage', label: '暂存', icon: '+' },
        ];
    }

    function actionButton({ action, icon, danger }, text) {
        return `<button type="button" class="git-icon-btn${danger ? ' danger' : ''}" data-git-action="${action}" title="${escapeHtml(text)}" aria-label="${escapeHtml(text)}">${icon}</button>`;
    }

    // ============================ 侧栏滑动分页 ============================

    const sideTabs = () => [...document.querySelectorAll('.side-tab')];

    function switchSideTab(name, { focus = false } = {}) {
        const target = name === 'git' ? 'git' : 'projects';
        $('project-sidebar').dataset.sideActive = target;
        $('main-panel').dataset.mode = target;
        sideTabs().forEach(tab => {
            const active = tab.dataset.sideTab === target;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
            if (active && focus) tab.focus();
        });
        document.querySelectorAll('.side-page').forEach(page => {
            const active = page.dataset.sidePage === target;
            page.inert = !active;
            page.setAttribute('aria-hidden', String(!active));
        });
        localStorage.setItem(SIDE_TAB_KEY, target);

        if (target !== 'git' || !git.enabled) {
            stopPolling();
            return;
        }
        startPolling();
        if (git.workspaces.length) refreshStatus({ quiet: true });
        else loadWorkspaces();
        requestAnimationFrame(refreshDiffLayout);
    }

    function bindTabEvents() {
        const bar = $('side-tabs');
        bar.addEventListener('click', e => {
            const tab = e.target.closest('.side-tab');
            if (tab) switchSideTab(tab.dataset.sideTab);
        });
        bar.addEventListener('keydown', e => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            e.preventDefault();
            const tabs = sideTabs();
            const current = Math.max(0, tabs.indexOf(document.activeElement));
            let next = current;
            if (e.key === 'ArrowRight') next = (current + 1) % tabs.length;
            else if (e.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
            else if (e.key === 'Home') next = 0;
            else next = tabs.length - 1;
            switchSideTab(tabs[next].dataset.sideTab, { focus: true });
        });
    }

    // ============================ 状态刷新与轮询 ============================

    function setLoading(on, quiet = false) {
        git.loading = on;
        $('git-refresh-btn').classList.toggle('spinning', on && !quiet);
    }

    function setBusy(on, op = null) {
        git.busy = on;
        git.busyOp = on ? op : null;
        const page = $('side-page-git');
        page.classList.toggle('busy', on);
        page.setAttribute('aria-busy', String(on));
        syncActionButtons();
    }

    function startPolling() {
        stopPolling();
        git.pollTimer = setInterval(() => {
            if (document.visibilityState !== 'visible' || git.busy || git.loading || !isGitTab()) return;
            refreshStatus({ quiet: true });
        }, POLL_MS);
    }

    function stopPolling() {
        clearInterval(git.pollTimer);
        git.pollTimer = null;
    }

    function clearSelection() {
        Object.values(git.selected).forEach(set => set.clear());
        git.anchor = null;
    }

    function resetWorkspaceView(nextId) {
        const textarea = $('git-commit-message');
        if (git.workspaceId) git.drafts.set(git.workspaceId, textarea.value);
        git.workspaceId = nextId;
        textarea.value = (nextId && git.drafts.get(nextId)) || '';
        git.status = null;
        git.statusSeq += 1;
        setLoading(false);
        clearSelection();
        clearDiff();
        hideOpOutput();
    }

    function renderWorkspaceSelect() {
        const select = $('git-workspace-select');
        if (!git.workspaces.length) {
            select.innerHTML = '<option value="">（未登记工作区）</option>';
            select.disabled = true;
            return;
        }
        select.disabled = false;
        select.innerHTML = git.workspaces.map(ws => `<option value="${escapeHtml(ws.id)}" title="${escapeHtml(ws.path)}">${escapeHtml(ws.alias)}</option>`).join('');
        select.value = git.workspaceId || '';
        select.title = git.workspaces.find(ws => ws.id === git.workspaceId)?.path || '';
    }

    async function loadWorkspaces({ quiet = false } = {}) {
        if (!git.enabled) return;
        setLoading(true, quiet);
        try {
            const data = await gitCall(api.gitListWorkspaces());
            git.workspaces = data.workspaces || [];
            const saved = localStorage.getItem(GIT_WS_KEY);
            const active = data.activeWorkspaceId;
            const valid = id => git.workspaces.some(ws => ws.id === id);
            let nextId = null;
            if (valid(git.workspaceId)) nextId = git.workspaceId;
            else if (valid(saved)) nextId = saved;
            else if (valid(active)) nextId = active;
            else if (git.workspaces.length) nextId = git.workspaces[0].id;

            renderWorkspaceSelect();
            if (nextId !== git.workspaceId) {
                resetWorkspaceView(nextId);
                if (nextId) localStorage.setItem(GIT_WS_KEY, nextId);
            }
            if (git.workspaceId) await refreshStatus({ quiet });
            else renderEmptyWorkspaces();
        } catch (error) {
            showNotice(`加载工作区失败：${error.message}`, 'error');
        } finally {
            setLoading(false, quiet);
        }
    }

    async function refreshStatus({ quiet = false } = {}) {
        if (!git.workspaceId || git.busy) return;
        const seq = (git.statusSeq += 1);
        setLoading(true, quiet);
        try {
            const status = await gitCall(api.gitStatus(git.workspaceId));
            if (seq !== git.statusSeq) return;
            applyStatus(status);
        } catch (error) {
            if (seq !== git.statusSeq) return;
            showNotice(`读取 Git 状态失败：${error.message}`, 'error');
        } finally {
            if (seq === git.statusSeq) setLoading(false, quiet);
        }
    }

    function applyStatus(status) {
        git.status = status;
        hideNotice();
        if (!status.isRepo) {
            renderNotRepo();
            clearDiff();
            updateBadge();
            syncActionButtons();
            return;
        }

        // 清理已不存在文件的勾选
        for (const group of GROUPS) {
            const set = git.selected[group.key];
            const current = new Set(entriesOf(group.key).map(e => e.path));
            for (const p of [...set]) {
                if (!current.has(p)) set.delete(p);
            }
        }

        renderBranchLine();
        renderGroups();
        updateBadge();
        syncActionButtons();

        // 当前打开的文件若已离开当前分组，刷新或清空 diff
        if (git.current) {
            const entry = findEntry(git.current.group, git.current.path);
            if (entry) openDiff(git.current.group, entry.path, { preserveFocus: true, reload: true });
            else clearDiff();
        }
    }

    function updateBadge() {
        const badge = $('git-tab-count');
        if (!git.status?.isRepo) {
            badge.hidden = true;
            return;
        }
        const count = (git.status.conflicts?.length || 0) + (git.status.staged?.length || 0) + (git.status.changes?.length || 0);
        badge.hidden = count === 0;
        badge.textContent = count > 99 ? '99+' : String(count);
    }

    function renderEmptyWorkspaces() {
        $('git-branch-line').hidden = true;
        $('git-groups').innerHTML = '<p class="git-empty muted">尚未登记任何工作区。请在设置中添加工作区。</p>';
        syncActionButtons();
    }

    function renderNotRepo() {
        $('git-branch-line').hidden = true;
        $('git-groups').innerHTML = `<div class="git-notice warn">工作区目录不是 Git 仓库：<br><code>${escapeHtml(git.status?.root || '')}</code></div>`;
    }

    function renderBranchLine() {
        const line = $('git-branch-line');
        const b = git.status.branch;
        line.hidden = false;
        const ahead = b.ahead ? `<span class="plus">↑${b.ahead}</span>` : '';
        const behind = b.behind ? `<span class="minus">↓${b.behind}</span>` : '';
        const up = b.upstream ? `<span class="muted" title="${escapeHtml(b.upstream)}">${escapeHtml(b.upstream)}</span>` : '<span class="muted">（无上游）</span>';
        line.innerHTML = `
            <span class="git-branch">⎇ ${escapeHtml(b.head || '(detached)')}</span>
            ${up}
            ${ahead}
            ${behind}`;
    }

    function renderGroups() {
        const box = $('git-groups');
        const total = (git.status.conflicts?.length || 0) + (git.status.staged?.length || 0) + (git.status.changes?.length || 0);
        if (total === 0) {
            box.innerHTML = '<p class="git-empty muted">干净的工作区，没有变更。</p>';
            return;
        }

        box.innerHTML = GROUPS.map(g => {
            const list = entriesOf(g.key);
            if (!list.length) return '';
            const collapsed = git.collapsed.has(g.key);
            const set = git.selected[g.key];
            const allChecked = list.length > 0 && list.every(e => set.has(e.path));
            const someChecked = !allChecked && list.some(e => set.has(e.path));
            const selCount = set.size;
            const chip = selCount > 0 ? `已选 ${selCount}` : '';

            const rows = list.map(entry => {
                const info = statusInfo(g.key, entry);
                const disp = displayPath(entry.path);
                const slash = disp.lastIndexOf('/');
                const base = slash === -1 ? disp : disp.slice(slash + 1);
                const dir = slash === -1 ? '' : disp.slice(0, slash);
                const checked = set.has(entry.path);
                const active = git.current?.group === g.key && git.current?.path === entry.path;
                const actions = actionsFor(g.key).map(a => actionButton(a, `${a.label} ${base}`)).join('');

                return `
                    <li class="git-row${checked ? ' selected' : ''}${active ? ' active' : ''}" data-path="${escapeHtml(entry.path)}" data-group="${g.key}">
                        <input type="checkbox" class="git-check" ${checked ? 'checked' : ''} aria-label="选择 ${escapeHtml(base)}">
                        <button type="button" class="git-open" title="${escapeHtml(entry.path)}">
                            <span class="git-status st-${escapeHtml(info.cls)}" title="${escapeHtml(info.label)}">${escapeHtml(info.letter)}</span>
                            <span class="git-name${entry.status === 'D' ? ' deleted' : ''}">${escapeHtml(base)}</span>
                            ${dir ? `<span class="git-dir">${escapeHtml(dir)}</span>` : ''}
                        </button>
                        <div class="git-row-actions">${actions}</div>
                    </li>`;
            }).join('');

            const groupActions = actionsFor(g.key).map(a => actionButton(a, `${a.label}（全部 ${list.length} 个文件）`)).join('');

            return `
                <div class="git-group${collapsed ? ' collapsed' : ''}" data-group="${g.key}">
                    <div class="git-group-head">
                        <input type="checkbox" class="git-check-all" ${allChecked ? 'checked' : ''} ${someChecked ? 'data-indeterminate="1"' : ''} title="全选 / 取消全选 ${escapeHtml(g.title)}" aria-label="全选 ${escapeHtml(g.title)}">
                        <button type="button" class="git-group-toggle" aria-expanded="${!collapsed}">
                            <span class="chev">▾</span>
                            <span>${escapeHtml(g.title)}</span>
                            <span class="git-count">${list.length}</span>
                            <span class="git-sel-chip">${escapeHtml(chip)}</span>
                        </button>
                        <div class="git-group-actions">${groupActions}</div>
                    </div>
                    <ul class="git-list" ${collapsed ? 'hidden' : ''}>${rows}</ul>
                </div>`;
        }).join('');

        box.querySelectorAll('input[data-indeterminate="1"]').forEach(cb => { cb.indeterminate = true; });
    }

    function syncActionButtons() {
        const isRepo = Boolean(git.status?.isRepo);
        const hasStaged = Boolean(git.status?.staged?.length);
        const b = git.status?.branch;
        const msg = $('git-commit-message').value.trim();

        $('git-commit-btn').disabled = !isRepo || !hasStaged || !msg || git.busy;
        $('git-push-btn').disabled = !isRepo || !b || b.detached || b.initial || git.busy;
        $('git-refresh-btn').disabled = !git.workspaceId || git.busy;
        $('git-workspace-select').disabled = git.workspaces.length === 0 || git.busy;
    }

    // ============================ 批量操作与执行 ============================

    async function executeGitAction(op, paths, group) {
        if (!git.workspaceId || git.busy || !paths.length) return;
        const label = OP_LABEL[op] || op;

        if (op === 'discard') {
            const ok = await confirmDiscard(paths);
            if (!ok) return;
        }

        setBusy(true, op);
        hideOpOutput();
        try {
            let res;
            if (op === 'stage') res = await gitCall(api.gitStage(git.workspaceId, paths));
            else if (op === 'unstage') res = await gitCall(api.gitUnstage(git.workspaceId, paths));
            else if (op === 'discard') res = await gitCall(api.gitDiscard(git.workspaceId, paths));
            toast(`已${label} ${paths.length} 个文件`, 'success');
            if (res?.status) applyStatus(res.status);
            else await refreshStatus({ quiet: true });
        } catch (error) {
            toast(`${label}失败：${error.message}`, 'error');
            showOpOutput(`${label}失败`, error.message);
        } finally {
            setBusy(false);
        }
    }

    async function confirmDiscard(paths) {
        const preview = paths.slice(0, MAX_CONFIRM_LIST).map(p => `<li><code>${escapeHtml(displayPath(p))}</code></li>`).join('');
        const more = paths.length > MAX_CONFIRM_LIST ? `<div class="muted">…以及另外 ${paths.length - MAX_CONFIRM_LIST} 个文件</div>` : '';
        const body = `
            <div>确定要放弃以下 <strong>${paths.length}</strong> 个文件的修改吗？</div>
            <div class="warn-line" style="margin:8px 0">⚠ 已跟踪文件的修改将被撤销（无法还原）；未跟踪的文件将被移入系统回收站。</div>
            <ul>${preview}</ul>
            ${more}`;
        return confirmDialog('放弃更改', body, '放弃更改');
    }

    async function doCommit() {
        const msg = $('git-commit-message').value.trim();
        if (!msg || !git.workspaceId || git.busy) return;
        setBusy(true, 'commit');
        hideOpOutput();
        try {
            const res = await gitCall(api.gitCommit(git.workspaceId, { message: msg }));
            toast(`提交成功：${res.commit}`, 'success');
            $('git-commit-message').value = '';
            git.drafts.delete(git.workspaceId);
            if (res?.status) applyStatus(res.status);
            else await refreshStatus({ quiet: true });
        } catch (error) {
            toast(`提交失败：${error.message}`, 'error');
            showOpOutput('提交失败', error.message);
        } finally {
            setBusy(false);
        }
    }

    async function doPush() {
        if (!git.workspaceId || git.busy) return;
        const b = git.status?.branch;
        if (!b?.upstream) {
            const ok = await confirmDialog('推送到新上游', `
                <div>当前分支 <code>${escapeHtml(b?.head || '')}</code> 尚未关联上游分支。</div>
                <div style="margin-top:6px">是否推送到默认远端并设置跟踪分支（<code>git push -u</code>）？</div>
            `, '推送到远端');
            if (!ok) return;
        }

        setBusy(true, 'push');
        hideOpOutput();
        try {
            const res = await gitCall(api.gitPush(git.workspaceId, { setUpstream: !b?.upstream }));
            toast('推送成功', 'success');
            if (res.output) showOpOutput('推送完成', res.output, 'success');
            if (res?.status) applyStatus(res.status);
            else await refreshStatus({ quiet: true });
        } catch (error) {
            toast(`推送失败：${error.message}`, 'error');
            showOpOutput('推送失败', error.message);
        } finally {
            setBusy(false);
        }
    }

    // ============================ Diff 渲染 ============================

    function clearDiff() {
        git.current = null;
        git.diffData = null;
        if (git.diffView) {
            $('git-diff-view').innerHTML = '';
            git.diffView = null;
        }
        $('git-diff-view').hidden = true;
        $('git-diff-legend').hidden = true;
        $('git-diff-action').hidden = true;
        $('git-diff-meta').innerHTML = '';
        $('git-diff-title').textContent = 'Git 差异';
        $('git-diff-fallback').hidden = false;
        $('git-diff-fallback').textContent = '选择左侧的变更文件以查看差异';
        document.querySelectorAll('.git-row.active').forEach(r => r.classList.remove('active'));
    }

    function refreshDiffLayout() {
        if (!git.diffView) return;
        const editor = git.diffView.editor();
        if (editor) {
            editor.refresh();
            git.diffView.leftOriginal()?.refresh();
        }
    }

    async function openDiff(group, relPath, { preserveFocus = false, reload = false } = {}) {
        if (!git.workspaceId) return;
        const entry = findEntry(group, relPath);
        if (!entry) return;

        git.current = { group, path: relPath };
        const seq = (git.diffSeq += 1);

        document.querySelectorAll('.git-row').forEach(r => {
            r.classList.toggle('active', r.dataset.group === group && r.dataset.path === relPath);
        });

        const isStaged = group === 'staged';
        const [lText, rText] = LEGEND[group] || ['前', '后'];
        $('git-legend-left').textContent = `${lText}（改动前）`;
        $('git-legend-right').textContent = `${rText}（改动后）`;

        const disp = displayPath(relPath);
        $('git-diff-title').innerHTML = `<code>${escapeHtml(disp)}</code>`;
        const info = statusInfo(group, entry);
        $('git-diff-meta').innerHTML = `
            <span>${escapeHtml(GROUP_TITLE[group])}</span>
            <span class="badge ${escapeHtml(info.cls)}">${escapeHtml(info.label)}</span>
            ${entry.origPath ? `<span>原路径 <code>${escapeHtml(entry.origPath)}</code></span>` : ''}`;

        const actBtn = $('git-diff-action');
        actBtn.hidden = false;
        if (isStaged) {
            actBtn.textContent = '− 取消暂存';
            actBtn.className = 'btn small';
            actBtn.onclick = () => executeGitAction('unstage', [relPath], group);
        } else {
            actBtn.textContent = '+ 暂存此文件';
            actBtn.className = 'btn small primary';
            actBtn.onclick = () => executeGitAction('stage', [relPath], group);
        }

        try {
            const data = await gitCall(api.gitDiff(git.workspaceId, relPath, { staged: isStaged, origPath: entry.origPath }));
            if (seq !== git.diffSeq) return;
            git.diffData = data;
            renderDiffView(data);
        } catch (error) {
            if (seq !== git.diffSeq) return;
            $('git-diff-view').hidden = true;
            $('git-diff-legend').hidden = true;
            $('git-diff-fallback').hidden = false;
            $('git-diff-fallback').textContent = `读取差异失败：${error.message}`;
        }
    }

    function renderDiffView(data) {
        const { before, after, path: filePath } = data;
        const fallback = $('git-diff-fallback');
        const viewEl = $('git-diff-view');

        if (before.binary || after.binary) {
            viewEl.hidden = true;
            $('git-diff-legend').hidden = true;
            fallback.hidden = false;
            fallback.textContent = `二进制文件，无法显示文本差异（${before.exists ? before.size + ' B' : '未跟踪'} → ${after.exists ? after.size + ' B' : '已删除'}）。`;
            return;
        }

        fallback.hidden = true;
        $('git-diff-legend').hidden = false;
        viewEl.hidden = false;
        viewEl.innerHTML = '';

        const note = (b, label) => (b.exists && b.truncated ? `\n\n/* …${label}内容超过 2MB 已截断 */` : '');

        git.diffView = CodeMirror.MergeView(viewEl, {
            origLeft: before.exists ? before.text + note(before, '改动前') : '',
            value: after.exists ? after.text + note(after, '改动后') : '',
            connect: 'align',
            mode: modeForPath(filePath),
            theme: isLightTheme() ? 'default' : 'material-darker',
            lineNumbers: true,
            readOnly: true,
            revertButtons: false,
            highlightDifferences: true,
            collapseIdentical: 4,
            lineWrapping: state.diffWrap,
        });

        requestAnimationFrame(refreshDiffLayout);
    }

    // ============================ 通知与输出 ============================

    function showNotice(text, type = 'info') {
        const el = $('git-notice');
        el.textContent = text;
        el.className = `git-notice ${type}`;
        el.hidden = false;
    }

    function hideNotice() { $('git-notice').hidden = true; }

    function showOpOutput(title, text, type = 'error') {
        $('git-op-title').textContent = title;
        $('git-op-text').textContent = text;
        $('git-op-output').className = `git-op-output ${type}`;
        $('git-op-output').hidden = false;
    }

    function hideOpOutput() { $('git-op-output').hidden = true; }

    // ============================ 事件交互绑定 ============================

    function bindGitEvents() {
        $('git-workspace-select').addEventListener('change', e => {
            const nextId = e.target.value;
            if (!nextId || nextId === git.workspaceId) return;
            localStorage.setItem(GIT_WS_KEY, nextId);
            resetWorkspaceView(nextId);
            refreshStatus();
        });

        $('git-refresh-btn').addEventListener('click', () => refreshStatus());

        $('git-commit-message').addEventListener('input', syncActionButtons);
        $('git-commit-message').addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                doCommit();
            }
        });

        $('git-commit-btn').addEventListener('click', doCommit);
        $('git-push-btn').addEventListener('click', doPush);
        $('git-op-close').addEventListener('click', hideOpOutput);

        $('git-diff-wrap-btn').addEventListener('click', () => {
            // 复用 projectforge.js 的换行切换机制
            if (window.toggleDiffWrap) window.toggleDiffWrap();
            else {
                state.diffWrap = !state.diffWrap;
                localStorage.setItem(DIFF_WRAP_KEY, state.diffWrap ? '1' : '0');
                syncDiffWrapButton();
            }
            if (git.diffData) renderDiffView(git.diffData);
        });

        // 代理变更分组委托点击
        $('git-groups').addEventListener('click', e => {
            // 行级操作按钮
            const actBtn = e.target.closest('[data-git-action]');
            if (actBtn) {
                const row = actBtn.closest('.git-row');
                const head = actBtn.closest('.git-group-head');
                const op = actBtn.dataset.gitAction;
                if (row) {
                    executeGitAction(op, [row.dataset.path], row.dataset.group);
                } else if (head) {
                    const group = head.closest('.git-group').dataset.group;
                    const selected = [...git.selected[group]];
                    const paths = selected.length ? selected : entriesOf(group).map(item => item.path);
                    executeGitAction(op, paths, group);
                }
                return;
            }

            // 单个复选框
            const check = e.target.closest('.git-check');
            if (check) {
                const row = check.closest('.git-row');
                const group = row.dataset.group;
                const path = row.dataset.path;
                const set = git.selected[group];
                if (check.checked) set.add(path);
                else set.delete(path);
                git.anchor = { group, path };
                renderGroups();
                return;
            }

            // 全选复选框
            const checkAll = e.target.closest('.git-check-all');
            if (checkAll) {
                const group = checkAll.closest('.git-group').dataset.group;
                const set = git.selected[group];
                const list = entriesOf(group);
                if (checkAll.checked) list.forEach(entry => set.add(entry.path));
                else set.clear();
                renderGroups();
                return;
            }

            // 分组折叠展开
            const toggle = e.target.closest('.git-group-toggle');
            if (toggle) {
                const groupEl = toggle.closest('.git-group');
                const groupKey = groupEl.dataset.group;
                const isCollapsed = git.collapsed.has(groupKey);
                if (isCollapsed) git.collapsed.delete(groupKey);
                else git.collapsed.add(groupKey);
                renderGroups();
                return;
            }

            // 点击行打开 diff
            const open = e.target.closest('.git-open');
            if (open) {
                const row = open.closest('.git-row');
                openDiff(row.dataset.group, row.dataset.path);
            }
        });
    }

    // ============================ 初始化 ============================

    document.addEventListener('DOMContentLoaded', async () => {
        if (!api?.gitStatus) {
            console.info('[ProjectForgeGit] Git API 不可用，侧栏分页保持传统模式。');
            return;
        }
        git.enabled = true;
        bindTabEvents();
        bindGitEvents();

        const savedTab = localStorage.getItem(SIDE_TAB_KEY);
        if (savedTab === 'git') switchSideTab('git');
        else loadWorkspaces({ quiet: true });
    });
})();