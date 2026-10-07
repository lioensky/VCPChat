/**
 * modules/ui-system/side-pane/git/cards.js
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
    // 缓存作废时展开着的 diff 先留着上一份：重新取的这段时间照旧显示，不缩成一行「加载中…」再撑开（对照 ZCode GitPane 重取时保留旧 diff）
    const previousDiff = new Map();
    let countQueue = [];
    let countWorkers = 0;
    // 缓存作废一次加一；作废前发出的请求回来时不再写缓存（对照 ZCode GitPane diffGenerationRef）
    let generation = 0;

    async function fetchDiff(item) {
        const key = keyOf(item);
        const cached = diffCache.get(key);
        if (cached && cached.state !== 'loading') return cached;
        if (cached?.promise) return cached.promise;
        const requestedWorkspace = store.currentWorkspaceId;
        const requestedGeneration = generation;
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
                // 读失败不进缓存：重新展开或点重试会再取，不会一直停在这条错误上
                result = { state: 'error', message: err.message || '暂时无法预览这个 Diff。' };
            }
            if (requestedWorkspace === store.currentWorkspaceId && requestedGeneration === generation && !disposed && !store.isDisposed) {
                if (result.state === 'error') diffCache.delete(key);
                else diffCache.set(key, result);
                previousDiff.delete(key);
            }
            return result;
        })();
        diffCache.set(key, { state: 'loading', promise });
        return promise;
    }

    // 已跟踪文件的行数随状态一起来（git diff --numstat）；未跟踪文件和二进制文件才靠拉 diff 算
    const hasStatusCounts = item => Number.isFinite(item.added) && Number.isFinite(item.removed);

    function paintCounts(item, card) {
        const countsEl = card.querySelector('.side-git-counts');
        if (!countsEl) return;
        const cached = hasStatusCounts(item)
            ? { state: 'ready', added: item.added, removed: item.removed, approximate: false }
            : diffCache.get(keyOf(item));
        if (cached?.state !== 'ready') return;
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

    function renderDiffBody(item, container, { result = null, onRetry = null } = {}) {
        const current = result || diffCache.get(keyOf(item));
        const cached = (!current || current.state === 'loading') ? (previousDiff.get(keyOf(item)) || current) : current;
        container.innerHTML = '';
        if (!cached || cached.state === 'loading') {
            container.innerHTML = '<div class="side-git-diff-loading">加载中…</div>';
            return;
        }
        if (cached.state === 'error') {
            const msg = doc.createElement('div');
            msg.className = 'side-git-diff-message side-git-diff-error';
            msg.setAttribute('role', 'alert');
            msg.textContent = `读取差异失败：${cached.message}`;
            if (onRetry) {
                const retry = doc.createElement('button');
                retry.type = 'button';
                retry.className = 'side-git-empty-add side-git-diff-retry';
                retry.textContent = '重试';
                retry.addEventListener('click', onRetry);
                msg.append(' ', retry);
            }
            container.appendChild(msg);
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
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = 'expand_more';
        meta.append(counts, chevron);
        row.append(label, meta);
        card.appendChild(row);

        const diffBox = doc.createElement('div');
        diffBox.className = 'side-git-diff';
        diffBox.hidden = !isOpen;
        card.appendChild(diffBox);

        const open = () => {
            const openedGeneration = generation;
            renderDiffBody(item, diffBox);
            fetchDiff(item).then((result) => {
                // 缓存作废后的旧结果不画：列表重绘时会用新卡片重新取
                if (disposed || store.isDisposed || !expanded.has(key) || openedGeneration !== generation) return;
                renderDiffBody(item, diffBox, { result: result?.state === 'error' ? result : null, onRetry: open });
                paintCounts(item, card);
            });
        };

        row.addEventListener('click', () => {
            const nowOpen = !expanded.has(key);
            // 同一时间只展开一个文件，打开新的就收起旧的
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
        countQueue = items.filter(item => !hasStatusCounts(item)).slice(0, COUNT_PREFETCH_LIMIT).filter(item => !diffCache.has(keyOf(item)));
        pumpCountQueue();
    }
    function clearExpanded() { expanded.clear(); }
    function clearDiff() { expanded.clear(); invalidate(); }
    function invalidate() {
        generation += 1;
        previousDiff.clear();
        expanded.forEach((key) => {
            const cached = diffCache.get(key);
            if (cached?.state === 'ready') previousDiff.set(key, cached);
        });
        diffCache.clear();
        countQueue = [];
    }
    function reset() { clearDiff(); countQueue = []; }
    function expand(item) { expanded.clear(); expanded.add(keyOf(item)); }
    function hasExpanded() { return expanded.size > 0; }
    function isExpanded(item) { return expanded.has(keyOf(item)); }

    return Object.freeze({ buildCard, cardFor, prefetch, reset, clearDiff, invalidate, clearExpanded, expand, hasExpanded, isExpanded, dispose() { disposed = true; countQueue = []; expanded.clear(); diffCache.clear(); previousDiff.clear(); } });
}
