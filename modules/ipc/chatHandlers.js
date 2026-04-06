// modules/ipc/chatHandlers.js
const { ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const contextSanitizer = require('../contextSanitizer');

/**
 * Initializes chat and topic related IPC handlers.
 * @param {BrowserWindow} mainWindow The main window instance.
 * @param {object} context - An object containing necessary context.
 * @param {string} context.AGENT_DIR - The path to the agents directory.
 * @param {string} context.USER_DATA_DIR - The path to the user data directory.
 * @param {string} context.APP_DATA_ROOT_IN_PROJECT - The path to the app data root.
 * @param {string} context.NOTES_AGENT_ID - The agent ID for notes.
 * @param {function} context.getSelectionListenerStatus - Function to get the current status of the selection listener.
 * @param {function} context.stopSelectionListener - Function to stop the selection listener.
 * @param {function} context.startSelectionListener - Function to start the selection listener.
 */
let ipcHandlersRegistered = false;

function initialize(mainWindow, context) {
    const { AGENT_DIR, USER_DATA_DIR, APP_DATA_ROOT_IN_PROJECT, NOTES_AGENT_ID, getMusicState, fileWatcher, agentConfigManager } = context;

    // Ensure the watcher is in a clean state on initialization
    if (fileWatcher) {
        fileWatcher.stopWatching();
    }

    if (ipcHandlersRegistered) {
        return;
    }

    ipcMain.handle('save-topic-order', async (event, agentId, orderedTopicIds) => {
        if (!agentId || !Array.isArray(orderedTopicIds)) {
            return { success: false, error: '无效的 agentId 或 topic IDs' };
        }
        try {
            if (agentConfigManager) {
                await agentConfigManager.updateAgentConfig(agentId, config => {
                    if (!config.topics || !Array.isArray(config.topics)) {
                        console.error(`保存Agent ${agentId} 的话题顺序失败: 配置文件损坏或缺少话题列表。`);
                        return config;
                    }
                    const topicMap = new Map(config.topics.map(topic => [topic.id, topic]));
                    const newTopicsArray = [];
                    orderedTopicIds.forEach(id => {
                        if (topicMap.has(id)) {
                            newTopicsArray.push(topicMap.get(id));
                            topicMap.delete(id);
                        }
                    });
                    newTopicsArray.push(...topicMap.values());
                    return { ...config, topics: newTopicsArray };
                });
            } else {
                console.error(`AgentConfigManager not available, cannot safely save topic order for agent ${agentId}`);
                return { success: false, error: 'AgentConfigManager 未初始化，无法安全保存话题顺序。' };
            }
            return { success: true };
        } catch (error) {
            console.error(`Error saving topic order for agent ${agentId}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('save-group-topic-order', async (event, groupId, orderedTopicIds) => {
        if (!groupId || !Array.isArray(orderedTopicIds)) {
            return { success: false, error: '无效的 groupId 或 topic IDs' };
        }
        const groupConfigPath = path.join(APP_DATA_ROOT_IN_PROJECT, 'AgentGroups', groupId, 'config.json');
        try {
            const groupConfig = await fs.readJson(groupConfigPath);
            if (!Array.isArray(groupConfig.topics)) groupConfig.topics = [];

            const newTopicsArray = [];
            const topicMap = new Map(groupConfig.topics.map(topic => [topic.id, topic]));

            orderedTopicIds.forEach(id => {
                if (topicMap.has(id)) {
                    newTopicsArray.push(topicMap.get(id));
                    topicMap.delete(id);
                }
            });

            newTopicsArray.push(...topicMap.values());
            groupConfig.topics = newTopicsArray;

            await fs.writeJson(groupConfigPath, groupConfig, { spaces: 2 });
            return { success: true };
        } catch (error) {
            console.error(`Error saving topic order for group ${groupId}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('search-topics-by-content', async (event, itemId, itemType, searchTerm) => {
        if (!itemId || !itemType || typeof searchTerm !== 'string' || searchTerm.trim() === '') {
            return { success: false, error: 'Invalid arguments for topic content search.', matchedTopicIds: [] };
        }
        const searchTermLower = searchTerm.toLowerCase();
        const matchedTopicIds = [];

        try {
            let itemConfig;
            let basePath = itemType === 'agent' ? AGENT_DIR : path.join(APP_DATA_ROOT_IN_PROJECT, 'AgentGroups');
            const configPath = path.join(basePath, itemId, 'config.json');

            if (await fs.pathExists(configPath)) {
                itemConfig = await fs.readJson(configPath);
            }

            if (!itemConfig || !itemConfig.topics || !Array.isArray(itemConfig.topics)) {
                return { success: true, matchedTopicIds: [] };
            }

            for (const topic of itemConfig.topics) {
                const historyFilePath = path.join(USER_DATA_DIR, itemId, 'topics', topic.id, 'history.json');
                if (await fs.pathExists(historyFilePath)) {
                    try {
                        const history = await fs.readJson(historyFilePath);
                        if (Array.isArray(history)) {
                            for (const message of history) {
                                if (message.content && typeof message.content === 'string' && message.content.toLowerCase().includes(searchTermLower)) {
                                    matchedTopicIds.push(topic.id);
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        console.error(`Error reading history for ${itemType} ${itemId}, topic ${topic.id}:`, e);
                    }
                }
            }
            return { success: true, matchedTopicIds: [...new Set(matchedTopicIds)] };
        } catch (error) {
            console.error(`Error searching topic content for ${itemType} ${itemId}:`, error);
            return { success: false, error: error.message, matchedTopicIds: [] };
        }
    });

    ipcMain.handle('save-agent-topic-title', async (event, agentId, topicId, newTitle) => {
        if (!topicId || !newTitle) return { error: "保存话题标题失败: topicId 或 newTitle 未提供。" };
        try {
            if (agentConfigManager) {
                await agentConfigManager.updateAgentConfig(agentId, existingConfig => {
                    if (!existingConfig.topics || !Array.isArray(existingConfig.topics)) {
                        return existingConfig;
                    }
                    const updatedConfig = { ...existingConfig, topics: [...existingConfig.topics] };
                    const topicIndex = updatedConfig.topics.findIndex(t => t.id === topicId);
                    if (topicIndex !== -1) {
                        updatedConfig.topics[topicIndex] = { ...updatedConfig.topics[topicIndex], name: newTitle };
                    }
                    return updatedConfig;
                });
                const updatedConfig = await agentConfigManager.readAgentConfig(agentId);
                return { success: true, topics: updatedConfig.topics };
            } else {
                console.error(`AgentConfigManager not available, cannot safely save topic title for agent ${agentId}`);
                return { error: 'AgentConfigManager 未初始化，无法安全保存话题标题。' };
            }
        } catch (error) {
            console.error(`保存Agent ${agentId} 话题 ${topicId} 标题为 "${newTitle}" 失败:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('get-chat-history', async (event, agentId, topicId) => {
        if (!topicId) return { error: `获取Agent ${agentId} 聊天历史失败: topicId 未提供。` };
        try {
            const historyFile = path.join(USER_DATA_DIR, agentId, 'topics', topicId, 'history.json');
            await fs.ensureDir(path.dirname(historyFile));


            if (await fs.pathExists(historyFile)) {
                return await fs.readJson(historyFile);
            }
            return [];
        } catch (error) {
            console.error(`获取Agent ${agentId} 话题 ${topicId} 聊天历史失败:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('save-chat-history', async (event, agentId, topicId, history) => {
        if (!topicId) return { error: `保存Agent ${agentId} 聊天历史失败: topicId 未提供。` };
        try {
            if (fileWatcher) {
                fileWatcher.signalInternalSave();
            }
            const historyDir = path.join(USER_DATA_DIR, agentId, 'topics', topicId);
            await fs.ensureDir(historyDir);
            const historyFile = path.join(historyDir, 'history.json');
            await fs.writeJson(historyFile, history, { spaces: 2 });
            return { success: true };
        } catch (error) {
            console.error(`保存Agent ${agentId} 话题 ${topicId} 聊天历史失败:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('get-agent-topics', async (event, agentId) => {
        try {
            let config;
            if (agentConfigManager) {
                try {
                    config = await agentConfigManager.readAgentConfig(agentId, { allowDefault: true });
                } catch (readError) {
                    console.error(`读取Agent ${agentId} 的配置失败 (get-agent-topics):`, readError);
                    return { error: `读取配置文件失败: ${readError.message}` };
                }
            } else {
                const configPath = path.join(AGENT_DIR, agentId, 'config.json');
                if (await fs.pathExists(configPath)) {
                    try {
                        config = await fs.readJson(configPath);
                    } catch (readError) {
                        console.error(`读取Agent ${agentId} 的 config.json 失败:`, readError);
                        return { error: `读取配置文件失败: ${readError.message}` };
                    }
                }
            }

            if (config && config.topics && Array.isArray(config.topics)) {
                // Part A: 历史数据兼容处理 - 自动为缺少新字段的话题添加默认值
                const normalizedTopics = config.topics.map(topic => ({
                    ...topic,
                    locked: topic.locked !== undefined ? topic.locked : true,
                    unread: topic.unread !== undefined ? topic.unread : false,
                    creatorSource: topic.creatorSource || 'unknown'
                }));
                return normalizedTopics;
            }
            return [];
        } catch (error) {
            console.error(`获取Agent ${agentId} 话题列表时发生意外错误:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('create-new-topic-for-agent', async (event, agentId, topicName, isBranch = false, locked = true) => {
        try {
            const newTopicId = `topic_${Date.now()}`;
            const timestamp = Date.now();

            if (agentConfigManager) {
                // 先读取当前配置以确定话题命名序号
                const currentConfig = await agentConfigManager.readAgentConfig(agentId, { allowDefault: true });
                if (currentConfig.topics && !Array.isArray(currentConfig.topics)) {
                    return { error: `配置文件已损坏: 'topics' 字段不是一个数组。` };
                }
                const existingTopics = currentConfig.topics || [];

                const newTopic = {
                    id: newTopicId,
                    name: topicName || `新话题 ${existingTopics.length + 1}`,
                    createdAt: timestamp,
                    locked: locked,
                    unread: false,
                    creatorSource: "ui"
                };

                await agentConfigManager.updateAgentConfig(agentId, existingConfig => ({
                    ...existingConfig,
                    topics: [newTopic, ...(existingConfig.topics || [])]
                }));
                const updatedConfig = await agentConfigManager.readAgentConfig(agentId);

                const topicHistoryDir = path.join(USER_DATA_DIR, agentId, 'topics', newTopicId);
                await fs.ensureDir(topicHistoryDir);
                await fs.writeJson(path.join(topicHistoryDir, 'history.json'), [], { spaces: 2 });

                return { success: true, topicId: newTopicId, topicName: newTopic.name, topics: updatedConfig.topics };
            } else {
                console.error(`AgentConfigManager not available, cannot safely create topic for agent ${agentId}`);
                return { error: 'AgentConfigManager 未初始化，无法安全创建话题。' };
            }
        } catch (error) {
            console.error(`为Agent ${agentId} 创建新话题失败:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('delete-topic', async (event, agentId, topicIdToDelete) => {
        try {
            if (agentConfigManager) {
                // 先读取当前配置进行验证
                const currentConfig = await agentConfigManager.readAgentConfig(agentId);
                if (!currentConfig.topics || !Array.isArray(currentConfig.topics)) {
                    return { error: `配置文件损坏或缺少话题列表。` };
                }
                if (!currentConfig.topics.some(t => t.id === topicIdToDelete)) {
                    return { error: `未找到要删除的话题 ID: ${topicIdToDelete}` };
                }

                let remainingTopics;
                await agentConfigManager.updateAgentConfig(agentId, existingConfig => {
                    let filtered = (existingConfig.topics || []).filter(topic => topic.id !== topicIdToDelete);
                    if (filtered.length === 0) {
                        filtered = [{ id: "default", name: "主要对话", createdAt: Date.now() }];
                    }
                    remainingTopics = filtered;
                    return { ...existingConfig, topics: filtered };
                });

                // 如果删空了并创建了默认话题，确保其 history 目录存在
                if (remainingTopics.length === 1 && remainingTopics[0].id === 'default') {
                    const defaultTopicHistoryDir = path.join(USER_DATA_DIR, agentId, 'topics', 'default');
                    await fs.ensureDir(defaultTopicHistoryDir);
                    const historyPath = path.join(defaultTopicHistoryDir, 'history.json');
                    if (!await fs.pathExists(historyPath)) {
                        await fs.writeJson(historyPath, [], { spaces: 2 });
                    }
                }

                const topicDataDir = path.join(USER_DATA_DIR, agentId, 'topics', topicIdToDelete);
                if (await fs.pathExists(topicDataDir)) await fs.remove(topicDataDir);

                return { success: true, remainingTopics };
            } else {
                console.error(`AgentConfigManager not available, cannot safely delete topic for agent ${agentId}`);
                return { error: 'AgentConfigManager 未初始化，无法安全删除话题。' };
            }
        } catch (error) {
            console.error(`删除Agent ${agentId} 的话题 ${topicIdToDelete} 失败:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('handle-file-paste', async (event, agentId, topicId, fileData) => {
        if (!topicId) return { error: "处理文件粘贴失败: topicId 未提供。" };
        try {
            let storedFileObject;
            if (fileData.type === 'path') {
                const originalFileName = path.basename(fileData.path);
                const ext = path.extname(fileData.path).toLowerCase();
                let fileTypeHint = 'application/octet-stream';
                if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
                    let mimeExt = ext.substring(1);
                    if (mimeExt === 'jpg') mimeExt = 'jpeg';
                    fileTypeHint = `image/${mimeExt}`;
                } else if (['.mp3', '.wav', '.ogg', '.flac', '.aac', '.aiff'].includes(ext)) {
                    const mimeExt = ext.substring(1);
                    fileTypeHint = `audio/${mimeExt === 'mp3' ? 'mpeg' : mimeExt}`;
                } else if (['.mp4', '.webm'].includes(ext)) {
                    fileTypeHint = `video/${ext.substring(1)}`;
                }

                const fileManager = require('../fileManager');
                storedFileObject = await fileManager.storeFile(fileData.path, originalFileName, agentId, topicId, fileTypeHint);
            } else if (fileData.type === 'base64') {
                const fileManager = require('../fileManager');
                const originalFileName = `pasted_image_${Date.now()}.${fileData.extension || 'png'}`;
                const buffer = Buffer.from(fileData.data, 'base64');
                const fileTypeHint = `image/${fileData.extension || 'png'}`;
                storedFileObject = await fileManager.storeFile(buffer, originalFileName, agentId, topicId, fileTypeHint);
            } else {
                throw new Error('不支持的文件粘贴类型');
            }
            return { success: true, attachment: storedFileObject };
        } catch (error) {
            console.error('处理粘贴文件失败:', error);
            return { error: error.message };
        }
    });

    ipcMain.handle('select-files-to-send', async (event, agentId, topicId) => {
        if (!agentId || !topicId) {
            console.error('[Main - select-files-to-send] Agent ID or Topic ID not provided.');
            return { error: "Agent ID and Topic ID are required to select files." };
        }

        const listenerWasActive = context.getSelectionListenerStatus();
        if (listenerWasActive) {
            context.stopSelectionListener();
            console.log('[Main] Temporarily stopped selection listener for file dialog.');
        }

        const result = await dialog.showOpenDialog(mainWindow, {
            title: '选择要发送的文件',
            properties: ['openFile', 'multiSelections']
        });

        if (listenerWasActive) {
            context.startSelectionListener();
            console.log('[Main] Restarted selection listener after file dialog.');
        }

        if (!result.canceled && result.filePaths.length > 0) {
            const storedFilesInfo = [];
            for (const filePath of result.filePaths) {
                try {
                    const originalName = path.basename(filePath);
                    const ext = path.extname(filePath).toLowerCase();
                    let fileTypeHint = 'application/octet-stream';
                    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
                        let mimeExt = ext.substring(1);
                        if (mimeExt === 'jpg') mimeExt = 'jpeg';
                        fileTypeHint = `image/${mimeExt}`;
                    } else if (['.mp3', '.wav', '.ogg', '.flac', '.aac', '.aiff'].includes(ext)) {
                        const mimeExt = ext.substring(1);
                        fileTypeHint = `audio/${mimeExt === 'mp3' ? 'mpeg' : mimeExt}`;
                    } else if (['.mp4', '.webm'].includes(ext)) {
                        fileTypeHint = `video/${ext.substring(1)}`;
                    }

                    const fileManager = require('../fileManager');
                    const storedFile = await fileManager.storeFile(filePath, originalName, agentId, topicId, fileTypeHint);
                    storedFilesInfo.push(storedFile);
                } catch (error) {
                    console.error(`[Main - select-files-to-send] Error storing file ${filePath}:`, error);
                    storedFilesInfo.push({ name: path.basename(filePath), error: error.message });
                }
            }
            return { success: true, attachments: storedFilesInfo };
        }
        return { success: false, attachments: [] };
    });

    ipcMain.handle('handle-text-paste-as-file', async (event, agentId, topicId, textContent) => {
        if (!agentId || !topicId) return { error: "处理长文本粘贴失败: agentId 或 topicId 未提供。" };
        if (typeof textContent !== 'string') return { error: "处理长文本粘贴失败: 无效的文本内容。" };

        try {
            const originalFileName = `pasted_text_${Date.now()}.txt`;
            const buffer = Buffer.from(textContent, 'utf8');
            const fileManager = require('../fileManager');
            const storedFileObject = await fileManager.storeFile(buffer, originalFileName, agentId, topicId, 'text/plain');
            return { success: true, attachment: storedFileObject };
        } catch (error) {
            console.error('[Main - handle-text-paste-as-file] 长文本转存为文件失败:', error);
            return { error: `长文本转存为文件失败: ${error.message}` };
        }
    });

    ipcMain.handle('handle-file-drop', async (event, agentId, topicId, droppedFilesData) => {
        if (!agentId || !topicId) return { error: "处理文件拖放失败: agentId 或 topicId 未提供。" };
        if (!Array.isArray(droppedFilesData) || droppedFilesData.length === 0) return { error: "处理文件拖放失败: 未提供文件数据。" };

        const storedFilesInfo = [];
        for (const fileData of droppedFilesData) {
            try {
                // Check if we have a path or data. One of them must exist.
                if (!fileData.data && !fileData.path) {
                    console.warn('[Main - handle-file-drop] Skipping a dropped file due to missing data and path. fileData:', JSON.stringify(fileData));
                    storedFilesInfo.push({ name: fileData.name || '未知文件', error: '文件内容或路径缺失' });
                    continue;
                }

                let fileSource;
                if (fileData.path) {
                    // If path is provided, use it as the source.
                    fileSource = fileData.path;
                } else {
                    // Otherwise, use the buffer from data.
                    fileSource = Buffer.isBuffer(fileData.data) ? fileData.data : Buffer.from(fileData.data);
                }

                let fileTypeHint = fileData.type;
                const fileExtension = path.extname(fileData.name).toLowerCase();

                // If file type is generic, try to guess from extension.
                if (fileTypeHint === 'application/octet-stream' || !fileTypeHint) {
                    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(fileExtension)) {
                        fileTypeHint = `image/${fileExtension.substring(1).replace('jpg', 'jpeg')}`;
                    } else if (['.mp3', '.wav', '.ogg', '.flac', '.aac', '.aiff'].includes(fileExtension)) {
                        const mimeExt = fileExtension.substring(1);
                        fileTypeHint = `audio/${mimeExt === 'mp3' ? 'mpeg' : mimeExt}`;
                    } else if (['.mp4', '.webm'].includes(fileExtension)) {
                        fileTypeHint = `video/${fileExtension.substring(1)}`;
                    } else if (['.md', '.txt'].includes(fileExtension)) {
                        fileTypeHint = 'text/plain';
                    }
                }

                console.log(`[Main - handle-file-drop] Attempting to store dropped file: ${fileData.name} (Type: ${fileTypeHint}) for Agent: ${agentId}, Topic: ${topicId}`);

                const fileManager = require('../fileManager');
                const storedFile = await fileManager.storeFile(fileSource, fileData.name, agentId, topicId, fileTypeHint);
                storedFilesInfo.push({ success: true, attachment: storedFile, name: fileData.name });

            } catch (error) {
                console.error(`[Main - handle-file-drop] Error storing dropped file ${fileData.name || 'unknown'}:`, error);
                console.error(`[Main - handle-file-drop] Full error details:`, error.stack);
                storedFilesInfo.push({ name: fileData.name || '未知文件', error: error.message });
            }
        }
        return storedFilesInfo;
    });

    ipcMain.handle('save-pasted-image-to-file', async (event, imageData, noteId) => {
        if (!imageData || !imageData.data || !imageData.extension) return { success: false, error: 'Invalid image data provided.' };
        if (!noteId) return { success: false, error: 'Note ID is required to save image.' };

        try {
            const buffer = Buffer.from(imageData.data, 'base64');
            const fileManager = require('../fileManager');
            const storedFileObject = await fileManager.storeFile(
                buffer,
                `pasted_image_${Date.now()}.${imageData.extension}`,
                NOTES_AGENT_ID,
                noteId,
                `image/${imageData.extension === 'jpg' ? 'jpeg' : imageData.extension}`
            );
            return { success: true, attachment: storedFileObject };
        } catch (error) {
            console.error('[Main Process] Error saving pasted image for note:', error);
            return { success: false, error: error.message };
        }
    });
    ipcMain.handle('get-original-message-content', async (event, itemId, itemType, topicId, messageId) => {
        if (!itemId || !itemType || !topicId || !messageId) {
            return { success: false, error: '无效的参数' };
        }

        try {
            let historyFile;
            if (itemType === 'agent') {
                historyFile = path.join(USER_DATA_DIR, itemId, 'topics', topicId, 'history.json');
            } else if (itemType === 'group') {
                historyFile = path.join(USER_DATA_DIR, itemId, 'topics', topicId, 'history.json');
            } else {
                return { success: false, error: '不支持的项目类型' };
            }

            if (await fs.pathExists(historyFile)) {
                const history = await fs.readJson(historyFile);
                const message = history.find(m => m.id === messageId);
                if (message) {
                    return { success: true, content: message.content };
                } else {
                    return { success: false, error: '在历史记录中未找到该消息' };
                }
            } else {
                return { success: false, error: '聊天历史文件不存在' };
            }
        } catch (error) {
            console.error(`获取原始消息内容失败 (itemId: ${itemId}, topicId: ${topicId}, messageId: ${messageId}):`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-to-vcp', async (event, vcpUrl, vcpApiKey, messages, modelConfig, messageId, isGroupCall = false, context = null) => {
        console.log(`[Main - sendToVCP] ***** sendToVCP HANDLER EXECUTED for messageId: ${messageId}, isGroupCall: ${isGroupCall} *****`, context);
        const streamChannel = 'vcp-stream-event'; // Use a single, unified channel for all stream events.

        // 🔧 数据验证和规范化
        try {
            // 确保messages数组中的content都是正确的格式
            messages = messages.map(msg => {
                if (!msg || typeof msg !== 'object') {
                    console.error('[Main - sendToVCP] Invalid message object:', msg);
                    return { role: 'system', content: '[Invalid message]' };
                }

                let processedContent = msg.content;

                // 如果content是对象，尝试提取text字段或转为JSON字符串
                if (msg.content && typeof msg.content === 'object') {
                    if (msg.content.text) {
                        processedContent = String(msg.content.text);
                    } else if (Array.isArray(msg.content)) {
                        // 如果是仅包含一个文本部分的多模态消息，则将其简化为纯字符串，保持兼容
                        if (msg.content.length === 1 && msg.content[0].type === 'text' && typeof msg.content[0].text === 'string') {
                            processedContent = msg.content[0].text;
                        } else {
                            // 保持多模态数组原样
                            processedContent = msg.content;
                        }
                    } else {
                        // 否则转为JSON字符串
                        console.warn('[Main - sendToVCP] Message content is object without text field, stringifying:', msg.content);
                        processedContent = JSON.stringify(msg.content);
                    }
                }

                // 强制转换为字符串（除非是多模态数组）
                if (processedContent && !Array.isArray(processedContent) && typeof processedContent !== 'string') {
                    processedContent = String(processedContent);
                }

                // 🛡️ 严格脱敏：只返回由 OpenAI/Gemini/Anthropic 等 API 规范定义的合法字段
                // 剔除 attachments, isThinking 等非标私有元数据，防止泄露给模型
                const sanitizedMsg = {
                    role: msg.role,
                    content: processedContent
                };
                if (msg.name) sanitizedMsg.name = msg.name;
                if (msg.tool_calls) sanitizedMsg.tool_calls = msg.tool_calls;
                if (msg.tool_call_id) sanitizedMsg.tool_call_id = msg.tool_call_id;
                
                return sanitizedMsg;
            });
        } catch (validationError) {
            console.error('[Main - sendToVCP] Error validating messages:', validationError);
            return { error: `消息格式验证失败: ${validationError.message}` };
        }

        let finalVcpUrl = vcpUrl;
        let settings = {};
        try {
            const settingsPath = path.join(APP_DATA_ROOT_IN_PROJECT, 'settings.json');
            if (await fs.pathExists(settingsPath)) {
                settings = await fs.readJson(settingsPath);
            }

            // **强制检查和切换URL**
            if (settings.enableVcpToolInjection === true) {
                const urlObject = new URL(vcpUrl);
                urlObject.pathname = '/v1/chatvcp/completions';
                finalVcpUrl = urlObject.toString();
                console.log(`[Main - sendToVCP] VCP tool injection is ON. URL switched to: ${finalVcpUrl}`);
            } else {
                console.log(`[Main - sendToVCP] VCP tool injection is OFF. Using original URL: ${vcpUrl}`);
            }
        } catch (e) {
            console.error(`[Main - sendToVCP] Error reading settings or switching URL: ${e.message}. Proceeding with original URL.`);
        }

        try {
            // --- Agent Music Control Injection ---
            if (getMusicState) {
                try {
                    const { musicWindow, currentSongInfo } = getMusicState();
                    const topParts = [];
                    const bottomParts = [];

                    // 1. 始终注入当前播放的歌曲信息（如果存在）
                    if (currentSongInfo) {
                        bottomParts.push(`[当前播放音乐：${currentSongInfo.title} - ${currentSongInfo.artist} (${currentSongInfo.album || '未知专辑'})]`);
                    }

                    // 2. 如果启用了音乐控制，则注入播放列表和控制器
                    if (settings.agentMusicControl) {
                        // 2a. 构建播放列表信息 (注入到顶部)
                        const songlistPath = path.join(APP_DATA_ROOT_IN_PROJECT, 'songlist.json');
                        if (await fs.pathExists(songlistPath)) {
                            const songlistJson = await fs.readJson(songlistPath);
                            if (Array.isArray(songlistJson) && songlistJson.length > 0) {
                                const titles = songlistJson.map(song => song.title).filter(Boolean);
                                if (titles.length > 0) {
                                    topParts.push(`[播放列表——\n${titles.join('\n')}\n]`);
                                }
                            }
                        }

                        // 2b. 注入插件权限
                        bottomParts.push(`点歌台{{VCPMusicController}}`);
                    }

                    // 3. 组合并注入到消息数组
                    if (topParts.length > 0 || bottomParts.length > 0) {
                        let systemMsgIndex = messages.findIndex(m => m.role === 'system');
                        let originalContent = '';

                        if (systemMsgIndex !== -1) {
                            originalContent = messages[systemMsgIndex].content;
                        } else {
                            messages.unshift({ role: 'system', content: '' });
                            systemMsgIndex = 0;
                        }

                        const finalParts = [];
                        if (topParts.length > 0) finalParts.push(topParts.join('\n'));
                        if (originalContent) finalParts.push(originalContent);
                        if (bottomParts.length > 0) finalParts.push(bottomParts.join('\n'));

                        messages[systemMsgIndex].content = finalParts.join('\n\n').trim();
                    }
                } catch (e) {
                    console.error('[Agent Music Control] Failed to inject music info:', e);
                }
            }

            // --- Agent Bubble Theme Injection ---
            try {
                // Settings already loaded, just check the flag
                if (settings.enableAgentBubbleTheme) {
                    let systemMsgIndex = messages.findIndex(m => m.role === 'system');
                    if (systemMsgIndex === -1) {
                        messages.unshift({ role: 'system', content: '' });
                        systemMsgIndex = 0;
                    }

                    const injection = '输出规范要求：{{VarDivRender}}';
                    if (!messages[systemMsgIndex].content.includes(injection)) {
                        messages[systemMsgIndex].content += `\n\n${injection}`;
                        messages[systemMsgIndex].content = messages[systemMsgIndex].content.trim();
                    }
                }
            } catch (e) {
                console.error('[Agent Bubble Theme] Failed to inject bubble theme info:', e);
            }
            // --- End of Injection ---

            // --- VCP Thought Chain Stripping ---
            try {
                // 默认不注入元思考链，除非明确开启
                if (settings.enableThoughtChainInjection !== true) {
                    messages = messages.map(msg => {
                        if (typeof msg.content === 'string') {
                            return { ...msg, content: contextSanitizer.stripThoughtChains(msg.content) };
                        } else if (Array.isArray(msg.content)) {
                            return {
                                ...msg,
                                content: msg.content.map(part => {
                                    if (part.type === 'text' && typeof part.text === 'string') {
                                        return { ...part, text: contextSanitizer.stripThoughtChains(part.text) };
                                    }
                                    return part;
                                })
                            };
                        }
                        return msg;
                    });
                    console.log(`[ThoughtChain] Thought chains stripped from context`);
                }
            } catch (e) {
                console.error('[ThoughtChain] Failed to strip thought chains:', e);
            }

            // --- Context Sanitizer Integration ---
            try {
                if (settings.enableContextSanitizer === true) {
                    const sanitizerDepth = settings.contextSanitizerDepth !== undefined ? settings.contextSanitizerDepth : 2;
                    console.log(`[Context Sanitizer] Enabled with depth: ${sanitizerDepth}`);

                    // 只处理非系统消息（排除 system role）
                    const systemMessages = messages.filter(m => m.role === 'system');
                    const nonSystemMessages = messages.filter(m => m.role !== 'system');

                    // 对非系统消息应用净化
                    const sanitizedNonSystemMessages = contextSanitizer.sanitizeMessages(
                        nonSystemMessages,
                        sanitizerDepth,
                        settings.enableThoughtChainInjection === true
                    );

                    // 重新组合消息数组（保持系统消息在最前面）
                    messages = [...systemMessages, ...sanitizedNonSystemMessages];

                    console.log(`[Context Sanitizer] Messages processed successfully`);
                }
            } catch (sanitizerError) {
                console.error('[Context Sanitizer] Error during sanitization, proceeding with original messages:', sanitizerError);
                // 出错时继续使用原始消息，不影响正常流程
            }
            // --- End of Context Sanitizer Integration ---

            console.log(`发送到VCP服务器: ${finalVcpUrl} for messageId: ${messageId}`);
            console.log('VCP API Key:', vcpApiKey ? '已设置' : '未设置');
            console.log('模型配置:', modelConfig);
            if (context) console.log('上下文:', context);

            // 🔧 在发送前验证请求体
            const requestBody = {
                messages: messages,
                ...modelConfig,
                stream: modelConfig.stream === true,
                requestId: messageId
            };

            // 🔥 记录模型使用频率
            try {
                if (modelConfig && modelConfig.model) {
                    const modelUsageTracker = require('../modelUsageTracker');
                    await modelUsageTracker.recordModelUsage(modelConfig.model);
                }
            } catch (e) {
                console.error('[ModelUsage] Failed to record model usage:', e);
            }

            // 验证JSON可序列化性
            let serializedBody;
            try {
                serializedBody = JSON.stringify(requestBody);
                // 调试：记录前100个字符
                console.log('[Main - sendToVCP] Request body preview:', serializedBody.substring(0, 100) + '...');
            } catch (serializeError) {
                console.error('[Main - sendToVCP] Failed to serialize request body:', serializeError);
                console.error('[Main - sendToVCP] Problematic request body:', requestBody);
                return { error: `请求体序列化失败: ${serializeError.message}` };
            }

            const response = await fetch(finalVcpUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${vcpApiKey}`
                },
                body: serializedBody
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[Main - sendToVCP] VCP请求失败. Status: ${response.status}, Response Text:`, errorText);
                let errorData = { message: `服务器返回状态 ${response.status}`, details: errorText };
                try {
                    const parsedError = JSON.parse(errorText);
                    if (typeof parsedError === 'object' && parsedError !== null) {
                        errorData = parsedError;
                    }
                } catch (e) { /* Not JSON, use raw text */ }

                // 🔧 改进错误消息构造，防止 [object Object]
                let errorMessage = '';
                if (errorData.message && typeof errorData.message === 'string') {
                    errorMessage = errorData.message;
                } else if (errorData.error) {
                    if (typeof errorData.error === 'string') {
                        errorMessage = errorData.error;
                    } else if (errorData.error.message && typeof errorData.error.message === 'string') {
                        errorMessage = errorData.error.message;
                    } else if (typeof errorData.error === 'object') {
                        // 如果error是对象，尝试JSON序列化
                        errorMessage = JSON.stringify(errorData.error);
                    }
                } else if (typeof errorData === 'string') {
                    errorMessage = errorData;
                } else {
                    errorMessage = '未知服务端错误';
                }

                const errorMessageToPropagate = `VCP请求失败: ${response.status} - ${errorMessage}`;

                if (modelConfig.stream === true && event && event.sender && !event.sender.isDestroyed()) {
                    // 构造更详细的错误信息
                    let detailedErrorMessage = `服务器返回状态 ${response.status}.`;
                    if (errorData && errorData.message && typeof errorData.message === 'string') {
                        detailedErrorMessage += ` 错误: ${errorData.message}`;
                    } else if (errorData && errorData.error && errorData.error.message && typeof errorData.error.message === 'string') {
                        detailedErrorMessage += ` 错误: ${errorData.error.message}`;
                    } else if (typeof errorData === 'string' && errorData.length < 200) {
                        detailedErrorMessage += ` 响应: ${errorData}`;
                    } else if (errorData && errorData.details && typeof errorData.details === 'string' && errorData.details.length < 200) {
                        detailedErrorMessage += ` 详情: ${errorData.details}`;
                    }

                    const errorPayload = { type: 'error', error: `VCP请求失败: ${detailedErrorMessage}`, details: errorData, messageId: messageId };
                    if (context) errorPayload.context = context;
                    event.sender.send(streamChannel, errorPayload);
                    // 为函数返回值构造统一的 errorDetail.message
                    const finalErrorMessageForReturn = `VCP请求失败: ${response.status} - ${errorMessage}`;
                    return { streamError: true, error: `VCP请求失败 (${response.status})`, errorDetail: { message: finalErrorMessageForReturn, originalData: errorData } };
                }
                const err = new Error(errorMessageToPropagate);
                err.details = errorData;
                err.status = response.status;
                throw err;
            }

            if (modelConfig.stream === true) {
                console.log(`VCP响应: 开始流式处理 for ${messageId} on channel ${streamChannel}`);
                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                // 【全新的、修正后的 processStream 函数】
                // 它现在接收 reader 和 decoder 作为参数
                async function processStream(reader, decoder) {
                    let buffer = '';

                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (value) {
                                buffer += decoder.decode(value, { stream: true });
                            }

                            const lines = buffer.split('\n');

                            // 如果流已结束，则处理所有行。否则，保留最后一行（可能不完整）。
                            buffer = done ? '' : lines.pop();

                            for (const line of lines) {
                                if (line.trim() === '') continue;

                                if (line.startsWith('data: ')) {
                                    const jsonData = line.substring(5).trim();
                                    if (jsonData === '[DONE]') {
                                        console.log(`VCP流明确[DONE] for messageId: ${messageId}`);
                                        const donePayload = { type: 'end', messageId: messageId, context };
                                        event.sender.send(streamChannel, donePayload);
                                        return; // [DONE] 是明确的结束信号，退出函数
                                    }
                                    // 如果 jsonData 为空，则忽略该行，这可能是网络波动或心跳信号
                                    if (jsonData === '') {
                                        continue;
                                    }
                                    try {
                                        const parsedChunk = JSON.parse(jsonData);
                                        const dataPayload = { type: 'data', chunk: parsedChunk, messageId: messageId, context };
                                        event.sender.send(streamChannel, dataPayload);
                                    } catch (e) {
                                        console.error(`解析VCP流数据块JSON失败 for messageId: ${messageId}:`, e, '原始数据:', jsonData);
                                        const errorChunkPayload = { type: 'data', chunk: { raw: jsonData, error: 'json_parse_error' }, messageId: messageId, context };
                                        event.sender.send(streamChannel, errorChunkPayload);
                                    }
                                }
                            }

                            if (done) {
                                // 流因连接关闭而结束，而不是[DONE]消息。
                                // 缓冲区已被处理，现在发送最终的 'end' 信号。
                                console.log(`VCP流结束 for messageId: ${messageId}`);
                                const endPayload = { type: 'end', messageId: messageId, context };
                                event.sender.send(streamChannel, endPayload);
                                break; // 退出 while 循环
                            }
                        }
                    } catch (streamError) {
                        console.error(`VCP流读取错误 for messageId: ${messageId}:`, streamError);
                        const streamErrPayload = { type: 'error', error: `VCP流读取错误: ${streamError.message}`, messageId: messageId };
                        if (context) streamErrPayload.context = context;
                        event.sender.send(streamChannel, streamErrPayload);
                    } finally {
                        reader.releaseLock();
                        console.log(`ReadableStream's lock released for messageId: ${messageId}`);
                    }
                }

                // 将 reader 和 decoder 作为参数传递给 processStream
                // 并且我们依然需要 await 来等待流处理完成
                processStream(reader, decoder).then(() => {
                    console.log(`[Main - sendToVCP] 流处理函数 processStream 已正常结束 for ${messageId}`);
                }).catch(err => {
                    console.error(`[Main - sendToVCP] processStream 内部抛出未捕获的错误 for ${messageId}:`, err);
                });

                return { streamingStarted: true };
            } else { // Non-streaming
                console.log('VCP响应: 非流式处理');
                const vcpResponse = await response.json();
                // For non-streaming, wrap the response with the original context
                // so the renderer knows where to save the history.
                return { response: vcpResponse, context };
            }

        } catch (error) {
            console.error('VCP请求错误 (catch block):', error);
            if (modelConfig.stream === true && event && event.sender && !event.sender.isDestroyed()) {
                const catchErrorPayload = { type: 'error', error: `VCP请求错误: ${error.message}`, messageId: messageId, context };
                event.sender.send(streamChannel, catchErrorPayload);
                return { streamError: true, error: `VCP客户端请求错误`, errorDetail: { message: error.message, stack: error.stack } };
            }
            return { error: `VCP请求错误: ${error.message}` };
        }
    });


    ipcMain.handle('interrupt-vcp-request', async (event, { messageId }) => {
        try {
            const settingsPath = path.join(APP_DATA_ROOT_IN_PROJECT, 'settings.json');
            if (!await fs.pathExists(settingsPath)) {
                return { success: false, error: 'Settings file not found.' };
            }
            const settings = await fs.readJson(settingsPath);
            const vcpUrl = settings.vcpServerUrl;
            const vcpApiKey = settings.vcpApiKey;

            if (!vcpUrl) {
                return { success: false, error: 'VCP Server URL is not configured.' };
            }

            // Construct the interrupt URL from the base server URL
            const urlObject = new URL(vcpUrl);
            const interruptUrl = `${urlObject.protocol}//${urlObject.host}/v1/interrupt`;

            console.log(`[Main - interrupt] Sending interrupt for messageId: ${messageId} to ${interruptUrl}`);

            const response = await fetch(interruptUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${vcpApiKey}`
                },
                body: JSON.stringify({
                    requestId: messageId // Corrected to requestId to match user's edit
                })
            });

            const result = await response.json();

            if (!response.ok) {
                console.error(`[Main - interrupt] Failed to send interrupt signal:`, result);
                return { success: false, error: result.message || `Server returned status ${response.status}` };
            }

            console.log(`[Main - interrupt] Interrupt signal sent successfully for ${messageId}. Response:`, result.message);
            return { success: true, message: result.message };

        } catch (error) {
            console.error(`[Main - interrupt] Error sending interrupt request for messageId ${messageId}:`, error);
            return { success: false, error: error.message };
        }
    });

    /**
     * Part C: 智能计数逻辑辅助函数
     * 判断是否应该激活计数
     * 规则：上下文（排除系统消息）有且只有一个 AI 的回复，且没有用户回复
     * @param {Array} history - 消息历史
     * @returns {boolean}
     */
    function shouldActivateCount(history) {
        if (!history || history.length === 0) return false;

        // 过滤掉系统消息
        const nonSystemMessages = history.filter(msg => msg.role !== 'system');

        // 必须有且只有一条消息，且该消息是 AI 回复
        return nonSystemMessages.length === 1 && nonSystemMessages[0].role === 'assistant';
    }

    /**
     * Part C: 计算未读消息数量
     * @param {Array} history - 消息历史
     * @returns {number}
     */
    function countUnreadMessages(history) {
        return shouldActivateCount(history) ? 1 : 0;
    }

    /**
     * Part C: 计算单个话题的未读消息数
     * @param {Object} topic - 话题对象
     * @param {Array} history - 话题历史消息
     * @returns {number} - 未读消息数，-1 表示仅显示小点
     */
    function calculateTopicUnreadCount(topic, history) {
        // 优先检查自动计数条件（AI回复了但用户没回）
        if (shouldActivateCount(history)) {
            const count = countUnreadMessages(history);
            if (count > 0) return count;
        }

        // 如果不满足自动计数条件，但被手动标记为未读，则显示小点
        if (topic.unread === true) {
            return -1; // 仅显示小点，不显示数字
        }

        return 0; // 不显示
    }

    ipcMain.handle('get-unread-topic-counts', async () => {
        const counts = {};
        try {
            const agentDirs = await fs.readdir(AGENT_DIR, { withFileTypes: true });
            for (const dirent of agentDirs) {
                if (dirent.isDirectory()) {
                    const agentId = dirent.name;
                    let totalCount = 0;
                    let hasUnreadMarker = false; // 用于标记是否有未读标记但无计数
                    const configPath = path.join(AGENT_DIR, agentId, 'config.json');

                    if (await fs.pathExists(configPath)) {
                        const config = await fs.readJson(configPath);
                        if (config.topics && Array.isArray(config.topics)) {
                            for (const topic of config.topics) {
                                const historyPath = path.join(USER_DATA_DIR, agentId, 'topics', topic.id, 'history.json');
                                if (await fs.pathExists(historyPath)) {
                                    try {
                                        const history = await fs.readJson(historyPath);
                                        const topicCount = calculateTopicUnreadCount(topic, history);
                                        if (topicCount > 0) {
                                            totalCount += topicCount;
                                        } else if (topicCount === -1) {
                                            // 有未读标记但无计数，记录这个状态
                                            hasUnreadMarker = true;
                                        }
                                    } catch (readJsonError) {
                                        console.error(`读取 history.json 失败: ${historyPath}`, readJsonError);
                                    }
                                }
                            }
                        }
                    }

                    // 如果有计数，显示数字
                    if (totalCount > 0) {
                        counts[agentId] = totalCount;
                    } else if (hasUnreadMarker) {
                        // 如果只有未读标记没有计数，返回 0（前端会识别为仅显示小点）
                        counts[agentId] = 0;
                    }
                }
            }
            return { success: true, counts };
        } catch (error) {
            console.error('获取未读话题计数时出错:', error);
            return { success: false, error: error.message, counts: {} };
        }
    });

    // Part A: 切换话题锁定状态
    ipcMain.handle('toggle-topic-lock', async (event, agentId, topicId) => {
        try {
            const agentConfigPath = path.join(AGENT_DIR, agentId, 'config.json');
            if (!await fs.pathExists(agentConfigPath)) {
                return { success: false, error: `Agent ${agentId} 的配置文件不存在` };
            }

            let config;
            try {
                config = await fs.readJson(agentConfigPath);
            } catch (e) {
                console.error(`读取Agent ${agentId} 配置文件失败 (toggle-topic-lock):`, e);
                return { success: false, error: `读取配置文件失败: ${e.message}` };
            }

            if (!config.topics || !Array.isArray(config.topics)) {
                return { success: false, error: '配置文件损坏或缺少话题列表' };
            }

            const topic = config.topics.find(t => t.id === topicId);
            if (!topic) {
                return { success: false, error: `未找到话题 ${topicId}` };
            }

            // Part A: 历史数据兼容 - 如果话题没有 locked 字段，默认设置为 true
            if (topic.locked === undefined) {
                topic.locked = true;
            }

            // 切换锁定状态
            topic.locked = !topic.locked;

            if (agentConfigManager) {
                await agentConfigManager.updateAgentConfig(agentId, existingConfig => ({
                    ...existingConfig,
                    topics: config.topics
                }));
            } else {
                await fs.writeJson(agentConfigPath, config, { spaces: 2 });
            }

            return {
                success: true,
                locked: topic.locked,
                message: topic.locked ? '话题已锁定' : '话题已解锁'
            };
        } catch (error) {
            console.error('[toggleTopicLock] Error:', error);
            return { success: false, error: error.message };
        }
    });

    // Part A: 设置话题未读状态
    ipcMain.handle('set-topic-unread', async (event, agentId, topicId, unread) => {
        try {
            const agentConfigPath = path.join(AGENT_DIR, agentId, 'config.json');
            if (!await fs.pathExists(agentConfigPath)) {
                return { success: false, error: `Agent ${agentId} 的配置文件不存在` };
            }

            let config;
            try {
                config = await fs.readJson(agentConfigPath);
            } catch (e) {
                console.error(`读取Agent ${agentId} 配置文件失败 (set-topic-unread):`, e);
                return { success: false, error: `读取配置文件失败: ${e.message}` };
            }

            if (!config.topics || !Array.isArray(config.topics)) {
                return { success: false, error: '配置文件损坏或缺少话题列表' };
            }

            const topic = config.topics.find(t => t.id === topicId);
            if (!topic) {
                return { success: false, error: `未找到话题 ${topicId}` };
            }

            // Part A: 历史数据兼容 - 如果话题没有 unread 字段，默认设置为 false
            if (topic.unread === undefined) {
                topic.unread = false;
            }

            topic.unread = unread;

            if (agentConfigManager) {
                await agentConfigManager.updateAgentConfig(agentId, existingConfig => ({
                    ...existingConfig,
                    topics: config.topics
                }));
            } else {
                await fs.writeJson(agentConfigPath, config, { spaces: 2 });
            }

            return { success: true, unread: topic.unread };
        } catch (error) {
            console.error('[setTopicUnread] Error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcHandlersRegistered = true;
}

module.exports = {
    initialize
};