'use strict';

// 插件：插件管理器窗口（清单、config.env、启停、打开目录），以及主窗口加载已启用的前端插件。
// 主进程：modules/ipc/desktopHandlers.js（plugin-manager-*、list-enabled-frontend-plugins）
// 渲染端：PluginManagerModules/、VCPDistributedServer/frontend-plugin-loader.js
const { invoke } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/desktopHandlers.js'],
    roles: ['utility'],
    api: {
        pluginManagerListPlugins: invoke('plugin-manager-list-plugins'),
        pluginManagerSaveManifest: invoke('plugin-manager-save-manifest', 'data'),
        pluginManagerSaveConfigEnv: invoke('plugin-manager-save-config-env', 'data'),
        pluginManagerSetPluginEnabled: invoke('plugin-manager-set-plugin-enabled', 'data'),
        pluginManagerOpenPluginFolder: invoke('plugin-manager-open-plugin-folder', 'data'),

        listEnabledFrontendPlugins: invoke('list-enabled-frontend-plugins').roles('chat'),
    },
};