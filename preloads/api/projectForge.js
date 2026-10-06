'use strict';

// ProjectForge 施工图：项目/批次/节点只读查询、署名单文件回退，以及 Git 侧栏、源码侧栏。
// 主进程：modules/ipc/projectForgeHandlers.js、modules/ipc/gitHandlers.js、modules/ipc/sourceHandlers.js
//        （Git / 源码接口按调用页面 URL 校验，仅施工图页面可用）
// 渲染端：ProjectForgemodules/
const { invoke, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/projectForgeHandlers.js', 'modules/ipc/gitHandlers.js', 'modules/ipc/sourceHandlers.js'],
    roles: ['utility', 'chat'],
    api: {
        projectForgeListProjects: invoke('project-forge:list-projects', 'options'),
        projectForgeGetProject: invoke('project-forge:get-project', 'projectId'),
        projectForgeSearchHistory: invoke('project-forge:search-history', 'filters'),
        projectForgeGetBatch: invoke('project-forge:get-batch', 'projectId', 'batchId'),
        projectForgeGetNode: invoke('project-forge:get-node', 'projectId', 'nodeId'),
        projectForgeRevertFile: invoke('project-forge:revert-file', 'payload'),
        projectForgeDeleteProject: invoke('project-forge:delete-project', 'projectId', 'signature'),
        onProjectForgeChanged: on('project-forge:changed'),

        // Git 侧栏
        gitListWorkspaces: invoke('git:list-workspaces'),
        gitStatus: invoke('git:status', 'workspaceId'),
        gitDiff: invoke('git:diff', 'workspaceId', 'relPath', 'options'),
        gitStage: invoke('git:stage', 'workspaceId', 'paths'),
        gitUnstage: invoke('git:unstage', 'workspaceId', 'paths'),
        gitDiscard: invoke('git:discard', 'workspaceId', 'paths'),
        gitCommit: invoke('git:commit', 'workspaceId', 'payload'),
        gitPush: invoke('git:push', 'workspaceId', 'payload'),
        gitListBranches: invoke('git:list-branches', 'workspaceId'),
        gitSwitchBranch: invoke('git:switch-branch', 'workspaceId', 'name'),
        gitCreateBranch: invoke('git:create-branch', 'workspaceId', 'name', 'startPoint'),
        gitCommitGraph: invoke('git:commit-graph', 'workspaceId', 'options'),
        gitChangeSummary: invoke('git:change-summary', 'workspaceId'),
        gitRevealPath: invoke('git:reveal-path', 'workspaceId', 'relPath'),
        // 仓库变了（文件改动、暂存、提交、切分支……）；只推给用 subscribeMainState('git.status', workspaceId) 订阅了的窗口
        onGitChanged: on('git:changed'),

        // 源码侧栏（工作区列表复用 gitListWorkspaces）
        sourceListFiles: invoke('source:list-files', 'workspaceId'),
        sourceReadFile: invoke('source:read-file', 'workspaceId', 'relPath'),
        sourceWriteFile: invoke('source:write-file', 'workspaceId', 'relPath', 'payload'),
        sourceCheck: invoke('source:check', 'relPath', 'text'),
    },
};