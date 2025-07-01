// modules/ipc/chatHandlers.js
const { ipcMain, dialog } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const fileManager = require('../fileManager');

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
function initialize(mainWindow, context) {
    const { AGENT_DIR, USER_DATA_DIR, APP_DATA_ROOT_IN_PROJECT, NOTES_AGENT_ID, getMusicState } = context;

    ipcMain.handle('save-topic-order', async (event, agentId, orderedTopicIds) => {
        if (!agentId || !Array.isArray(orderedTopicIds)) {
            return { success: false, error: '无效的 agentId 或 topic IDs' };
        }
        const agentConfigPath = path.join(AGENT_DIR, agentId, 'config.json');
        try {
            const agentConfig = await fs.readJson(agentConfigPath);
            if (!Array.isArray(agentConfig.topics)) agentConfig.topics = [];
            
            const newTopicsArray = [];
            const topicMap = new Map(agentConfig.topics.map(topic => [topic.id, topic]));

            orderedTopicIds.forEach(id => {
                if (topicMap.has(id)) {
                    newTopicsArray.push(topicMap.get(id));
                    topicMap.delete(id); 
                }
            });
            
            newTopicsArray.push(...topicMap.values());
            agentConfig.topics = newTopicsArray;

            await fs.writeJson(agentConfigPath, agentConfig, { spaces: 2 });
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
            const configPath = path.join(AGENT_DIR, agentId, 'config.json');
            if (!await fs.pathExists(configPath)) return { error: `保存话题标题失败: Agent ${agentId} 的配置文件不存在。` };
            
            let config = await fs.readJson(configPath);
            if (!config.topics || !Array.isArray(config.topics)) return { error: `保存话题标题失败: Agent ${agentId} 没有话题列表。` };

            const topicIndex = config.topics.findIndex(t => t.id === topicId);
            if (topicIndex === -1) return { error: `保存话题标题失败: Agent ${agentId} 中未找到 ID 为 ${topicId} 的话题。` };

            config.topics[topicIndex].name = newTitle;
            await fs.writeJson(configPath, config, { spaces: 2 });
            return { success: true, topics: config.topics }; 
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
            const configPath = path.join(AGENT_DIR, agentId, 'config.json');
            if (await fs.pathExists(configPath)) {
                const config = await fs.readJson(configPath);
                if (config.topics && Array.isArray(config.topics) && config.topics.length > 0) {
                    return config.topics;
                } else { 
                    const defaultTopics = [{ id: "default", name: "主要对话", createdAt: Date.now() }];
                    config.topics = defaultTopics;
                    await fs.writeJson(configPath, config, { spaces: 2 });
                    return defaultTopics;
                }
            }
            return [{ id: "default", name: "主要对话", createdAt: Date.now() }];
        } catch (error) {
            console.error(`获取Agent ${agentId} 话题列表失败:`, error);
            return [{ id: "default", name: "主要对话", createdAt: Date.now(), error: error.message }];
        }
    });

    ipcMain.handle('create-new-topic-for-agent', async (event, agentId, topicName) => {
        try {
            const configPath = path.join(AGENT_DIR, agentId, 'config.json');
            if (!await fs.pathExists(configPath)) return { error: `Agent ${agentId} 的配置文件不存在。` };
            
            const config = await fs.readJson(configPath);
            if (!config.topics || !Array.isArray(config.topics)) config.topics = []; 

            const newTopicId = `topic_${Date.now()}`;
            const newTopic = { id: newTopicId, name: topicName || `新话题 ${config.topics.length + 1}`, createdAt: Date.now() };
            config.topics.push(newTopic);
            await fs.writeJson(configPath, config, { spaces: 2 });

            const topicHistoryDir = path.join(USER_DATA_DIR, agentId, 'topics', newTopicId);
            await fs.ensureDir(topicHistoryDir);
            await fs.writeJson(path.join(topicHistoryDir, 'history.json'), [], { spaces: 2 });

            return { success: true, topicId: newTopicId, topicName: newTopic.name, topics: config.topics };
        } catch (error) {
            console.error(`为Agent ${agentId} 创建新话题失败:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('delete-topic', async (event, agentId, topicIdToDelete) => {
        try {
            const configPath = path.join(AGENT_DIR, agentId, 'config.json');
            if (!await fs.pathExists(configPath)) return { error: `Agent ${agentId} 的配置文件不存在。` };
            
            let config = await fs.readJson(configPath);
            if (!config.topics || !Array.isArray(config.topics)) return { error: `Agent ${agentId} 没有话题列表可供删除。` };

            const initialTopicCount = config.topics.length;
            config.topics = config.topics.filter(topic => topic.id !== topicIdToDelete);

            if (config.topics.length === initialTopicCount) return { error: `未找到要删除的话题 ID: ${topicIdToDelete}` };

            if (config.topics.length === 0) {
                const defaultTopic = { id: "default", name: "主要对话", createdAt: Date.now() };
                config.topics.push(defaultTopic);
                const defaultTopicHistoryDir = path.join(USER_DATA_DIR, agentId, 'topics', defaultTopic.id);
                await fs.ensureDir(defaultTopicHistoryDir);
                await fs.writeJson(path.join(defaultTopicHistoryDir, 'history.json'), [], { spaces: 2 });
            }

            await fs.writeJson(configPath, config, { spaces: 2 });

            const topicDataDir = path.join(USER_DATA_DIR, agentId, 'topics', topicIdToDelete);
            if (await fs.pathExists(topicDataDir)) await fs.remove(topicDataDir);

            return { success: true, remainingTopics: config.topics };
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
                if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) fileTypeHint = `image/${ext.substring(1)}`;
                else if (['.mp3', '.wav', '.ogg'].includes(ext)) fileTypeHint = `audio/${ext.substring(1)}`;

                storedFileObject = await fileManager.storeFile(fileData.path, originalFileName, agentId, topicId, fileTypeHint);
            } else if (fileData.type === 'base64') {
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
                    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) fileTypeHint = `image/${ext.substring(1)}`;
                    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
                    let mimeExt = ext.substring(1); // 移除点
                    if (mimeExt === 'jpg') {
                    mimeExt = 'jpeg'; // 将 jpg 转换为 jpeg
                    }
                    fileTypeHint = `image/${mimeExt}`;}

                    else if (['.mp3', '.wav', '.ogg'].includes(ext)) fileTypeHint = `audio/${ext.substring(1)}`;

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
                if (!fileData.data || !fileData.name || !fileData.type) {
                    console.warn('[Main - handle-file-drop] Skipping a dropped file due to missing data, name, or type. fileData:', JSON.stringify(fileData));
                    storedFilesInfo.push({ name: fileData.name || '未知文件（数据缺失）', error: '文件内容、名称或类型缺失' });
                    continue;
                }

                let fileTypeHint = fileData.type;
                const fileExtension = path.extname(fileData.name).toLowerCase();

                // 如果文件类型未知，但扩展名是 .md，则将其视为纯文本
                if (!fileTypeHint && fileExtension === '.md') {
                    fileTypeHint = 'text/plain';
                    console.log(`[Main - handle-file-drop] Markdown file detected. Overriding fileTypeHint to 'text/plain'.`);
                }

                console.log(`[Main - handle-file-drop] Attempting to store dropped file: ${fileData.name} (Type: ${fileTypeHint}, Size: ${fileData.size}) for Agent: ${agentId}, Topic: ${topicId}`);
                const fileBuffer = Buffer.isBuffer(fileData.data) ? fileData.data : Buffer.from(fileData.data);

                console.log(`[Main - handle-file-drop] Calling fileManager.storeFile with buffer for ${fileData.name}, size: ${fileBuffer.length}`);
                const storedFile = await fileManager.storeFile(fileBuffer, fileData.name, agentId, topicId, fileTypeHint);
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
ipcMain.handle('send-to-vcp', async (event, vcpUrl, vcpApiKey, messages, modelConfig, messageId, isGroupCall = false, groupContext = null) => {
        console.log(`[Main - sendToVCP] ***** sendToVCP HANDLER EXECUTED for messageId: ${messageId}, isGroupCall: ${isGroupCall} *****`);
        const streamChannel = isGroupCall ? 'vcp-group-stream-chunk' : 'vcp-stream-chunk';
        try {
            // --- Agent Music Control Injection ---
            if (getMusicState) {
                const settingsPath = path.join(APP_DATA_ROOT_IN_PROJECT, 'settings.json');
                try {
                    const settings = await fs.readJson(settingsPath);
                    if (settings.agentMusicControl) {
                        const { musicWindow, currentSongInfo } = getMusicState();
                        const topParts = [];
                        const bottomParts = [];

                        // 1. 构建播放列表信息 (注入到顶部)
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

                        // 2. 构建注入到底部的信息
                        // 2a. 插件权限
                        bottomParts.push(`点歌台{{VCPMusicController}}`);

                        // 2b. 当前歌曲信息 (仅当播放器打开且有歌曲信息时)
                        if (musicWindow && !musicWindow.isDestroyed() && currentSongInfo) {
                            bottomParts.push(`[当前播放音乐：${currentSongInfo.title} - ${currentSongInfo.artist} (${currentSongInfo.album || '未知专辑'})]`);
                        }

                        // 3. 组合并注入到消息数组
                        if (topParts.length > 0 || bottomParts.length > 0) {
                            let systemMsgIndex = messages.findIndex(m => m.role === 'system');
                            let originalContent = '';

                            if (systemMsgIndex !== -1) {
                                originalContent = messages[systemMsgIndex].content;
                            } else {
                                // 如果没有系统消息，则创建一个以便注入
                                messages.unshift({ role: 'system', content: '' });
                                systemMsgIndex = 0;
                            }
                            
                            const finalParts = [];
                            if (topParts.length > 0) finalParts.push(topParts.join('\n'));
                            if (originalContent) finalParts.push(originalContent);
                            if (bottomParts.length > 0) finalParts.push(bottomParts.join('\n'));

                            // 用换行符连接各个部分，确保格式正确
                            messages[systemMsgIndex].content = finalParts.join('\n\n').trim();
                        }
                    }
                } catch (e) {
                    console.error('[Agent Music Control] Failed to inject music info:', e);
                }
            }
            // --- End of Injection ---

            console.log(`发送到VCP服务器: ${vcpUrl} for messageId: ${messageId}`);
            console.log('VCP API Key:', vcpApiKey ? '已设置' : '未设置');
            console.log('模型配置:', modelConfig);
            if (isGroupCall) console.log('群聊上下文:', groupContext);
    
            const response = await fetch(vcpUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${vcpApiKey}`
                },
                body: JSON.stringify({
                    messages: messages,
                    model: modelConfig.model,
                    temperature: modelConfig.temperature,
                    stream: modelConfig.stream === true
                })
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
                
                const errorMessageToPropagate = `VCP请求失败: ${response.status} - ${errorData.message || errorData.error || (typeof errorData === 'string' ? errorData : '未知服务端错误')}`;
                
                if (modelConfig.stream === true && event && event.sender && !event.sender.isDestroyed()) {
                    // 构造更详细的错误信息
                    let detailedErrorMessage = `服务器返回状态 ${response.status}.`;
                    if (errorData && errorData.message) detailedErrorMessage += ` 错误: ${errorData.message}`;
                    else if (errorData && errorData.error && errorData.error.message) detailedErrorMessage += ` 错误: ${errorData.error.message}`;
                    else if (typeof errorData === 'string' && errorData.length < 200) detailedErrorMessage += ` 响应: ${errorData}`;
                    else if (errorData && errorData.details && typeof errorData.details === 'string' && errorData.details.length < 200) detailedErrorMessage += ` 详情: ${errorData.details}`;
    
                    const errorPayload = { type: 'error', error: `VCP请求失败: ${detailedErrorMessage}`, details: errorData, messageId: messageId }; // details 字段保持原始 errorData
                    if (isGroupCall && groupContext) {
                        Object.assign(errorPayload, groupContext); // Add agentId, agentName, groupId, topicId
                    }
                    event.sender.send(streamChannel, errorPayload);
                    // 为函数返回值构造统一的 errorDetail.message
                    const finalErrorMessageForReturn = `VCP请求失败: ${response.status} - ${errorData.message || (errorData.error && errorData.error.message) || (typeof errorData === 'string' ? errorData : '详细错误请查看控制台')}`;
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
                    const streamChannel = isGroupCall ? 'vcp-group-stream-chunk' : 'vcp-stream-chunk';

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
                                        const donePayload = { type: 'end', messageId: messageId };
                                        if (isGroupCall && groupContext) {
                                            Object.assign(donePayload, groupContext);
                                        }
                                        event.sender.send(streamChannel, donePayload);
                                        return; // [DONE] 是明确的结束信号，退出函数
                                    }
                                    try {
                                        const parsedChunk = JSON.parse(jsonData);
                                        const dataPayload = { type: 'data', chunk: parsedChunk, messageId: messageId };
                                        if (isGroupCall && groupContext) {
                                            Object.assign(dataPayload, groupContext);
                                        }
                                        event.sender.send(streamChannel, dataPayload);
                                    } catch (e) {
                                        console.error(`解析VCP流数据块JSON失败 for messageId: ${messageId}:`, e, '原始数据:', jsonData);
                                        const errorChunkPayload = { type: 'data', chunk: { raw: jsonData, error: 'json_parse_error' }, messageId: messageId };
                                        if (isGroupCall && groupContext) {
                                            Object.assign(errorChunkPayload, groupContext);
                                        }
                                        event.sender.send(streamChannel, errorChunkPayload);
                                    }
                                }
                            }

                            if (done) {
                                // 流因连接关闭而结束，而不是[DONE]消息。
                                // 缓冲区已被处理，现在发送最终的 'end' 信号。
                                console.log(`VCP流结束 for messageId: ${messageId}`);
                                const endPayload = { type: 'end', messageId: messageId };
                                if (isGroupCall && groupContext) {
                                    Object.assign(endPayload, groupContext);
                                }
                                event.sender.send(streamChannel, endPayload);
                                break; // 退出 while 循环
                            }
                        }
                    } catch (streamError) {
                        console.error(`VCP流读取错误 for messageId: ${messageId}:`, streamError);
                        const streamErrPayload = { type: 'error', error: `VCP流读取错误: ${streamError.message}`, messageId: messageId };
                        if (isGroupCall && groupContext) {
                            Object.assign(streamErrPayload, groupContext);
                        }
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
                return vcpResponse; // Return full response for non-streaming
            }
    
        } catch (error) {
            console.error('VCP请求错误 (catch block):', error);
            if (modelConfig.stream === true && event && event.sender && !event.sender.isDestroyed()) {
                const catchErrorPayload = { type: 'error', error: `VCP请求错误: ${error.message}`, messageId: messageId };
                if (isGroupCall && groupContext) {
                    Object.assign(catchErrorPayload, groupContext);
                }
                event.sender.send(streamChannel, catchErrorPayload);
                return { streamError: true, error: `VCP客户端请求错误`, errorDetail: { message: error.message, stack: error.stack } };
            }
            return { error: `VCP请求错误: ${error.message}` };
        }
    });
}

module.exports = {
    initialize
};