'use strict';

// VCPLoom 在聊天窗口和桌面窗口中的入口：打开 Loom 管理器、列出并启动 Loom 应用、把 Loom 页面文字分享到聊天输入框。
// 主进程：modules/loom/VCPLoomManager.js
// 注意：Loom 自己的外壳窗口用的是独立的 preloads/loom.js（loomAPI），不走这里。
const { invoke, on } = require('../core/define');

module.exports = {
    handlers: ['modules/loom/VCPLoomManager.js'],
    roles: ['desktop'],
    api: {
        loomOpenManager: invoke('loom:open-manager').roles('chat', 'desktop'),
        loomListApps: invoke('loom:list-apps'),
        loomOpenApp: invoke('loom:open-app', 'appId'),
        onLoomRegistryChanged: on('loom:registry-changed'),
        onLoomShareTextToInput: on('loom:share-text-to-input').roles('chat'),
    },
};