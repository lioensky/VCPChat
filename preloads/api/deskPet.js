'use strict';

// 桌宠：从当前 agent 打开/关闭桌宠窗口。
// 主进程：modules/ipc/deskPetHandlers.js
const { invoke, on, send } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/deskPetHandlers.js'],
    roles: ['chat'],
    api: {
        toggleDeskPet: invoke('deskpet:toggle', 'agentId'),
        getDeskPetOpenAgents: invoke('deskpet:get-open-agents'),
        onDeskPetStateChanged: on('deskpet:state-changed'),
        // 桌宠上输入的话由主窗口按正常流程发送；结果回给主进程。
        onDeskPetSendRequest: on('deskpet:send-request'),
        deskPetSendResult: send('deskpet:send-result', 'payload'),
        // 闲时主动搭话写话题前问一声：主窗口现在开着哪个话题
        onDeskPetWhereRequest: on('deskpet:where-request'),
        deskPetWhereResult: send('deskpet:where-result', 'payload'),
        // 点桌宠上 AI 主动开的新话题：切到那个话题。
        onDeskPetOpenTopic: on('deskpet:open-topic'),
        // 工具审批：待批的转给桌宠一份，答完（任何一边）告诉桌宠收起；桌宠上点的允许/拒绝回到这里应答。
        deskPetApprovalOffer: send('deskpet:approval-offer', 'payload'),
        deskPetApprovalSettled: send('deskpet:approval-settled', 'requestId'),
        onDeskPetApprovalAnswer: on('deskpet:approval-answer'),
        // 桌宠上点了停止：中止那条回复
        onDeskPetInterrupt: on('deskpet:interrupt-request'),
        // 全局设置 → 桌宠（modules/settings/schema/deskpet-panel.js）；主进程：modules/deskpet/settingsPage.js、petControls.js
        onDeskPetSettingsOpen: on('deskpet-settings:open'),
        onDeskPetSettingsChanged: on('deskpet-settings:changed'),
        onDeskPetPreview: on('deskpet-settings:preview'),
        getDeskPetSettings: invoke('deskpet-settings:get'),
        getDeskPetCatalog: invoke('deskpet-settings:catalog', 'agentId'),
        refreshDeskPetCatalog: invoke('deskpet-settings:refresh', 'agentId'),
        chooseDeskPetOutfit: invoke('deskpet-settings:choose', 'agentId', 'outfitId'),
        setDeskPetsVisible: invoke('deskpet-settings:set-visible', 'visible', 'agentId'),
        importDeskPetOutfit: invoke('deskpet-settings:import', 'agentId', 'files'),
        openDeskPetFolder: invoke('deskpet-settings:open-folder', 'agentId'),
        installDeskPetCore: invoke('deskpet-settings:core-install', 'source', 'agentId'),
        openDeskPetCoreLink: invoke('deskpet-settings:core-link', 'which'),
        onDeskPetCoreProgress: on('deskpet-settings:core-progress'),
        getDeskPetMapping: invoke('deskpet-settings:mapping', 'agentId', 'outfitId'),
        applyDeskPetMapping: invoke('deskpet-settings:mapping-apply', 'agentId', 'outfitId', 'mapping', 'options'),
        talkToDeskPet: invoke('deskpet-settings:talk', 'agentId', 'text', 'options'),
        updateDeskPetSettings: invoke('deskpet-settings:update', 'patch'),
        setDeskPetShortcut: invoke('deskpet-settings:set-shortcut', 'actionId', 'accelerator'),
        resetDeskPetShortcuts: invoke('deskpet-settings:reset-shortcuts'),
        pauseDeskPetShortcuts: invoke('deskpet-settings:pause-shortcuts', 'paused'),
        setDeskPetScale: invoke('deskpet-settings:set-scale', 'agentId', 'scale'),
    },
};
