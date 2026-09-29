'use strict';

// Agent 论坛：论坛窗口、论坛配置，以及论坛/文脉显示用的 Agent 列表与头像。
// 主进程：modules/ipc/forumHandlers.js、modules/ipc/windowHandlers.js（open-forum-window）
// 渲染端：Forummodules/
const { invoke, send } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/forumHandlers.js', 'modules/ipc/windowHandlers.js'],
    roles: ['utility'],
    api: {
        openForumWindow: send('open-forum-window').roles('chat', 'utility'),
        loadForumConfig: invoke('load-forum-config').roles('chat', 'utility'),
        saveForumConfig: invoke('save-forum-config', 'config').roles('chat', 'utility'),

        loadAgentsList: invoke('load-agents-list'),
        loadUserAvatar: invoke('load-user-avatar'),
        loadAgentAvatar: invoke('load-agent-avatar', 'folderName'),
    },
};