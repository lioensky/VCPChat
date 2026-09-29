'use strict';

// 工作区：目录索引搜索、工作区增删改、系统提示占位符 {{VCPChatWorkSpace}} 展开与设置。
// 主进程：modules/ipc/workspaceHandlers.js
const { invoke } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/workspaceHandlers.js'],
    roles: ['chat'],
    api: {
        searchWorkspaceFiles: invoke('workspaces:search', (queryText, options = {}) => [queryText, options]),
        listWorkspaces: invoke('workspaces:list'),
        setActiveWorkspace: invoke('workspaces:set-active', (workspaceId = null) => [workspaceId]),
        addWorkspace: invoke('workspaces:add', (dirPath, alias = '') => [dirPath, alias]),
        removeWorkspace: invoke('workspaces:remove', 'workspaceId'),
        updateWorkspace: invoke('workspaces:update', 'workspaceId', 'patch'),
        rebuildWorkspaceIndex: invoke('workspaces:rebuild', (workspaceId = null) => [workspaceId]),
        selectWorkspaceDirectory: invoke('workspaces:select-directory'),

        // {{VCPChatWorkSpace}} / {{VCPChatWorkSpace:文件夹名}} 占位符
        expandWorkspacePlaceholders: invoke('workspaces:expand-placeholders', 'text'),
        getWorkspacePromptSettings: invoke('workspaces:get-prompt-settings'),
        setWorkspacePromptSettings: invoke('workspaces:set-prompt-settings', 'patch'),
    },
};