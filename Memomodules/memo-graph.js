/**
 * Memomodules/memo-graph.js
 * 神经元云图 (Neural Graph) 渲染与逻辑引擎
 */

// ========== 神经联想网络状态 ==========
let graphState = {
    sourceMemo: null,
    nodes: [],
    links: [],
    transform: { x: 0, y: 0, scale: 1 },
    selectedNode: null,
    selectedNodes: new Set(), // 多选支持
    hoveredNode: null,
    isDragging: false,
    dragNode: null,
    lastMousePos: { x: 0, y: 0 },
    animationId: null,
    config: {
        k: 10,
        boost: '0.6+',
        range: []
    },
    palette: null,
    themeObserver: null
};

const GRAPH_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";

// 画布颜色全部取自主题变量。变量的值可能是 color-mix 之类的表达式，
// 先让探针元素解析成具体颜色再交给 canvas；透明度统一用 globalAlpha 控制。
function resolveThemeColor(probe, expr) {
    probe.style.color = expr;
    return getComputedStyle(probe).color;
}

function refreshGraphPalette() {
    const probe = document.createElement('span');
    probe.hidden = true;
    document.body.appendChild(probe);
    graphState.palette = {
        text: resolveThemeColor(probe, 'var(--memo-ink)'),
        textSecondary: resolveThemeColor(probe, 'var(--memo-ink-2)'),
        textTertiary: resolveThemeColor(probe, 'var(--memo-ink-3)'),
        card: resolveThemeColor(probe, 'var(--memo-panel)'),
        border: resolveThemeColor(probe, 'var(--border-color)'),
        accent: resolveThemeColor(probe, 'var(--memo-accent)')
    };
    probe.remove();
}

// 主题切换会改 body / html 的 class 或 style，届时重新取色
function watchGraphTheme() {
    if (graphState.themeObserver) return;
    graphState.themeObserver = new MutationObserver(refreshGraphPalette);
    const options = { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] };
    graphState.themeObserver.observe(document.body, options);
    graphState.themeObserver.observe(document.documentElement, options);
}

// ========== 联想逻辑 & 神经图谱引擎 ==========

async function openAssociationConfig(memo, isAppend = false) {
    graphState.sourceMemo = memo;
    graphState.isAppend = isAppend;
    graphState.targetNodeId = isAppend ? memo.id : null;
    const modal = document.getElementById('assoc-config-modal');
    const tagCloud = document.getElementById('assoc-folder-tags');
    const searchInput = document.getElementById('assoc-folder-search');
    tagCloud.innerHTML = '';
    closeAllPopovers();

    if (searchInput) searchInput.value = '';
    const sourceTitle = getMemoDisplayTitle(memo.name);
    document.getElementById('assoc-source-name').textContent = `从「${sourceTitle}」出发`;

    try {
        const data = await apiFetch('/folders');
        const folders = data.folders.filter(f => f !== 'MusicDiary' && !hiddenFolders.has(f));

        const folderTags = folders.map(folder => {
            const tag = document.createElement('button');
            tag.type = 'button';
            tag.className = 'folder-tag';
            tag.textContent = folder;
            tag.setAttribute('aria-pressed', 'false');
            tag.onclick = () => {
                const active = tag.classList.toggle('active');
                tag.setAttribute('aria-pressed', String(active));
                updateAssocScopeHint();
            };
            tagCloud.appendChild(tag);
            return tag;
        });

        // 绑定搜索过滤
        if (searchInput) {
            searchInput.oninput = (e) => {
                const term = e.target.value.toLowerCase().trim();
                folderTags.forEach(tag => {
                    const visible = tag.textContent.toLowerCase().includes(term);
                    tag.style.display = visible ? '' : 'none';
                });
            };
        }

        updateAssocSummary();
        updateAssocScopeHint();
        modal.style.display = 'flex';
    } catch (e) {
        alert('加载文件夹列表失败: ' + e.message);
    }
}

