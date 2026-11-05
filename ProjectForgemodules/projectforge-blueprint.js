// ProjectForgemodules/projectforge-blueprint.js
// 工程画布动态渲染器（二期）：把 v 工程数据库实时投影成泳道画布。
// 数据源：state.detail（get-project 全量，selectProject/changed 回调负责刷新）+ getBatchNodes 节点级补拉（带缓存）。
// 实时生长：onProjectForgeChanged → scheduleAutoRefresh → renderBlueprint(force) → diff 出新节点加 pop 动画。
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

function bpCardHtml(n, fresh) {
    const reason = String(n.reason || n.summary || '').trim();
    const shortReason = reason.length > 90 ? reason.slice(0, 90) + '…' : reason;
    let whyHtml = '';
    if (n.op === 'external') {
        whyHtml = '<div class="bp-why bp-warn">工程外动刀 · 无快照保护</div>';
    } else if (reason) {
        const prefix = (n.op === 'edit' || n.op === 'rollback') ? '为什么修：' : '';
        whyHtml = '<div class="bp-why" title="' + escapeHtml(reason) + '">' + escapeHtml(prefix + shortReason) + '</div>';
    }
    return '<div class="bp-card ' + bpOpClass(n.op) + (fresh ? ' bp-pop' : '') + '" data-node="' + n.id + '" title="点击查看节点详情">' +
        '<div class="bp-card-head">' +
            '<span class="bp-nid">n' + n.id + '</span>' +
            '<span class="bp-op">' + escapeHtml(bpOpLabel(n.op)) + '</span>' +
            (n.op === 'rollback' ? '<span class="bp-rollback-badge" title="此节点后被回退">⟲</span>' : '') +
            '<span class="bp-delta"><span class="plus">+' + n.added + '</span>/<span class="minus">-' + n.removed + '</span></span>' +
        '</div>' + whyHtml + '</div>';
}

/** 动态画布主渲染：读 state.detail + 补拉节点 → 泳道分组 → 卡片墙。新节点（相对上次渲染）带 pop 动画。 */
async function renderBlueprintDynamic(pane, projectId) {
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

    // 展平节点（正序）
    const flat = [];
    timeline.forEach(b => (cache.byBatch.get(b.id) || []).forEach(n => flat.push(n)));

    if (!flat.length) {
        if (timeline.length && fetchFail === missing.length && missing.length) {
            pane.innerHTML = '<p class="muted">节点数据拉取失败：' + escapeHtml(fetchFail + ' 个批次全部失败') + '</p>';
            return;
        }
        pane.innerHTML = '<div class="bp-dyn"><div class="bp-canvas bp-solo"><div class="bp-empty"><p class="muted">工程还没有动刀记录，画布将随施工实时生长。</p></div></div></div>';
        cache.booted = true;
        return;
    }

    // 生长动画 diff：本次渲染前不在 rendered 集合里的节点视为"新长出来的"
    const freshIds = new Set();
    if (!firstRender) flat.forEach(n => { if (!cache.rendered.has(n.id)) freshIds.add(n.id); });

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
        const laneAdded = nodes.reduce((s, n) => s + (n.added || 0), 0);
        const laneRemoved = nodes.reduce((s, n) => s + (n.removed || 0), 0);
        return '<div class="bp-lane">' +
            '<div class="bp-lane-head" title="' + escapeHtml(file) + '">' +
                '<span class="bp-lane-file">' + escapeHtml(bpShortPath(file)) + '</span>' +
                '<span class="bp-lane-delta"><span class="plus">+' + laneAdded + '</span>/<span class="minus">-' + laneRemoved + '</span></span>' +
                '<span class="bp-lane-count">' + nodes.length + '</span>' +
            '</div>' +
            '<div class="bp-lane-body">' + nodes.map(n => bpCardHtml(n, freshIds.has(n.id))).join('') + '</div>' +
        '</div>';
    }).join('');

    pane.innerHTML =
        '<div class="bp-dyn">' +
            '<div class="bp-stats">' +
                '<span class="bp-chip">节点 <b>' + flat.length + '</b></span>' +
                '<span class="bp-chip">泳道/文件 <b>' + lanes.size + '</b></span>' +
                '<span class="bp-chip"><span class="plus">+' + (st.added || 0) + '</span>/<span class="minus">-' + (st.removed || 0) + '</span></span>' +
                '<span class="bp-chip">返工 <b>' + rollbackCount + '</b></span>' +
                (externalCount ? '<span class="bp-chip bp-warn-chip">外部动刀 <b>' + externalCount + '</b></span>' : '') +
                '<span class="bp-chip">耗时 <b>' + escapeHtml(durationTxt) + '</b></span>' +
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

    // 卡片点击 → 复用节点详情弹窗（openNode 为 projectforge.js 全局）
    pane.querySelectorAll('.bp-card').forEach(card => {
        card.addEventListener('click', () => openNode(Number(card.dataset.node)));
    });
}