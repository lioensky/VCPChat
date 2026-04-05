// modules/ipc/agentHandlers.js
const { ipcMain } = require('electron');
const fs = require('fs-extra');
const path = require('path');

let AGENT_DIR_CACHE; // Cache the agent directory path
let USER_DATA_DIR_CACHE; // Cache the user data directory path
let AVATAR_IMAGE_DIR; // Centralized avatar storage directory
let agentConfigManagerInstance; // Cache the agentConfigManager instance
let cachedAgents = null; // Memory cache for full agent list
let cachedMetadata = null; // Memory cache for lightweight metadata list

function invalidateCaches() {
    console.log('[agentHandlers] Invalidating agent caches.');
    cachedAgents = null;
    cachedMetadata = null;
}

async function getAgentConfigById(agentId) {
    if (!AGENT_DIR_CACHE) {
        console.error("agentHandlers not initialized with AGENT_DIR. Cannot get agent config.");
        return { error: "Agent handler not initialized." };
    }
    const agentDir = path.join(AGENT_DIR_CACHE, agentId);
    const configPath = path.join(agentDir, 'config.json');
    const regexPath = path.join(agentDir, 'regex_rules.json');

    // 优先使用 agentConfigManager 读取，以获得锁保护和缓存支持
    let config;
    try {
        if (agentConfigManagerInstance) {
            config = await agentConfigManagerInstance.readAgentConfig(agentId);
        } else if (await fs.pathExists(configPath)) {
            config = await fs.readJson(configPath);
        }
    } catch (e) {
        console.error(`Error reading config for agent ${agentId}:`, e);
        return { error: `读取 Agent 配置失败: ${e.message}` };
    }

    if (config) {
        // Check for external regex rules file
        if (await fs.pathExists(regexPath)) {
            try {
                config.stripRegexes = await fs.readJson(regexPath);
            } catch (e) {
                console.error(`Error reading regex_rules.json for agent ${agentId}:`, e);
                // Keep stripRegexes from config.json as a fallback
            }
        }

        const avatarPathPng = path.join(agentDir, 'avatar.png');
        const avatarPathJpg = path.join(agentDir, 'avatar.jpg');
        const avatarPathJpeg = path.join(agentDir, 'avatar.jpeg');
        const avatarPathGif = path.join(agentDir, 'avatar.gif');
        config.avatarUrl = null;
        if (await fs.pathExists(avatarPathPng)) {
            config.avatarUrl = `file://${avatarPathPng}?t=${Date.now()}`;
        } else if (await fs.pathExists(avatarPathJpg)) {
            config.avatarUrl = `file://${avatarPathJpg}?t=${Date.now()}`;
        } else if (await fs.pathExists(avatarPathJpeg)) {
            config.avatarUrl = `file://${avatarPathJpeg}?t=${Date.now()}`;
        } else if (await fs.pathExists(avatarPathGif)) {
            config.avatarUrl = `file://${avatarPathGif}?t=${Date.now()}`;
        }
        config.id = agentId;
        // 注入正确的用户数据目录路径，而不是Agent定义目录
        config.agentDataPath = path.join(AGENT_DIR_CACHE.replace('Agents', 'UserData'), agentId);
        return config;
    }
    return { error: `Agent config for ${agentId} not found.` };
}


/**
 * Initializes agent management related IPC handlers.
 * @param {object} context - An object containing necessary context.
 * @param {string} context.AGENT_DIR - The path to the agents directory.
 * @param {string} context.USER_DATA_DIR - The path to the user data directory.
 * @param {string} context.SETTINGS_FILE - The path to the settings.json file.
 * @param {string} context.USER_AVATAR_FILE - The path to the user avatar file.
 * @param {function} context.getSelectionListenerStatus - Function to get the current status of the selection listener.
 * @param {function} context.stopSelectionListener - Function to stop the selection listener.
 * @param {function} context.startSelectionListener - Function to start the selection listener.
 * @param {object} context.settingsManager - The AppSettingsManager instance.
 */
