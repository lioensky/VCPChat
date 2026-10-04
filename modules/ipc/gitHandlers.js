// modules/ipc/gitHandlers.js
// ProjectForge Git 侧栏的主进程桥。
// - 渲染进程只传 workspaceId 和仓库相对路径；根目录由 workspaceService 解析，且必须是已启用的工作区。
// - utility preload 被多个工具窗口共用，这里再按调用页面 URL 校验，只放行 ProjectForge 施工图。
// - 放弃未跟踪文件时使用 shell.trashItem，文件进入系统回收站而不是硬删。
'use strict';

const path = require('path');
const { ipcMain, shell } = require('electron');
const gitService = require('../services/gitService');
const { createApplicationSenderGuard, isApplicationPageUrl, resolveWindowWebContents } = require('./applicationSender');

const CHANNELS = [
    'git:list-workspaces',
    'git:status',
    'git:diff',
    'git:stage',
    'git:unstage',
    'git:discard',
    'git:commit',
    'git:push',
    'git:list-branches',
    'git:switch-branch',
    'git:create-branch',
    'git:commit-graph',
    'git:change-summary',
    'git:reveal-path',
];

const ALLOWED_PAGES = ['ProjectForgemodules/projectforge.html', 'main.html'];
const MAX_PATHS = 5000;
let workspaceServiceRef = null;
let getMainWindow = () => null;
const isAllowedSender = createApplicationSenderGuard({ pages: ALLOWED_PAGES, getMainWebContents: () => resolveWindowWebContents(getMainWindow) });
function isAllowedSenderUrl(raw) { return isApplicationPageUrl(raw, ALLOWED_PAGES); }

function listEnabledWorkspaces() {
    return (workspaceServiceRef?.list() || [])
        .filter(ws => ws.enabled)
        .map(ws => ({ id: ws.id, alias: ws.alias, path: ws.path }));
}

function resolveWorkspaceRoot(workspaceId) {
    if (!workspaceServiceRef) throw new Error('工作区服务未初始化。');
    if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('请先选择工作区。');
    const ws = workspaceServiceRef.list().find(item => item.id === workspaceId);
    if (!ws) throw new Error('工作区不存在，可能已被移除。');
    if (!ws.enabled) throw new Error(`工作区 "${ws.alias}" 已停用。`);
    return ws.path;
}

function asPathList(value) {
    if (!Array.isArray(value)) throw new Error('文件列表格式错误。');
    const list = value.filter(item => typeof item === 'string' && item);
    if (list.length > MAX_PATHS) throw new Error(`单次最多操作 ${MAX_PATHS} 个文件。`);
    return list;
}

function handle(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
        if (!isAllowedSender(event)) {
            return { success: false, error: '当前窗口无权调用 Git 接口。' };
        }
        try {
            return { success: true, data: await fn(...args) };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error),
                code: typeof error?.code === 'string' ? error.code : null,
            };
        }
    });
}

function initialize({ workspaceService = null, mainWindow = null, getMainWindow: getWindow = null } = {}) {
    getMainWindow = typeof getWindow === 'function' ? getWindow : () => mainWindow;
    workspaceServiceRef = workspaceService;
    CHANNELS.forEach(channel => ipcMain.removeHandler(channel));

    handle('git:list-workspaces', () => ({
        workspaces: listEnabledWorkspaces(),
        activeWorkspaceId: workspaceServiceRef?.getActiveWorkspaceId?.() || null,
    }));

    handle('git:status', workspaceId => gitService.getStatus(resolveWorkspaceRoot(workspaceId)));

    handle('git:diff', (workspaceId, relPath, options = {}) => gitService.getDiff(
        resolveWorkspaceRoot(workspaceId),
        typeof relPath === 'string' ? relPath : '',
        {
            staged: options?.staged === true,
            origPath: typeof options?.origPath === 'string' && options.origPath ? options.origPath : null,
        },
    ));

    handle('git:stage', (workspaceId, paths) => gitService.stage(resolveWorkspaceRoot(workspaceId), asPathList(paths)));

    handle('git:unstage', (workspaceId, paths) => gitService.unstage(resolveWorkspaceRoot(workspaceId), asPathList(paths)));

    handle('git:discard', (workspaceId, paths) => gitService.discard(
        resolveWorkspaceRoot(workspaceId),
        asPathList(paths),
        { removeUntracked: absPath => shell.trashItem(absPath) },
    ));

    handle('git:commit', (workspaceId, payload = {}) => gitService.commit(
        resolveWorkspaceRoot(workspaceId),
        { message: typeof payload?.message === 'string' ? payload.message : '' },
    ));

    handle('git:push', (workspaceId, payload = {}) => gitService.push(
        resolveWorkspaceRoot(workspaceId),
        { setUpstream: payload?.setUpstream === true },
    ));

    // 在系统文件管理器中定位文件：只接受工作区内的相对路径，越界一律拒绝。
    handle('git:reveal-path', (workspaceId, relPath) => {
        const root = path.resolve(resolveWorkspaceRoot(workspaceId));
        const target = path.resolve(root, typeof relPath === 'string' ? relPath : '');
        if (target !== root && !target.startsWith(root + path.sep)) throw new Error('路径不在工作区内。');
        shell.showItemInFolder(target);
        return { revealed: true };
    });

    handle('git:list-branches', workspaceId => gitService.listBranches(resolveWorkspaceRoot(workspaceId)));

    handle('git:switch-branch', (workspaceId, name) => gitService.switchBranch(
        resolveWorkspaceRoot(workspaceId),
        typeof name === 'string' ? name : '',
    ));

    handle('git:create-branch', (workspaceId, name, startPoint) => gitService.createBranch(
        resolveWorkspaceRoot(workspaceId),
        typeof name === 'string' ? name : '',
        typeof startPoint === 'string' ? startPoint : '',
    ));

    handle('git:commit-graph', (workspaceId, options = {}) => gitService.getCommitGraph(
        resolveWorkspaceRoot(workspaceId),
        { maxCount: options?.maxCount, skip: options?.skip },
    ));

    handle('git:change-summary', workspaceId => gitService.getChangeSummary(resolveWorkspaceRoot(workspaceId)));
}

module.exports = {
    initialize,
    isAllowedSenderUrl,
};