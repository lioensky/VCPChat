'use strict';
const { invoke } = require('../core/define');
module.exports = {
    handlers: ['modules/ipc/pluginSettingsHandlers.js'],
    roles: ['chat'],
    api: {
        pluginSettingsList: invoke('plugin-settings:list', 'data'),
        pluginSettingsDetail: invoke('plugin-settings:detail', 'data'),
        pluginSettingsToggle: invoke('plugin-settings:toggle', 'data'),
        pluginSettingsSave: invoke('plugin-settings:save', 'data'),
        pluginSettingsConnect: invoke('plugin-settings:connect', 'data'),
        pluginSettingsDisconnect: invoke('plugin-settings:disconnect'),
    },
};
