'use strict';

// ProjectForge 施工图：项目/批次/节点只读查询、署名单文件回退，以及 Git 侧栏。
// 主进程：modules/ipc/projectForgeHandlers.js、modules/ipc/gitHandlers.js（按调用页面 URL 校验，仅施工图页面可用）
// 渲染端：ProjectForgemodules/
const { invoke } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/projectForgeHandlers.js', 'modules/ipc/gitHandlers.js'],
    roles: ['utility'],
    api: {
        projectForgeListProjects: invoke('project-forge:list-projects', 'options'),
        projectForgeGetProject: invoke('project-forge:get-project', 'projectId'),
        projectForgeSearchHistory: invoke('project-forge:search-history', 'filters'),
        projectForgeGetBatch: invoke('project-forge:get-batch', 'projectId', 'batchId'),
        projectForgeGetNode: invoke('project-forge:get-node', 'projectId', 'nodeId'),
        projectForgeRevertFile: invoke('project-forge:revert-file', 'payload'),

        // Git 侧栏
        gitListWorkspaces: invoke('git:list-workspaces'),
        gitStatus: invoke('git:status', 'workspaceId'),
        gitDiff: invoke('git:diff', 'workspaceId', 'relPath', 'options'),
        gitStage: invoke('git:stage', 'workspaceId', 'paths'),
        gitUnstage: invoke('git:unstage', 'workspaceId', 'paths'),
        gitDiscard: invoke('git:discard', 'workspaceId', 'paths'),
        gitCommit: invoke('git:commit', 'workspaceId', 'payload'),
        gitPush: invoke('git:push', 'workspaceId', 'payload'),
    },
};