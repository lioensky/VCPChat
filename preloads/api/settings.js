'use strict';

// 全局设置、用户头像、翻译器设置。
// 主进程：modules/ipc/settingsHandlers.js、modules/ipc/agentHandlers.js（saveUserAvatar）、modules/ipc/translatorHandlers.js
const { invoke, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/settingsHandlers.js', 'modules/ipc/agentHandlers.js', 'modules/ipc/translatorHandlers.js'],
    roles: ['chat', 'utility'],
    api: {
        loadSettings: invoke('load-settings'),
        saveSettings: invoke('save-settings', 'settings'),
        onSettingsExternalUpdated: on('settings-external-updated').roles('chat'),
        loadWebindexModels: invoke('load-webindex-models').roles('chat'),

        saveUserAvatar: invoke('save-user-avatar', 'avatarData'),
        saveAvatarColor: invoke('save-avatar-color', 'data'),

        loadTranslatorSettings: invoke('load-translator-settings').roles('utility'),
        saveTranslatorSettings: invoke('save-translator-settings', 'settings').roles('utility'),
        openTranslatorWindow: invoke('open-translator-window', 'theme'),
    },
};