'use strict';

// 划词小助手：划词监听开关、助手浮条、Rust 助手引擎配置与运行状态。
// 主进程：modules/ipc/assistantHandlers.js
const { invoke, send, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/assistantHandlers.js'],
    roles: ['chat'],
    api: {
        toggleSelectionListener: send('toggle-selection-listener', 'enable').roles('chat', 'utility'),
        getSelectionListenerStatus: invoke('get-selection-listener-status').roles('chat', 'utility'),
        suspendAssistantListener: invoke('assistant-suspend-listener', 'durationMs'),
        getAssistantRuntimeStatus: invoke('get-assistant-runtime-status'),
        getRustAssistantConfig: invoke('get-rust-assistant-config'),
        saveRustAssistantConfig: invoke('save-rust-assistant-config', 'configPatch'),

        assistantAction: send('assistant-action', 'action'),
        closeAssistantBar: send('close-assistant-bar'),
        getAssistantBarInitialData: invoke('get-assistant-bar-initial-data'),
        onAssistantBarData: on('assistant-bar-data'),
        onAssistantData: on('assistant-data'),
    },
};