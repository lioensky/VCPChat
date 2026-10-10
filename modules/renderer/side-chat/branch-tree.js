/* side-chat/branch-tree.js
 * Pure branch-tree model for fractal side chats.
 *
 * 一个辅助对话 = 一个独立 child topic（独立 history.json / 流式 / 编辑 / 轨迹）。
 * 分支关系不靠额外清单文件，而是由每个 child 的 sidechat-metadata.json 上的
 * 拓扑字段派生：
 *   rootTopicId      这棵分支树的根侧聊 child topicId（根指向自己）
 *   forkFromTopicId  从哪个侧聊 child topic 分叉；根为 null
 *   forkMessageId    分叉锚点（父分支里的某条 assistant 消息 id）
 *   forkLabel        分叉时选中的文本 / 盲点关键词
 *   branchTitle      用户可编辑的分支名
 *   depth            距根的层级（根为 0）
 *   crystallized     是否已「知识结晶」
 *
 * 本模块无 DOM、无 IPC、无副作用，方便单测。
 */
'use strict';

function topicIdOf(meta) {
    return meta?.child?.topicId || null;
}

function asString(value) {
    return typeof value === 'string' && value ? value : null;
}

/**
 * 规范化单条 metadata 上的分支字段。旧侧聊（没有分支字段）视为独立根。
 */
export function normalizeBranchMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const topicId = topicIdOf(meta);
    if (!topicId) return null;

    const forkFromTopicId = asString(meta.forkFromTopicId);
    const declaredRoot = asString(meta.rootTopicId);

    return {
        topicId,
        title: asString(meta.branchTitle) || asString(meta.title) || '辅助对话',
        branchTitle: asString(meta.branchTitle),
        rootTopicId: declaredRoot || topicId,
        forkFromTopicId,
        forkMessageId: asString(meta.forkMessageId),
        forkLabel: asString(meta.forkLabel),
        depth: Number.isFinite(meta.depth) ? Math.max(0, Math.floor(meta.depth)) : 0,
        crystallized: Boolean(meta.crystallized),
        createdAt: Number.isFinite(meta.createdAt) ? meta.createdAt : 0,
        status: asString(meta.status) || 'ready',
        open: meta.open !== false,
        meta,
    };
}

function makeNode(entry) {
    return {
        ...entry,
        parent: null,
        children: [],
    };
}

/**
 * 由 metadata 列表构建一个 topicId -> node 的索引，并连好 parent/children。
 * 容错：forkFrom 指向集合外或形成环时，该节点退回为根，不丢分支。
 *
 * @param {Array} metadataList listSideChatMetadata 返回的 items
 * @returns {{ nodes: Map<string,object>, roots: object[] }}
 */
export function buildBranchForest(metadataList = []) {
    const nodes = new Map();
    const list = Array.isArray(metadataList) ? metadataList : [];

    for (const raw of list) {
        const entry = normalizeBranchMeta(raw);
        if (!entry) continue;
        if (!nodes.has(entry.topicId)) nodes.set(entry.topicId, makeNode(entry));
    }

    const roots = [];

    for (const node of nodes.values()) {
        const parentId = node.forkFromTopicId;
        if (!parentId || !nodes.has(parentId) || parentId === node.topicId) {
            roots.push(node);
            continue;
        }
        // 环检测：沿父链走，若回到自己则断开当根处理
        let cursor = nodes.get(parentId);
        let cyclic = false;
        const seen = new Set([node.topicId]);
        while (cursor) {
            if (seen.has(cursor.topicId)) { cyclic = true; break; }
            seen.add(cursor.topicId);
            cursor = cursor.forkFromTopicId ? nodes.get(cursor.forkFromTopicId) : null;
        }
        if (cyclic) {
            roots.push(node);
            continue;
        }
        const parent = nodes.get(parentId);
        node.parent = parent;

        parent.children.push(node);
    }

    const byCreated = (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
        || a.topicId.localeCompare(b.topicId);

    roots.sort(byCreated);
    const pending = roots.map(node => ({ node, depth: 0 }));
    while (pending.length) {
        const { node, depth } = pending.pop();
        node.depth = depth;
        node.children.sort(byCreated);
        for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
    }

    return { nodes, roots };
}

/**
 * 取某棵分支树（按根 topicId）的根节点。找不到时返回 null。
 */
export function findRoot(forest, rootTopicId) {
    if (!forest?.nodes || !rootTopicId) return null;
    return forest.roots.find(r => r.topicId === rootTopicId)
        || forest.nodes.get(rootTopicId)
        || null;
}

/**
 * 根 -> 当前节点 的面包屑链（含两端）。
 */
export function breadcrumbChain(node) {
    if (!node) return [];
    const chain = [];
    let cursor = node;
    const guard = new Set();
    while (cursor && !guard.has(cursor.topicId)) {
        guard.add(cursor.topicId);
        chain.unshift(cursor);
        cursor = cursor.parent;
    }
    return chain;
}

/**
 * 某节点的全部后代（不含自身），深度优先、按创建时间。
 */
export function descendants(node) {
    const out = [];
    if (!node) return out;
    const walk = (n) => {
        for (const child of n.children) {
            out.push(child);
            walk(child);
        }
    };
    walk(node);
    return out;
}

/**
 * 统计一棵子树的消息轮数无法在纯函数层拿到（需读 history），
 * 这里统计分支节点数量与已结晶数量。
 */
export function subtreeStats(node) {
    const all = node ? [node, ...descendants(node)] : [];
    return {
        branchCount: all.length,
        crystallizedCount: all.filter(n => n.crystallized).length,
        leafCount: all.filter(n => n.children.length === 0).length,
    };
}

/**
 * 把树拍平成拓扑图渲染用的有序行（深度优先），每行带 depth 与节点引用。
 */
export function flattenTree(root) {
    const rows = [];
    if (!root) return rows;
    const walk = (node) => {
        rows.push(node);
        node.children.forEach(walk);
    };
    walk(root);
    return rows;
}