// 参数面板收起时，底部摘要显示当前深度和强度
function updateAssocSummary() {
    const summary = document.getElementById('assoc-summary');
    if (!summary) return;
    const k = document.getElementById('input-assoc-k').value;
    const boost = document.getElementById('input-assoc-boost').value.trim() || '默认';
    summary.textContent = `深度 ${k} · 强度 ${boost}`;
}

function updateAssocScopeHint() {
    const hint = document.getElementById('assoc-scope-hint');
    if (!hint) return;
    const count = document.querySelectorAll('#assoc-folder-tags .folder-tag.active').length;
    const sourceFolder = graphState.sourceMemo?.folderName || currentFolder;
    hint.textContent = count > 0
        ? `在 ${count} 个文件夹中联想`
        : `未选择时只在「${sourceFolder}」中联想`;
}

async function startAssociation() {
    const k = parseInt(document.getElementById('input-assoc-k').value);
    const boost = document.getElementById('input-assoc-boost').value.trim();
    let selectedTags = Array.from(document.querySelectorAll('#assoc-folder-tags .folder-tag.active')).map(t => t.textContent);
    
    // 保底逻辑：如果用户没有选择任何文件夹，则默认使用当前日记所在的文件夹
    if (selectedTags.length === 0 && graphState.sourceMemo) {
        const sourceFolder = graphState.sourceMemo.folderName || currentFolder;
        if (sourceFolder) {
            selectedTags = [sourceFolder];
            console.log(`[Association] No folders selected, falling back to source folder: ${sourceFolder}`);
        }
    }
    
    closeAllPopovers();
    document.getElementById('assoc-config-modal').style.display = 'none';
    
    // 显示视图并初始化 Canvas
    const overlay = document.getElementById('neural-graph-overlay');
    overlay.style.display = 'flex';
    const canvas = document.getElementById('neural-canvas');
    const ctx = canvas.getContext('2d');
    
    const sourceTitle = getMemoDisplayTitle(graphState.sourceMemo.name);
    const graphSourceTitle = document.getElementById('graph-source-title');
    graphSourceTitle.textContent = sourceTitle;
    graphSourceTitle.title = graphState.sourceMemo.name;
    document.getElementById('node-count-stat').textContent = '正在联想中...';
    
    // 恢复被误删的变量定义
    const sourceMemo = graphState.sourceMemo;
    const folder = (sourceMemo.folderName || (sourceMemo.path ? '' : currentFolder)).trim();
    const sourceFilePath = (sourceMemo.path || (folder ? `${folder}/${sourceMemo.name}` : sourceMemo.name)).trim().replace(/\\/g, '/');

    // 显示高大上的加载动画
    const loader = document.getElementById('neural-loading-overlay');
    const loaderText = document.getElementById('loader-source-name');
    if (loader) {
        loader.style.display = 'flex';
        loader.style.opacity = '1';
        if (loaderText) loaderText.textContent = `神经网络正在遍历「${sourceTitle}」的记忆星图`;
    }

    console.log('[Association] Request Path:', `'${sourceFilePath}'`);

    try {
        const payload = {
            sourceFilePath: sourceFilePath,
            k: k,
            range: selectedTags,
            tagBoost: boost
        };
        
        const data = await apiFetch('/associative-discovery', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        // 这里的延迟是为了让神经网络的“算力感”表现出来，营造深层溯源的精品感
        await new Promise(resolve => setTimeout(resolve, 800));
        
        if (loader) {
            loader.style.opacity = '0';
            setTimeout(() => { if (loader) loader.style.display = 'none'; }, 500);
        }

        if (data.warning) {
            console.warn(data.warning);
        }

        console.log('[Association] Results from backend:', data.results);

        // 构造图谱数据
        initGraphData(data.results, graphState.isAppend);
        
        if (!graphState.animationId) {
            startGraphEngine(canvas, ctx);
        }

    } catch (e) {
        if (loader) loader.style.display = 'none';
        console.error('[Association Error]', e);
        // 如果后端返回了 details，补充显示
        let msg = e.message;
        alert(`联想失败: ${msg}\n请求路径: [${sourceFilePath}]`);
        if (!graphState.isAppend) overlay.style.display = 'none';
    }
}

function initGraphData(results, isAppend = false) {
    const source = graphState.sourceMemo;
    let centerNode;

    if (!isAppend) {
        let path = (source.folderName || currentFolder) ? 
                   `${source.folderName || currentFolder}/${source.name}` : 
                   source.name;
        path = path.trim();

        centerNode = {
            id: 'SOURCE',
            path: path,
            name: source.name,
            folder: source.folderName || currentFolder,
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            fx: 0, // 固定中心
            fy: 0,
            isSource: true,
            score: 1.0,
            chunks: [source.preview || '核心源节点内容加载中...'],
            tags: []
        };
        graphState.nodes = [centerNode];
        graphState.links = [];
        graphState.transform = { x: 0, y: 0, scale: 1 };
    } else {
        // 寻找图中现有的该节点作为父节点
        centerNode = graphState.nodes.find(n => n.id === graphState.targetNodeId);
        
        if (!centerNode) {
            // 路径兜底方案
            let currentPath = source.path || (
                (source.folderName || currentFolder) ? 
                `${source.folderName || currentFolder}/${source.name}` : 
                source.name
            );
            currentPath = currentPath.trim().replace(/\\/g, '/');
            centerNode = graphState.nodes.find(n => n.path === currentPath);
        }

        if (!centerNode) {
             // 降级处理: 如果没找到，退回到非追加模式
             console.warn('[Association] Target node not found, falling back to reset mode');
             return initGraphData(results, false);
        }
    }

    results.forEach((res, i) => {
        // 保持原始路径，仅修剪
        let resPath = res.path ? res.path.trim() : '';

        // 检查节点是否已存在
        let existingNode = graphState.nodes.find(n => n.path === resPath);
        
        if (!existingNode) {
            const angle = (i / results.length) * Math.PI * 2;
            const dist = 300 + Math.random() * 100;
            const newNode = {
                id: `node-${Date.now()}-${i}`,
                name: res.name,
                folder: resPath.includes('/') ? resPath.split('/')[0] : (resPath.includes('\\') ? resPath.split('\\')[0] : ''),
                path: resPath,
                score: res.score,
                chunks: res.chunks,
                tags: res.matchedTags,
                x: centerNode.x + Math.cos(angle) * dist,
                y: centerNode.y + Math.sin(angle) * dist,
                vx: 0,
                vy: 0
            };
            graphState.nodes.push(newNode);
            existingNode = newNode;
        }

        // 添加连线
        const alreadyLinked = graphState.links.find(l => 
            (l.source === centerNode && l.target === existingNode) ||
            (l.source === existingNode && l.target === centerNode)
        );

        if (!alreadyLinked) {
            graphState.links.push({
                source: centerNode,
                target: existingNode,
                score: res.score
            });
        }
    });

    document.getElementById('node-count-stat').textContent = `${graphState.nodes.length} 节点 / ${graphState.links.length} 连线`;
    document.getElementById('node-detail-panel').classList.add('hidden');
}

function startGraphEngine(canvas, ctx) {
    if (graphState.animationId) cancelAnimationFrame(graphState.animationId);

    // 设置 Canvas 大小：位图按 devicePixelRatio 放大，绘制坐标仍是 CSS 像素，文字才不会发虚
    const resize = () => {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(window.innerWidth * dpr);
        canvas.height = Math.round(window.innerHeight * dpr);
    };
    window.addEventListener('resize', resize);
    resize();
    refreshGraphPalette();
    watchGraphTheme();

    // 交互逻辑
    canvas.onmousedown = (e) => {
        graphState.lastMousePos = { x: e.clientX, y: e.clientY };
        
        // 检查是否点击了节点
        const pos = getGraphCoords(e.clientX, e.clientY);
        const node = findNodeAt(pos.x, pos.y);
        
        if (node) {
            graphState.dragNode = node;
            graphState.isDragging = true;
            
            // 多选逻辑 (Ctrl/Cmd 键)
            if (e.ctrlKey || e.metaKey) {
                if (graphState.selectedNodes.has(node)) {
                    graphState.selectedNodes.delete(node);
                } else {
                    graphState.selectedNodes.add(node);
                }
                updateGraphStats();
            } else {
                // 普通点击，如果点击的是未选中的节点，则清除其他选中
                if (!graphState.selectedNodes.has(node)) {
                    graphState.selectedNodes.clear();
                    graphState.selectedNodes.add(node);
                }
                selectGraphNode(node);
            }
        } else {
            graphState.isDragging = false;
            if (!e.ctrlKey && !e.metaKey) {
                graphState.selectedNodes.clear();
                updateGraphStats();
            }
        }
    };

    window.onmousemove = (e) => {
        const dx = e.clientX - graphState.lastMousePos.x;
        const dy = e.clientY - graphState.lastMousePos.y;
        
        if (graphState.isDragging && graphState.dragNode) {
            const worldPos = getGraphCoords(e.clientX, e.clientY);
            graphState.dragNode.fx = worldPos.x;
            graphState.dragNode.fy = worldPos.y;
        } else if (e.buttons === 1) {
            // 平移
            graphState.transform.x += dx;
            graphState.transform.y += dy;
        }

        // 悬停检测
        const pos = getGraphCoords(e.clientX, e.clientY);
        graphState.hoveredNode = findNodeAt(pos.x, pos.y);
        canvas.style.cursor = graphState.hoveredNode ? 'pointer' : (e.buttons === 1 ? 'grabbing' : 'grab');

        graphState.lastMousePos = { x: e.clientX, y: e.clientY };
    };

    window.onmouseup = () => {
        if (graphState.dragNode && !graphState.dragNode.isSource) {
            graphState.dragNode.fx = undefined;
            graphState.dragNode.fy = undefined;
        }
        graphState.dragNode = null;
        graphState.isDragging = false;
    };

    canvas.onwheel = (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        
        // 以鼠标为中心缩放
        const mouseX = e.clientX;
        const mouseY = e.clientY;
        
        const beforeX = (mouseX - graphState.transform.x) / graphState.transform.scale;
        const beforeY = (mouseY - graphState.transform.y) / graphState.transform.scale;
        
        graphState.transform.scale *= factor;
        graphState.transform.scale = Math.max(0.1, Math.min(5, graphState.transform.scale));

        const afterX = (mouseX - graphState.transform.x) / graphState.transform.scale;
        const afterY = (mouseY - graphState.transform.y) / graphState.transform.scale;

        graphState.transform.x += (afterX - beforeX) * graphState.transform.scale;
        graphState.transform.y += (afterY - beforeY) * graphState.transform.scale;
    };

    function update() {
        const strength = 0.5; // 连接强度
        
        // 1. 斥力 (所有节点之间)
        for (let i = 0; i < graphState.nodes.length; i++) {
            for (let j = i + 1; j < graphState.nodes.length; j++) {
                const n1 = graphState.nodes[i];
                const n2 = graphState.nodes[j];
                const dx = n2.x - n1.x;
                const dy = n2.y - n1.y;
                const distSq = dx*dx + dy*dy || 1;
                const force = 12000 / distSq; // 增大斥力防止重叠
                
                const fx = (dx / Math.sqrt(distSq)) * force;
                const fy = (dy / Math.sqrt(distSq)) * force;
                
                n1.vx -= fx; n1.vy -= fy;
                n2.vx += fx; n2.vy += fy;
            }
        }

        // 2. 引力 (连线)
        graphState.links.forEach(link => {
            const s = link.source;
            const t = link.target;
            const dx = t.x - s.x;
            const dy = t.y - s.y;
            const dist = Math.sqrt(dx*dx + dy*dy) || 1;
            
            // 目标距离取决于得分
            const targetDist = 200 + (1 - link.score) * 400;
            const force = (dist - targetDist) * strength * 0.1;
            
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            
            s.vx += fx; s.vy += fy;
            t.vx -= fx; t.vy -= fy;
        });

        // 3. 更新位置
        graphState.nodes.forEach(node => {
            if (node.fx !== undefined) {
                node.x = node.fx;
                node.y = node.fy;
                node.vx = 0;
                node.vy = 0;
            } else {
                node.vx *= 0.9; // 摩擦力
                node.vy *= 0.9;
                node.x += node.vx;
                node.y += node.vy;
            }
        });
    }

    function draw() {
        const dpr = canvas.width / window.innerWidth || 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const palette = graphState.palette;

        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.translate(window.innerWidth / 2 + graphState.transform.x, window.innerHeight / 2 + graphState.transform.y);
        ctx.scale(graphState.transform.scale, graphState.transform.scale);

        // 绘制连线：主题强调色，得分越高越实
        graphState.links.forEach(link => {
            ctx.beginPath();
            ctx.moveTo(link.source.x, link.source.y);
            ctx.lineTo(link.target.x, link.target.y);
            ctx.lineWidth = 1 + link.score * 2;
            ctx.strokeStyle = palette.accent;
            ctx.globalAlpha = 0.2 + link.score * 0.5;
            ctx.stroke();

            // 绘制流动光点 (脉冲)
            const time = Date.now() / 1000;
            const progress = (time % 2) / 2;
            const lx = link.source.x + (link.target.x - link.source.x) * progress;
            const ly = link.source.y + (link.target.y - link.source.y) * progress;

            ctx.beginPath();
            ctx.arc(lx, ly, 2, 0, Math.PI * 2);
            ctx.fillStyle = palette.accent;
            ctx.globalAlpha = 0.9;
            ctx.fill();
            ctx.globalAlpha = 1;
        });

        // 绘制节点
        graphState.nodes.forEach(node => {
            const isHovered = graphState.hoveredNode === node;
            const isSelected = graphState.selectedNode === node || graphState.selectedNodes.has(node);
            
            // 计算卡片尺寸
            const width = node.isSource ? 220 : 200;
            const height = node.isSource ? 110 : 100;
            const x = node.x - width / 2;
            const y = node.y - height / 2;
            const radius = 10;

            // 1. 外圈：源节点、悬停和选中节点用强调色淡环标出
            if (isHovered || isSelected || node.isSource) {
                ctx.beginPath();
                ctx.roundRect(x - 5, y - 5, width + 10, height + 10, radius + 5);
                ctx.fillStyle = palette.accent;
                ctx.globalAlpha = node.isSource ? 0.16 : 0.12;
                ctx.fill();
                ctx.globalAlpha = 1;
            }

            // 2. 卡片背景
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(x, y, width, height, radius);
            } else {
                // 回退方案: 绘制圆角矩形
                ctx.moveTo(x + radius, y);
                ctx.lineTo(x + width - radius, y);
                ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
                ctx.lineTo(x + width, y + height - radius);
                ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
                ctx.lineTo(x + radius, y + height);
                ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
                ctx.lineTo(x, y + radius);
                ctx.quadraticCurveTo(x, y, x + radius, y);
                ctx.closePath();
            }
            
            // 卡片底色用面板色，文字对比度与页面一致
            ctx.fillStyle = palette.card;
            ctx.fill();

            // 3. 边框
            ctx.lineWidth = (isSelected || node.isSource) ? 2 : 1;
            ctx.strokeStyle = (isSelected || node.isSource) ? palette.accent : palette.border;
            ctx.stroke();

            // 4. 文字内容
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            // 标题：与列表一致的可读标题
            ctx.fillStyle = node.isSource ? palette.accent : palette.text;
            ctx.font = `600 ${node.isSource ? '13px' : '12px'} ${GRAPH_FONT}`;
            const displayName = getMemoDisplayTitle(node.name);
            const title = displayName.length > 18 ? displayName.slice(0, 16) + '…' : displayName;
            ctx.fillText(title, x + 12, y + 12);

            // 摘要 (从 chunks 中取一小段)
            ctx.fillStyle = palette.textSecondary;
            ctx.font = `11px ${GRAPH_FONT}`;
            const summary = (node.chunks && node.chunks[0])
                ? node.chunks[0].slice(0, 160).replace(/\n/g, ' ') + '...'
                : (node.isSource ? '核心源节点内容加载中...' : '暂无摘要内容...');
            
            // 简单的两行自动换行
            const words = summary.split('');
            let line = '';
            let lineCount = 0;
            let textY = y + 32;
            for (let n = 0; n < words.length; n++) {
                let testLine = line + words[n];
                let metrics = ctx.measureText(testLine);
                if (metrics.width > width - 24 && n > 0) {
                    ctx.fillText(line, x + 12, textY);
                    line = words[n];
                    textY += 15;
                    lineCount++;
                    if (lineCount >= 3) break;
                } else {
                    line = testLine;
                }
            }
            if (lineCount < 3) ctx.fillText(line, x + 12, textY);

            // 底行：源节点写所在文件夹，其余写得分
            ctx.textBaseline = 'bottom';
            if (node.isSource) {
                ctx.fillStyle = palette.textTertiary;
                ctx.font = `10px ${GRAPH_FONT}`;
                ctx.fillText(`源 · ${node.folder || '根目录'}`, x + 12, y + height - 10);
            } else {
                ctx.fillStyle = palette.accent;
                ctx.font = `600 10px ${GRAPH_FONT}`;
                ctx.textAlign = 'right';
                ctx.fillText(node.score.toFixed(2), x + width - 12, y + height - 10);
            }
        });

        ctx.restore();
        
        update();
        graphState.animationId = requestAnimationFrame(draw);
    }

    draw();
}

