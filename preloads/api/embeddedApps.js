'use strict';

// 内嵌应用：主窗口里以 WebContentsView 标签页形式打开的 VChat 子应用（笔记、音乐、画布等），以及主进程生命周期快照。
// 主进程：main.js（embedded-vchat-app:*、lifecycle:get-main-snapshot、lifecycle:renderer-ready、diagnostics:export-snapshot）、modules/services/embeddedAppSessionManager.js
// 内嵌页面自身的关闭请求见 api/window.js 的 closeWindow。
const { invoke, on, send } = require('../core/define');

// requestId 为空时沿用旧协议：直接传 appAction；有 requestId 时传 { requestId, action }，便于取消
const withRequest = (appAction, requestId = '') => [requestId ? { requestId, action: appAction } : appAction];

module.exports = {
    handlers: ['main.js', 'modules/services/embeddedAppSessionManager.js'],
    roles: ['chat'],
    api: {
        desktopCreateEmbeddedVchatApp: invoke('embedded-vchat-app:create', withRequest),
        desktopCloseEmbeddedVchatApp: invoke('embedded-vchat-app:close', withRequest),
        desktopDetachEmbeddedVchatApp: invoke('embedded-vchat-app:detach', (appAction, point, requestId = '') => (
            requestId ? [{ requestId, action: appAction, point }, undefined] : [appAction, point]
        )),
        desktopCancelEmbeddedVchatAppTask: invoke('embedded-vchat-app:cancel', 'requestId'),
        desktopListEmbeddedVchatApps: invoke('embedded-vchat-app:list'),
        desktopActivateEmbeddedVchatApp: invoke('embedded-vchat-app:activate', 'appAction'),
        desktopSetEmbeddedVchatAppBounds: invoke('embedded-vchat-app:set-bounds', 'appAction', 'bounds'),
        desktopCloseAllEmbeddedVchatApps: invoke('embedded-vchat-app:close-all'),
        onEmbeddedVchatAppState: on('embedded-vchat-app-state'),

        getMainLifecycleSnapshot: invoke('lifecycle:get-main-snapshot'),
        // 渲染器就绪信号：主进程记 renderer-ready 启动标记（modules/launchMarks.js）
        markRendererReady: send('lifecycle:renderer-ready'),
        // 一次性诊断导出：进程指标 + 窗口状态 + 生命周期快照写成 JSON（modules/diagnosticsSnapshot.js），返回文件路径
        exportDiagnosticsSnapshot: invoke('diagnostics:export-snapshot'),
    },
};