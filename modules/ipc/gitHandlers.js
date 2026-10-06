// modules/ipc/gitHandlers.js
// ProjectForge Git 侧栏的主进程桥。
// - 渲染进程只传 workspaceId 和仓库相对路径；根目录由 workspaceService 解析，且必须是已启用的工作区。
// - utility preload 被多个工具窗口共用，这里再按调用页面 URL 校验，只放行 ProjectForge 施工图。
// - 放弃未跟踪文件时使用 shell.trashItem，文件进入系统回收站而不是硬删。
// - 仓库变化推送：窗口订阅 git.status（key 为工作区 id）时才监听那个仓库，最后一个窗口离开就停；
//   监听到变化、或任何窗口通过这里改了仓库（暂存、提交、推送、切分支……），都推 git:changed 给订阅了的窗口。
//   这里改了仓库时监听会把同一件事吞掉，不再晚几百毫秒重复推一次；
//   监听降级（只看得到 .git 或挂不上）时推一次 degraded，订阅回执里也带着，渲染端退回到窗口获得焦点时补读。
'use strict';

const path = require('path');
const { ipcMain, shell } = require('electron');
const gitService = require('../services/gitService');
const { createGitWatcher } = require('../services/gitWatcher');
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
const STATUS_TOPIC = 'git.status';
const MAX_PATHS = 5000;
let workspaceServiceRef = null;
let getMainWindow = () => null;
let subscriptionsRef = null;
let watcher = null;
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

function notifyChanged(workspaceId, reason, extra = null) {
    if (typeof workspaceId !== 'string' || !workspaceId) return;
    subscriptionsRef?.publish(STATUS_TOPIC, workspaceId, 'git:changed', { workspaceId, reason, ...extra });
}

/** mutates：改了仓库的操作，成功后推给其它窗口（发起操作的界面自己会刷新，推送到了也只是多读一次） */
function handle(channel, fn, { mutates = false } = {}) {
    ipcMain.handle(channel, async (event, ...args) => {
        if (!isAllowedSender(event)) {
            return { success: false, error: '当前窗口无权调用 Git 接口。' };
        }
        try {
            const data = await fn(...args);
            if (mutates) {
                watcher?.absorb(args[0]);
                notifyChanged(args[0], channel.slice('git:'.length));
            }
            return { success: true, data };
        } catch (error) {
            return {
                success: false,
                error: error?.message || String(error),
                code: typeof error?.code === 'string' ? error.code : null,
            };
        }
    });
}

/**
 * @param {object} [options]
 * @param {object} [options.subscriptions] stateSubscriptions.js 的订阅表；有窗口订阅某个工作区时才监听它的仓库
 * @param {Function} [options.watch] 测试注入 fs.watch
 */
function initialize({ workspaceService = null, mainWindow = null, getMainWindow: getWindow = null, subscriptions = null, watch = undefined } = {}) {
    getMainWindow = typeof getWindow === 'function' ? getWindow : () => mainWindow;
    workspaceServiceRef = workspaceService;
    CHANNELS.forEach(channel => ipcMain.removeHandler(channel));
    if (subscriptions && subscriptions !== subscriptionsRef) {
        watcher?.dispose();
        subscriptionsRef = subscriptions;
        watcher = createGitWatcher({
            getTargets: workspaceId => gitService.getWatchTargets(resolveWorkspaceRoot(workspaceId)),
            onChange: workspaceId => notifyChanged(workspaceId, 'files'),
            onDegraded: workspaceId => notifyChanged(workspaceId, 'watch-degraded', { degraded: true }),
            ...(watch ? { watch } : {}),
        });
        subscriptions.declare(STATUS_TOPIC, {
            keyed: true,
            onFirst: workspaceId => { void watcher.start(workspaceId); },
            onLast: workspaceId => watcher.stop(workspaceId),
            describe: workspaceId => ({ degraded: watcher.isDegraded(workspaceId) }),
        });
    }

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

    handle('git:stage', (workspaceId, paths) => gitService.stage(resolveWorkspaceRoot(workspaceId), asPathList(paths)), { mutates: true });

    handle('git:unstage', (workspaceId, paths) => gitService.unstage(resolveWorkspaceRoot(workspaceId), asPathList(paths)), { mutates: true });

    handle('git:discard', (workspaceId, paths) => gitService.discard(
        resolveWorkspaceRoot(workspaceId),
        asPathList(paths),
        { removeUntracked: absPath => shell.trashItem(absPath) },
    ), { mutates: true });

    handle('git:commit', (workspaceId, payload = {}) => gitService.commit(
        resolveWorkspaceRoot(workspaceId),
        { message: typeof payload?.message === 'string' ? payload.message : '' },
    ), { mutates: true });

    handle('git:push', (workspaceId, payload = {}) => gitService.push(
        resolveWorkspaceRoot(workspaceId),
        { setUpstream: payload?.setUpstream === true },
    ), { mutates: true });

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
    ), { mutates: true });

    handle('git:create-branch', (workspaceId, name, startPoint) => gitService.createBranch(
        resolveWorkspaceRoot(workspaceId),
        typeof name === 'string' ? name : '',
        typeof startPoint === 'string' ? startPoint : '',
    ), { mutates: true });

    handle('git:commit-graph', (workspaceId, options = {}) => gitService.getCommitGraph(
        resolveWorkspaceRoot(workspaceId),
        { maxCount: options?.maxCount, skip: options?.skip },
    ));

    handle('git:change-summary', workspaceId => gitService.getChangeSummary(resolveWorkspaceRoot(workspaceId)));
}

/** 诊断：正在监听的工作区和监听方式 */
function watchSnapshot() {
    return watcher?.snapshot() || [];
}

function dispose() {
    watcher?.dispose();
}

module.exports = {
    CHANNELS,
    STATUS_TOPIC,
    initialize,
    isAllowedSenderUrl,
    watchSnapshot,
    dispose,
};