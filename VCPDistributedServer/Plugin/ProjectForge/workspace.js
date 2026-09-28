'use strict';
// 工作区解析：写入白名单来自“已启用工作区根目录 + 插件配置 ALLOWED_DIRECTORIES”，
// 每次调用实时计算，设置页增删/停用工作区后立即生效。
// 工程根目录按 workspace_id + subpath 定位，工作区整体搬家后仍可找到。

const path = require('path');
const { isPathInside, toPosixRelative } = require('../../shared/fileKit/paths');

function normalizeAlias(value) {
    return String(value || '').trim().toLowerCase();
}

class WorkspaceResolver {
    /**
     * @param {object} options
     * @param {object|null} options.workspaceService 主进程注入的只读门面（可为空，例如单测或未启用工作区）
     * @param {string[]} [options.extraAllowed] 额外允许的目录（插件 config.env 的 ALLOWED_DIRECTORIES）
     */
    constructor({ workspaceService = null, extraAllowed = [] } = {}) {
        this.workspaceService = workspaceService;
        this.extraAllowed = extraAllowed.map(dir => String(dir).trim()).filter(Boolean).map(dir => path.resolve(dir));
    }

    list() {
        try {
            return this.workspaceService?.list?.() || [];
        } catch (_e) {
            return [];
        }
    }

    enabled() {
        return this.list().filter(ws => ws.enabled);
    }

    /** 写入白名单根目录 */
    allowedRoots() {
        return [...this.enabled().map(ws => path.resolve(ws.path)), ...this.extraAllowed];
    }

    isWritable(absPath) {
        return this.allowedRoots().some(root => isPathInside(absPath, root));
    }

    /** 按 id 或别名查找（大小写不敏感）；includeDisabled 用于读取已停用工作区的工程。 */
    find(ref, { includeDisabled = false } = {}) {
        if (!ref) return null;
        const key = normalizeAlias(ref);
        const pool = includeDisabled ? this.list() : this.enabled();
        return pool.find(ws => ws.id === ref || normalizeAlias(ws.alias) === key) || null;
    }

    active() {
        let id = null;
        try { id = this.workspaceService?.getActiveWorkspaceId?.() || null; } catch (_e) { id = null; }
        return id ? this.find(id) : null;
    }

    describeAvailable() {
        const list = this.enabled();
        const lines = list.map(ws => `- \`${ws.alias}\` → ${ws.path}`);
        if (this.extraAllowed.length) lines.push(...this.extraAllowed.map(dir => `- （配置目录）${dir}`));
        return lines.length ? lines.join('\n') : '- （无）请先在“全局设置 → 工作区管理”中登记工作区。';
    }

    /**
     * 为新工程确定根目录。
     * workspaceRef：别名/id；为空时依次取当前工作区、唯一启用的工作区。
     * subdir：工作区内子目录（相对路径），或位于白名单内的绝对路径。
     */
    resolveNewProjectRoot(workspaceRef, subdir) {
        const sub = typeof subdir === 'string' ? subdir.trim() : '';

        // 绝对路径：直接按白名单判定，归属到所在工作区（若有）
        if (sub && path.isAbsolute(sub)) {
            const abs = path.resolve(sub);
            if (!this.isWritable(abs)) {
                throw new Error(`目录不在任何已启用工作区或允许目录内：${abs}\n可用工作区：\n${this.describeAvailable()}`);
            }
            const ws = this.enabled()
                .filter(item => isPathInside(abs, item.path))
                .sort((a, b) => b.path.length - a.path.length)[0] || null;
            return {
                root: abs,
                workspace: ws,
                subpath: ws ? toPosixRelative(ws.path, abs) : '',
            };
        }

        let ws = null;
        if (workspaceRef) {
            ws = this.find(workspaceRef);
            if (!ws) throw new Error(`工作区“${workspaceRef}”不存在或已停用。可用工作区：\n${this.describeAvailable()}`);
        } else {
            ws = this.active();
            if (!ws && this.enabled().length === 1) ws = this.enabled()[0];
            if (!ws) {
                throw new Error(`未指定工作区，且当前没有选定工作区。请提供 workspace（别名）。可用工作区：\n${this.describeAvailable()}`);
            }
        }
        const root = path.resolve(ws.path, ...sub.split(/[/\\]+/).filter(Boolean));
        if (!isPathInside(root, ws.path)) throw new Error(`子目录越出工作区：${sub}`);
        return { root, workspace: ws, subpath: toPosixRelative(ws.path, root) };
    }

    /**
     * 解析工程当前的根目录与可写状态。
     * @returns {{ root: string, writable: boolean, blockedReason: string|null, workspaceAlias: string|null }}
     */
    projectRoot(project) {
        if (project.workspace_id) {
            const ws = this.find(project.workspace_id, { includeDisabled: true });
            if (ws) {
                const root = path.resolve(ws.path, ...String(project.subpath || '').split('/').filter(Boolean));
                if (!ws.enabled) {
                    return { root, writable: false, blockedReason: `工作区“${ws.alias}”已停用，工程只读。`, workspaceAlias: ws.alias };
                }
                return { root, writable: true, blockedReason: null, workspaceAlias: ws.alias };
            }
            // 工作区服务不可用或已被移除：回退到记录的根目录，但仍需通过白名单
        }
        const root = path.resolve(project.root);
        const writable = this.isWritable(root);
        return {
            root,
            writable,
            blockedReason: writable ? null : `工程所属工作区已被移除或不可用，工程只读（根目录：${root}）。`,
            workspaceAlias: project.workspace_alias || null,
        };
    }

    /**
     * 解析工程内路径。相对路径基于工程根；绝对路径必须位于工程根内。
     * @returns {{ abs: string, rel: string }} rel 为 posix 相对路径，用作数据库键
     */
    resolveInProject(projectRootInfo, inputPath) {
        const raw = String(inputPath || '').trim().replace(/^["']|["']$/g, '');
        if (!raw) throw new Error('缺少 path。');
        const abs = path.isAbsolute(raw)
            ? path.resolve(raw)
            : path.resolve(projectRootInfo.root, ...raw.split(/[/\\]+/).map(part => part.trim()).filter(Boolean));
        if (!isPathInside(abs, projectRootInfo.root) || abs === path.resolve(projectRootInfo.root)) {
            throw new Error(`路径越出工程根目录：${raw}（工程根：${projectRootInfo.root}）`);
        }
        return { abs, rel: toPosixRelative(projectRootInfo.root, abs) };
    }
}

module.exports = { WorkspaceResolver };