// ProjectForgemodules/projectforge-source.js
// 侧栏「源码」分页：从工作区挑选文件，基于文件名搜索，轻量查看 / 编辑 / 保存，支持格式检查与自动换行。
// 与 projectforge.js 同为经典脚本，复用其顶层工具：
//   api、$、escapeHtml、toast、confirmDialog、modeForPath、isLightTheme、debounce
// 文件读写与格式检查全部在主进程执行（modules/ipc/sourceHandlers.js），这里只传工作区 id 与相对路径。
// 不做自动保存：只有点击「保存」或 Ctrl+S 才写盘。
'use strict';

(() => {
    const WS_KEY = 'vcp-projectforge-source-workspace';
    const WRAP_KEY = 'vcp-projectforge-source-wrap';
    const MAX_RENDER = 400;
    const MAX_TREE_ROWS = 3000;
    const EXPANDED_KEY = 'vcp-projectforge-source-expanded:';
    const DISK_CHECK_INTERVAL = 3000;
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

    const src = {
        enabled: false,
        started: false,
        workspaces: [],
        workspaceId: null,
        files: [],
        lowerFiles: [],
        tree: null,
        expanded: new Set(),
        truncated: false,
        limit: 0,
        listSeq: 0,
        openSeq: 0,
        file: null, // { path, hash, eol, savedEol, bom, editable, checkLanguage, size, encodingError }
        editor: null,
        cleanGen: 0,
        wrap: localStorage.getItem(WRAP_KEY) === '1',
        saving: false,
        diagnostics: null,
        manualCheck: false,
        lastDiskCheck: 0,
    };

    // ============================ 基础工具 ============================

    async function srcCall(promise) {
        const result = await promise;
        if (!result?.success) {
            const error = new Error(result?.error || '未知错误');
            error.code = result?.code || null;
            throw error;
        }
        return result.data;
    }

    const isSourceTab = () => window.ProjectForgeSideTabs?.current() === 'source';
    const baseName = p => String(p || '').split('/').pop();

    function extOf(p) {
        const base = baseName(p);
        const dot = base.lastIndexOf('.');
        return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
    }

    function sourceMode(p) {
        const ext = extOf(p);
        if (ext === 'toml') return 'toml';
        if (ext === 'jsonc') return { name: 'javascript', json: true };
        return modeForPath(p);
    }

    function fmtSize(n) {
        if (!Number.isFinite(n)) return '-';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(2)} MB`;
    }

    /** 按字符掩码高亮所有关键字出现的位置（不区分大小写）。 */
    function highlight(text, tokens) {
        if (!tokens.length) return escapeHtml(text);
        const lower = text.toLowerCase();
        const mask = new Uint8Array(text.length);
        for (const t of tokens) {
            for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + 1)) mask.fill(1, i, i + t.length);
        }
        let html = '';
        let i = 0;
        while (i < text.length) {
            const on = mask[i];
            let j = i;
            while (j < text.length && mask[j] === on) j += 1;
            const seg = escapeHtml(text.slice(i, j));
            html += on ? `<mark>${seg}</mark>` : seg;
            i = j;
        }
        return html;
    }

    /** 猜测缩进：制表符为主则用 Tab；空格缩进里 2 的倍数明显多于 4 的倍数时用 2，否则 4。 */
    function applyIndent(cm, text) {
        let tabs = 0;
        let spaces = 0;
        let two = 0;
        let four = 0;
        const lines = text.split('\n', 5000);
        for (const line of lines) {
            if (line[0] === '\t') { tabs += 1; continue; }
            const m = /^( +)\S/.exec(line);
            if (!m || line[m[1].length] === '*') continue;
            spaces += 1;
            const len = m[1].length;
            if (len % 4 === 0) four += 1;
            else if (len % 2 === 0) two += 1;
        }
        const useTabs = tabs > spaces;
        const unit = useTabs ? 4 : (two > four * 0.2 ? 2 : 4);
        cm.setOption('indentWithTabs', useTabs);
        cm.setOption('indentUnit', unit);
        cm.setOption('tabSize', unit);
    }

    // ============================ 编辑器 ============================

    function ensureEditor() {
        if (src.editor) return src.editor;
        const cm = CodeMirror($('source-editor'), {
            value: '',
            lineNumbers: true,
            theme: isLightTheme() ? 'default' : 'material-darker',
            lineWrapping: src.wrap,
            indentUnit: 4,
            tabSize: 4,
            gutters: ['CodeMirror-linenumbers', 'CodeMirror-lint-markers'],
            extraKeys: {
                Tab: editor => {
                    if (editor.somethingSelected()) editor.indentSelection('add');
                    else editor.replaceSelection(editor.getOption('indentWithTabs') ? '\t' : ' '.repeat(editor.getOption('indentUnit')), 'end');
                },
                'Shift-Tab': editor => editor.indentSelection('subtract'),
            },
        });
        cm.on('change', syncDirty);
        cm.on('cursorActivity', updateCursor);
        src.editor = cm;

        // 跟随主题切换（projectforge.js 通过 body.light-theme 切换）
        new MutationObserver(() => {
            cm.setOption('theme', isLightTheme() ? 'default' : 'material-darker');
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
        return cm;
    }

    function isDirty() {
        const f = src.file;
        return Boolean(f && f.editable && src.editor && (!src.editor.isClean(src.cleanGen) || f.eol !== f.savedEol));
    }

    function syncDirty() {
        const dirty = isDirty();
        $('source-save-btn').disabled = !src.file?.editable || !dirty || src.saving;
        $('source-tab-dirty').hidden = !dirty;
        $('source-title').classList.toggle('dirty', dirty);
        renderStatus();
    }

    function updateCursor() {
        const cm = src.editor;
        if (!cm || !src.file) return;
        const c = cm.getCursor();
        const selected = cm.getSelection().length;
        $('source-status-cursor').textContent = selected ? `已选择 ${selected} 字符` : `行 ${c.line + 1}，列 ${c.ch + 1}`;
    }

    function syncWrapButton() {
        const btn = $('source-wrap-btn');
        btn.classList.toggle('active', src.wrap);
        btn.setAttribute('aria-pressed', String(src.wrap));
    }

    function toggleWrap() {
        src.wrap = !src.wrap;
        localStorage.setItem(WRAP_KEY, src.wrap ? '1' : '0');
        syncWrapButton();
        if (!src.editor) return;
        const top = src.editor.lineAtHeight(src.editor.getScrollInfo().top, 'local');
        src.editor.setOption('lineWrapping', src.wrap);
        src.editor.scrollTo(null, src.editor.heightAtLine(top, 'local'));
    }

    // ============================ 格式检查 ============================

    function lintConfig() {
        return { async: true, lintOnChange: false, getAnnotations: lintAnnotations };
    }

    async function lintAnnotations(text, update) {
        const file = src.file;
        const seq = src.openSeq;
        const manual = src.manualCheck;
        src.manualCheck = false;
        if (!file) return;
        const btn = $('source-check-btn');
        btn.disabled = true;
        const stale = () => seq !== src.openSeq || src.file !== file;
        try {
            const result = await srcCall(api.sourceCheck(file.path, text));
            if (stale()) return;
            src.diagnostics = result;
            renderProblems(result);
            update(result.diagnostics.map(d => ({
                from: CodeMirror.Pos(d.line - 1, Math.max(0, d.column - 1)),
                to: CodeMirror.Pos(d.line - 1, Math.max(0, d.column)),
                message: d.message,
                severity: d.severity === 'warning' ? 'warning' : 'error',
            })));
            if (manual) {
                if (result.ok && !result.warningCount) toast(`${result.language} 格式检查通过`, 'success');
                else if (result.ok) toast(`${result.language} 语法正确，有 ${result.warningCount} 个警告`);
                else toast(`发现 ${result.errorCount} 个错误`, 'error');
            }
        } catch (error) {
            if (stale()) return;
            src.diagnostics = null;
            renderProblems(null, error.message);
            try { update([]); } catch (_e) { /* lint 状态已被重置 */ }
        } finally {
            if (!stale()) btn.disabled = !file.checkLanguage;
        }
    }

    function runCheck() {
        if (!src.editor || !src.file?.checkLanguage) return;
        src.manualCheck = true;
        src.editor.performLint();
    }

    function renderProblems(result, errorText = null) {
        const panel = $('source-problems');
        const list = $('source-problems-list');
        if (errorText) {
            panel.hidden = false;
            panel.className = 'source-problems error';
            $('source-problems-title').textContent = '格式检查失败';
            list.innerHTML = `<li class="muted">${escapeHtml(errorText)}</li>`;
        } else if (!result || !result.diagnostics.length) {
            panel.hidden = true;
        } else {
            panel.hidden = false;
            panel.className = `source-problems ${result.ok ? 'warn' : 'error'}`;
            const parts = [];
            if (result.errorCount) parts.push(`${result.errorCount} 个错误`);
            if (result.warningCount) parts.push(`${result.warningCount} 个警告`);
            $('source-problems-title').textContent = `${result.language} · ${parts.join('，')}${result.truncated ? '（仅显示前 100 条）' : ''}`;
            list.innerHTML = result.diagnostics.map(d => `
                <li>
                    <button type="button" class="source-problem ${d.severity === 'warning' ? 'warning' : 'error'}" data-line="${d.line}" data-column="${d.column}">
                        <span class="sev">${d.severity === 'warning' ? '⚠' : '✕'}</span>
                        <span class="msg">${escapeHtml(d.message)}</span>
                        <span class="pos">行 ${d.line}，列 ${d.column}</span>
                    </button>
                </li>`).join('');
        }
        renderStatus();
        requestAnimationFrame(() => src.editor?.refresh());
    }

    function jumpTo(line, column) {
        const cm = src.editor;
        if (!cm) return;
        const pos = CodeMirror.Pos(Math.max(0, line - 1), Math.max(0, column - 1));
        cm.setCursor(pos);
        cm.scrollIntoView(pos, 80);
        cm.focus();
    }

    // ============================ 状态栏 / 提示 ============================

    function renderStatus() {
        const f = src.file;
        const bar = $('source-status');
        if (!f) {
            bar.hidden = true;
            return;
        }
        bar.hidden = false;
        let stateText = '已保存';
        if (src.saving) stateText = '保存中…';
        else if (!f.editable) stateText = '只读';
        else if (isDirty()) stateText = '● 未保存';
        const stateEl = $('source-status-state');
        stateEl.textContent = stateText;
        stateEl.className = isDirty() ? 'dirty' : '';

        let lang = f.checkLanguage || (extOf(f.path) ? extOf(f.path).toUpperCase() : '纯文本');
        const d = src.diagnostics;
        if (d?.supported) {
            if (!d.ok) lang += ` · ✕ ${d.errorCount} 个错误`;
            else if (d.warningCount) lang += ` · ⚠ ${d.warningCount} 个警告`;
            else lang += ' · ✓ 格式正确';
        }
        const langEl = $('source-status-lang');
        langEl.textContent = lang;
        langEl.className = d?.supported ? (d.ok ? (d.warningCount ? 'warn' : 'ok') : 'error') : '';

        const eolText = f.eol === '\r\n' ? 'CRLF' : 'LF';
        const encText = `UTF-8${f.bom ? ' BOM' : ''}`;
        $('source-status-eol').innerHTML = f.editable
            ? `${encText} · <button type="button" class="source-eol-btn" title="切换换行符（保存时生效）">${eolText}</button>`
            : `${f.encodingError ? '非 UTF-8' : encText} · ${eolText}`;
    }

    function showNotice(html, type = 'info') {
        const el = $('source-notice');
        el.innerHTML = html;
        el.className = `git-notice ${type}`;
        el.hidden = false;
    }

    function hideNotice() { $('source-notice').hidden = true; }

    // ============================ 工作区与文件列表 ============================

    function setLoading(on) {
        $('source-refresh-btn').classList.toggle('spinning', on);
    }

    function renderWorkspaceSelect() {
        const select = $('source-workspace-select');
        if (!src.workspaces.length) {
            select.innerHTML = '<option value="">（未登记工作区）</option>';
            select.disabled = true;
            return;
        }
        select.disabled = false;
        select.innerHTML = src.workspaces.map(ws => `<option value="${escapeHtml(ws.id)}" title="${escapeHtml(ws.path)}">${escapeHtml(ws.alias)}</option>`).join('');
        select.value = src.workspaceId || '';
        select.title = src.workspaces.find(ws => ws.id === src.workspaceId)?.path || '';
    }

    async function loadWorkspaces() {
        setLoading(true);
        try {
            const data = await srcCall(api.gitListWorkspaces());
            src.workspaces = data.workspaces || [];
            const valid = id => src.workspaces.some(ws => ws.id === id);
            const saved = localStorage.getItem(WS_KEY);
            let nextId = null;
            if (valid(src.workspaceId)) nextId = src.workspaceId;
            else if (valid(saved)) nextId = saved;
            else if (valid(data.activeWorkspaceId)) nextId = data.activeWorkspaceId;
            else if (src.workspaces.length) nextId = src.workspaces[0].id;

            if (nextId !== src.workspaceId) {
                src.workspaceId = nextId;
                src.expanded = loadExpanded(nextId);
                if (nextId) localStorage.setItem(WS_KEY, nextId);
                closeFile();
            }
            renderWorkspaceSelect();
            if (src.workspaceId) await loadFiles();
            else {
                src.files = [];
                src.lowerFiles = [];
                $('source-summary').textContent = '';
                $('source-file-list').innerHTML = '<li class="git-empty muted">尚未登记任何工作区。请在设置中添加工作区。</li>';
            }
        } catch (error) {
            $('source-file-list').innerHTML = `<li class="git-empty muted">加载工作区失败：${escapeHtml(error.message)}</li>`;
        } finally {
            setLoading(false);
        }
    }

    async function loadFiles() {
        if (!src.workspaceId) return;
        const seq = (src.listSeq += 1);
        setLoading(true);
        try {
            const data = await srcCall(api.sourceListFiles(src.workspaceId));
            if (seq !== src.listSeq) return;
            src.files = data.files || [];
            src.lowerFiles = src.files.map(f => f.toLowerCase());
            src.tree = buildTree(src.files);
            src.truncated = Boolean(data.truncated);
            src.limit = data.limit || 0;
            renderFileList();
        } catch (error) {
            if (seq !== src.listSeq) return;
            src.files = [];
            src.lowerFiles = [];
            $('source-summary').textContent = '';
            $('source-file-list').innerHTML = `<li class="git-empty muted">读取文件列表失败：${escapeHtml(error.message)}</li>`;
        } finally {
            if (seq === src.listSeq) setLoading(false);
        }
    }

    function searchTokens() {
        return $('source-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    }

    function matchIndices(tokens) {
        if (!tokens.length) return src.files.map((_, i) => i);
        const scored = [];
        for (let i = 0; i < src.lowerFiles.length; i += 1) {
            const p = src.lowerFiles[i];
            if (!tokens.every(t => p.includes(t))) continue;
            const base = p.slice(p.lastIndexOf('/') + 1);
            let score = 0;
            for (const t of tokens) {
                if (base === t) score += 100;
                else if (base.startsWith(t)) score += 40;
                else if (base.includes(t)) score += 20;
            }
            scored.push([score - p.length * 0.01, i]);
        }
        scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
        return scored.map(s => s[1]);
    }

    // ============================ 文件夹树 ============================

    function loadExpanded(wsId) {
        if (!wsId) return new Set();
        try {
            const list = JSON.parse(localStorage.getItem(EXPANDED_KEY + wsId) || '[]');
            return new Set(Array.isArray(list) ? list.filter(item => typeof item === 'string') : []);
        } catch (_e) {
            return new Set();
        }
    }

    function saveExpanded() {
        if (!src.workspaceId) return;
        localStorage.setItem(EXPANDED_KEY + src.workspaceId, JSON.stringify([...src.expanded].slice(-2000)));
    }

    /** 由文件路径列表构建目录树；目录在前、文件在后，按名称自然排序。 */
    function buildTree(files) {
        const makeNode = (name, p) => ({ name, path: p, dirs: new Map(), dirList: [], files: [], count: 0 });
        const root = makeNode('', '');
        let dirCount = 0;
        for (const file of files) {
            const parts = file.split('/');
            let node = root;
            node.count += 1;
            for (let i = 0; i < parts.length - 1; i += 1) {
                let child = node.dirs.get(parts[i]);
                if (!child) {
                    child = makeNode(parts[i], node.path ? `${node.path}/${parts[i]}` : parts[i]);
                    node.dirs.set(parts[i], child);
                    dirCount += 1;
                }
                node = child;
                node.count += 1;
            }
            node.files.push(file);
        }
        const finalize = node => {
            node.dirList = [...node.dirs.values()].sort((a, b) => collator.compare(a.name, b.name));
            node.files.sort((a, b) => collator.compare(baseName(a), baseName(b)));
            node.dirList.forEach(finalize);
        };
        finalize(root);
        root.dirCount = dirCount;
        return root;
    }

    /** 只含单个子目录、没有文件的目录链合并显示为一行（如 src/lib）。 */
    function compactDir(dir) {
        let node = dir;
        let label = dir.name;
        while (!node.files.length && node.dirList.length === 1) {
            node = node.dirList[0];
            label += `/${node.name}`;
        }
        return { node, label };
    }

    function treeRows() {
        const rows = [];
        let truncated = false;
        const walk = (node, depth) => {
            for (const dir of node.dirList) {
                if (rows.length >= MAX_TREE_ROWS) { truncated = true; return; }
                const { node: target, label } = compactDir(dir);
                const open = src.expanded.has(target.path);
                rows.push({ type: 'dir', path: target.path, label, count: target.count, depth, open });
                if (open) walk(target, depth + 1);
            }
            for (const file of node.files) {
                if (rows.length >= MAX_TREE_ROWS) { truncated = true; return; }
                rows.push({ type: 'file', path: file, depth });
            }
        };
        if (src.tree) walk(src.tree, 0);
        return { rows, truncated };
    }

    function fileRowHtml(p, { depth = 0, tokens = [], flat = false } = {}) {
        const slash = p.lastIndexOf('/');
        const base = slash === -1 ? p : p.slice(slash + 1);
        const dir = slash === -1 ? '' : p.slice(0, slash);
        const ext = extOf(p);
        return `
            <li class="source-row source-file${p === src.file?.path ? ' active' : ''}" data-path="${escapeHtml(p)}" data-depth="${depth}" style="--depth:${depth}">
                <button type="button" class="source-open" title="${escapeHtml(p)}">
                    ${flat ? '' : '<span class="source-chev" aria-hidden="true"></span>'}
                    <span class="source-ext">${escapeHtml(ext ? ext.slice(0, 4) : '·')}</span>
                    <span class="git-name">${highlight(base, tokens)}</span>
                    ${flat && dir ? `<span class="git-dir">${highlight(dir, tokens)}</span>` : ''}
                </button>
            </li>`;
    }

    function dirRowHtml(row) {
        return `
            <li class="source-row source-dir${row.open ? ' open' : ''}" data-dir="${escapeHtml(row.path)}" data-depth="${row.depth}" style="--depth:${row.depth}">
                <button type="button" class="source-open" title="${escapeHtml(row.path)}" aria-expanded="${row.open}">
                    <span class="source-chev" aria-hidden="true">▸</span>
                    <span class="source-folder" aria-hidden="true"></span>
                    <span class="git-name">${escapeHtml(row.label)}</span>
                    <span class="source-count">${row.count}</span>
                </button>
            </li>`;
    }

    function summaryTail(parts) {
        if (src.truncated) parts.push(`文件过多，只扫描了前 ${src.limit} 个`);
        $('source-summary').textContent = parts.join(' · ');
    }

    function renderTree() {
        const box = $('source-file-list');
        box.classList.add('tree');
        if (!src.files.length || !src.tree) {
            summaryTail(['共 0 个文件']);
            box.innerHTML = '<li class="git-empty muted">工作区内没有文件</li>';
            return;
        }
        const { rows, truncated } = treeRows();
        const parts = [`${src.files.length} 个文件 · ${src.tree.dirCount} 个文件夹`];
        if (truncated) parts.push(`展开内容过多，仅显示前 ${MAX_TREE_ROWS} 行`);
        summaryTail(parts);
        box.innerHTML = rows.map(r => (r.type === 'dir' ? dirRowHtml(r) : fileRowHtml(r.path, { depth: r.depth }))).join('');
    }

    function renderSearchResults(tokens) {
        const box = $('source-file-list');
        box.classList.remove('tree');
        const indices = matchIndices(tokens);
        const shown = indices.slice(0, MAX_RENDER);
        const parts = [`匹配 ${indices.length} / ${src.files.length} 个文件`];
        if (indices.length > MAX_RENDER) parts.push(`仅显示前 ${MAX_RENDER} 个，请输入更精确的关键字`);
        summaryTail(parts);
        box.innerHTML = shown.length
            ? shown.map(i => fileRowHtml(src.files[i], { tokens, flat: true })).join('')
            : `<li class="git-empty muted">${src.files.length ? '没有匹配的文件' : '工作区内没有文件'}</li>`;
    }

    /** 搜索框为空时显示文件夹树，否则显示按文件名匹配的扁平结果。 */
    function renderFileList() {
        const tokens = searchTokens();
        if (tokens.length) renderSearchResults(tokens);
        else renderTree();
    }

    const listRows = () => [...$('source-file-list').querySelectorAll('.source-row')];

    function focusDirRow(dirPath) {
        listRows().find(r => r.dataset.dir === dirPath)?.querySelector('.source-open')?.focus({ preventScroll: true });
    }

    function toggleDir(dirPath, open = !src.expanded.has(dirPath)) {
        if (open === src.expanded.has(dirPath)) return;
        if (open) src.expanded.add(dirPath);
        else src.expanded.delete(dirPath);
        saveExpanded();
        renderFileList();
        focusDirRow(dirPath);
    }

    function revealPath(p) {
        const parts = String(p || '').split('/');
        let changed = false;
        for (let i = 1; i < parts.length; i += 1) {
            const dir = parts.slice(0, i).join('/');
            if (!src.expanded.has(dir)) {
                src.expanded.add(dir);
                changed = true;
            }
        }
        if (changed) saveExpanded();
    }

    function scrollActiveIntoView() {
        requestAnimationFrame(() => {
            listRows().find(r => r.classList.contains('active'))?.scrollIntoView({ block: 'nearest' });
        });
    }

    function revealCurrent() {
        if (!src.file) return;
        $('source-search').value = '';
        revealPath(src.file.path);
        renderFileList();
        scrollActiveIntoView();
    }

    function collapseAll() {
        src.expanded.clear();
        saveExpanded();
        renderFileList();
    }

    function highlightActiveRow() {
        const activePath = src.file?.path;
        document.querySelectorAll('#source-file-list .source-row').forEach(row => {
            row.classList.toggle('active', row.dataset.path === activePath);
        });
    }

    async function changeWorkspace(nextId) {
        if (!nextId || nextId === src.workspaceId) return;
        if (isDirty() && !(await confirmDiscard())) {
            $('source-workspace-select').value = src.workspaceId || '';
            return;
        }
        src.workspaceId = nextId;
        src.expanded = loadExpanded(nextId);
        localStorage.setItem(WS_KEY, nextId);
        renderWorkspaceSelect();
        closeFile();
        src.files = [];
        src.lowerFiles = [];
        $('source-file-list').innerHTML = '<li class="git-empty muted">加载中…</li>';
        await loadFiles();
    }

    // ============================ 打开 / 关闭 ============================

    function confirmDiscard() {
        return confirmDialog('放弃未保存的更改', `
            <div><code>${escapeHtml(src.file?.path || '')}</code> 有未保存的更改。</div>
            <div style="margin-top:6px">继续将丢弃这些修改。</div>`, '放弃更改');
    }

    function resetEditorPane(message) {
        if (src.editor) {
            src.editor.setOption('lint', false);
            src.editor.setValue('');
            src.editor.clearHistory();
            src.cleanGen = src.editor.changeGeneration(true);
        }
        $('source-editor').hidden = true;
        $('source-fallback').hidden = false;
        $('source-fallback').textContent = message;
        $('source-problems').hidden = true;
        $('source-check-btn').disabled = true;
    }

    function closeFile() {
        src.openSeq += 1;
        src.file = null;
        src.diagnostics = null;
        resetEditorPane('选择左侧的文件以查看 / 编辑源码');
        hideNotice();
        $('source-title').textContent = '源码';
        $('source-meta').innerHTML = '';
        highlightActiveRow();
        syncDirty();
    }

    async function openFile(relPath, { reload = false } = {}) {
        if (!src.workspaceId || !relPath) return;
        if (!reload && src.file?.path === relPath) {
            src.editor?.focus();
            return;
        }
        if (!reload && isDirty() && !(await confirmDiscard())) return;
        const seq = (src.openSeq += 1);
        let data;
        try {
            data = await srcCall(api.sourceReadFile(src.workspaceId, relPath));
        } catch (error) {
            if (seq !== src.openSeq) return;
            toast(`打开文件失败：${error.message}`, 'error');
            return;
        }
        if (seq !== src.openSeq) return;
        showFile(data, { keepView: reload });
    }

    function showFile(data, { keepView = false } = {}) {
        const readable = !data.binary && !data.tooLarge;
        const editable = readable && data.editable;
        src.openSeq += 1;
        src.file = {
            path: data.path,
            hash: data.hash,
            eol: data.eol,
            savedEol: data.eol,
            bom: data.bom,
            editable,
            encodingError: Boolean(data.encodingError),
            checkLanguage: readable ? data.checkLanguage : null,
            size: data.size,
        };
        src.diagnostics = null;
        src.lastDiskCheck = Date.now();
        // 在树中展开该文件所在的文件夹并定位
        revealPath(data.path);
        renderFileList();
        scrollActiveIntoView();
        hideNotice();

        $('source-title').innerHTML = `<code>${escapeHtml(data.path)}</code>`;
        $('source-meta').innerHTML = `
            <span>${escapeHtml(fmtSize(data.size))}</span>
            ${data.checkLanguage ? `<span>支持 ${escapeHtml(data.checkLanguage)} 格式检查</span>` : '<span>不支持格式检查</span>'}
            ${editable ? '' : '<span style="color:var(--pf-warn)">只读</span>'}`;

        if (!readable) {
            resetEditorPane(data.binary
                ? `二进制文件，无法以文本方式打开（${fmtSize(data.size)}）。`
                : `文件超过 ${fmtSize(data.limit)}，为避免卡顿不在此打开（${fmtSize(data.size)}）。`);
            syncDirty();
            return;
        }
        if (data.encodingError) showNotice('⚠ 文件不是有效的 UTF-8 编码，已以只读方式打开，避免保存时损坏内容。', 'warn');

        const cm = ensureEditor();
        const view = keepView ? { cursor: cm.getCursor(), scroll: cm.getScrollInfo() } : null;
        cm.setOption('lint', false);
        $('source-fallback').hidden = true;
        $('source-editor').hidden = false;
        $('source-problems').hidden = true;
        cm.setOption('mode', sourceMode(data.path));
        applyIndent(cm, data.text);
        cm.setValue(data.text);
        cm.clearHistory();
        src.cleanGen = cm.changeGeneration(true);
        cm.setOption('readOnly', !editable);
        $('source-check-btn').disabled = !src.file.checkLanguage;
        if (src.file.checkLanguage) cm.setOption('lint', lintConfig());

        requestAnimationFrame(() => {
            cm.refresh();
            if (view) {
                cm.setCursor(view.cursor);
                cm.scrollTo(view.scroll.left, view.scroll.top);
            }
        });
        syncDirty();
        updateCursor();
    }

    /** 回到窗口 / 分页时核对磁盘内容：未修改则静默重载，有本地修改则提示。 */
    async function checkDiskChange({ force = false } = {}) {
        const file = src.file;
        if (!file || !src.workspaceId || !file.hash || src.saving) return;
        if (!force && Date.now() - src.lastDiskCheck < DISK_CHECK_INTERVAL) return;
        src.lastDiskCheck = Date.now();
        let data;
        try {
            data = await srcCall(api.sourceReadFile(src.workspaceId, file.path));
        } catch (error) {
            if (src.file === file) showNotice(`⚠ 无法读取磁盘上的文件：${escapeHtml(error.message)}`, 'warn');
            return;
        }
        if (src.file !== file || src.saving || data.hash === file.hash) return;
        if (!isDirty()) {
            showFile(data, { keepView: true });
            toast('文件已被外部修改，已重新载入');
        } else {
            showNotice(`⚠ 磁盘上的文件已被其他程序修改。保存时会提示是否覆盖；也可以
                <button type="button" class="btn small" data-source-action="reload">放弃本地修改并重新载入</button>`, 'warn');
        }
    }

    // ============================ 保存 ============================

    async function saveCurrent({ force = false } = {}) {
        const file = src.file;
        const cm = src.editor;
        if (!file || !cm || !file.editable || src.saving) return;
        if (!force && !isDirty()) return;

        src.saving = true;
        syncDirty();
        const content = cm.getValue();
        const generation = cm.changeGeneration();
        let conflict = false;
        try {
            const res = await srcCall(api.sourceWriteFile(src.workspaceId, file.path, {
                content,
                expectedHash: file.hash,
                eol: file.eol,
                force,
            }));
            if (src.file !== file) return;
            file.hash = res.hash;
            file.savedEol = file.eol;
            file.size = res.size;
            src.cleanGen = generation;
            src.lastDiskCheck = Date.now();
            hideNotice();
            toast(res.changed ? `已保存 ${baseName(file.path)}` : '内容与磁盘一致，无需写入', 'success');
            if (file.checkLanguage) cm.performLint();
        } catch (error) {
            if (error.code === 'CONFLICT') conflict = true;
            else toast(`保存失败：${error.message}`, 'error');
        } finally {
            src.saving = false;
            syncDirty();
        }

        if (conflict && src.file === file) {
            const ok = await confirmDialog('文件已被修改', `
                <div><code>${escapeHtml(file.path)}</code> 在打开之后已被 Agent 或其他程序修改。</div>
                <div class="warn-line" style="margin:8px 0">⚠ 覆盖保存将丢弃磁盘上的那些改动。</div>
                <div class="muted">取消后可在提示条中选择「重新载入」。</div>`, '覆盖保存');
            if (ok) await saveCurrent({ force: true });
            else showNotice(`⚠ 磁盘上的文件已被其他程序修改。
                <button type="button" class="btn small" data-source-action="reload">放弃本地修改并重新载入</button>`, 'warn');
        }
    }

    // ============================ 分页进入 / 离开 ============================

    function onEnterSourceTab() {
        if (!src.started) {
            src.started = true;
            loadWorkspaces();
        } else {
            checkDiskChange();
        }
        requestAnimationFrame(() => src.editor?.refresh());
    }

    // ============================ 事件绑定 ============================

    function bindEvents() {
        $('source-workspace-select').addEventListener('change', e => changeWorkspace(e.target.value));
        $('source-refresh-btn').addEventListener('click', () => {
            loadWorkspaces();
            checkDiskChange({ force: true });
        });

        const search = $('source-search');
        search.addEventListener('input', debounce(renderFileList, 80));
        search.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const first = $('source-file-list').querySelector('.source-row[data-path]');
                if (first) openFile(first.dataset.path);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                $('source-file-list').querySelector('.source-open')?.focus();
            }
        });

        const list = $('source-file-list');
        list.addEventListener('click', e => {
            const row = e.target.closest('.source-row');
            if (!row) return;
            if (row.dataset.dir !== undefined) toggleDir(row.dataset.dir);
            else if (row.dataset.path) openFile(row.dataset.path);
        });
        list.addEventListener('keydown', e => {
            if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
            const buttons = [...list.querySelectorAll('.source-open')];
            const index = buttons.indexOf(document.activeElement);
            if (index === -1) return;
            e.preventDefault();
            const row = buttons[index].closest('.source-row');
            const isDir = row.dataset.dir !== undefined;
            if (e.key === 'ArrowRight') {
                // 右：展开文件夹；已展开则进入第一个子项
                if (isDir && !src.expanded.has(row.dataset.dir)) toggleDir(row.dataset.dir, true);
                else if (isDir) buttons[index + 1]?.focus();
                return;
            }
            if (e.key === 'ArrowLeft') {
                // 左：折叠文件夹；否则回到上级文件夹
                if (isDir && src.expanded.has(row.dataset.dir)) {
                    toggleDir(row.dataset.dir, false);
                    return;
                }
                const depth = Number(row.dataset.depth) || 0;
                if (!depth) return;
                for (let i = index - 1; i >= 0; i -= 1) {
                    const r = buttons[i].closest('.source-row');
                    if (r.dataset.dir !== undefined && Number(r.dataset.depth) === depth - 1) {
                        buttons[i].focus();
                        break;
                    }
                }
                return;
            }
            if (e.key === 'ArrowUp' && index === 0) search.focus();
            else buttons[Math.min(buttons.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1))]?.focus();
        });
        $('source-collapse-btn').addEventListener('click', collapseAll);
        $('source-reveal-btn').addEventListener('click', revealCurrent);

        $('source-save-btn').addEventListener('click', () => saveCurrent());
        $('source-wrap-btn').addEventListener('click', toggleWrap);
        $('source-check-btn').addEventListener('click', runCheck);
        $('source-problems-close').addEventListener('click', () => {
            $('source-problems').hidden = true;
            src.editor?.refresh();
        });
        $('source-problems-list').addEventListener('click', e => {
            const item = e.target.closest('.source-problem');
            if (item) jumpTo(Number(item.dataset.line), Number(item.dataset.column));
        });

        $('source-status-eol').addEventListener('click', e => {
            if (!e.target.closest('.source-eol-btn') || !src.file?.editable) return;
            src.file.eol = src.file.eol === '\r\n' ? '\n' : '\r\n';
            syncDirty();
        });

        $('source-notice').addEventListener('click', async e => {
            const btn = e.target.closest('[data-source-action="reload"]');
            if (!btn || !src.file) return;
            if (isDirty() && !(await confirmDiscard())) return;
            openFile(src.file.path, { reload: true });
        });

        document.addEventListener('keydown', e => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's' || !isSourceTab()) return;
            if (!$('node-modal').hidden || !$('confirm-modal').hidden) return;
            e.preventDefault();
            saveCurrent();
        });

        window.addEventListener('focus', () => {
            if (isSourceTab()) checkDiskChange();
        });

        // 关闭窗口前确认未保存的修改（捕获阶段先于 projectforge.js 的关闭处理执行）
        $('close-btn').addEventListener('click', async e => {
            if (!isDirty()) return;
            e.stopImmediatePropagation();
            if (!(await confirmDiscard())) return;
            if (api?.closeWindow) api.closeWindow();
            else window.close();
        }, true);
    }

    // ============================ 初始化 ============================

    document.addEventListener('DOMContentLoaded', () => {
        if (!api?.sourceListFiles || !api?.gitListWorkspaces) {
            console.info('[ProjectForgeSource] 源码 API 不可用，隐藏源码分页。');
            $('side-tab-source').hidden = true;
            return;
        }
        src.enabled = true;
        syncWrapButton();
        renderStatus();
        bindEvents();
        window.ProjectForgeSideTabs?.register('source', { onEnter: onEnterSourceTab });
    });
})();