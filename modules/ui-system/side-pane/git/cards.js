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

const COUNT_PREFETCH_LIMIT = 80;
const COUNT_PREFETCH_CONCURRENCY = 3;
const DIFF_MAX_ROWS = 600;

export function createGitCards({
    store,
    api,
    buildHunkRows,
    computeLineDiff,
    doc,
    keyOf,
    list,
    openContextMenu
}) {
    let disposed = false;
    const expanded = new Set();
    const diffCache = new Map();
    let countQueue = [];
    let countWorkers = 0;

    async function fetchDiff(item) {
        const key = keyOf(item);
        const cached = diffCache.get(key);
        if (cached && cached.state !== 'loading') return cached;
        if (cached?.promise) return cached.promise;
        const requestedWorkspace = store.currentWorkspaceId;
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
            if (requestedWorkspace === store.currentWorkspaceId && !disposed && !store.isDisposed) diffCache.set(key, result);
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
                if (disposed || store.isDisposed) return;
                const card = cardFor(item);
                if (card) paintCounts(item, card);
            }).finally(() => {
                countWorkers -= 1;
                pumpCountQueue();
            });
        }
    }

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
                if (disposed || store.isDisposed || !expanded.has(key)) return;
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

    function prefetch(items) {
        countQueue = items.slice(0, COUNT_PREFETCH_LIMIT).filter(item => !diffCache.has(keyOf(item)));
        pumpCountQueue();
    }
    function clearExpanded() { expanded.clear(); }
    function clearDiff() { expanded.clear(); diffCache.clear(); }
    function reset() { clearDiff(); countQueue = []; }
    function expand(item) { expanded.clear(); expanded.add(keyOf(item)); }
    function hasExpanded() { return expanded.size > 0; }

    return Object.freeze({ buildCard, cardFor, prefetch, reset, clearDiff, clearExpanded, expand, hasExpanded, dispose() { disposed = true; countQueue = []; expanded.clear(); diffCache.clear(); } });
}
