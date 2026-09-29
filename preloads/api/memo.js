'use strict';

// 记忆管理（Memo）：记忆窗口与配置。
// 主进程：modules/ipc/memoHandlers.js、modules/ipc/windowHandlers.js（open-memo-window）
// 渲染端：Memomodules/
const { invoke, send } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/memoHandlers.js', 'modules/ipc/windowHandlers.js'],
    roles: ['utility'],
    api: {
        openMemoWindow: send('open-memo-window').roles('chat', 'utility'),
        loadMemoConfig: invoke('load-memo-config'),
        saveMemoConfig: invoke('save-memo-config', 'config'),
    },
};