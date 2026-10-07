// modules/ipc/sidePaneIpcPolicy.js
// 侧栏相关 IPC 的调用方窗口策略，集中在一张表里，由注册层统一执行（领域激活器的 allowSender、guardIpcMain 包装），
// 不靠每个 handler 自己记得检查。chat / utility preload 会装进语音、助手、笔记、论坛等很多窗口，
// 这些窗口能拿到同样的接口；能写文件、跑命令、开终端或浏览器、改工作区的通道只认下面列出的应用页面的真实顶层窗口。
// 做法同 DSH ipc.ts 的 assertDesktopSender（按通道限定允许的文档来源）；模块内部原有的检查保留，作为第二道。
'use strict';

const { createApplicationSenderGuard, resolveWindowWebContents } = require('./applicationSender');

const MAIN = Object.freeze(['main.html']);
// V工程窗口也是 Git、源码、施工图的正当调用方
const MAIN_AND_FORGE = Object.freeze(['main.html', 'ProjectForgemodules/projectforge.html']);

/**
 * preload 领域（preloads/api/<领域>.js）→ 允许的页面；open 是对其它带同一 preload 的窗口开放的只读通道。
 * 新增侧栏领域时加在这里，tests/side-pane-ipc-sender.test.js 会核对表里的每个通道都被拦住。
 */
const SIDE_PANE_IPC_POLICY = Object.freeze({
    browser: { pages: MAIN },
    terminal: { pages: MAIN },
    sideChat: { pages: MAIN },
    modelTrajectory: { pages: MAIN },
    projectForge: { pages: MAIN_AND_FORGE },
    state: { pages: MAIN_AND_FORGE },
    workspaces: {
        pages: MAIN,
        open: ['workspaces:list', 'workspaces:search', 'workspaces:expand-placeholders', 'workspaces:get-prompt-settings'],
    },
});

const DENIED = Object.freeze({ success: false, error: '当前窗口无权调用这个接口。' });

/**
 * 某个领域的调用方检查：(event, channel) => boolean。
 * @param {string} domain SIDE_PANE_IPC_POLICY 的键
 * @param {() => any} getMainWindow 主窗口可能重建，每次现取
 */
function createSidePaneSenderGuard(domain, getMainWindow) {
    const policy = SIDE_PANE_IPC_POLICY[domain];
    if (!policy) throw new Error(`[SidePaneIpcPolicy] 未登记的领域：${domain}`);
    const open = new Set(policy.open || []);
    const isAllowed = createApplicationSenderGuard({
        pages: [...policy.pages],
        getMainWebContents: () => resolveWindowWebContents(getMainWindow),
    });
    return (event, channel) => open.has(channel) || isAllowed(event);
}

/** 给直接注册的模块用：handle 时先过调用方检查，没通过就返回统一的拒绝结果，不进 handler */
function guardIpcMain(ipcMain, allowSender) {
    return Object.freeze({
        handle(channel, handler) {
            ipcMain.handle(channel, (event, ...args) => (allowSender(event, channel) ? handler(event, ...args) : DENIED));
        },
        removeHandler(channel) {
            ipcMain.removeHandler(channel);
        },
    });
}

module.exports = { SIDE_PANE_IPC_POLICY, DENIED, createSidePaneSenderGuard, guardIpcMain };
