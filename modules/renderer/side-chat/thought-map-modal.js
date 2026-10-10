/* side-chat/thought-map-modal.js
 * 纯致敬 ThoughtDAG 图1 艺术风格的「一张思路地图 (Thought Map)」海报弹窗。
 * 在黑底 / 宣纸质感画布上，以极简点线星图与纯净排版呈现当前分支探索的思考轨迹。
 */
'use strict';

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="14.5 2.5 22 39" width="16" height="24"><line x1="19" y1="10" x2="19" y2="18" stroke="#60a5fa" stroke-width="2.2" stroke-linecap="round"/><line x1="19" y1="25" x2="19" y2="33" stroke="#60a5fa" stroke-width="2.2" stroke-linecap="round"/><line x1="22.5" y1="23.5" x2="30" y2="28.5" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="3 3"/><circle cx="19" cy="7" r="3.4" fill="#60a5fa"/><circle cx="19" cy="21.5" r="3.4" fill="none" stroke="#60a5fa" stroke-width="2.2"/><circle cx="19" cy="36.5" r="3.4" fill="#60a5fa"/><circle cx="32.5" cy="30" r="3" fill="#f59e0b"/></svg>`;

export function openThoughtMapModal({
    doc,
    forest,
    currentTopicId,
    onSwitch = null,
    onRename = null,
    onDelete = null,
    onExportNote = null,
}) {
    if (!doc) return;

    const existing = doc.querySelector('.thought-map-backdrop');
    if (existing) existing.remove();

    const backdrop = doc.createElement('div');
    backdrop.className = 'thought-map-backdrop vcp-ui-scope';

    const sheet = doc.createElement('div');
    sheet.className = 'thought-map-sheet';

    // ── 头部 ──
    const header = doc.createElement('div');
    header.className = 'thought-map-sheet-header';

    const titlesCol = doc.createElement('div');
    const kicker = doc.createElement('div');
    kicker.className = 'thought-map-kicker';
    kicker.style.display = 'flex';
    kicker.style.alignItems = 'center';
    kicker.style.gap = '8px';
    kicker.innerHTML = `${LOGO_SVG} <span>一张思路地图 · A THOUGHT MAP</span>`;

    // 计算统计指标
    const nodes = forest ? Array.from(forest.nodes.values()) : [];
    const totalBranches = nodes.length;
    const maxDepth = nodes.reduce((acc, n) => Math.max(acc, n.depth || 0), 0);

    const headline = doc.createElement('h2');
    headline.className = 'thought-map-headline';
    if (totalBranches <= 1) {
        headline.textContent = '一根筋钻到底';
    } else if (maxDepth >= 3) {
        headline.textContent = `${totalBranches} 条支线层层推演`;
    } else {
        headline.textContent = `${totalBranches} 个分形思考脉络`;
    }

    const subtitle = doc.createElement('p');
    subtitle.className = 'thought-map-subtitle';
    subtitle.textContent = `最大深度 ${maxDepth + 1} 层 · 保持思维独立，不打断主对话节奏`;

    titlesCol.append(kicker, headline, subtitle);

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'thought-map-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.addEventListener('click', close);

    header.append(titlesCol, closeBtn);

    // ── 中心地图 (SVG 星图) ──
    const canvasBox = doc.createElement('div');
    canvasBox.className = 'thought-map-canvas-box';

    // ── 底部统计栏 ──
    const statsLine = doc.createElement('div');
    statsLine.className = 'thought-map-stats-line';

    const statSteps = doc.createElement('span');
    statSteps.className = 'thought-map-stat-item';
    statSteps.innerHTML = `<span class="thought-map-stat-dot"></span><b>${totalBranches}</b> 条分支`;

    const statDepth = doc.createElement('span');
    statDepth.className = 'thought-map-stat-item';
    statDepth.innerHTML = `<span class="thought-map-stat-dot" style="background:#f59e0b"></span><b>${maxDepth + 1}</b> 级拓扑`;

    statsLine.append(statSteps, statDepth);

    const actions = doc.createElement('div');
    actions.className = 'thought-map-actions';

    if (typeof onExportNote === 'function') {
        const noteBtn = doc.createElement('button');
        noteBtn.type = 'button';
        noteBtn.className = 'thought-map-export-btn';
        noteBtn.textContent = '固化为 Markdown 笔记';
        noteBtn.addEventListener('click', async () => {
            noteBtn.disabled = true;
            try {
                await onExportNote();
            } finally {
                noteBtn.disabled = false;
            }
        });
        actions.appendChild(noteBtn);
    }

    statsLine.appendChild(actions);

    sheet.append(header, canvasBox, statsLine);
    backdrop.appendChild(sheet);
    doc.body.appendChild(backdrop);

    function close() {
        backdrop.remove();
        doc.removeEventListener('keydown', onKeyDown);
    }

    function onKeyDown(e) {
        if (e.key === 'Escape') close();
    }
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
    });
    doc.addEventListener('keydown', onKeyDown);

    // 绘制 SVG 星图
    requestAnimationFrame(() => {
        renderStarMap(canvasBox, forest, currentTopicId, {
            onNodeClick: async (topicId) => {
                if (typeof onSwitch === 'function') {
                    close();
                    await onSwitch(topicId);
                }
            },
            onNodeRename: async (topicId, currentTitle) => {
                if (typeof onRename === 'function') {
                    const next = doc.defaultView?.prompt('修改分支名称：', currentTitle);
                    if (next !== null && next.trim() && next.trim() !== currentTitle) {
                        await onRename(topicId, next.trim());
                        close();
                    }
                }
            },
            onNodeDelete: async (topicId, currentTitle, childCount) => {
                if (typeof onDelete !== 'function') return;
                const cascadeNote = childCount > 0 ? `\n其下还有 ${childCount} 个子分支，将被一并删除。` : '';
                if (doc.defaultView?.confirm(`确定要删除分支「${currentTitle}」吗？${cascadeNote || '该分支的对话记录将永久消失。'}`)) {
                    close();
                    await onDelete(topicId);
                }
            }
        });
    });

    return { close };
}

function renderStarMap(box, forest, currentTopicId, { onNodeClick = null, onNodeRename = null, onNodeDelete = null } = {}) {
    if (!box || !forest) return;
    const bw = box.clientWidth || 440;
    const bh = box.clientHeight || 260;
    box.innerHTML = '';

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(bw));
    svg.setAttribute('height', String(bh));
    svg.setAttribute('viewBox', `0 0 ${bw} ${bh}`);

    const nodes = Array.from(forest.nodes.values());
    if (nodes.length === 0) return;

    // 分配整齐的树坐标
    const depthCols = new Map();
    for (const n of nodes) {
        const d = n.depth || 0;
        if (!depthCols.has(d)) depthCols.set(d, []);
        depthCols.get(d).push(n);
    }

    const maxD = Math.max(...Array.from(depthCols.keys()));
    const xStep = Math.min(100, (bw - 100) / Math.max(1, maxD));
    const padX = 50;

    const coords = new Map();
    for (const [d, list] of depthCols.entries()) {
        const x = padX + d * xStep;
        const total = list.length;
        const yStep = Math.min(60, (bh - 60) / Math.max(1, total));
        const startY = (bh - (total - 1) * yStep) / 2;

        list.forEach((n, i) => {
            coords.set(n.topicId, { x, y: startY + i * yStep });
        });
    }

    // 连线 (折角优雅线条)
    for (const n of nodes) {
        if (!n.forkFromTopicId || !coords.has(n.forkFromTopicId)) continue;
        const p1 = coords.get(n.forkFromTopicId);
        const p2 = coords.get(n.topicId);

        const path = document.createElementNS(NS, 'path');
        const midX = (p1.x + p2.x) / 2;
        const d = `M ${p1.x} ${p1.y} C ${midX} ${p1.y}, ${midX} ${p2.y}, ${p2.x} ${p2.y}`;
        path.setAttribute('d', d);
        path.setAttribute('stroke', 'rgba(255, 255, 255, 0.22)');
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('fill', 'none');
        svg.appendChild(path);
    }

    // 绘制节点 (Dot & Halo & Clickable Group)
    for (const n of nodes) {
        const p = coords.get(n.topicId);
        if (!p) continue;
        const isActive = n.topicId === currentTopicId;
        const isRoot = (n.depth || 0) === 0;
        const titleText = n.branchTitle || n.title || n.forkLabel || '分支';

        const group = document.createElementNS(NS, 'g');
        group.setAttribute('class', 'thought-map-node-group');
        group.style.cursor = 'pointer';

        // 激活光环
        if (isActive) {
            const halo = document.createElementNS(NS, 'circle');
            halo.setAttribute('cx', String(p.x));
            halo.setAttribute('cy', String(p.y));
            halo.setAttribute('r', '11');
            halo.setAttribute('fill', 'rgba(96, 165, 250, 0.2)');
            halo.setAttribute('stroke', 'rgba(96, 165, 250, 0.6)');
            halo.setAttribute('stroke-width', '1.2');
            group.appendChild(halo);
        }

        // 实心圆点
        const circle = document.createElementNS(NS, 'circle');
        circle.setAttribute('cx', String(p.x));
        circle.setAttribute('cy', String(p.y));
        circle.setAttribute('r', isRoot ? '6.5' : (isActive ? '5.5' : '4.5'));
        circle.setAttribute('fill', isActive ? '#60a5fa' : (isRoot ? '#f3f4f6' : 'rgba(255, 255, 255, 0.6)'));
        group.appendChild(circle);

        // 标签文字
        const label = document.createElementNS(NS, 'text');
        label.setAttribute('x', String(p.x + 12));
        label.setAttribute('y', String(p.y + 4));
        label.setAttribute('fill', isActive ? '#ffffff' : 'rgba(255, 255, 255, 0.7)');
        label.setAttribute('font-size', '11');
        label.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, sans-serif');
        label.textContent = titleText;
        group.appendChild(label);

        // 点击节点切换到对应分支
        group.addEventListener('click', () => {
            if (typeof onNodeClick === 'function') onNodeClick(n.topicId);
        });
        // 双击可重命名
        group.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (typeof onNodeRename === 'function') onNodeRename(n.topicId, titleText);
        });
        // 右键删除分支（统计级联子孙数量）
        group.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof onNodeDelete !== 'function') return;
            let childCount = 0;
            try {
                const treeNode = forest?.nodes?.get?.(n.topicId);
                if (treeNode) {
                    const walk = (x) => x.children.forEach(c => { childCount++; walk(c); });
                    walk(treeNode);
                }
            } catch (err) { void err; }
            onNodeDelete(n.topicId, titleText, childCount);
        });

        svg.appendChild(group);
    }

    box.appendChild(svg);
}