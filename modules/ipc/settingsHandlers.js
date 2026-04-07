// modules/ipc/settingsHandlers.js
const { ipcMain, nativeTheme } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const themeHandlers = require('./themeHandlers');

/**
 * Initializes settings and theme related IPC handlers.
 * @param {object} paths - An object containing required paths.
 * @param {string} paths.SETTINGS_FILE - The path to the settings.json file.
 * @param {string} paths.USER_AVATAR_FILE - The path to the user_avatar.png file.
 * @param {string} paths.AGENT_DIR - The path to the agents directory.
 * @param {object} paths.settingsManager - The AppSettingsManager instance.
 */
function initialize(paths) {
    const { SETTINGS_FILE, USER_AVATAR_FILE, AGENT_DIR, settingsManager, agentConfigManager } = paths;
    const WEBINDEX_MODEL_FILE = path.join(path.dirname(SETTINGS_FILE), 'webindexmodel.json');

    // Settings Management
    ipcMain.handle('load-settings', async () => {
        try {
            const settings = await settingsManager.readSettings();
            
            // Check for user avatar
            if (await fs.pathExists(USER_AVATAR_FILE)) {
                settings.userAvatarUrl = `file://${USER_AVATAR_FILE}?t=${Date.now()}`;
            } else {
                settings.userAvatarUrl = null; // Or a default path
            }
            
            return settings;
        } catch (error) {
            console.error('加载设置失败:', error);
            return {
                error: error.message,
                sidebarWidth: 260,
                notificationsSidebarWidth: 300,
                userAvatarUrl: null,
                enableDistributedServerLogs: false // 修复：确保错误情况下也有默认值
            };
        }
    });

    ipcMain.handle('save-settings', async (event, settings) => {
        try {
            // User avatar URL is handled by 'save-user-avatar', remove it from general settings to avoid saving a file path
            // Also protect order fields from being accidentally overwritten by stale renderer snapshots.
            const {
                userAvatarUrl,
                combinedItemOrder,
                agentOrder,
                ...settingsToSave
            } = settings;

            // 确保 flowlockContinueDelay 是一个有效的数字
            if (typeof settingsToSave.flowlockContinueDelay !== 'number' || isNaN(settingsToSave.flowlockContinueDelay)) {
                settingsToSave.flowlockContinueDelay = 5; // 如果无效，则设置为默认值
            }

            // 确保必需的默认字段存在
            if (settingsToSave.enableDistributedServerLogs === undefined) {
                settingsToSave.enableDistributedServerLogs = false;
            }

            const result = await settingsManager.updateSettings(settingsToSave);
            return result;
        } catch (error) {
            console.error('保存设置失败:', error);
            return { success: false, error: error.message };
        }
    });

    // New IPC Handler to save calculated avatar color
    ipcMain.handle('save-avatar-color', async (event, { type, id, color }) => {
        try {
            if (type === 'user') {
                const result = await settingsManager.updateSettings(settings => ({
                    ...settings,
                    userAvatarCalculatedColor: color
                }));
                console.log(`[Main] User avatar color saved: ${color}`);
                return result;
            } else if (type === 'agent' && id) {
                if (agentConfigManager) {
                    const result = await agentConfigManager.updateAgentConfig(id, config => ({
                        ...config,
                        avatarCalculatedColor: color
                    }));
                    console.log(`[Main] Agent ${id} avatar color saved: ${color}`);
                    return result;
                } else {
                    // 回退到原来的方式（为了兼容性）
                    const configPath = path.join(AGENT_DIR, id, 'config.json');
                    if (await fs.pathExists(configPath)) {
                        let agentConfig;
                        // 修复：如果解析失败，应抛出错误而不是创建一个不完整的对象
                        // 这可以防止意外覆盖整个配置文件
                        try {
                            agentConfig = await fs.readJson(configPath);
                        } catch (parseError) {
                            console.error(`[Main] Error parsing agent config for ${id} to save avatar color:`, parseError);
                            return { success: false, error: `Failed to read agent config for ${id}: ${parseError.message}` };
                        }
                        
                        agentConfig.avatarCalculatedColor = color;
                        
                        // 使用安全的文件写入方式
                        const tempConfigPath = configPath + '.tmp';
                        await fs.writeJson(tempConfigPath, agentConfig, { spaces: 2 });
                        
                        // 验证写入的文件是否正确
                        const verifyContent = await fs.readFile(tempConfigPath, 'utf8');
                        JSON.parse(verifyContent);
                        
                        // 如果验证成功，再重命名为正式文件
                        await fs.move(tempConfigPath, configPath, { overwrite: true });
                        
                        console.log(`[Main] Agent ${id} avatar color saved: ${color}`);
                        return { success: true };
                    } else {
                        return { success: false, error: `Agent config for ${id} not found.` };
                    }
                }
            }
            return { success: false, error: 'Invalid type or missing ID for saving avatar color.' };
        } catch (error) {
            console.error('Error saving avatar color:', error);
            
            // 清理可能存在的临时文件 for agent (只在没有agentConfigManager时需要)
            if (type === 'agent' && id && !agentConfigManager) {
                const tempConfigPath = path.join(AGENT_DIR, id, 'config.json') + '.tmp';
                if (await fs.pathExists(tempConfigPath)) {
                    await fs.remove(tempConfigPath).catch(() => {});
                }
            }
            
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('load-webindex-models', async () => {
        try {
            if (!await fs.pathExists(WEBINDEX_MODEL_FILE)) {
                return {
                    success: true,
                    exists: false,
                    path: WEBINDEX_MODEL_FILE,
                    models: []
                };
            }

            const payload = await fs.readJson(WEBINDEX_MODEL_FILE);
            return {
                success: true,
                exists: true,
                path: WEBINDEX_MODEL_FILE,
                models: Array.isArray(payload?.models) ? payload.models : [],
                updatedAt: payload?.updatedAt || null,
                source: payload?.source || 'unknown'
            };
        } catch (error) {
            console.error('读取 webindexmodel.json 失败:', error);
            return { success: false, error: error.message, path: WEBINDEX_MODEL_FILE, models: [] };
        }
    });

    // Theme control
    ipcMain.on('set-theme', async (event, theme) => {
        if (theme === 'light' || theme === 'dark') {
            nativeTheme.themeSource = theme;
            console.log(`[Main] Theme source explicitly set to: ${theme}`);
            
            try {
                const result = await settingsManager.updateSettings(settings => ({
                    ...settings,
                    currentThemeMode: theme,
                    themeLastUpdated: Date.now()
                }));
                console.log(`[Main] Settings.json safely updated: currentThemeMode=${theme}, themeLastUpdated=${Date.now()}`);
                themeHandlers.broadcastThemeUpdate(theme);
            } catch (error) {
                console.error('[Main] Error updating settings.json for theme change:', error);
                console.error('[Main] Theme change in nativeTheme was successful, but settings.json update failed');
                themeHandlers.broadcastThemeUpdate(theme);
            }
        }
    });
    
    // recoverSettingsFromCorruptedFile 已由 SettingsManager 处理，无需此函数
}

module.exports = {
    initialize
};