function getGraphCoords(clientX, clientY) {
    return {
        x: (clientX - (window.innerWidth / 2 + graphState.transform.x)) / graphState.transform.scale,
        y: (clientY - (window.innerHeight / 2 + graphState.transform.y)) / graphState.transform.scale
    };
}

function findNodeAt(x, y) {
    return graphState.nodes.find(node => {
        const width = node.isSource ? 220 : 200;
        const height = node.isSource ? 110 : 100;
        return (x >= node.x - width / 2 && x <= node.x + width / 2 &&
                y >= node.y - height / 2 && y <= node.y + height / 2);
    });
}

function updateGraphStats() {
    const nodeCount = graphState.nodes.length;
    const linkCount = graphState.links.length;
    const selectedCount = graphState.selectedNodes.size;
    
    let statText = `${nodeCount} 节点 / ${linkCount} 连线`;
    if (selectedCount > 0) {
        statText += ` (已选 ${selectedCount})`;
    }
    document.getElementById('node-count-stat').textContent = statText;

    // 更新详情面板中“加入工作台”图标的提示与数量角标
    const addBtn = document.getElementById('node-add-workbench-btn');
    if (addBtn) {
        const label = selectedCount > 1 ? `批量加入工作台（${selectedCount}）` : '加入工作台';
        addBtn.title = label;
        addBtn.setAttribute('aria-label', label);
        const badge = document.getElementById('node-add-workbench-count');
        if (badge) {
            badge.textContent = String(selectedCount);
            badge.hidden = selectedCount <= 1;
        }
        addBtn.onclick = async () => {
            if (window.DiaryWorkbench) {
                const nodesToAdd = selectedCount > 0 ? Array.from(graphState.selectedNodes) : [graphState.selectedNode];
                await window.DiaryWorkbench.addMemos(nodesToAdd);
                // 加入后自动打开工作台，提供即时反馈
                window.DiaryWorkbench.overlay.style.display = 'flex';
            }
        };
    }
}

