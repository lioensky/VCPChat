'use strict';

// 群聊：群组管理、群话题、群聊记录、发言调度（邀请/重做/中断），以及 JEV 智能群聊。
// 主进程：modules/ipc/groupChatHandlers.js、modules/ipc/chatHandlers.js（save-group-topic-order）、main.js（jev:*、interrupt-group-request）
const { invoke, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/groupChatHandlers.js', 'modules/ipc/chatHandlers.js', 'main.js'],
    roles: ['chat'],
    api: {
        // 群组
        createAgentGroup: invoke('create-agent-group', 'groupName', 'initialConfig'),
        getAgentGroups: invoke('get-agent-groups'),
        getAgentGroupConfig: invoke('get-agent-group-config', 'groupId'),
        saveAgentGroupConfig: invoke('save-agent-group-config', 'groupId', 'configData'),
        deleteAgentGroup: invoke('delete-agent-group', 'groupId'),
        saveAgentGroupAvatar: invoke('save-agent-group-avatar', 'groupId', 'avatarData'),

        // 群话题
        getGroupTopics: invoke('get-group-topics', 'groupId', 'searchTerm'),
        createNewTopicForGroup: invoke('create-new-topic-for-group', 'groupId', 'topicName'),
        deleteGroupTopic: invoke('delete-group-topic', 'groupId', 'topicId'),
        saveGroupTopicTitle: invoke('save-group-topic-title', 'groupId', 'topicId', 'newTitle'),
        regenerateGroupTopicTitle: invoke('regenerate-group-topic-title', 'groupId', 'topicId'),
        saveGroupTopicOrder: invoke('save-group-topic-order', 'groupId', 'orderedTopicIds'),
        onVCPGroupTopicUpdated: on('vcp-group-topic-updated'),

        // 群聊记录与发言
        getGroupChatHistory: invoke('get-group-chat-history', 'groupId', 'topicId'),
        saveGroupChatHistory: invoke('save-group-chat-history', 'groupId', 'topicId', 'history'),
        sendGroupChatMessage: invoke('send-group-chat-message', 'groupId', 'topicId', 'userMessage'),
        inviteAgentToSpeak: invoke('inviteAgentToSpeak', 'groupId', 'topicId', 'invitedAgentId'),
        redoGroupChatMessage: invoke('redo-group-chat-message', 'groupId', 'topicId', 'messageId', 'agentId'),
        // 中断单条正在生成的回复
        interruptGroupRequest: invoke('interrupt-group-request', 'messageId'),
        // 停止后续排队发言，当前正在生成的回复继续完成
        interruptGroupChatQueue: invoke('interrupt-group-chat-queue', 'groupId', 'topicId'),

        // JEV 智能群聊
        startJevGroupChat: invoke('start-jev-group-chat', 'groupId', 'topicId'),
        continueJevGroupChat: invoke('continue-jev-group-chat', 'groupId', 'topicId'),
        enqueueJevGroupAgent: invoke('enqueue-jev-group-agent', 'groupId', 'topicId', 'agentId'),
        getJevGroupChatState: invoke('get-jev-group-chat-state', 'groupId', 'topicId'),
        getJevStatus: invoke('jev:get-status'),
        decideWithJev: invoke('jev:decide', (state, questions) => [{ state, questions }]),
    },
};