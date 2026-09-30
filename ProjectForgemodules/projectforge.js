// ProjectForgemodules/projectforge.js
// ProjectForge 施工图 GUI：数据库展示器。只读浏览；唯一写操作为带署名的单文件回退。
'use strict';

const api = window.utilityAPI || window.electronAPI;
const SIGNATURE_KEY = 'vcp-projectforge-signature';
const DIFF_WRAP_KEY = 'vcp-projectforge-diff-wrap';

const state = {
    projects: [],
    currentId: null,
    detail: null,
    currentNode: null,
    diffView: null,
    diffWrap: localStorage.getItem(DIFF_WRAP_KEY) === '1',
};

const $ = id => document.getElementById(id);

// ============================ 工具 ============================

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmtTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function maidHtml(maid, kind) {
    if (maid) return `<span class="maid">@${escapeHtml(maid)}</span>`;
    return `<span class="maid none">${kind === 'external' ? '@外部' : '@未署名'}</span>`;
}

const KIND_LABEL = { edit: '编辑', create: '新建', remove: '删除', move: '移动', rollback: '回退', external: '外部修改' };
const TODO_LABEL = { pending: '待办', doing: '进行中', done: '完成', blocked: '阻塞' };
const STATUS_LABEL = { active: '施工中', review: '待验收', accepted: '已验收' };

async function call(promise) {
    const result = await promise;
    if (!result?.success) throw new Error(result?.error || '未知错误');
    return result.data;
}

