// ProjectForgemodules/projectforge-blueprint.js
// 工程画布动态渲染器（二期）：把 v 工程数据库实时投影成泳道画布。
// 数据源：state.detail（get-project 全量，selectProject/changed 回调负责刷新）+ getBatchNodes 节点级补拉（带缓存）。
// 实时生长：onProjectForgeChanged → scheduleAutoRefresh → renderBlueprint(force) → diff 出新节点加 pop 动画。
// 重建不丢阅读位置：renderBlueprint 先 bpCaptureScroll 记录视口顶端泳道锚点，离屏渲染替换后 bpRestoreScroll 对齐。
// 依赖 projectforge.js 的全局符号：state / escapeHtml / call / api / openNode / STATUS_LABEL（加载顺序在本文件之前）。
'use strict';

// per-project 节点缓存与已渲染节点集合（供生长动画 diff）
const BP_CACHE = new Map(); // projectId -> { byBatch: Map(batchId -> nodes[]), rendered: Set(nodeId), booted: bool }
const BP_VIEW_MODES = {}; // projectId -> 'dynamic' | 'manual'

function bpGetViewMode(projectId, hasManual) {
    if (!hasManual) return 'dynamic';
    return BP_VIEW_MODES[projectId] || 'dynamic';
}

function bpSetViewMode(projectId, mode) {
    BP_VIEW_MODES[projectId] = mode;
}

function bpShortPath(p, max = 42) {
    const s = String(p || '');
    if (s.length <= max) return s;
    const parts = s.split('/');
    if (parts.length <= 2) return s.slice(0, Math.max(1, max - 1)) + '…';
    const head = parts[0];
    let tail = parts[parts.length - 1];
    let i = parts.length - 2;
    while (i > 0 && (head.length + tail.length + parts[i].length + 3) < max) {
        tail = parts[i] + '/' + tail;
        i -= 1;
    }
    return head + '/…/' + tail;
}

/** 'a/b/c.js' → { dir: 'a/b', name: 'c.js' }；兼容反斜杠。 */
function bpSplitPath(p) {
    const s = String(p || '').replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    return i < 0 ? { dir: '', name: s } : { dir: s.slice(0, i), name: s.slice(i + 1) };
}

function bpOpClass(op) {
    switch (op) {
        case 'create': return 'bp-create';
        case 'edit': return 'bp-edit';
        case 'remove': return 'bp-remove';
        case 'move': return 'bp-move';
        case 'rollback': return 'bp-rollback';
        case 'external': return 'bp-external';
        default: return 'bp-edit';
    }
}

function bpOpLabel(op) {
    const m = { create: '新建', edit: '修复', remove: '删除', move: '移动', rollback: '回退', external: '外部' };
    return m[op] || String(op || '');
}

