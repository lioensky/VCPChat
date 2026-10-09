'use strict';

// Agent 管理与模型列表：Agent 增删改、头像、排序、模型缓存与收藏、论坛/文脉用的 Agent 元数据。
// 主进程：modules/ipc/agentHandlers.js、modules/ipc/fileDialogHandlers.js（select-avatar）、main.js（模型相关）
const { invoke, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/agentHandlers.js', 'modules/ipc/fileDialogHandlers.js', 'main.js'],
    roles: ['chat'],
    api: {
        getAgents: invoke('get-agents'),
        getAgentConfig: invoke('get-agent-config', 'agentId'),
        saveAgentConfig: invoke('save-agent-config', 'agentId', 'config'),
        createAgent: invoke('create-agent', 'agentName', 'initialConfig'),
        deleteAgent: invoke('delete-agent', 'agentId'),
        selectAvatar: invoke('select-avatar'),
        saveAvatar: invoke('save-avatar', 'agentId', 'avatarData'),
        getAgentPortraits: invoke('get-agent-portraits', 'agentId'),
        saveAgentPortrait: invoke('save-agent-portrait', 'agentId', 'variant', 'imageData'),
        removeAgentPortrait: invoke('remove-agent-portrait', 'agentId', 'variant'),
        onReloadAgentSettings: on('reload-agent-settings'),
        getAgentsMetadata: invoke('get-agents-metadata').roles('utility'),

        // 侧栏中 Agent 与群组的混合列表及排序
        getAllItems: invoke('get-all-items'),
        saveAgentOrder: invoke('save-agent-order', 'orderedAgentIds'),
        saveCombinedItemOrder: invoke('save-combined-item-order', 'orderedItemsWithTypes'),

        // 模型列表
        getCachedModels: invoke('get-cached-models'),
        refreshModels: invoke('refresh-models'),
        getHotModels: invoke('get-hot-models'),
        getFavoriteModels: invoke('get-favorite-models'),
        toggleFavoriteModel: invoke('toggle-favorite-model', 'modelId'),
        onModelsUpdated: on('models-updated'),
    },
};