let toastTimer = null;
function toast(message, type = 'info') {
    const el = $('toast');
    el.textContent = message;
    el.className = `toast ${type}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, type === 'error' ? 5000 : 2600);
}

function statusBadge(project) {
    if (project.deleted_at) return '<span class="badge deleted">已删除</span>';
    const s = project.status || 'active';
    return `<span class="badge ${escapeHtml(s)}">${escapeHtml(STATUS_LABEL[s] || s)}</span>`;
}

function opBadge(op) {
    return `<span class="badge op-${escapeHtml(op)}">${escapeHtml(op)}</span>`;
}

function progressBar(progress) {
    const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return `<div class="progress" title="Todo ${escapeHtml(progress?.text || '无')}"><span style="width:${pct}%"></span></div>`;
}

/** 报告来自 AI 生成的 markdown：渲染后剥离脚本与事件属性。 */
function renderMarkdownSafe(md) {
    const html = window.marked ? window.marked.parse(String(md || '')) : `<pre>${escapeHtml(md)}</pre>`;
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    doc.querySelectorAll('script, iframe, object, embed, style, link, meta').forEach(n => n.remove());
    doc.querySelectorAll('*').forEach(el => {
        for (const attr of [...el.attributes]) {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on')) el.removeAttribute(attr.name);
            if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
        }
    });
    return doc.body.firstChild.innerHTML;
}

function modeForPath(filePath) {
    const ext = String(filePath || '').split('.').pop().toLowerCase();
    const map = {
        js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
        ts: { name: 'javascript', typescript: true }, tsx: { name: 'javascript', typescript: true },
        json: { name: 'javascript', json: true },
        py: 'python', css: 'css', scss: 'css', less: 'css',
        html: 'htmlmixed', htm: 'htmlmixed', xml: 'xml', svg: 'xml', vue: 'htmlmixed',
        md: 'markdown', rs: 'rust', go: 'go',
        c: 'text/x-csrc', h: 'text/x-csrc', cpp: 'text/x-c++src', hpp: 'text/x-c++src',
        java: 'text/x-java', cs: 'text/x-csharp', kt: 'text/x-kotlin',
        sh: 'shell', bash: 'shell', ps1: 'shell', yml: 'yaml', yaml: 'yaml', sql: 'sql',
    };
    return map[ext] || 'text/plain';
}

function isLightTheme() {
    return document.body.classList.contains('light-theme');
}

/** CodeMirror 按 \n 分行并丢弃 \r；diff 必须在同样的文本上计算，否则 CRLF 文件字级标记错位、甚至整篇标红。 */
function normalizeEol(text) {
    return String(text || '').replace(/\r\n?/g, '\n');
}

function countLines(text) {
    let n = 1;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
    return n;
}

// 不超过该行数时一次性渲染全部行（相同段落已折叠，实际 DOM 量通常很小）
const DIFF_FULL_RENDER_MAX_LINES = 1500;

/** 施工图节点与 Git 侧栏共用的只读 MergeView。left = 改动前，right = 改动后。 */
function createDiffMergeView(container, { left, right, filePath }) {
    const lines = Math.max(countLines(left), countLines(right));
    return CodeMirror.MergeView(container, {
        // origLeft = 改动前（删除标红），value = 改动后（新增标绿）。
        // value=前 / orig=后 会让 MergeView 把增删方向完全颠倒。
        origLeft: left,
        value: right,
        connect: 'align',
        mode: modeForPath(filePath),
        theme: isLightTheme() ? 'default' : 'material-darker',
        lineNumbers: true,
        readOnly: true,
        revertButtons: false,
        highlightDifferences: true,
        collapseIdentical: 4,
        lineWrapping: state.diffWrap,
        // 中小文件全量渲染：滚动时两侧编辑器不再重绘，行高也不再变化，
        // 避免 align 模式在滚动中反复清空并重建所有对齐占位（换行模式下最明显）
        viewportMargin: lines <= DIFF_FULL_RENDER_MAX_LINES ? Infinity : 30,
        // 语法高亮后台任务切成短片，避免默认 100ms 的长任务卡帧
        workTime: 16,
        workDelay: 50,
    });
}

// ============================ 署名 ============================

function getSignature() {
    return $('signature-input').value.trim();
}

function syncSignatureChip() {
    $('signature-input').closest('.signature-chip').classList.toggle('missing', !getSignature());
}

async function initSignature() {
    let saved = localStorage.getItem(SIGNATURE_KEY) || '';
    if (!saved && api?.loadForumConfig) {
        // 与论坛模块一致：默认取回帖署名，其次登录名
        try {
            const cfg = await api.loadForumConfig();
            saved = cfg?.replyUsername || cfg?.username || '';
        } catch (_e) { /* ignore */ }
    }
    $('signature-input').value = saved;
    syncSignatureChip();
    $('signature-input').addEventListener('input', () => {
        localStorage.setItem(SIGNATURE_KEY, getSignature());
        syncSignatureChip();
    });
}

// ============================ 工程列表 ============================

async function loadProjects() {
    try {
        state.projects = await call(api.projectForgeListProjects({
            includeDeleted: $('include-deleted').checked,
        }));
        renderProjectList();
        if (state.currentId && !state.projects.some(p => p.id === state.currentId)) {
            state.currentId = null;
            showProjectView(false);
        }
    } catch (error) {
        $('project-list').innerHTML = `<li class="muted" style="padding:12px">加载失败：${escapeHtml(error.message)}</li>`;
    }
}

function renderProjectList() {
    const term = $('project-search').value.trim().toLowerCase();
    const list = state.projects.filter(p => !term
        || p.name.toLowerCase().includes(term)
        || p.id.toLowerCase().includes(term)
        || (p.maids || []).some(m => m && m.toLowerCase().includes(term)));
    const ul = $('project-list');
    if (!list.length) {
        ul.innerHTML = '<li class="muted" style="padding:12px">没有工程。Agent 通过 ProjectForge CreateProject 创建后会出现在这里。</li>';
        return;
    }
    ul.innerHTML = list.map(p => `
        <li class="project-item${p.id === state.currentId ? ' active' : ''}${p.deleted_at ? ' deleted' : ''}" data-id="${escapeHtml(p.id)}">
            <div class="row"><span class="name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>${statusBadge(p)}</div>
            <div class="sub"><code>${escapeHtml(p.id)}</code> · ${escapeHtml(p.workspace_alias || '-')} · Todo ${escapeHtml(p.progress?.text || '无')}</div>
            <div class="sub meta-line">
                <span>${p.stats?.nodeCount || 0} 次变动 · 最近 ${escapeHtml(fmtTime(p.stats?.lastAt || p.updated_at))}</span>
                ${p.status === 'accepted' && !p.deleted_at ? `
                <div class="project-delete-wrap" data-id="${escapeHtml(p.id)}">
                    <button class="project-delete-trigger" type="button" title="删除工程" aria-label="删除工程">
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                            <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
                            <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
                        </svg>
                    </button>
                    <button class="project-delete-confirm" type="button" data-id="${escapeHtml(p.id)}">是否删除工程？</button>
                </div>` : ''}
            </div>
            ${progressBar(p.progress)}
        </li>`).join('');
}

// ============================ 工程详情 ============================

function showProjectView(show) {
    $('project-view').hidden = !show;
    $('empty-state').hidden = show;
}

async function selectProject(projectId, { keepTab = false } = {}) {
    state.currentId = projectId;
    renderProjectList();
    try {
        state.detail = await call(api.projectForgeGetProject(projectId));
    } catch (error) {
        toast(`读取工程失败：${error.message}`, 'error');
        return;
    }
    showProjectView(true);
    renderHeader();
    renderOverview();
    renderTimeline();
    renderFiles();
    renderReport();
    if (!keepTab) switchTab('overview');
    $('history-results').innerHTML = '<p class="muted">输入条件后搜索本工程的变动历史。</p>';
}

function renderHeader() {
    const { project } = state.detail;
    const ri = project.rootInfo || {};
    $('project-header').innerHTML = `
        <h2>${escapeHtml(project.name)} ${statusBadge(project)}</h2>
        <div class="header-meta">
            <span>ID <code>${escapeHtml(project.id)}</code></span>
            <span>工作区 ${escapeHtml(ri.workspaceAlias || project.workspace_alias || '-')}</span>
            <span title="${escapeHtml(ri.root)}">根目录 <code>${escapeHtml(ri.root || project.root)}</code></span>
            <span>创建者 ${maidHtml(project.created_by)}</span>
            <span>创建于 ${escapeHtml(fmtTime(project.created_at))}</span>
        </div>
        ${ri.writable === false ? `<div class="warn-line">⚠ ${escapeHtml(ri.blockedReason || '工程只读')}（无法回退）</div>` : ''}
        ${project.deleted_at ? `<div class="warn-line">⚠ 工程已被 ${escapeHtml(project.deleted_by ? '@' + project.deleted_by : '')} 删除（仅数据库记录）</div>` : ''}`;
}

function renderOverview() {
    const { project, todos, contributors } = state.detail;
    const st = project.stats || {};
    const todoHtml = todos.length ? `<ul class="todo-list">${todos.map(t => `
        <li>
            <span class="todo-state ${escapeHtml(t.status)}">${escapeHtml(TODO_LABEL[t.status] || t.status)}</span>
            <span>#${t.seq} ${escapeHtml(t.title)}${t.note ? `<div class="note">${escapeHtml(t.note)}</div>` : ''}</span>
            <span class="muted" style="margin-left:auto;font-size:12px;white-space:nowrap">${t.updated_by ? maidHtml(t.updated_by) : ''} ${escapeHtml(fmtTime(t.updated_at))}</span>
        </li>`).join('')}</ul>` : '<p class="muted">暂无 todo</p>';

    const roleHtml = contributors.length ? `<table class="grid"><thead><tr><th>施工角色</th><th>批次</th><th>增删</th><th>最近活动</th><th></th></tr></thead><tbody>${contributors.map(c => `
        <tr>
            <td>${maidHtml(c.maid, c.maid ? null : 'external')}</td>
            <td>${c.batches}</td>
            <td><span class="plus">+${c.added}</span> / <span class="minus">-${c.removed}</span></td>
            <td class="muted">${escapeHtml(fmtTime(c.last_at))}</td>
            <td>${c.maid ? `<button class="btn" data-history-maid="${escapeHtml(c.maid)}">查看其改动</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>` : '<p class="muted">暂无</p>';

    $('pane-overview').innerHTML = `
        <div class="section-title">进度</div>
        <div class="stat-grid">
            <div class="stat"><div class="v">${escapeHtml(project.progress?.text || '无')}</div><div class="k">Todo 完成</div>${progressBar(project.progress)}</div>
            <div class="stat"><div class="v">${st.nodeCount || 0}</div><div class="k">变动节点</div></div>
            <div class="stat"><div class="v">${st.fileCount || 0}</div><div class="k">涉及文件</div></div>
            <div class="stat"><div class="v"><span class="plus">+${st.added || 0}</span> <span class="minus">-${st.removed || 0}</span></div><div class="k">累计增删行</div></div>
            <div class="stat"><div class="v" style="font-size:14px">${escapeHtml(fmtTime(st.lastAt))}</div><div class="k">最近变动</div></div>
        </div>
        <div class="section-title">Todo</div>
        ${todoHtml}
        <div class="section-title">施工角色</div>
        ${roleHtml}`;
}

function renderTimeline() {
    const { timeline } = state.detail;
    if (!timeline.length) {
        $('pane-timeline').innerHTML = '<p class="muted">暂无改动</p>';
        return;
    }
    $('pane-timeline').innerHTML = `<div class="timeline">${timeline.map(b => `
        <div class="tl-item kind-${escapeHtml(b.kind)}" data-batch="${b.id}">
            <div class="tl-card">
                <div class="tl-head">
                    <code>b${b.id}</code>
                    <span class="badge">${escapeHtml(KIND_LABEL[b.kind] || b.kind)}</span>
                    ${maidHtml(b.maid, b.kind)}
                    <span class="muted">${escapeHtml(fmtTime(b.created_at))}</span>
                    <span class="muted">${b.node_count} 个节点 · <span class="plus">+${b.added}</span>/<span class="minus">-${b.removed}</span></span>
                </div>
                <div class="tl-reason">${escapeHtml(b.reason || '（未记录原因）')}</div>
                <div class="muted" style="font-size:12px;margin-top:4px">${b.files.slice(0, 6).map(f => `<code>${escapeHtml(f)}</code>`).join('、')}${b.files.length > 6 ? ` 等 ${b.files.length} 个` : ''}</div>
                <div class="tl-nodes"></div>
            </div>
        </div>`).join('')}</div>`;
}

function nodeRowHtml(n) {
    return `
        <div class="node-row" data-node="${n.id}">
            <code>n${n.id}</code>
            ${opBadge(n.op)}
            <span class="path mono" title="${escapeHtml(n.file_path)}">${escapeHtml(n.file_path)}</span>
            <span class="muted">${escapeHtml(n.reason || n.summary || '')}</span>
            <span><span class="plus">+${n.added}</span>/<span class="minus">-${n.removed}</span></span>
        </div>`;
}

async function toggleBatch(item) {
    const open = item.classList.toggle('open');
    const box = item.querySelector('.tl-nodes');
    if (!open || box.dataset.loaded) return;
    box.innerHTML = '<p class="muted">加载中...</p>';
    try {
        const { nodes } = await call(api.projectForgeGetBatch(state.currentId, Number(item.dataset.batch)));
        box.innerHTML = nodes.map(nodeRowHtml).join('') || '<p class="muted">无节点</p>';
        box.dataset.loaded = '1';
    } catch (error) {
        box.innerHTML = `<p class="muted">加载失败：${escapeHtml(error.message)}</p>`;
    }
}

function renderFiles() {
    const { files } = state.detail;
    $('pane-files').innerHTML = files.length ? `
        <table class="grid"><thead><tr><th>文件</th><th>改动次数</th><th>增删</th><th>最近节点</th></tr></thead><tbody>
        ${files.map(f => `
            <tr class="clickable" data-file="${escapeHtml(f.file_path)}" title="查看该文件的全部变动">
                <td class="mono">${escapeHtml(f.file_path)}</td>
                <td>${f.edits}</td>
                <td><span class="plus">+${f.added || 0}</span> / <span class="minus">-${f.removed || 0}</span></td>
                <td><code>n${f.last_node}</code></td>
            </tr>`).join('')}
        </tbody></table>` : '<p class="muted">暂无改动文件</p>';
}

function renderReport() {
    const { project } = state.detail;
    $('pane-report').innerHTML = project.report
        ? `<div class="muted" style="margin-bottom:10px">提交者 ${maidHtml(project.report_by)} · 状态 ${statusBadge(project)}</div><div class="markdown">${renderMarkdownSafe(project.report)}</div>`
        : '<p class="muted">尚未提交验收报告。</p>';
}

// ============================ 历史搜索 ============================

async function runHistorySearch(filters = {}) {
    const box = $('history-results');
    box.innerHTML = '<p class="muted">搜索中...</p>';
    try {
        const rows = await call(api.projectForgeSearchHistory({ projectId: state.currentId, limit: 300, ...filters }));
        if (!rows.length) {
            box.innerHTML = '<p class="muted">没有匹配的记录。</p>';
            return;
        }
        box.innerHTML = `
            <div class="muted" style="margin-bottom:8px">共 ${rows.length} 条</div>
            <table class="grid"><thead><tr><th>节点</th><th>操作</th><th>文件</th><th>操作者</th><th>原因</th><th>增删</th><th>时间</th></tr></thead><tbody>
            ${rows.map(r => `
                <tr class="clickable" data-node="${r.id}">
                    <td><code>n${r.id}</code><div class="muted"><code>b${r.batch_id}</code></div></td>
                    <td>${opBadge(r.op)}</td>
                    <td class="mono">${escapeHtml(r.file_path)}</td>
                    <td>${maidHtml(r.maid, r.batch_kind)}</td>
                    <td>${escapeHtml(r.effective_reason || r.summary || '（未记录原因）')}</td>
                    <td><span class="plus">+${r.added}</span>/<span class="minus">-${r.removed}</span></td>
                    <td class="muted">${escapeHtml(fmtTime(r.created_at))}</td>
                </tr>`).join('')}
            </tbody></table>`;
    } catch (error) {
        box.innerHTML = `<p class="muted">搜索失败：${escapeHtml(error.message)}</p>`;
    }
}

function historyByFilters(filters) {
    const form = $('history-form');
    for (const el of form.elements) {
        if (el.name) el.value = filters[el.name] || '';
    }
    switchTab('history');
    runHistorySearch(filters);
}

// ============================ 节点 Diff ============================

function destroyDiffView() {
    $('diff-view').innerHTML = '';
    state.diffView = null;
}

function syncDiffWrapButton() {
    const btn = $('diff-wrap-btn');
    btn.classList.toggle('active', state.diffWrap);
    btn.setAttribute('aria-pressed', String(state.diffWrap));
}

/** 按当前节点与换行设置（重新）创建 MergeView；topLine 用于重建后恢复阅读位置。 */
function buildDiffView({ topLine = null } = {}) {
    const detail = state.currentNode;
    if (!detail) return;
    const { node, before, after } = detail;
    destroyDiffView();
    const note = (b, label) => (b.exists ? (b.truncated ? `\n\n/* …${label}内容超过 2MB，已截断显示 */` : '') : '');
    state.diffView = createDiffMergeView($('diff-view'), {
        left: before.exists ? normalizeEol(before.text) + note(before, '改动前') : '',
        right: after.exists ? normalizeEol(after.text) + note(after, '改动后') : '',
        filePath: node.file_path,
    });
    // 容器在创建前已可见，尺寸测量正确，无需 refresh（refresh 会让两侧编辑器整体重测重绘一遍）
    if (topLine != null) {
        const editor = state.diffView.editor();
        editor.scrollTo(null, editor.heightAtLine(topLine, 'local'));
    }
}

function toggleDiffWrap() {
    state.diffWrap = !state.diffWrap;
    localStorage.setItem(DIFF_WRAP_KEY, state.diffWrap ? '1' : '0');
    syncDiffWrapButton();
    if (!state.diffView) return;
    // 换行会改变行高，按"顶部所在行"而非像素恢复位置；重建以保证 align 对齐正确
    const editor = state.diffView.editor();
    const topLine = editor.lineAtHeight(editor.getScrollInfo().top, 'local');
    buildDiffView({ topLine });
}

async function openNode(nodeId) {
    let detail;
    try {
        detail = await call(api.projectForgeGetNode(state.currentId, Number(nodeId)));
    } catch (error) {
        toast(`读取节点失败：${error.message}`, 'error');
        return;
    }
    state.currentNode = detail;
    const { node, batch, todo, before, after, laterChanges } = detail;
    $('node-title').innerHTML = `<code>n${node.id}</code> ${opBadge(node.op)} <span class="mono">${escapeHtml(node.file_path)}</span>`;
    $('node-meta').innerHTML = `
        <span>批次 <code>b${node.batch_id ?? '-'}</code></span>
        <span>操作者 ${maidHtml(batch?.maid, batch?.kind)}</span>
        <span>${escapeHtml(fmtTime(node.created_at))}</span>
        <span><span class="plus">+${node.added}</span>/<span class="minus">-${node.removed}</span></span>
        ${todo ? `<span>关联 Todo #${todo.seq} ${escapeHtml(todo.title)}</span>` : ''}
        ${laterChanges ? `<span style="color:var(--pf-warn)">此后该文件还有 ${laterChanges} 次改动</span>` : ''}
        <span class="reason">${escapeHtml(node.reason || batch?.reason || node.summary || '（未记录原因）')}</span>`;
    $('revert-reason').value = '';

    const writable = state.detail?.project?.rootInfo?.writable !== false && !state.detail?.project?.deleted_at;
    $('revert-before-btn').disabled = !writable;
    $('revert-after-btn').disabled = !writable;

    $('node-modal').hidden = false;
    destroyDiffView();
    syncDiffWrapButton();
    const fallback = $('diff-fallback');
    const binary = before.binary || after.binary;
    $('diff-wrap-btn').disabled = binary;
    if (binary) {
        fallback.hidden = false;
        fallback.textContent = `二进制文件，无法显示差异（改动前 ${before.size} B → 改动后 ${after.size} B）。`;
        $('diff-view').hidden = true;
        return;
    }
    fallback.hidden = true;
    $('diff-view').hidden = false;
    buildDiffView();
}

function closeNodeModal() {
    $('node-modal').hidden = true;
    destroyDiffView();
    state.currentNode = null;
}

function confirmDialog(title, bodyHtml, okText = '确定') {
    return new Promise(resolve => {
        $('confirm-title').textContent = title;
        $('confirm-body').innerHTML = bodyHtml;
        $('confirm-ok').textContent = okText;
        $('confirm-modal').hidden = false;
        const done = value => {
            $('confirm-modal').hidden = true;
            $('confirm-ok').onclick = null;
            $('confirm-cancel').onclick = null;
            resolve(value);
        };
        $('confirm-ok').onclick = () => done(true);
        $('confirm-cancel').onclick = () => done(false);
        $('confirm-modal').onclick = e => { if (e.target === $('confirm-modal')) done(false); };
    });
}

async function revertCurrent(mode) {
    const detail = state.currentNode;
    if (!detail) return;
    const signature = getSignature();
    if (!signature) {
        toast('回退需要署名，请先在右上角填写署名。', 'error');
        $('signature-input').focus();
        return;
    }
    const base = {
        projectId: state.currentId,
        nodeId: detail.node.id,
        mode,
        signature,
        reason: $('revert-reason').value.trim(),
    };
    let plan;
    try {
        plan = await call(api.projectForgeRevertFile({ ...base, dryRun: true }));
    } catch (error) {
        toast(`回退预检失败：${error.message}`, 'error');
        return;
    }
    if (plan.status === 'noop') {
        toast('磁盘内容已是目标状态，无需回退。');
        return;
    }
    const conflictHtml = plan.conflicts.length
        ? `<div class="conflict">⚠ 存在冲突，继续将强制覆盖（当前磁盘内容会先存快照，仍可再回退）：<ul>${plan.conflicts.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul></div>`
        : '';
    const ok = await confirmDialog(mode === 'after' ? '恢复到此版本' : '撤销此变动', `
        <div>${escapeHtml(plan.label)}</div>
        <div>文件：<code>${escapeHtml(plan.file)}</code></div>
        <div>动作：<strong>${escapeHtml(plan.action)}</strong></div>
        <div>署名：<span class="maid">@${escapeHtml(signature)}</span></div>
        ${base.reason ? `<div>原因：${escapeHtml(base.reason)}</div>` : ''}
        ${conflictHtml}`, plan.conflicts.length ? '强制回退' : '确认回退');
    if (!ok) return;
    try {
        const result = await call(api.projectForgeRevertFile({ ...base, force: plan.conflicts.length > 0 }));
        if (result.status === 'conflict') {
            toast('文件在确认期间发生变化，请重新操作。', 'error');
            return;
        }
        if (result.status === 'noop') {
            toast('无需回退。');
            return;
        }
        toast(`已回退：批次 b${result.batchId}（@${result.maid}）`, 'success');
        closeNodeModal();
        await Promise.all([loadProjects(), selectProject(state.currentId, { keepTab: true })]);
    } catch (error) {
        toast(`回退失败：${error.message}`, 'error');
    }
}

// ============================ 事件 ============================

function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
}

function debounce(fn, wait) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function bindEvents() {
    $('minimize-btn').addEventListener('click', () => api?.minimizeWindow?.());
    $('maximize-btn').addEventListener('click', () => api?.maximizeWindow?.());
    $('close-btn').addEventListener('click', () => (api?.closeWindow ? api.closeWindow() : window.close()));

    $('refresh-btn').addEventListener('click', async () => {
        await loadProjects();
        if (state.currentId) await selectProject(state.currentId, { keepTab: true });
    });
    $('project-search').addEventListener('input', debounce(renderProjectList, 120));
    $('include-deleted').addEventListener('change', loadProjects);

    let activeDeleteWrap = null;
    let activeDeleteTimer = null;

    function collapseActiveDelete() {
        if (activeDeleteTimer) {
            clearTimeout(activeDeleteTimer);
            activeDeleteTimer = null;
        }
        if (activeDeleteWrap) {
            activeDeleteWrap.classList.remove('expanded');
            activeDeleteWrap = null;
        }
    }

    document.addEventListener('click', e => {
        if (activeDeleteWrap && !activeDeleteWrap.contains(e.target)) {
            collapseActiveDelete();
        }
    });

    $('project-list').addEventListener('click', async e => {
        const trigger = e.target.closest('.project-delete-trigger');
        if (trigger) {
            e.stopPropagation();
            const wrap = trigger.closest('.project-delete-wrap');
            if (!wrap) return;
            if (activeDeleteWrap && activeDeleteWrap !== wrap) collapseActiveDelete();
            wrap.classList.add('expanded');
            activeDeleteWrap = wrap;
            activeDeleteTimer = setTimeout(() => collapseActiveDelete(), 3000);
            return;
        }

        const confirmBtn = e.target.closest('.project-delete-confirm');
        if (confirmBtn) {
            e.stopPropagation();
            collapseActiveDelete();
            const projectId = confirmBtn.dataset.id;
            if (!projectId) return;
            confirmBtn.disabled = true;
            confirmBtn.textContent = '删除中...';
            try {
                await call(api.projectForgeDeleteProject(projectId, getSignature()));
                toast('工程已删除（仅数据库记录）', 'info');
                await loadProjects();
                if (state.currentId === projectId) {
                    if ($('include-deleted').checked) {
                        await selectProject(projectId, { keepTab: true });
                    } else {
                        state.currentId = null;
                        showProjectView(false);
                    }
                }
            } catch (err) {
                toast(`删除工程失败：${err.message}`, 'error');
                confirmBtn.disabled = false;
                confirmBtn.textContent = '是否删除工程？';
            }
            return;
        }

        const item = e.target.closest('.project-item');
        if (item) selectProject(item.dataset.id);
    });

    document.querySelector('.tabs').addEventListener('click', e => {
        const tab = e.target.closest('.tab');
        if (tab) switchTab(tab.dataset.tab);
    });

    $('pane-timeline').addEventListener('click', e => {
        const row = e.target.closest('.node-row');
        if (row) { openNode(row.dataset.node); return; }
        const head = e.target.closest('.tl-head, .tl-reason');
        if (head) toggleBatch(head.closest('.tl-item'));
    });

    $('pane-files').addEventListener('click', e => {
        const row = e.target.closest('tr[data-file]');
        if (row) historyByFilters({ file: row.dataset.file });
    });

    $('pane-overview').addEventListener('click', e => {
        const btn = e.target.closest('[data-history-maid]');
        if (btn) historyByFilters({ byMaid: btn.dataset.historyMaid });
    });

    $('history-form').addEventListener('submit', e => {
        e.preventDefault();
        const filters = Object.fromEntries(new FormData(e.target).entries());
        runHistorySearch(filters);
    });

    $('history-results').addEventListener('click', e => {
        const row = e.target.closest('tr[data-node]');
        if (row) openNode(row.dataset.node);
    });

    $('node-modal').addEventListener('click', e => {
        if (e.target === $('node-modal') || e.target.closest('[data-close-modal]')) closeNodeModal();
    });
    $('diff-wrap-btn').addEventListener('click', toggleDiffWrap);
    $('revert-before-btn').addEventListener('click', () => revertCurrent('before'));
    $('revert-after-btn').addEventListener('click', () => revertCurrent('after'));

    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (!$('confirm-modal').hidden) $('confirm-cancel').click();
        else if (!$('node-modal').hidden) closeNodeModal();
    });

    // 回到窗口时轻量刷新，便于观察 Agent 正在进行的施工
    let lastFocusRefresh = 0;
    window.addEventListener('focus', () => {
        if (Date.now() - lastFocusRefresh < 5000 || !$('node-modal').hidden) return;
        lastFocusRefresh = Date.now();
        loadProjects();
    });
    // 监听主进程广播的工程变动（反向 IPC 推送，防抖 160ms）
    const scheduleAutoRefresh = debounce(async payload => {
        if (!$('node-modal').hidden) return;
        await loadProjects();
        if (state.currentId) {
            if (!payload?.projectId || payload.projectId === state.currentId) {
                await selectProject(state.currentId, { keepTab: true });
            }
        }
    }, 160);

    if (typeof api?.onProjectForgeChanged === 'function') {
        api.onProjectForgeChanged(payload => {
            scheduleAutoRefresh(payload);
        });
    }
}

function applyTheme(theme) {
    document.body.classList.toggle('light-theme', theme === 'light');
}

document.addEventListener('DOMContentLoaded', async () => {
    if (!api?.projectForgeListProjects) {
        document.body.innerHTML = '<p style="padding:24px">当前窗口没有 ProjectForge API，请从 VChat 托盘打开。</p>';
        return;
    }
    try {
        const settings = await api.loadSettings?.();
        if (settings?.currentThemeMode) applyTheme(settings.currentThemeMode);
        api.onThemeUpdated?.(applyTheme);
    } catch (_e) { /* ignore */ }
    bindEvents();
    await initSignature();
    await loadProjects();
    api.windowReady?.('project-forge');
});