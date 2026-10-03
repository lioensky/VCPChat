'use strict';
const path = require('node:path');
const { ipcMain } = require('electron');
const { createApplicationSenderGuard } = require('./applicationSender');
const { createPluginSettingsService } = require('../services/pluginSettingsService');

function initialize({ mainWindow, settingsManager, getRuntime }) {
    const allowed = createApplicationSenderGuard({ getMainWebContents: () => mainWindow?.webContents });
    const service = createPluginSettingsService({ root: path.resolve(__dirname, '../..'), readSettings: () => settingsManager.readSettings(), getRuntime });
    const handler = fn => async (event, data) => {
        if (!allowed(event)) return { success: false, error: '此页面无权管理插件' };
        try { return { success: true, data: await fn(data || {}) }; }
        catch (error) { return { success: false, error: error.message.includes('fetch') ? '无法连接 VCPToolBox 管理端，请检查服务器连接' : error.message }; }
    };
    ipcMain.handle('plugin-settings:list', handler(data => service.list(data.category)));
    ipcMain.handle('plugin-settings:detail', handler(data => service.detail(data.category, data.id)));
    ipcMain.handle('plugin-settings:toggle', handler(data => service.toggle(data)));
    ipcMain.handle('plugin-settings:save', handler(data => service.save(data)));
    ipcMain.handle('plugin-settings:connect', handler(data => service.connect(data)));
    ipcMain.handle('plugin-settings:disconnect', handler(() => service.disconnect()));
    mainWindow?.webContents?.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) service.disconnect(); });
    mainWindow?.once('closed', () => service.disconnect());
}
module.exports = { initialize };