function initialize(context) {
    const { AGENT_DIR, USER_DATA_DIR, SETTINGS_FILE, USER_AVATAR_FILE, settingsManager, agentConfigManager } = context;
    AGENT_DIR_CACHE = AGENT_DIR; // Cache the directory path
    USER_DATA_DIR_CACHE = USER_DATA_DIR; // Cache the user data directory path
    agentConfigManagerInstance = agentConfigManager; // Cache the manager instance

    // Calculate the centralized avatar directory path based on the structure used in getGroupsInternal
    // Assuming USER_DATA_DIR is inside a structure like .../VCPChat/UserData
    // Correcting path calculation based on user feedback (assuming path.dirname(USER_DATA_DIR) already points to the AppData root)
    const appDataRoot = path.dirname(USER_DATA_DIR);
    AVATAR_IMAGE_DIR = path.join(appDataRoot, 'avatarimage');

    ipcMain.handle('get-agents-metadata', async () => {
        if (cachedMetadata) return cachedMetadata;
        
        try {
            const agents = await ipcMain.invoke('get-agents');
            if (agents.error) return agents;
            
            cachedMetadata = agents.map(a => ({
                id: a.id,
                name: a.name,
                avatarUrl: a.avatarUrl,
                avatarCalculatedColor: a.config?.avatarCalculatedColor
            }));
            return cachedMetadata;
        } catch (error) {
            return { error: error.message };
        }
    });

    ipcMain.handle('get-agents', async () => {
        if (cachedAgents) return cachedAgents;

        try {
            const agentFolders = await fs.readdir(AGENT_DIR);
            const agentResults = await Promise.all(agentFolders.map(async (folderName) => {
                const agentPath = path.join(AGENT_DIR, folderName);
                const stat = await fs.stat(agentPath);
                if (!stat.isDirectory()) return null;

                const configPath = path.join(agentPath, 'config.json');
                const avatarExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
                
                let agentData = { id: folderName, name: folderName, avatarUrl: null, config: {} };

                if (await fs.pathExists(configPath)) {
                    let config;
                    try {
                        if (agentConfigManager) {
                            config = await agentConfigManager.readAgentConfig(folderName);
                        } else {
                            config = await fs.readJson(configPath);
                        }
                    } catch (readError) {
                        console.error(`[agentHandlers] Skipping corrupted agent ${folderName}:`, readError);
                        return null;
                    }

                    // Load external regex rules if they exist
                    const regexPath = path.join(agentPath, 'regex_rules.json');
                    if (await fs.pathExists(regexPath)) {
                        try {
                            config.stripRegexes = await fs.readJson(regexPath);
                        } catch (e) {
                            console.error(`Error reading regex_rules.json for agent ${folderName}:`, e);
                        }
                    }

                    agentData.name = config.name || folderName;
                    agentData.config = config;
                    agentData.topics = (config.topics && Array.isArray(config.topics) && config.topics.length > 0)
                        ? config.topics
                        : [{ id: "default", name: "主要对话", createdAt: Date.now() }];
                    
                    // Inject correct paths
                    agentData.config.id = folderName;
                    agentData.config.agentDataPath = path.join(AGENT_DIR, '..', 'UserData', folderName);
                } else {
                    // Default config for missing config.json
                    agentData.topics = [{ id: "default", name: "主要对话", createdAt: Date.now() }];
                    agentData.config = {
                        name: folderName,
                        topics: agentData.topics,
                        systemPrompt: `你是 ${folderName}。`,
                        model: '',
                        temperature: 0.7,
                        contextTokenLimit: 4000,
                        maxOutputTokens: 1000,
                        disableCustomColors: true,
                        useThemeColorsInChat: true
                    };
                }

                // Avatar detection (Parallelize if many, but 4-5 is fine)
                for (const ext of avatarExtensions) {
                    const avatarPath = path.join(agentPath, `avatar${ext}`);
                    if (await fs.pathExists(avatarPath)) {
                        agentData.avatarUrl = `file://${avatarPath}`;
                        break;
                    }
                }

                return agentData;
            }));

            let agents = agentResults.filter(Boolean);

            let settings = {};
            try {
                settings = await settingsManager.readSettings();
            } catch (readError) {
                console.warn('Could not read settings for agent order:', readError);
            }

            if (settings.agentOrder && Array.isArray(settings.agentOrder)) {
                const orderedAgents = [];
                const agentMap = new Map(agents.map(agent => [agent.id, agent]));
                settings.agentOrder.forEach(id => {
                    if (agentMap.has(id)) {
                        orderedAgents.push(agentMap.get(id));
                        agentMap.delete(id);
                    }
                });
                orderedAgents.push(...agentMap.values());
                agents = orderedAgents;
            } else {
                agents.sort((a, b) => a.name.localeCompare(b.name));
            }
            
            cachedAgents = agents;
            return agents;
        } catch (error) {
            console.error('获取Agent列表失败:', error);
            return { error: error.message };
        }
    });

    ipcMain.handle('save-combined-item-order', async (event, orderedItemsWithTypes) => {
        try {
            const result = await settingsManager.updateSettings(settings => ({
                ...settings,
                combinedItemOrder: orderedItemsWithTypes
            }));
            return result;
        } catch (error) {
            console.error('Error saving combined item order:', error);
            return { success: false, error: error.message || '保存项目顺序时发生未知错误' };
        }
    });

    ipcMain.handle('save-agent-order', async (event, orderedAgentIds) => {
        try {
            const result = await settingsManager.updateSettings(settings => ({
                ...settings,
                agentOrder: orderedAgentIds
            }));
            invalidateCaches();
            return result;
        } catch (error) {
            console.error('Error saving agent order:', error);
            return { success: false, error: error.message || '保存Agent顺序时发生未知错误' };
        }
    });

    ipcMain.handle('get-agent-config', (event, agentId) => {
        // Now this handler simply calls the exported function
        return getAgentConfigById(agentId);
    });

    ipcMain.handle('save-agent-config', async (event, agentId, config) => {
        try {
            const agentDir = path.join(AGENT_DIR, agentId);
            await fs.ensureDir(agentDir);
            const regexPath = path.join(agentDir, 'regex_rules.json');

            // Handle stripRegexes separately if the property exists in the incoming config
            if (config.hasOwnProperty('stripRegexes')) {
                let stripRegexes = config.stripRegexes;
                if (Array.isArray(stripRegexes) && stripRegexes.length > 0) {
                    // 终极修复：在保存到JSON之前，手动“解毒”正则表达式字符串。
                    // fs.writeJson 会自动转义 \，导致 \\ -> \\\\。
                    // 我们在这里进行一次反向操作，将 \\ 变回 \，这样经过 fs.writeJson 的转义后，文件里就是正确的 \\。
                    const cleanedRegexes = stripRegexes.map(rule => {
                        if (rule.findPattern && typeof rule.findPattern === 'string') {
                            // 将 \\ 替换为 \，为 fs.writeJson 的自动转义做准备
                            rule.findPattern = rule.findPattern.replace(/\\\\/g, '\\');
                        }
                        return rule;
                    });

                    // 使用清理过的数据进行保存
                    await fs.writeJson(regexPath, cleanedRegexes, { spaces: 2 });
                } else {
                    // If the array is empty or not an array, remove the regex file if it exists
                    if (await fs.pathExists(regexPath)) {
                        await fs.remove(regexPath);
                    }
                }
            }

            // CRITICAL: Always remove stripRegexes from the object to be saved to config.json
            const configToSave = { ...config };
            delete configToSave.stripRegexes;

            if (agentConfigManager) {
                // 使用AgentConfigManager进行安全的配置更新
                const result = await agentConfigManager.updateAgentConfig(agentId, existingConfig => ({
                    ...existingConfig,
                    ...configToSave
                }));
                invalidateCaches();
                return { success: true, message: `Agent ${agentId} 配置已保存。` };
            } else {
                // AgentConfigManager 不可用，报错而非静默 fallback
                console.error(`AgentConfigManager not available, cannot safely save config for agent ${agentId}`);
                return { error: 'AgentConfigManager 未初始化，无法安全保存配置。' };
            }
        } catch (error) {
            console.error(`保存Agent ${agentId} 配置失败:`, error);
            return { error: error.message };
        }
    });

    // 新增：更新Agent配置（部分更新）
    ipcMain.handle('update-agent-config', async (event, agentId, updates) => {
        try {
            if (agentConfigManager) {
                const result = await agentConfigManager.updateAgentConfig(agentId, existingConfig => ({
                    ...existingConfig,
                    ...updates
                }));
                invalidateCaches();
                return { success: true, message: `Agent ${agentId} 配置已更新。` };
            } else {
                // AgentConfigManager 不可用，报错而非静默 fallback
                console.error(`AgentConfigManager not available, cannot safely update config for agent ${agentId}`);
                return { error: 'AgentConfigManager 未初始化，无法安全更新配置。' };
            }
        } catch (error) {
            console.error(`更新Agent ${agentId} 配置失败:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('save-avatar', async (event, agentId, avatarData) => {
        const listenerWasActive = context.getSelectionListenerStatus();
        if (listenerWasActive) context.stopSelectionListener();
        try {
            if (!avatarData || !avatarData.name || !avatarData.type || !avatarData.buffer) {
                return { error: '保存头像失败：未提供有效的头像数据。' };
            }

            const agentDir = path.join(AGENT_DIR_CACHE, agentId);
            await fs.ensureDir(agentDir);

            // 1. 获取 Agent 配置（用于重命名头像文件）
            let agentConfig = {};
            try {
                if (agentConfigManager) {
                    // 这里也不允许返回默认配置，因为这是在操作已存在的 Agent
                    agentConfig = await agentConfigManager.readAgentConfig(agentId);
                } else {
                    const configPath = path.join(agentDir, 'config.json');
                    if (await fs.pathExists(configPath)) {
                        agentConfig = await fs.readJson(configPath);
                    }
                }
            } catch (e) {
                console.warn(`无法读取Agent ${agentId} 的配置以获取名称 (可能正在更新中):`, e);
                // 如果读取失败，尝试使用缓存或回退到 ID，但不覆盖文件
            }
            const agentName = agentConfig.name || agentId;


            let ext = path.extname(avatarData.name).toLowerCase();
            if (!ext) {
                if (avatarData.type === 'image/png') ext = '.png';
                else if (avatarData.type === 'image/jpeg') ext = '.jpg';
                else if (avatarData.type === 'image/gif') ext = '.gif';
                else if (avatarData.type === 'image/webp') ext = '.webp';
                else ext = '.png';
            }

            const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
            if (!allowedExtensions.includes(ext)) {
                return { error: `保存头像失败：不支持的文件类型/扩展名 "${ext}"。` };
            }

            // 2. 删除 Agent 目录下的旧头像
            const oldAvatars = [
                path.join(agentDir, 'avatar.png'),
                path.join(agentDir, 'avatar.jpg'),
                path.join(agentDir, 'avatar.gif'),
                path.join(agentDir, 'avatar.webp')
            ];

            for (const oldAvatarPath of oldAvatars) {
                if (await fs.pathExists(oldAvatarPath)) {
                    await fs.remove(oldAvatarPath);
                }
            }

            const newAvatarPath = path.join(agentDir, `avatar${ext}`);
            const nodeBuffer = Buffer.from(avatarData.buffer);

            // 3. 写入 Agent 目录下的新头像
            await fs.writeFile(newAvatarPath, nodeBuffer);

            // 4. 集中式头像存储逻辑
            if (AVATAR_IMAGE_DIR) {
                await fs.ensureDir(AVATAR_IMAGE_DIR);

                // 4a. 删除集中式目录中旧的、以 Agent 名称命名的头像文件
                const centralizedOldAvatars = allowedExtensions.map(e => path.join(AVATAR_IMAGE_DIR, `${agentName}${e}`));
                for (const oldAvatarPath of centralizedOldAvatars) {
                    if (await fs.pathExists(oldAvatarPath)) {
                        await fs.remove(oldAvatarPath);
                    }
                }

                // 4b. 写入集中式目录的新头像
                const centralizedNewAvatarPath = path.join(AVATAR_IMAGE_DIR, `${agentName}${ext}`);
                await fs.writeFile(centralizedNewAvatarPath, nodeBuffer);
            }

            invalidateCaches();
            return { success: true, avatarUrl: `file://${newAvatarPath}?t=${Date.now()}`, needsColorExtraction: true };
        } catch (error) {
            console.error(`保存Agent ${agentId} 头像失败:`, error);
            return { error: `保存头像失败: ${error.message}` };
        } finally {
            if (listenerWasActive) context.startSelectionListener();
        }
    });

    ipcMain.handle('create-agent', async (event, agentName, initialConfig = null) => {
        try {
            const baseName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
            const agentId = `${baseName}_${Date.now()}`;
            const agentDir = path.join(AGENT_DIR, agentId);

            if (await fs.pathExists(agentDir)) {
                return { error: 'Agent文件夹已存在（ID冲突）。' };
            }
            await fs.ensureDir(agentDir);

            let configToSave;
            if (initialConfig) {
                configToSave = { ...initialConfig, name: agentName };
            } else {
                configToSave = {
                    name: agentName,
                    systemPrompt: `你是 ${agentName}。`,
                    model: 'gemini-2.5-flash-preview-05-20',
                    temperature: 0.7,
                    contextTokenLimit: 1000000,
                    maxOutputTokens: 60000,
                    topics: [{ id: "default", name: "主要对话", createdAt: Date.now() }],
                    disableCustomColors: true,  // 默认启用：禁用自定义颜色（使用主题默认颜色）
                    useThemeColorsInChat: true  // 默认启用：会话中使用主题颜色
                };
            }
            if (!configToSave.topics || !Array.isArray(configToSave.topics) || configToSave.topics.length === 0) {
                configToSave.topics = [{ id: "default", name: "主要对话", createdAt: Date.now() }];
            }

            if (agentConfigManager) {
                await agentConfigManager.writeAgentConfig(agentId, configToSave);
            } else {
                await fs.writeJson(path.join(agentDir, 'config.json'), configToSave, { spaces: 2 });
            }

            if (configToSave.topics && configToSave.topics.length > 0) {
                const firstTopicId = configToSave.topics[0].id || "default";
                const topicHistoryDir = path.join(USER_DATA_DIR, agentId, 'topics', firstTopicId);
                await fs.ensureDir(topicHistoryDir);
                const historyFilePath = path.join(topicHistoryDir, 'history.json');
                if (!await fs.pathExists(historyFilePath)) {
                    await fs.writeJson(historyFilePath, [], { spaces: 2 });
                }
            }

            invalidateCaches();
            return { success: true, agentId: agentId, agentName: agentName, config: configToSave, avatarUrl: null };
        } catch (error) {
            console.error('创建Agent失败:', error);
            return { error: error.message };
        }
    });

    ipcMain.handle('delete-agent', async (event, agentId) => {
        try {
            const agentDir = path.join(AGENT_DIR, agentId);
            const userDataAgentDir = path.join(USER_DATA_DIR, agentId);
            if (await fs.pathExists(agentDir)) await fs.remove(agentDir);
            if (await fs.pathExists(userDataAgentDir)) await fs.remove(userDataAgentDir);
            invalidateCaches();
            return { success: true, message: `Agent ${agentId} 已删除。` };
        } catch (error) {
            console.error(`删除Agent ${agentId} 失败:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('save-user-avatar', async (event, avatarData) => {
        const listenerWasActive = context.getSelectionListenerStatus();
        if (listenerWasActive) context.stopSelectionListener();
        try {
            if (!avatarData || !avatarData.buffer) {
                return { error: '保存用户头像失败：未提供有效的头像数据。' };
            }
            await fs.ensureDir(USER_DATA_DIR);
            const nodeBuffer = Buffer.from(avatarData.buffer);
            await fs.writeFile(USER_AVATAR_FILE, nodeBuffer);
            return { success: true, avatarUrl: `file://${USER_AVATAR_FILE}?t=${Date.now()}`, needsColorExtraction: true };
        } catch (error) {
            console.error(`保存用户头像失败:`, error);
            return { error: `保存用户头像失败: ${error.message}` };
        } finally {
            if (listenerWasActive) context.startSelectionListener();
        }
    });

    ipcMain.handle('get-all-items', async () => {
        const agents = await getAgentsInternal(context);
        const groups = await getGroupsInternal(context);
        return { success: true, items: [...agents, ...groups] };
    });
}

async function getAgentsInternal({ AGENT_DIR }) {
    try {
        const agentDirs = await fs.readdir(AGENT_DIR);
        const agentConfigs = await Promise.all(agentDirs.map(async (agentId) => {
            const configPath = path.join(AGENT_DIR, agentId, 'config.json');

            let config;
            try {
                if (agentConfigManagerInstance) {
                    config = await agentConfigManagerInstance.readAgentConfig(agentId);
                } else if (await fs.pathExists(configPath)) {
                    config = await fs.readJson(configPath);
                }
            } catch (e) {
                console.error(`Error reading agent config for ${agentId} in getAgentsInternal:`, e);
                return null;
            }

            if (config) {
                try {
                    const agentDir = path.join(AGENT_DIR, agentId);
                    const avatarPathPng = path.join(agentDir, 'avatar.png');
                    const avatarPathJpg = path.join(agentDir, 'avatar.jpg');
                    const avatarPathJpeg = path.join(agentDir, 'avatar.jpeg');
                    const avatarPathGif = path.join(agentDir, 'avatar.gif');
                    let avatarUrl = null;
                    if (await fs.pathExists(avatarPathPng)) avatarUrl = `file://${avatarPathPng}`;
                    else if (await fs.pathExists(avatarPathJpg)) avatarUrl = `file://${avatarPathJpg}`;
                    else if (await fs.pathExists(avatarPathJpeg)) avatarUrl = `file://${avatarPathJpeg}`;
                    else if (await fs.pathExists(avatarPathGif)) avatarUrl = `file://${avatarPathGif}`;

                    return { ...config, id: agentId, type: 'agent', avatarUrl };
                } catch (e) {
                    console.error(`Error reading agent config for ${agentId}:`, e);
                    return null;
                }
            }
            return null;
        }));
        return agentConfigs.filter(Boolean);
    } catch (error) {
        console.error('Failed to get agents internally:', error);
        return [];
    }
}

async function getGroupsInternal({ USER_DATA_DIR }) {
    // Correcting path calculation based on user feedback (assuming path.dirname(USER_DATA_DIR) already points to the AppData root)
    const groupsDir = path.join(path.dirname(USER_DATA_DIR), 'AgentGroups');
    try {
        if (!await fs.pathExists(groupsDir)) {
            return [];
        }
        const groupDirs = await fs.readdir(groupsDir);
        const groupConfigs = await Promise.all(groupDirs.map(async (groupId) => {
            const configPath = path.join(groupsDir, groupId, 'config.json');
            if (await fs.pathExists(configPath)) {
                try {
                    const config = await fs.readJson(configPath);
                    const groupDir = path.join(groupsDir, groupId);
                    const avatarPathPng = path.join(groupDir, 'avatar.png');
                    const avatarPathJpg = path.join(groupDir, 'avatar.jpg');
                    const avatarPathJpeg = path.join(groupDir, 'avatar.jpeg');
                    const avatarPathGif = path.join(groupDir, 'avatar.gif');
                    let avatarUrl = null;
                    if (await fs.pathExists(avatarPathPng)) avatarUrl = `file://${avatarPathPng}`;
                    else if (await fs.pathExists(avatarPathJpg)) avatarUrl = `file://${avatarPathJpg}`;
                    else if (await fs.pathExists(avatarPathJpeg)) avatarUrl = `file://${avatarPathJpeg}`;
                    else if (await fs.pathExists(avatarPathGif)) avatarUrl = `file://${avatarPathGif}`;

                    return { ...config, id: groupId, type: 'group', avatarUrl };
                } catch (e) {
                    console.error(`Error reading group config for ${groupId}:`, e);
                    return null;
                }
            }
            return null;
        }));
        return groupConfigs.filter(Boolean);
    } catch (error) {
        console.error('Failed to get groups internally:', error);
        return [];
    }
}

function getAgentConfigManager() {
    return agentConfigManagerInstance;
}

module.exports = {
    initialize,
    getAgentConfigById,
    getAgentConfigManager
};

// recoverSettingsFromCorruptedFile 已由 SettingsManager 处理，无需此函数