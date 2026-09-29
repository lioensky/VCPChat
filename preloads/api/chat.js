'use strict';

// 单聊：话题、聊天记录、发送与流式事件、附件（粘贴/拖拽/选择）、聊天记录文件监听。
// 主进程：modules/ipc/chatHandlers.js、main.js（export-topic-as-markdown、watcher:*）、modules/ipc/musicHandlers.js（add-file-to-input）
const { invoke, on, onSignal } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/chatHandlers.js', 'main.js'],
    roles: ['chat'],
    api: {
        // 话题
        getAgentTopics: invoke('get-agent-topics', 'agentId'),
        createNewTopicForAgent: invoke('create-new-topic-for-agent', 'agentId', 'topicName', 'isBranch', 'locked'),
        saveAgentTopicTitle: invoke('save-agent-topic-title', 'agentId', 'topicId', 'newTitle'),
        regenerateAgentTopicTitle: invoke('regenerate-agent-topic-title', 'agentId', 'topicId'),
        deleteTopic: invoke('delete-topic', 'agentId', 'topicId'),
        toggleTopicLock: invoke('toggle-topic-lock', 'agentId', 'topicId'),
        setTopicUnread: invoke('set-topic-unread', 'agentId', 'topicId', 'unread'),
        getUnreadTopicCounts: invoke('get-unread-topic-counts'),
        saveTopicOrder: invoke('save-topic-order', 'agentId', 'orderedTopicIds'),
        searchTopicsByContent: invoke('search-topics-by-content', 'itemId', 'itemType', 'searchTerm'),
        exportTopicAsMarkdown: invoke('export-topic-as-markdown', 'exportData'),
        onCreateUnlockedTopic: onSignal('create-unlocked-topic'),

        // 聊天记录
        getChatHistory: invoke('get-chat-history', 'agentId', 'topicId'),
        saveChatHistory: invoke('save-chat-history', 'agentId', 'topicId', 'history'),
        getOriginalMessageContent: invoke('get-original-message-content', 'itemId', 'itemType', 'topicId', 'messageId'),
        onHistoryFileUpdated: on('history-file-updated'),

        // 聊天记录文件监听：watcherBegin 取得租约，start/stop 携带租约令牌；令牌缺省为 null
        watcherBegin: invoke('watcher:begin'),
        watcherStart: invoke('watcher:start', (filePath, agentId, topicId, leaseToken = null) => [filePath, agentId, topicId, leaseToken]).roles('chat', 'utility'),
        watcherStop: invoke('watcher:stop', (leaseToken = null) => [leaseToken]).roles('chat', 'utility'),

        // 发送与流式响应
        sendToVCP: invoke('send-to-vcp', 'vcpUrl', 'vcpApiKey', 'messages', 'modelConfig', 'messageId', 'isGroupCall', 'context'),
        onVCPStreamEvent: on('vcp-stream-event'),
        onVCPStreamChunk: on('vcp-stream-chunk'),
        interruptVcpRequest: invoke('interrupt-vcp-request', 'data'),

        // 附件
        handleFilePaste: invoke('handle-file-paste', 'agentId', 'topicId', 'fileData'),
        handleTextPasteAsFile: invoke('handle-text-paste-as-file', 'agentId', 'topicId', 'textContent'),
        handleFileDrop: invoke('handle-file-drop', 'agentId', 'topicId', 'droppedFilesData').roles('chat', 'desktop'),
        selectFilesToSend: invoke('select-files-to-send', 'agentId', 'topicId'),
        onAddFileToInput: on('add-file-to-input'),
    },
};