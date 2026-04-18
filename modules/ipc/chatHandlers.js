// modules/ipc/chatHandlers.js
const { ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const contextSanitizer = require('../contextSanitizer');
const { getAgentConfigById } = require('./agentHandlers');

}

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
            return { success: false, error: '鏃犳晥鐨?agentId 鎴?topic IDs' };
        }
        try {
            if (agentConfigManager) {
                await agentConfigManager.updateAgentConfig(agentId, config => {
                    if (!config.topics || !Array.isArray(config.topics)) {
                        console.error(`淇濆瓨Agent ${agentId} 鐨勮瘽棰橀『搴忓け璐? 閰嶇疆鏂囦欢鎹熷潖鎴栫己灏戣瘽棰樺垪琛ㄣ€俙);
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
                return { success: false, error: 'AgentConfigManager 鏈垵濮嬪寲锛屾棤娉曞畨鍏ㄤ繚瀛樿瘽棰橀『搴忋€? };
            }
            return { success: true };
        } catch (error) {
            console.error(`Error saving topic order for agent ${agentId}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('save-group-topic-order', async (event, groupId, orderedTopicIds) => {
        if (!groupId || !Array.isArray(orderedTopicIds)) {
            return { success: false, error: '鏃犳晥鐨?groupId 鎴?topic IDs' };
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
        if (!topicId || !newTitle) return { error: "淇濆瓨璇濋鏍囬澶辫触: topicId 鎴?newTitle 鏈彁渚涖€? };
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
                return { error: 'AgentConfigManager 鏈垵濮嬪寲锛屾棤娉曞畨鍏ㄤ繚瀛樿瘽棰樻爣棰樸€? };
            }
        } catch (error) {
            console.error(`淇濆瓨Agent ${agentId} 璇濋 ${topicId} 鏍囬涓?"${newTitle}" 澶辫触:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('get-chat-history', async (event, agentId, topicId) => {
        if (!topicId) return { error: `鑾峰彇Agent ${agentId} 鑱婂ぉ鍘嗗彶澶辫触: topicId 鏈彁渚涖€俙 };
        try {
            const historyFile = path.join(USER_DATA_DIR, agentId, 'topics', topicId, 'history.json');
            await fs.ensureDir(path.dirname(historyFile));


            if (await fs.pathExists(historyFile)) {
                return await fs.readJson(historyFile);
            }
            return [];
        } catch (error) {
            console.error(`鑾峰彇Agent ${agentId} 璇濋 ${topicId} 鑱婂ぉ鍘嗗彶澶辫触:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('save-chat-history', async (event, agentId, topicId, history) => {
        if (!topicId) return { error: `淇濆瓨Agent ${agentId} 鑱婂ぉ鍘嗗彶澶辫触: topicId 鏈彁渚涖€俙 };
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
            console.error(`淇濆瓨Agent ${agentId} 璇濋 ${topicId} 鑱婂ぉ鍘嗗彶澶辫触:`, error);
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
                    console.error(`璇诲彇Agent ${agentId} 鐨勯厤缃け璐?(get-agent-topics):`, readError);
                    return { error: `璇诲彇閰嶇疆鏂囦欢澶辫触: ${readError.message}` };
                }
            } else {
                const configPath = path.join(AGENT_DIR, agentId, 'config.json');
                if (await fs.pathExists(configPath)) {
                    try {
                        config = await fs.readJson(configPath);
                    } catch (readError) {
                        console.error(`璇诲彇Agent ${agentId} 鐨?config.json 澶辫触:`, readError);
                        return { error: `璇诲彇閰嶇疆鏂囦欢澶辫触: ${readError.message}` };
                    }
                }
            }

            if (config && config.topics && Array.isArray(config.topics)) {
                // Part A: 鍘嗗彶鏁版嵁鍏煎澶勭悊 - 鑷姩涓虹己灏戞柊瀛楁鐨勮瘽棰樻坊鍔犻粯璁ゅ€?
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
            console.error(`鑾峰彇Agent ${agentId} 璇濋鍒楄〃鏃跺彂鐢熸剰澶栭敊璇?`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('create-new-topic-for-agent', async (event, agentId, topicName, isBranch = false, locked = true) => {
        try {
            const newTopicId = `topic_${Date.now()}`;
            const timestamp = Date.now();

            if (agentConfigManager) {
                // 鍏堣鍙栧綋鍓嶉厤缃互纭畾璇濋鍛藉悕搴忓彿
                const currentConfig = await agentConfigManager.readAgentConfig(agentId, { allowDefault: true });
                if (currentConfig.topics && !Array.isArray(currentConfig.topics)) {
                    return { error: `閰嶇疆鏂囦欢宸叉崯鍧? 'topics' 瀛楁涓嶆槸涓€涓暟缁勩€俙 };
                }
                const existingTopics = currentConfig.topics || [];

                const newTopic = {
                    id: newTopicId,
                    name: topicName || `鏂拌瘽棰?${existingTopics.length + 1}`,
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
                return { error: 'AgentConfigManager 鏈垵濮嬪寲锛屾棤娉曞畨鍏ㄥ垱寤鸿瘽棰樸€? };
            }
        } catch (error) {
            console.error(`涓篈gent ${agentId} 鍒涘缓鏂拌瘽棰樺け璐?`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('delete-topic', async (event, agentId, topicIdToDelete) => {
        try {
            if (agentConfigManager) {
                // 鍏堣鍙栧綋鍓嶉厤缃繘琛岄獙璇?
                const currentConfig = await agentConfigManager.readAgentConfig(agentId);
                if (!currentConfig.topics || !Array.isArray(currentConfig.topics)) {
                    return { error: `閰嶇疆鏂囦欢鎹熷潖鎴栫己灏戣瘽棰樺垪琛ㄣ€俙 };
                }
                if (!currentConfig.topics.some(t => t.id === topicIdToDelete)) {
                    return { error: `鏈壘鍒拌鍒犻櫎鐨勮瘽棰?ID: ${topicIdToDelete}` };
                }

                let remainingTopics;
                await agentConfigManager.updateAgentConfig(agentId, existingConfig => {
                    let filtered = (existingConfig.topics || []).filter(topic => topic.id !== topicIdToDelete);
                    if (filtered.length === 0) {
                        filtered = [{ id: "default", name: "涓昏瀵硅瘽", createdAt: Date.now() }];
                    }
                    remainingTopics = filtered;
                    return { ...existingConfig, topics: filtered };
                });

                // 濡傛灉鍒犵┖浜嗗苟鍒涘缓浜嗛粯璁よ瘽棰橈紝纭繚鍏?history 鐩綍瀛樺湪
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
                return { error: 'AgentConfigManager 鏈垵濮嬪寲锛屾棤娉曞畨鍏ㄥ垹闄よ瘽棰樸€? };
            }
        } catch (error) {
            console.error(`鍒犻櫎Agent ${agentId} 鐨勮瘽棰?${topicIdToDelete} 澶辫触:`, error);
            return { error: error.message };
        }
    });

    ipcMain.handle('handle-file-paste', async (event, agentId, topicId, fileData) => {
        if (!topicId) return { error: "澶勭悊鏂囦欢绮樿创澶辫触: topicId 鏈彁渚涖€? };
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
                throw new Error('涓嶆敮鎸佺殑鏂囦欢绮樿创绫诲瀷');
            }
            return { success: true, attachment: storedFileObject };
        } catch (error) {
            console.error('澶勭悊绮樿创鏂囦欢澶辫触:', error);
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
            title: '閫夋嫨瑕佸彂閫佺殑鏂囦欢',
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
        if (!agentId || !topicId) return { error: "澶勭悊闀挎枃鏈矘璐村け璐? agentId 鎴?topicId 鏈彁渚涖€? };
        if (typeof textContent !== 'string') return { error: "澶勭悊闀挎枃鏈矘璐村け璐? 鏃犳晥鐨勬枃鏈唴瀹广€? };

        try {
            const originalFileName = `pasted_text_${Date.now()}.txt`;
            const buffer = Buffer.from(textContent, 'utf8');
            const fileManager = require('../fileManager');
            const storedFileObject = await fileManager.storeFile(buffer, originalFileName, agentId, topicId, 'text/plain');
            return { success: true, attachment: storedFileObject };
        } catch (error) {
            console.error('[Main - handle-text-paste-as-file] 闀挎枃鏈浆瀛樹负鏂囦欢澶辫触:', error);
            return { error: `闀挎枃鏈浆瀛樹负鏂囦欢澶辫触: ${error.message}` };
        }
    });

    ipcMain.handle('handle-file-drop', async (event, agentId, topicId, droppedFilesData) => {
        if (!agentId || !topicId) return { error: "澶勭悊鏂囦欢鎷栨斁澶辫触: agentId 鎴?topicId 鏈彁渚涖€? };
        if (!Array.isArray(droppedFilesData) || droppedFilesData.length === 0) return { error: "澶勭悊鏂囦欢鎷栨斁澶辫触: 鏈彁渚涙枃浠舵暟鎹€? };

        const storedFilesInfo = [];
        for (const fileData of droppedFilesData) {
            try {
                // Check if we have a path or data. One of them must exist.
                if (!fileData.data && !fileData.path) {
                    console.warn('[Main - handle-file-drop] Skipping a dropped file due to missing data and path. fileData:', JSON.stringify(fileData));
                    storedFilesInfo.push({ name: fileData.name || '鏈煡鏂囦欢', error: '鏂囦欢鍐呭鎴栬矾寰勭己澶? });
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
                storedFilesInfo.push({ name: fileData.name || '鏈煡鏂囦欢', error: error.message });
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
            return { success: false, error: '鏃犳晥鐨勫弬鏁? };
        }

        try {
            let historyFile;
            if (itemType === 'agent') {
                historyFile = path.join(USER_DATA_DIR, itemId, 'topics', topicId, 'history.json');
            } else if (itemType === 'group') {
                historyFile = path.join(USER_DATA_DIR, itemId, 'topics', topicId, 'history.json');
            } else {
                return { success: false, error: '涓嶆敮鎸佺殑椤圭洰绫诲瀷' };
            }

            if (await fs.pathExists(historyFile)) {
                const history = await fs.readJson(historyFile);
                const message = history.find(m => m.id === messageId);
                if (message) {
                    return { success: true, content: message.content };
                } else {
                    return { success: false, error: '鍦ㄥ巻鍙茶褰曚腑鏈壘鍒拌娑堟伅' };
                }
            } else {
                return { success: false, error: '鑱婂ぉ鍘嗗彶鏂囦欢涓嶅瓨鍦? };
            }
        } catch (error) {
            console.error(`鑾峰彇鍘熷娑堟伅鍐呭澶辫触 (itemId: ${itemId}, topicId: ${topicId}, messageId: ${messageId}):`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-to-vcp', async (event, vcpUrl, vcpApiKey, messages, modelConfig, messageId, isGroupCall = false, context = null) => {
        const streamChannel = 'vcp-stream-event'; // Use a single, unified channel for all stream events.

        // 馃敡 鏁版嵁楠岃瘉鍜岃鑼冨寲
        try {
            // 纭繚messages鏁扮粍涓殑content閮芥槸姝ｇ‘鐨勬牸寮?
            messages = messages.map(msg => {
                if (!msg || typeof msg !== 'object') {
                    console.error('[Main - sendToVCP] Invalid message object:', msg);
                    return { role: 'system', content: '[Invalid message]' };
                }

                let processedContent = msg.content;

                // 濡傛灉content鏄璞★紝灏濊瘯鎻愬彇text瀛楁鎴栬浆涓篔SON瀛楃涓?
                if (msg.content && typeof msg.content === 'object') {
                    if (msg.content.text) {
                        processedContent = String(msg.content.text);
                    } else if (Array.isArray(msg.content)) {
                        // 濡傛灉鏄粎鍖呭惈涓€涓枃鏈儴鍒嗙殑澶氭ā鎬佹秷鎭紝鍒欏皢鍏剁畝鍖栦负绾瓧绗︿覆锛屼繚鎸佸吋瀹?
                        if (msg.content.length === 1 && msg.content[0].type === 'text' && typeof msg.content[0].text === 'string') {
                            processedContent = msg.content[0].text;
                        } else {
                            // 淇濇寔澶氭ā鎬佹暟缁勫師鏍?
                            processedContent = msg.content;
                        }
                    } else {
                        // 鍚﹀垯杞负JSON瀛楃涓?
                        console.warn('[Main - sendToVCP] Message content is object without text field, stringifying:', msg.content);
                        processedContent = JSON.stringify(msg.content);
                    }
                }

                // 寮哄埗杞崲涓哄瓧绗︿覆锛堥櫎闈炴槸澶氭ā鎬佹暟缁勶級
                if (processedContent && !Array.isArray(processedContent) && typeof processedContent !== 'string') {
                    processedContent = String(processedContent);
                }

                // 馃洝锔?涓ユ牸鑴辨晱锛氬彧杩斿洖鐢?OpenAI/Gemini/Anthropic 绛?API 瑙勮寖瀹氫箟鐨勫悎娉曞瓧娈?
                // 鍓旈櫎 attachments, isThinking 绛夐潪鏍囩鏈夊厓鏁版嵁锛岄槻姝㈡硠闇茬粰妯″瀷
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
            return { error: `娑堟伅鏍煎紡楠岃瘉澶辫触: ${validationError.message}` };
        }

        let finalVcpUrl = vcpUrl;
        let settings = {};
        try {
            const settingsPath = path.join(APP_DATA_ROOT_IN_PROJECT, 'settings.json');
            if (await fs.pathExists(settingsPath)) {
                settings = await fs.readJson(settingsPath);
            }

            // **寮哄埗妫€鏌ュ拰鍒囨崲URL**
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

                    // 1. 濮嬬粓娉ㄥ叆褰撳墠鎾斁鐨勬瓕鏇蹭俊鎭紙濡傛灉瀛樺湪锛?
                    if (currentSongInfo) {
                        bottomParts.push(`[褰撳墠鎾斁闊充箰锛?{currentSongInfo.title} - ${currentSongInfo.artist} (${currentSongInfo.album || '鏈煡涓撹緫'})]`);
                    }

                    // 2. 濡傛灉鍚敤浜嗛煶涔愭帶鍒讹紝鍒欐敞鍏ユ挱鏀惧垪琛ㄥ拰鎺у埗鍣?
                    if (settings.agentMusicControl) {
                        // 2a. 鏋勫缓鎾斁鍒楄〃淇℃伅 (娉ㄥ叆鍒伴《閮?
                        const songlistPath = path.join(APP_DATA_ROOT_IN_PROJECT, 'songlist.json');
                        if (await fs.pathExists(songlistPath)) {
                            const songlistJson = await fs.readJson(songlistPath);
                            if (Array.isArray(songlistJson) && songlistJson.length > 0) {
                                const titles = songlistJson.map(song => song.title).filter(Boolean);
                                if (titles.length > 0) {
                                    topParts.push(`[鎾斁鍒楄〃鈥斺€擻n${titles.join('\n')}\n]`);
                                }
                            }
                        }

                        // 2b. 娉ㄥ叆鎻掍欢鏉冮檺
                        bottomParts.push(`鐐规瓕鍙皗{VCPMusicController}}`);
                    }

                    // 3. 缁勫悎骞舵敞鍏ュ埌娑堟伅鏁扮粍
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

                    const injection = '杈撳嚭瑙勮寖瑕佹眰锛歿{VarDivRender}}';
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
                // 榛樿涓嶆敞鍏ュ厓鎬濊€冮摼锛岄櫎闈炴槑纭紑鍚?
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

                    // 鍙鐞嗛潪绯荤粺娑堟伅锛堟帓闄?system role锛?
                    const systemMessages = messages.filter(m => m.role === 'system');
                    const nonSystemMessages = messages.filter(m => m.role !== 'system');

                    // 瀵归潪绯荤粺娑堟伅搴旂敤鍑€鍖?
                    const sanitizedNonSystemMessages = contextSanitizer.sanitizeMessages(
                        nonSystemMessages,
                        sanitizerDepth,
                        settings.enableThoughtChainInjection === true
                    );

                    // 閲嶆柊缁勫悎娑堟伅鏁扮粍锛堜繚鎸佺郴缁熸秷鎭湪鏈€鍓嶉潰锛?
                    messages = [...systemMessages, ...sanitizedNonSystemMessages];

                    console.log(`[Context Sanitizer] Messages processed successfully`);
                }
            } catch (sanitizerError) {
                console.error('[Context Sanitizer] Error during sanitization, proceeding with original messages:', sanitizerError);
                // 鍑洪敊鏃剁户缁娇鐢ㄥ師濮嬫秷鎭紝涓嶅奖鍝嶆甯告祦绋?
            }
            // --- End of Context Sanitizer Integration ---

            console.log(`鍙戦€佸埌VCP鏈嶅姟鍣? ${finalVcpUrl} for messageId: ${messageId}`);
            console.log('VCP API Key:', vcpApiKey ? '宸茶缃? : '鏈缃?);
            console.log('妯″瀷閰嶇疆:', modelConfig);
            if (context) console.log('涓婁笅鏂?', context);

            // 琛ュ叏缂哄け鐨?agentName (鍓嶇 UI 鍙兘鏈紶閫掓纭殑鍙鍚嶇О)
            if (context && context.agentId && (!context.agentName || context.agentName === context.agentId)) {
                try {
                    const agentConfig = await getAgentConfigById(context.agentId);
                    if (agentConfig && !agentConfig.error && agentConfig.name) {
                        context.agentName = agentConfig.name;
                        
                    }
                } catch (e) {

                }
            }

            // 馃敡 鍦ㄥ彂閫佸墠楠岃瘉璇锋眰浣?
            const requestBody = {
                messages: messages,
                ...modelConfig,
                stream: modelConfig.stream === true,
                requestId: messageId,
                ...(context ? { context } : {}),
                ...(context?.agentName ? { agentName: context.agentName } : {}),
                ...(context?.agentId ? { agentId: context.agentId } : {}),
                ...(context?.topicId ? { topicId: context.topicId } : {})
            };

            

            // 馃敟 璁板綍妯″瀷浣跨敤棰戠巼
            try {
                if (modelConfig && modelConfig.model) {
                    const modelUsageTracker = require('../modelUsageTracker');
                    await modelUsageTracker.recordModelUsage(modelConfig.model);
                }
            } catch (e) {
                console.error('[ModelUsage] Failed to record model usage:', e);
            }

            // 楠岃瘉JSON鍙簭鍒楀寲鎬?
            let serializedBody;
            try {
                serializedBody = JSON.stringify(requestBody);
                // 璋冭瘯锛氳褰曞墠100涓瓧绗?
                console.log('[Main - sendToVCP] Request body preview:', serializedBody.substring(0, 100) + '...');
            } catch (serializeError) {
                console.error('[Main - sendToVCP] Failed to serialize request body:', serializeError);
                console.error('[Main - sendToVCP] Problematic request body:', requestBody);
                return { error: `璇锋眰浣撳簭鍒楀寲澶辫触: ${serializeError.message}` };
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
                console.error(`[Main - sendToVCP] VCP璇锋眰澶辫触. Status: ${response.status}, Response Text:`, errorText);
                let errorData = { message: `鏈嶅姟鍣ㄨ繑鍥炵姸鎬?${response.status}`, details: errorText };
                try {
                    const parsedError = JSON.parse(errorText);
                    if (typeof parsedError === 'object' && parsedError !== null) {
                        errorData = parsedError;
                    }
                } catch (e) { /* Not JSON, use raw text */ }

                // 馃敡 鏀硅繘閿欒娑堟伅鏋勯€狅紝闃叉 [object Object]
                let errorMessage = '';
                if (errorData.message && typeof errorData.message === 'string') {
                    errorMessage = errorData.message;
                } else if (errorData.error) {
                    if (typeof errorData.error === 'string') {
                        errorMessage = errorData.error;
                    } else if (errorData.error.message && typeof errorData.error.message === 'string') {
                        errorMessage = errorData.error.message;
                    } else if (typeof errorData.error === 'object') {
                        // 濡傛灉error鏄璞★紝灏濊瘯JSON搴忓垪鍖?
                        errorMessage = JSON.stringify(errorData.error);
                    }
                } else if (typeof errorData === 'string') {
                    errorMessage = errorData;
                } else {
                    errorMessage = '鏈煡鏈嶅姟绔敊璇?;
                }

                const errorMessageToPropagate = `VCP璇锋眰澶辫触: ${response.status} - ${errorMessage}`;

                if (modelConfig.stream === true && event && event.sender && !event.sender.isDestroyed()) {
                    // 鏋勯€犳洿璇︾粏鐨勯敊璇俊鎭?
                    let detailedErrorMessage = `鏈嶅姟鍣ㄨ繑鍥炵姸鎬?${response.status}.`;
                    if (errorData && errorData.message && typeof errorData.message === 'string') {
                        detailedErrorMessage += ` 閿欒: ${errorData.message}`;
                    } else if (errorData && errorData.error && errorData.error.message && typeof errorData.error.message === 'string') {
                        detailedErrorMessage += ` 閿欒: ${errorData.error.message}`;
                    } else if (typeof errorData === 'string' && errorData.length < 200) {
                        detailedErrorMessage += ` 鍝嶅簲: ${errorData}`;
                    } else if (errorData && errorData.details && typeof errorData.details === 'string' && errorData.details.length < 200) {
                        detailedErrorMessage += ` 璇︽儏: ${errorData.details}`;
                    }

                    const errorPayload = { type: 'error', error: `VCP璇锋眰澶辫触: ${detailedErrorMessage}`, details: errorData, messageId: messageId };
                    if (context) errorPayload.context = context;
                    event.sender.send(streamChannel, errorPayload);
                    // 涓哄嚱鏁拌繑鍥炲€兼瀯閫犵粺涓€鐨?errorDetail.message
                    const finalErrorMessageForReturn = `VCP璇锋眰澶辫触: ${response.status} - ${errorMessage}`;
                    return { streamError: true, error: `VCP璇锋眰澶辫触 (${response.status})`, errorDetail: { message: finalErrorMessageForReturn, originalData: errorData } };
                }
                const err = new Error(errorMessageToPropagate);
                err.details = errorData;
                err.status = response.status;
                throw err;
            }

            if (modelConfig.stream === true) {
                console.log(`VCP鍝嶅簲: 寮€濮嬫祦寮忓鐞?for ${messageId} on channel ${streamChannel}`);
                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                // 銆愬叏鏂扮殑銆佷慨姝ｅ悗鐨?processStream 鍑芥暟銆?
                // 瀹冪幇鍦ㄦ帴鏀?reader 鍜?decoder 浣滀负鍙傛暟
                async function processStream(reader, decoder) {
                    let buffer = '';

                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (value) {
                                buffer += decoder.decode(value, { stream: true });
                            }

                            const lines = buffer.split('\n');

                            // 濡傛灉娴佸凡缁撴潫锛屽垯澶勭悊鎵€鏈夎銆傚惁鍒欙紝淇濈暀鏈€鍚庝竴琛岋紙鍙兘涓嶅畬鏁达級銆?
                            buffer = done ? '' : lines.pop();

                            for (const line of lines) {
                                if (line.trim() === '') continue;

                                if (line.startsWith('data: ')) {
                                    const jsonData = line.substring(5).trim();
                                    if (jsonData === '[DONE]') {
                                        console.log(`VCP娴佹槑纭甗DONE] for messageId: ${messageId}`);
                                        const donePayload = { type: 'end', messageId: messageId, context };
                                        event.sender.send(streamChannel, donePayload);
                                        return; // [DONE] 鏄槑纭殑缁撴潫淇″彿锛岄€€鍑哄嚱鏁?
                                    }
                                    // 濡傛灉 jsonData 涓虹┖锛屽垯蹇界暐璇ヨ锛岃繖鍙兘鏄綉缁滄尝鍔ㄦ垨蹇冭烦淇″彿
                                    if (jsonData === '') {
                                        continue;
                                    }
                                    try {
                                        const parsedChunk = JSON.parse(jsonData);
                                        const dataPayload = { type: 'data', chunk: parsedChunk, messageId: messageId, context };
                                        event.sender.send(streamChannel, dataPayload);
                                    } catch (e) {
                                        console.error(`瑙ｆ瀽VCP娴佹暟鎹潡JSON澶辫触 for messageId: ${messageId}:`, e, '鍘熷鏁版嵁:', jsonData);
                                        const errorChunkPayload = { type: 'data', chunk: { raw: jsonData, error: 'json_parse_error' }, messageId: messageId, context };
                                        event.sender.send(streamChannel, errorChunkPayload);
                                    }
                                }
                            }

                            if (done) {
                                // 娴佸洜杩炴帴鍏抽棴鑰岀粨鏉燂紝鑰屼笉鏄痆DONE]娑堟伅銆?
                                // 缂撳啿鍖哄凡琚鐞嗭紝鐜板湪鍙戦€佹渶缁堢殑 'end' 淇″彿銆?
                                console.log(`VCP娴佺粨鏉?for messageId: ${messageId}`);
                                const endPayload = { type: 'end', messageId: messageId, context };
                                event.sender.send(streamChannel, endPayload);
                                break; // 閫€鍑?while 寰幆
                            }
                        }
                    } catch (streamError) {
                        console.error(`VCP娴佽鍙栭敊璇?for messageId: ${messageId}:`, streamError);
                        const streamErrPayload = { type: 'error', error: `VCP娴佽鍙栭敊璇? ${streamError.message}`, messageId: messageId };
                        if (context) streamErrPayload.context = context;
                        event.sender.send(streamChannel, streamErrPayload);
                    } finally {
                        reader.releaseLock();
                        console.log(`ReadableStream's lock released for messageId: ${messageId}`);
                    }
                }

                // 灏?reader 鍜?decoder 浣滀负鍙傛暟浼犻€掔粰 processStream
                // 骞朵笖鎴戜滑渚濈劧闇€瑕?await 鏉ョ瓑寰呮祦澶勭悊瀹屾垚
                processStream(reader, decoder).then(() => {
                    console.log(`[Main - sendToVCP] 娴佸鐞嗗嚱鏁?processStream 宸叉甯哥粨鏉?for ${messageId}`);
                }).catch(err => {
                    console.error(`[Main - sendToVCP] processStream 鍐呴儴鎶涘嚭鏈崟鑾风殑閿欒 for ${messageId}:`, err);
                });

                return { streamingStarted: true };
            } else { // Non-streaming
                console.log('VCP鍝嶅簲: 闈炴祦寮忓鐞?);
                const vcpResponse = await response.json();
                // For non-streaming, wrap the response with the original context
                // so the renderer knows where to save the history.
                return { response: vcpResponse, context };
            }

        } catch (error) {
            console.error('VCP璇锋眰閿欒 (catch block):', error);
            if (modelConfig.stream === true && event && event.sender && !event.sender.isDestroyed()) {
                const catchErrorPayload = { type: 'error', error: `VCP璇锋眰閿欒: ${error.message}`, messageId: messageId, context };
                event.sender.send(streamChannel, catchErrorPayload);
                return { streamError: true, error: `VCP瀹㈡埛绔姹傞敊璇痐, errorDetail: { message: error.message, stack: error.stack } };
            }
            return { error: `VCP璇锋眰閿欒: ${error.message}` };
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
     * Part C: 鏅鸿兘璁℃暟閫昏緫杈呭姪鍑芥暟
     * 鍒ゆ柇鏄惁搴旇婵€娲昏鏁?
     * 瑙勫垯锛氫笂涓嬫枃锛堟帓闄ょ郴缁熸秷鎭級鏈変笖鍙湁涓€涓?AI 鐨勫洖澶嶏紝涓旀病鏈夌敤鎴峰洖澶?
     * @param {Array} history - 娑堟伅鍘嗗彶
     * @returns {boolean}
     */
    function shouldActivateCount(history) {
        if (!history || history.length === 0) return false;

        // 杩囨护鎺夌郴缁熸秷鎭?
        const nonSystemMessages = history.filter(msg => msg.role !== 'system');

        // 蹇呴』鏈変笖鍙湁涓€鏉℃秷鎭紝涓旇娑堟伅鏄?AI 鍥炲
        return nonSystemMessages.length === 1 && nonSystemMessages[0].role === 'assistant';
    }

    /**
     * Part C: 璁＄畻鏈娑堟伅鏁伴噺
     * @param {Array} history - 娑堟伅鍘嗗彶
     * @returns {number}
     */
    function countUnreadMessages(history) {
        return shouldActivateCount(history) ? 1 : 0;
    }

    /**
     * Part C: 璁＄畻鍗曚釜璇濋鐨勬湭璇绘秷鎭暟
     * @param {Object} topic - 璇濋瀵硅薄
     * @param {Array} history - 璇濋鍘嗗彶娑堟伅
     * @returns {number} - 鏈娑堟伅鏁帮紝-1 琛ㄧず浠呮樉绀哄皬鐐?
     */
    function calculateTopicUnreadCount(topic, history) {
        // 浼樺厛妫€鏌ヨ嚜鍔ㄨ鏁版潯浠讹紙AI鍥炲浜嗕絾鐢ㄦ埛娌″洖锛?
        if (shouldActivateCount(history)) {
            const count = countUnreadMessages(history);
            if (count > 0) return count;
        }

        // 濡傛灉涓嶆弧瓒宠嚜鍔ㄨ鏁版潯浠讹紝浣嗚鎵嬪姩鏍囪涓烘湭璇伙紝鍒欐樉绀哄皬鐐?
        if (topic.unread === true) {
            return -1; // 浠呮樉绀哄皬鐐癸紝涓嶆樉绀烘暟瀛?
        }

        return 0; // 涓嶆樉绀?
    }

    ipcMain.handle('get-unread-topic-counts', async () => {
        const counts = {};
        try {
            const agentDirs = await fs.readdir(AGENT_DIR, { withFileTypes: true });
            for (const dirent of agentDirs) {
                if (dirent.isDirectory()) {
                    const agentId = dirent.name;
                    let totalCount = 0;
                    let hasUnreadMarker = false; // 鐢ㄤ簬鏍囪鏄惁鏈夋湭璇绘爣璁颁絾鏃犺鏁?
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
                                            // 鏈夋湭璇绘爣璁颁絾鏃犺鏁帮紝璁板綍杩欎釜鐘舵€?
                                            hasUnreadMarker = true;
                                        }
                                    } catch (readJsonError) {
                                        console.error(`璇诲彇 history.json 澶辫触: ${historyPath}`, readJsonError);
                                    }
                                }
                            }
                        }
                    }

                    // 濡傛灉鏈夎鏁帮紝鏄剧ず鏁板瓧
                    if (totalCount > 0) {
                        counts[agentId] = totalCount;
                    } else if (hasUnreadMarker) {
                        // 濡傛灉鍙湁鏈鏍囪娌℃湁璁℃暟锛岃繑鍥?0锛堝墠绔細璇嗗埆涓轰粎鏄剧ず灏忕偣锛?
                        counts[agentId] = 0;
                    }
                }
            }
            return { success: true, counts };
        } catch (error) {
            console.error('鑾峰彇鏈璇濋璁℃暟鏃跺嚭閿?', error);
            return { success: false, error: error.message, counts: {} };
        }
    });

    // Part A: 鍒囨崲璇濋閿佸畾鐘舵€?
    ipcMain.handle('toggle-topic-lock', async (event, agentId, topicId) => {
        try {
            const agentConfigPath = path.join(AGENT_DIR, agentId, 'config.json');
            if (!await fs.pathExists(agentConfigPath)) {
                return { success: false, error: `Agent ${agentId} 鐨勯厤缃枃浠朵笉瀛樺湪` };
            }

            let config;
            try {
                config = await fs.readJson(agentConfigPath);
            } catch (e) {
                console.error(`璇诲彇Agent ${agentId} 閰嶇疆鏂囦欢澶辫触 (toggle-topic-lock):`, e);
                return { success: false, error: `璇诲彇閰嶇疆鏂囦欢澶辫触: ${e.message}` };
            }

            if (!config.topics || !Array.isArray(config.topics)) {
                return { success: false, error: '閰嶇疆鏂囦欢鎹熷潖鎴栫己灏戣瘽棰樺垪琛? };
            }

            const topic = config.topics.find(t => t.id === topicId);
            if (!topic) {
                return { success: false, error: `鏈壘鍒拌瘽棰?${topicId}` };
            }

            // Part A: 鍘嗗彶鏁版嵁鍏煎 - 濡傛灉璇濋娌℃湁 locked 瀛楁锛岄粯璁よ缃负 true
            if (topic.locked === undefined) {
                topic.locked = true;
            }

            // 鍒囨崲閿佸畾鐘舵€?
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
                message: topic.locked ? '璇濋宸查攣瀹? : '璇濋宸茶В閿?
            };
        } catch (error) {
            console.error('[toggleTopicLock] Error:', error);
            return { success: false, error: error.message };
        }
    });

    // Part A: 璁剧疆璇濋鏈鐘舵€?
    ipcMain.handle('set-topic-unread', async (event, agentId, topicId, unread) => {
        try {
            const agentConfigPath = path.join(AGENT_DIR, agentId, 'config.json');
            if (!await fs.pathExists(agentConfigPath)) {
                return { success: false, error: `Agent ${agentId} 鐨勯厤缃枃浠朵笉瀛樺湪` };
            }

            let config;
            try {
                config = await fs.readJson(agentConfigPath);
            } catch (e) {
                console.error(`璇诲彇Agent ${agentId} 閰嶇疆鏂囦欢澶辫触 (set-topic-unread):`, e);
                return { success: false, error: `璇诲彇閰嶇疆鏂囦欢澶辫触: ${e.message}` };
            }

            if (!config.topics || !Array.isArray(config.topics)) {
                return { success: false, error: '閰嶇疆鏂囦欢鎹熷潖鎴栫己灏戣瘽棰樺垪琛? };
            }

            const topic = config.topics.find(t => t.id === topicId);
            if (!topic) {
                return { success: false, error: `鏈壘鍒拌瘽棰?${topicId}` };
            }

            // Part A: 鍘嗗彶鏁版嵁鍏煎 - 濡傛灉璇濋娌℃湁 unread 瀛楁锛岄粯璁よ缃负 false
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