function bpDuration(ms) {
    if (!(ms > 0)) return '-';
    const m = Math.floor(ms / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟';
    const h = Math.floor(m / 60);
    if (h < 48) return h + ' 小时 ' + (m % 60) + ' 分';
    return Math.floor(h / 24) + ' 天';
}

/** ±行数；字段缺省时显示 0 而不是 undefined。 */
function bpDeltaHtml(added, removed) {
    return '<span class="bp-delta"><span class="plus">+' + (Number(added) || 0) + '</span> <span class="minus">−' + (Number(removed) || 0) + '</span></span>';
}

/** 卡片：op 字（色）+ todo（灰）+ 元数据（等宽灰，靠右）/ 正文「为什么」。 */
function bpCardHtml(n, fresh, todoMap) {
    const id = Number(n.id);
    const reason = String(n.reason || n._batchReason || n.summary || '').trim();
    const todo = (n.todo_id && todoMap) ? todoMap.get(n.todo_id) : null;
    let todoBadge = '';
    if (todo) {
        const tTitle = String(todo.title || '').trim();
        todoBadge = '<span class="bp-todo" title="todo #' + todo.seq + ' ' + escapeHtml(tTitle) + '">#' + todo.seq + ' ' + escapeHtml(tTitle) + '</span>';
    }
    const whyHtml = reason ? '<div class="bp-why">' + escapeHtml(reason) + '</div>' : '';
    return '<div class="bp-card ' + bpOpClass(n.op) + (fresh ? ' bp-pop' : '') + '" data-node="' + id + '" tabindex="0" role="button" title="查看节点 n' + id + ' 的 Diff">' +
        '<div class="bp-card-head">' +
            '<span class="bp-op">' + escapeHtml(bpOpLabel(n.op)) + '</span>' +
            (n.op === 'rollback' ? '<span class="bp-rollback-badge" title="此节点后被回退">⟲</span>' : '') +
            todoBadge +
            '<span class="bp-meta"><span class="bp-nid">n' + id + '</span>' + bpDeltaHtml(n.added, n.removed) + '</span>' +
        '</div>' + whyHtml + '</div>';
}

/** 连续外部节点合并为一条细行：同一句警告只说一次，nid 逐个可点。 */
function bpExtRowHtml(run, freshIds) {
    const fresh = run.some(n => freshIds.has(n.id));
    const label = run.length > 1 ? '外部 ×' + run.length + ' · 无快照保护' : '外部 · 无快照保护';
    const ids = run.map(n => '<button type="button" class="bp-ext-node" data-node="' + Number(n.id) + '">n' + Number(n.id) + '</button>').join('');
    return '<div class="bp-ext' + (fresh ? ' bp-pop' : '') + '" title="工程外改动（直接写文件 / CLI 等），未经 ProjectForge，没有快照可回退">' +
        '<span class="bp-ext-label">' + label + '</span>' + ids + '</div>';
}

function bpLaneBodyHtml(nodes, freshIds, todoMap) {
    let html = '';
    let run = [];
    const flush = () => {
        if (run.length) { html += bpExtRowHtml(run, freshIds); run = []; }
    };
    for (const n of nodes) {
        if (n.op === 'external') { run.push(n); continue; }
        flush();
        html += bpCardHtml(n, freshIds.has(n.id), todoMap);
    }
    flush();
    return html;
}

/** 记录阅读锚点：视口顶端第一条泳道的文件 + 相对偏移（content-visibility 下按像素还原会落错位）。 */
function bpCaptureScroll(root) {
    const canvas = root && root.querySelector('.bp-canvas');
    if (!canvas || canvas.scrollTop <= 0) return null;
    const top = canvas.getBoundingClientRect().top;
    for (const lane of canvas.querySelectorAll('.bp-lane')) {
        const r = lane.getBoundingClientRect();
        if (r.bottom > top) return { file: lane.dataset.file, offset: r.top - top };
    }
    return { scrollTop: canvas.scrollTop };
}

/** 新画布已挂载后调用：把锚点泳道对齐回原来的视口位置。 */
function bpRestoreScroll(root, anchor) {
    if (!anchor) return;
    const canvas = root && root.querySelector('.bp-canvas');
    if (!canvas) return;
    const lane = anchor.file != null
        ? [...canvas.querySelectorAll('.bp-lane')].find(l => l.dataset.file === anchor.file)
        : null;
    if (!lane) {
        if (anchor.scrollTop) canvas.scrollTop = anchor.scrollTop;
        return;
    }
    canvas.scrollTop += lane.getBoundingClientRect().top - canvas.getBoundingClientRect().top - anchor.offset;
}

/** 动态画布主渲染：读 state.detail + 补拉节点 → 泳道分组 → 卡片墙。新节点（相对上次渲染）带 pop 动画。
 *  host 可以是未挂载的离屏元素；挂载与滚动还原由 renderBlueprint 负责。 */
async function renderBlueprintDynamic(host, projectId) {
    const detail = state.detail;
    if (!detail) return;
    const timeline = (detail.timeline || []).slice().reverse(); // 正序：旧 → 新
    const cache = BP_CACHE.get(projectId) || { byBatch: new Map(), rendered: new Set(), booted: false };
    BP_CACHE.set(projectId, cache);
    const firstRender = !cache.booted;

    // 补拉缺失 batch 的节点（并发，只拉缓存没有的）
    const missing = timeline.filter(b => !cache.byBatch.has(b.id));
    let fetchFail = 0;
    if (missing.length) {
        const results = await Promise.all(missing.map(async b => {
            try {
                const { nodes } = await call(api.projectForgeGetBatch(projectId, Number(b.id)));
                return [b.id, nodes || []];
            } catch (_e) {
                fetchFail += 1;
                return [b.id, []];
            }
        }));
        results.forEach(([id, nodes]) => cache.byBatch.set(id, nodes));
    }

    // 展平节点（正序）；注入批次 reason 兜底——顶层 reason 落在批次上，节点只存单步 reasonN，缺省时卡片显示批次原因
    const flat = [];
    timeline.forEach(b => (cache.byBatch.get(b.id) || []).forEach(n => flat.push({ ...n, _batchReason: b.reason || '' })));

    if (!flat.length) {
        if (timeline.length && fetchFail === missing.length && missing.length) {
            host.innerHTML = '<p class="muted">节点数据拉取失败：' + escapeHtml(fetchFail + ' 个批次全部失败') + '</p>';
            return;
        }
        host.innerHTML = '<div class="bp-dyn"><div class="bp-canvas bp-solo"><div class="bp-empty"><p class="muted">工程还没有动刀记录，画布将随施工实时生长。</p></div></div></div>';
        cache.booted = true;
        return;
    }

    // 生长动画 diff：本次渲染前不在 rendered 集合里的节点视为"新长出来的"
    const freshIds = new Set();
    if (!firstRender) flat.forEach(n => { if (!cache.rendered.has(n.id)) freshIds.add(n.id); });

    // todoId → todo 映射（卡片挂 #seq 步骤）
    const todoMap = new Map((detail.todos || []).map(t => [t.id, t]));

    // 泳道：按文件分组，保持首次出现顺序（时间序，避免重渲染时泳道跳动）
    const lanes = new Map();
    flat.forEach(n => {
        const key = n.file_path || '(未知文件)';
        if (!lanes.has(key)) lanes.set(key, []);
        lanes.get(key).push(n);
    });

    // 统计
    const st = detail.project?.stats || {};
    const rollbackCount = flat.filter(n => n.op === 'rollback').length;
    const externalCount = flat.filter(n => n.op === 'external').length;
    const created = detail.project?.created_at;
    const durationTxt = created && st.lastAt ? bpDuration(new Date(st.lastAt) - new Date(created)) : '-';
    const statusTxt = STATUS_LABEL[detail.project?.status] || detail.project?.status || '-';

    const lanesHtml = [...lanes.entries()].map(([file, nodes]) => {
        const laneAdded = nodes.reduce((s, n) => s + (Number(n.added) || 0), 0);
        const laneRemoved = nodes.reduce((s, n) => s + (Number(n.removed) || 0), 0);
        const { dir, name } = bpSplitPath(file);
        return '<div class="bp-lane" data-file="' + escapeHtml(file) + '">' +
            '<div class="bp-lane-head" title="' + escapeHtml(file) + '">' +
                (dir ? '<span class="bp-lane-dir">' + escapeHtml(bpShortPath(dir, 46)) + '/</span>' : '') +
                '<span class="bp-lane-file">' + escapeHtml(name) + '</span>' +
                '<span class="bp-lane-meta"><span>' + nodes.length + ' 操作</span>' + bpDeltaHtml(laneAdded, laneRemoved) + '</span>' +
            '</div>' +
            '<div class="bp-lane-body">' + bpLaneBodyHtml(nodes, freshIds, todoMap) + '</div>' +
        '</div>';
    }).join('');

    host.innerHTML =
        '<div class="bp-dyn">' +
            '<div class="bp-stats">' +
                '<span class="bp-chip">节点<b>' + flat.length + '</b></span>' +
                '<span class="bp-chip">文件<b>' + lanes.size + '</b></span>' +
                '<span class="bp-chip">' + bpDeltaHtml(st.added, st.removed) + '</span>' +
                '<span class="bp-chip">返工<b>' + rollbackCount + '</b></span>' +
                (externalCount ? '<span class="bp-chip bp-warn-chip">外部动刀<b>' + externalCount + '</b></span>' : '') +
                '<span class="bp-chip">耗时<b>' + escapeHtml(durationTxt) + '</b></span>' +
                '<span class="bp-live"><span class="bp-live-dot"></span>实时投影 · 施工变动自动生长</span>' +
            '</div>' +
            '<div class="bp-canvas">' + lanesHtml + '</div>' +
            '<div class="bp-foot">' +
                '<span>数据源：v 工程数据库实时投影（GetProject + GetBatchNodes），零编造。</span>' +
                '<span>验收状态：' + escapeHtml(statusTxt) + '</span>' +
            '</div>' +
        '</div>';

    flat.forEach(n => cache.rendered.add(n.id));
    cache.booted = true;

    // 事件委托：卡片与外部细行 nid 共用 data-node → 复用节点详情弹窗（openNode 为 projectforge.js 全局）
    if (!host.dataset.bpBound) {
        host.dataset.bpBound = '1';
        host.addEventListener('click', e => {
            const t = e.target.closest('[data-node]');
            if (t && host.contains(t)) openNode(Number(t.dataset.node));
        });
        host.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const card = e.target.closest('.bp-card[data-node]');
            if (!card || card !== e.target) return;
            e.preventDefault();
            openNode(Number(card.dataset.node));
        });
    }
}