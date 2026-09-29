'use strict';

// 内嵌应用：主窗口里以 WebContentsView 标签页形式打开的 VChat 子应用（笔记、音乐、画布等），以及主进程生命周期快照。
// 主进程：main.js（embedded-vchat-app:*、lifecycle:get-main-snapshot）、modules/services/embeddedAppSessionManager.js
// 内嵌页面自身的关闭请求见 api/window.js 的 closeWindow。
const { invoke, on } = require('../core/define');

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
    },
};