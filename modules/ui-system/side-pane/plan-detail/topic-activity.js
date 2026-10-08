/**
 * modules/ui-system/side-pane/plan-detail/topic-activity.js
 * 侧栏计划里「跟着话题走」的那部分数据：只算这个话题自己施工产生的批次。
 *
 * ProjectForge 的批次不记话题，话题的批次号从聊天记录里读（conversation-scope.js 的 batchIds），
 * 这里把这些批次的节点汇总成时间线、变更文件、参与者和统计，口径与 V工程 页的工程级数据一致。
 */

'use strict';

// 批次类型（batches.kind）和节点操作（nodes.op）的叫法与 V工程 页一致
export const KIND_LABEL = Object.freeze({ edit: '编辑', create: '新建', remove: '删除', move: '移动', rollback: '回退', external: '外部修改' });
export const KIND_ICON = Object.freeze({ edit: 'edit', create: 'add_circle', remove: 'delete', move: 'drive_file_move', rollback: 'undo', external: 'sync_problem' });
export const OP_LABEL = Object.freeze({ create: '新建', edit: '编辑', delete: '删除', move: '移动', rollback: '回退', external: '外部修改' });

// project-forge:get-project 的时间线最多返回这么多批，更早的话题批次要单独查
export const TIMELINE_LIMIT = 200;

const sum = (list, key) => list.reduce((total, item) => total + (Number(item[key]) || 0), 0);
const later = (a, b) => (String(a || '') > String(b || '') ? a : b);

/**
 * 某个工程里哪些话题批次需要单独读取：时间线里有的直接用；时间线满了，更早的号可能也在这个工程里。
 * 批次号全局递增、各工程共用，所以不在时间线范围内的号属于别的工程，不必去查。
 * @returns {{ inTimeline: number[], older: number[] }}
 */
export function locateTopicBatches(timeline, topicBatchIds) {
    const rows = Array.isArray(timeline) ? timeline : [];
    const ids = new Set(rows.map(row => Number(row.id)));
    const full = rows.length >= TIMELINE_LIMIT;
    const oldest = rows.length ? Math.min(...ids) : Infinity;
    const inTimeline = [];
    const older = [];
    for (const id of topicBatchIds || []) {
        if (ids.has(id)) inTimeline.push(id);
        else if (full && id < oldest) older.push(id);
    }
    return { inTimeline, older };
}

/**
 * 话题批次（{ batch, nodes }）→ 时间线、文件、参与者、统计。没有节点的批次（施工失败）不算。
 */
export function buildTopicActivity(entries) {
    const batches = (entries || [])
        .filter(entry => entry?.batch && Array.isArray(entry.nodes) && entry.nodes.length)
        .map(({ batch, nodes }) => ({
            id: Number(batch.id),
            kind: batch.kind,
            reason: batch.reason || '',
            maid: batch.maid || null,
            created_at: batch.created_at || '',
            nodes: [...nodes].sort((a, b) => a.id - b.id),
            files: [...new Set(nodes.map(node => node.file_path))],
            node_count: nodes.length,
            added: sum(nodes, 'added'),
            removed: sum(nodes, 'removed')
        }))
        .sort((a, b) => b.id - a.id);

    const files = new Map();
    const people = new Map();
    let lastAt = '';
    for (const batch of batches) {
        lastAt = later(lastAt, batch.created_at);
        const who = batch.maid || '';
        const person = people.get(who) || { maid: batch.maid, batches: 0, added: 0, removed: 0, last_at: '' };
        person.batches += 1;
        person.added += batch.added;
        person.removed += batch.removed;
        person.last_at = later(person.last_at, batch.created_at);
        people.set(who, person);
        for (const node of batch.nodes) {
            const file = files.get(node.file_path) || { file_path: node.file_path, edits: 0, added: 0, removed: 0, last_node: 0 };
            file.edits += 1;
            file.added += Number(node.added) || 0;
            file.removed += Number(node.removed) || 0;
            file.last_node = Math.max(file.last_node, node.id);
            files.set(node.file_path, file);
        }
    }
    const fileList = [...files.values()].sort((a, b) => b.last_node - a.last_node);
    return {
        batches,
        files: fileList,
        contributors: [...people.values()].sort((a, b) => b.batches - a.batches || String(b.last_at).localeCompare(String(a.last_at))),
        stats: {
            batchCount: batches.length,
            nodeCount: sum(batches, 'node_count'),
            fileCount: fileList.length,
            added: sum(batches, 'added'),
            removed: sum(batches, 'removed'),
            lastAt: lastAt || null
        }
    };
}

export const EMPTY_FILTERS = Object.freeze({ keyword: '', file: '', exactFile: '', maid: '', op: '', content: '' });

export function hasFilters(filters) {
    return Boolean(filters && (filters.keyword || filters.file || filters.exactFile || filters.maid || filters.op || filters.content));
}

/** 筛选条件 → project-forge:search-history 的参数（与 V工程 页「历史」一致）。 */
export function searchParams(projectId, filters, limit = 500) {
    const params = { projectId, limit };
    if (filters.keyword) params.keyword = filters.keyword;
    if (filters.exactFile || filters.file) params.file = filters.exactFile || filters.file;
    if (filters.maid) params.byMaid = filters.maid;
    if (filters.op) params.op = filters.op;
    if (filters.content) params.content = filters.content;
    return params;
}

/**
 * 历史搜索结果收窄到话题：只留话题批次里的节点；点文件进来的筛选只要这一个文件（搜索本身按子串匹配）。
 * topicBatchIds 为 null 时不按话题收窄（没有话题的全局标签）。
 */
export function narrowSearchRows(rows, { topicBatchIds = null, exactFile = '' } = {}) {
    return (rows || []).filter(row => (!topicBatchIds || topicBatchIds.has(Number(row.batch_id)))
        && (!exactFile || row.file_path === exactFile));
}