async function selectGraphNode(node) {
    graphState.selectedNode = node;
    updateGraphStats();
    
    // 标题只显示日记名，完整路径放进提示；副标题只写所在文件夹，避免把文件名再显示一遍
    const detailTitle = document.getElementById('detail-title');
    detailTitle.textContent = getMemoDisplayTitle(node.name);
    detailTitle.title = node.path;
    document.getElementById('detail-path').textContent = node.folder || '';
    document.getElementById('detail-score').textContent = node.isSource ? "1.000 (源)" : node.score.toFixed(3);
    
    const tagList = document.getElementById('detail-tags');
    tagList.innerHTML = '';
    if (node.tags && node.tags.length > 0) {
        const maxVisibleTags = 15;
        const showAll = node.tags.length <= maxVisibleTags;
        
        node.tags.forEach((t, index) => {
            const span = document.createElement('span');
            span.className = 'tag-item';
            span.textContent = t;
            if (!showAll && index >= maxVisibleTags) {
                span.style.display = 'none';
                span.classList.add('hidden-tag');
            }
            tagList.appendChild(span);
        });

        if (!showAll) {
            const moreBtn = document.createElement('span');
            moreBtn.className = 'tag-item more-tags-btn';
            moreBtn.textContent = `+ 展开更多 (${node.tags.length - maxVisibleTags})`;
            moreBtn.onclick = () => {
                tagList.querySelectorAll('.hidden-tag').forEach(el => el.style.display = 'inline-block');
                moreBtn.style.display = 'none';
            };
            tagList.appendChild(moreBtn);
        }
    } else {
        tagList.innerHTML = `<span class="small-text">${node.isSource ? '核心源节点' : '无标签匹配'}</span>`;
    }

    const chunkList = document.getElementById('detail-chunks');
    chunkList.innerHTML = '<div class="loading-spinner">加载中...</div>';
    
    document.getElementById('node-detail-panel').classList.remove('hidden');

    // 绑定加入工作台按钮
    const addWorkbenchBtn = document.getElementById('node-add-workbench-btn');
    if (addWorkbenchBtn) {
        addWorkbenchBtn.onclick = () => {
            if (window.DiaryWorkbench) {
                window.DiaryWorkbench.open([node]);
            }
        };
    }

    try {
        // 如果是源节点或者没有 chunks，尝试加载完整内容
        if (node.isSource || !node.chunks || node.chunks.length === 0 || (node.chunks.length === 1 && node.chunks[0].endsWith('...'))) {
            const folder = node.folder || '';
            const data = await apiFetch(`/note/${encodeURIComponent(folder)}/${encodeURIComponent(node.name)}`);
            node.chunks = [data.content]; // 将完整内容存入 chunks 以便预览
        }

        chunkList.innerHTML = '';
        if (node.chunks && node.chunks.length > 0) {
            node.chunks.forEach(c => {
                const div = document.createElement('div');
                div.className = 'chunk-item';
                // 如果是 Markdown，可以考虑渲染，但这里先保持纯文本以符合原 UI
                div.textContent = c;
                chunkList.appendChild(div);
            });
        } else {
            chunkList.innerHTML = '<span class="small-text">无关联文本片段</span>';
        }
    } catch (e) {
        console.error('加载节点详情失败:', e);
        chunkList.innerHTML = `<span class="small-text" style="color:var(--danger-color)">加载失败: ${e.message}</span>`;
    }
}

function closeNeuralGraph() {
    document.getElementById('neural-graph-overlay').style.display = 'none';
    if (graphState.animationId) cancelAnimationFrame(graphState.animationId);
    graphState.animationId = null;
}