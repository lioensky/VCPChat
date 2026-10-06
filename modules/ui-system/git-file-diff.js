/**
 * modules/ui-system/git-file-diff.js
 * 把「某个文件路径」对到 V工程 / 已登记的 Git 工作区里，查出它当前相对 Git 的增删行数。
 *
 * 给回答下面的「本轮改动 N 个文件」补 ZCode ConversationFileSummaryPanel 里的 `+N -N`
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4/ConversationFileSummaryPanel.tsx）。
 * 原实现的数字来自 agent 自己的文件改动记录；VCPChat 没有这份记录，但 FileOperator 改的文件落在工作区里，
 * 工作区是 Git 仓库时 `git:status` / `git:diff` 就能给出准确数字。
 * 注意这是「该文件当前未提交的全部改动」，不是「只算这一轮」；文件已提交、不在任何工作区或不是 Git 仓库时返回 null / clean。
 * 全部走已有的 git IPC（gitListWorkspaces / gitStatus / gitDiff），只读。
 */

'use strict';

import { computeLineDiff } from './line-diff.js';

const DEFAULT_TTL_MS = 4000;

/** 统一成正斜杠、去掉开头的 ./ 和结尾的斜杠；比较时再整体转小写（Windows 路径不区分大小写）。 */
export function normalizeFsPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

const isAbsolutePath = (value) => /^([a-zA-Z]:\/|\/|\\\\)/.test(String(value || '').replace(/\\/g, '/'));

/** 绝对路径落在哪个工作区里（取最长的那个根）→ { workspace, relPath }；相对路径或不在任何工作区里返回 null。 */
export function toWorkspaceRelative(path, workspaces) {
    const normalized = normalizeFsPath(path);
    if (!isAbsolutePath(path)) return null;
    const lowered = normalized.toLowerCase();
    let best = null;
    for (const workspace of workspaces || []) {
        const root = normalizeFsPath(workspace?.path);
        if (!root) continue;
        const rootLowered = root.toLowerCase();
        if (lowered.startsWith(`${rootLowered}/`) && (!best || root.length > best.rootLength)) {
            best = { workspace, relPath: normalized.slice(root.length + 1), rootLength: root.length };
        }
    }
    return best ? { workspace: best.workspace, relPath: best.relPath } : null;
}

/**
 * 在 git:status 的结果里找这个文件；优先未暂存（工作区相对暂存区的改动），其次已暂存。
 * relPath 不是仓库内路径时（相对路径、服务器上的路径）允许互为后缀，但后缀只有唯一一个候选时才算命中，
 * 免得 `a.js` 随便对上哪个 `x/a.js`。
 */
export function findStatusItem(status, relPath) {
    if (!status || status.isRepo === false) return null;
    const wanted = normalizeFsPath(relPath).toLowerCase();
    if (!wanted) return null;
    const entries = [
        ...[...(status.conflicts || []), ...(status.changes || [])].map(item => ({ ...item, staged: false })),
        ...(status.staged || []).map(item => ({ ...item, staged: true }))
    ];
    const pathOf = (item) => normalizeFsPath(item?.path).toLowerCase();
    const exact = entries.find(item => pathOf(item) === wanted);
    if (exact) return exact;
    const suffixed = entries.filter(item => wanted.endsWith(`/${pathOf(item)}`) || pathOf(item).endsWith(`/${wanted}`));
    return new Set(suffixed.map(pathOf)).size === 1 ? suffixed[0] : null;
}

export function createGitFileDiffResolver({ api = null, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    let workspaceCache = null; // { at, list }
    const statusCache = new Map(); // workspaceId -> { at, promise }
    const diffCache = new Map(); // `${workspaceId}|${staged}|${path}` -> { at, promise }

    const fresh = (entry) => entry && now() - entry.at < ttlMs;

    async function listWorkspaces() {
        if (!api?.gitListWorkspaces) return [];
        if (!fresh(workspaceCache)) {
            workspaceCache = {
                at: now(),
                list: api.gitListWorkspaces()
                    .then(res => (res?.success && Array.isArray(res.data?.workspaces) ? res.data.workspaces : []))
                    .catch(() => [])
            };
        }
        return workspaceCache.list;
    }

    function statusOf(workspaceId) {
        const cached = statusCache.get(workspaceId);
        if (fresh(cached)) return cached.promise;
        const promise = api.gitStatus(workspaceId)
            .then(res => (res?.success ? res.data : null))
            .catch(() => null);
        statusCache.set(workspaceId, { at: now(), promise });
        return promise;
    }

    function diffOf(workspaceId, item) {
        const key = `${workspaceId}|${item.staged ? 1 : 0}|${item.path}`;
        const cached = diffCache.get(key);
        if (fresh(cached)) return cached.promise;
        const promise = api.gitDiff(workspaceId, item.path, { staged: item.staged, origPath: item.origPath || undefined })
            .then((res) => {
                if (!res?.success) return { state: 'unavailable' };
                const { before, after } = res.data || {};
                if ([before, after].some(side => side?.binary)) return { state: 'unavailable' };
                const lcs = computeLineDiff(before?.text || '', after?.text || '');
                if (lcs.approximate) return { state: 'unavailable' }; // 区块 fallback 不是精确 Git 行数。
                return { state: 'ready', added: lcs.addedCount, removed: lcs.deletedCount, truncated: Boolean(before?.truncated || after?.truncated) };
            })
            .catch(() => ({ state: 'unavailable' }));
        diffCache.set(key, { at: now(), promise });
        return promise;
    }

    /**
     * path → { state: 'ready', added, removed, workspaceId, path(仓库内相对路径), staged }
     *       | { state: 'clean', workspaceId }   工作区里有这个文件但没有未提交改动（多半已提交）
     *       | { state: 'unavailable', workspaceId, path }   二进制 / 过大 / 读取失败
     *       | null   不在任何 Git 工作区里（含服务器在别的机器上的路径）
     */
    async function resolve(path) {
        if (!api?.gitStatus || !api?.gitDiff || !path) return null;
        const workspaces = await listWorkspaces();
        if (!workspaces.length) return null;
        let candidates;
        let rel = null;
        const located = toWorkspaceRelative(path, workspaces);
        if (located) {
            candidates = [located.workspace];
            rel = located.relPath;
        } else if (!isAbsolutePath(path)) {
            candidates = workspaces;
            rel = normalizeFsPath(path);
        } else {
            return null;
        }
        for (const workspace of candidates) {
            const status = await statusOf(workspace.id);
            if (!status || status.isRepo === false) continue;
            const item = findStatusItem(status, rel);
            if (!item) {
                if (located) return { state: 'clean', workspaceId: workspace.id };
                continue;
            }
            const diff = await diffOf(workspace.id, item);
            return { ...diff, workspaceId: workspace.id, path: item.path, staged: item.staged };
        }
        return null;
    }

    return { resolve, listWorkspaces };
}
