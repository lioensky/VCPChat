'use strict';

// 边栏子聊（Workspace Side Chat）：上下文快照、元数据读写与生命周期
// 主进程：modules/ipc/sideChatHandlers.js
const { invoke } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/sideChatHandlers.js'],
    roles: ['chat'],
    api: {
        createSideChatSnapshot: invoke('side-chat:create-snapshot', 'agentId', 'parentTopicId', 'childTopicId', 'explicitMessages'),
        saveSideChatMetadata: invoke('side-chat:save-metadata', 'metadata'),
        listSideChatMetadata: invoke('side-chat:list-metadata', 'agentId', 'parentTopicId'),
        createSideChatChild: invoke('side-chat:create-child', 'agentId'),
        deleteSideChatChild: invoke('side-chat:delete-child', 'agentId', 'childTopicId'),
        updateSideChatBranch: invoke('side-chat:update-branch', 'agentId', 'childTopicId', 'patch'),
        exportSideChatNote: invoke('side-chat:export-note', 'payload'),
    },
};
