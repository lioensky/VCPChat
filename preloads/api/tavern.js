'use strict';

// VCPChatTarven（高级回复）：回复规则的读取、保存与单条启停。
// 主进程：modules/ipc/tavernHandlers.js
// 渲染端：Tavernmodules/
const { invoke } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/tavernHandlers.js'],
    roles: ['chat'],
    api: {
        tavernGetRules: invoke('tavern:get-rules'),
        tavernSaveRules: invoke('tavern:save-rules', 'store'),
        tavernSetRuleEnabled: invoke('tavern:set-rule-enabled', 'ruleId', 'enabled'),
    },
};