'use strict';

// 侧栏浏览器：在默认浏览器中打开、清除浏览数据，以及网页 window.open 转发过来的「新开标签」事件、
// 焦点在网页里时截下的副屏快捷键
// 主进程：modules/ipc/browserHandlers.js（仅主窗口页面可用；页面本身由渲染进程的 <webview> 承载）
const { invoke, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/browserHandlers.js'],
    roles: ['chat'],
    api: {
        browserRegisterTarget: invoke('browser:register-target', 'tabId', 'guestId'),
        browserUnregisterTarget: invoke('browser:unregister-target', 'tabId', 'guestId'),
        browserAgentResponse: invoke('browser:agent-response', 'payload'),
        browserActiveTarget: invoke('browser:active-target', 'tabId'),
        browserCompleteAssistance: invoke('browser:complete-assistance', 'tabId', 'requestId', 'cancelled'),
        onBrowserAgentRequest: on('browser:agent-request'),
        browserOpenExternal: invoke('browser:open-external', 'url'),
        browserClearData: invoke('browser:clear-data'),
        onBrowserOpenTab: on('browser:open-tab'),
        onBrowserSidePaneShortcut: on('browser:side-pane-shortcut'),
    },
};
