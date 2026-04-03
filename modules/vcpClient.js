// modules/vcpClient.js - 统一的 VCP 请求处理模块
const fs = require('fs-extra');
const path = require('path');

// 全局的 AbortController 映射：messageId -> AbortController
const activeRequests = new Map();

// 模块配置（将在初始化时设置）
let moduleConfig = {
    APP_DATA_ROOT_IN_PROJECT: null,
    getMusicState: null
};

/**
 * 初始化 VCP 客户端模块
 * @param {object} config - 配置对象
 */
function initialize(config) {
    moduleConfig = {
        APP_DATA_ROOT_IN_PROJECT: config.APP_DATA_ROOT_IN_PROJECT,
        getMusicState: config.getMusicState
    };
    console.log('[VCPClient] Initialized successfully.');
}

/**
 * 统一的 VCP 请求函数
 * @param {object} params - 请求参数
 * @param {string} params.vcpUrl - VCP服务器URL
 * @param {string} params.vcpApiKey - API密钥
 * @param {array} params.messages - 消息数组
 * @param {object} params.modelConfig - 模型配置
 * @param {string} params.messageId - 消息ID（用于中止）
 * @param {object} params.context - 上下文信息（agentId, topicId等）
 * @param {object} params.webContents - The webContents of the main window for sending events.
 * @param {string} params.streamChannel - 流式数据频道名称
 * @param {function} [params.onStreamEnd] - (optional) Callback for when stream ends, receives { success, content, error }
 * @returns {Promise<object>} - 返回响应对象
 */
async function sendToVCP(params) {
    const {
        vcpUrl,
        vcpApiKey,
        messages: originalMessages,
        modelConfig,
        messageId,
        context = null,
        webContents = null,
        streamChannel = 'vcp-stream-event',
        onStreamEnd = null
    } = params;

    console.log(`[VCPClient] sendToVCP called for messageId: ${messageId}, context:`, context);

    let messages = [...originalMessages]; // 创建副本以避免修改原始数组

    // === 数据验证和规范化 ===
    try {
        messages = messages.map(msg => {
            if (!msg || typeof msg !== 'object') {
                console.error('[VCPClient] Invalid message object:', msg);
                return { role: 'system', content: '[Invalid message]' };
            }
            
            let processedContent = msg.content;
            
            if (msg.content && typeof msg.content === 'object') {
                if (msg.content.text) {
                    processedContent = String(msg.content.text);
                } else if (Array.isArray(msg.content)) {
                    // Always keep content as an array for multimodal messages, even if it's just text.
                    // This ensures consistency for endpoints that expect an array.
                    processedContent = msg.content;
                } else {
                    console.warn('[VCPClient] Message content is object without text field, stringifying:', msg.content);
                    processedContent = JSON.stringify(msg.content);
                }
            }
            
            if (processedContent && !Array.isArray(processedContent) && typeof processedContent !== 'string') {
                processedContent = String(processedContent);
            }
            
            // 🛡️ 严格脱敏：只返回由 OpenAI/Gemini 等 API 规范要求的字段
            // 剔除 attachments, isThinking 等私有元数据，防止泄露给模型
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
        console.error('[VCPClient] Error validating messages:', validationError);
        return { error: `消息格式验证失败: ${validationError.message}` };
    }

    // === URL 切换（根据工具注入设置）===
    let finalVcpUrl = vcpUrl;
    let settings = {};
    try {
        const settingsPath = path.join(moduleConfig.APP_DATA_ROOT_IN_PROJECT, 'settings.json');
        if (await fs.pathExists(settingsPath)) {
            settings = await fs.readJson(settingsPath);
        }

        if (settings.enableVcpToolInjection === true) {
            const urlObject = new URL(vcpUrl);
            urlObject.pathname = '/v1/chatvcp/completions';
            finalVcpUrl = urlObject.toString();
            console.log(`[VCPClient] VCP tool injection is ON. URL switched to: ${finalVcpUrl}`);
        } else {
            console.log(`[VCPClient] VCP tool injection is OFF. Using original URL: ${vcpUrl}`);
        }
    } catch (e) {
        console.error(`[VCPClient] Error reading settings or switching URL: ${e.message}. Proceeding with original URL.`);
    }

    // === 音乐控制注入 ===
    if (moduleConfig.getMusicState) {
        try {
            const { musicWindow, currentSongInfo } = moduleConfig.getMusicState();
            const topParts = [];
            const bottomParts = [];

            if (currentSongInfo) {
                bottomParts.push(`[当前播放音乐：${currentSongInfo.title} - ${currentSongInfo.artist} (${currentSongInfo.album || '未知专辑'})]`);
            }

            if (settings.agentMusicControl) {
                const songlistPath = path.join(moduleConfig.APP_DATA_ROOT_IN_PROJECT, 'songlist.json');
                if (await fs.pathExists(songlistPath)) {
                    const songlistJson = await fs.readJson(songlistPath);
                    if (Array.isArray(songlistJson) && songlistJson.length > 0) {
                        const titles = songlistJson.map(song => song.title).filter(Boolean);
                        if (titles.length > 0) {
                            topParts.push(`[播放列表——\n${titles.join('\n')}\n]`);
                        }
                    }
                }
                bottomParts.push(`点歌台{{VCPMusicController}}`);
            }

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
            console.error('[VCPClient] Failed to inject music info:', e);
        }
    }

    // === Agent Bubble Theme 注入 ===
    try {
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
        console.error('[VCPClient] Failed to inject bubble theme info:', e);
    }

    // === 准备请求体 ===
    const requestBody = {
        messages: messages,
        ...modelConfig,
        stream: modelConfig.stream === true,
        requestId: messageId
    };

    let serializedBody;
    try {
        serializedBody = JSON.stringify(requestBody);
        console.log('[VCPClient] Request body preview:', serializedBody.substring(0, 100) + '...');
    } catch (serializeError) {
        console.error('[VCPClient] Failed to serialize request body:', serializeError);
        return { error: `请求体序列化失败: ${serializeError.message}` };
    }

    // === 创建 AbortController 并注册 ===
    const controller = new AbortController();
    activeRequests.set(messageId, controller);
    console.log(`[VCPClient] Registered AbortController for messageId: ${messageId}. Active requests: ${activeRequests.size}`);

    // 设置超时（300秒，适应长推理模型和流式传输）
    const timeoutId = setTimeout(() => {
        console.log(`[VCPClient] Timeout triggered for messageId: ${messageId} (300s limit reached)`);
        controller.abort();
    }, 300000);

    try {
        console.log(`[VCPClient] Sending request to: ${finalVcpUrl}`);
        const response = await fetch(finalVcpUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${vcpApiKey}`
            },
            body: serializedBody,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[VCPClient] VCP request failed. Status: ${response.status}, Response Text:`, errorText);
            
            let errorData = { message: `服务器返回状态 ${response.status}`, details: errorText };
            try {
                const parsedError = JSON.parse(errorText);
                if (typeof parsedError === 'object' && parsedError !== null) {
                    errorData = parsedError;
                }
            } catch (e) { /* Not JSON */ }
            
            let errorMessage = '';
            if (errorData.message && typeof errorData.message === 'string') {
                errorMessage = errorData.message;
            } else if (errorData.error) {
                if (typeof errorData.error === 'string') {
                    errorMessage = errorData.error;
                } else if (errorData.error.message && typeof errorData.error.message === 'string') {
                    errorMessage = errorData.error.message;
                } else if (typeof errorData.error === 'object') {
                    errorMessage = JSON.stringify(errorData.error);
                }
            } else if (typeof errorData === 'string') {
                errorMessage = errorData;
            } else {
                errorMessage = '未知服务端错误';
            }
            
            const errorMessageToPropagate = `VCP请求失败: ${response.status} - ${errorMessage}`;
            
            if (modelConfig.stream === true && webContents && !webContents.isDestroyed()) {
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

            const errorPayload = { type: 'error', error: `VCP请求失败: ${detailedErrorMessage}`, details: errorData, messageId: messageId, accumulatedResponse: "" };
                if (context) errorPayload.context = context;
                webContents.send(streamChannel, errorPayload);
                
                return { streamError: true, error: `VCP请求失败 (${response.status})`, errorDetail: { message: errorMessageToPropagate, originalData: errorData } };
            }
            
            const err = new Error(errorMessageToPropagate);
            err.details = errorData;
            err.status = response.status;
            throw err;
        }

        // === 处理流式响应 ===
        if (modelConfig.stream === true) {
            console.log(`[VCPClient] Starting stream processing for messageId: ${messageId}`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            async function processStream() {
                let buffer = '';
                let accumulatedResponse = ''; // Accumulate the full response text
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (value) {
                            buffer += decoder.decode(value, { stream: true });
                        }

                        const lines = buffer.split('\n');
                        buffer = done ? '' : lines.pop();

                        for (const line of lines) {
                            if (line.trim() === '') continue;

                            if (line.startsWith('data: ')) {
                                const jsonData = line.substring(5).trim();
                                if (jsonData === '[DONE]') {
                                    console.log(`[VCPClient] Stream [DONE] for messageId: ${messageId}`);
                                    const donePayload = { type: 'end', messageId: messageId, context };
                                    if (webContents && !webContents.isDestroyed()) {
                                        webContents.send(streamChannel, donePayload);
                                    }
                                    if (onStreamEnd) {
                                        onStreamEnd({ success: true, content: accumulatedResponse });
                                    }
                                    return;
                                }
                                if (jsonData === '') continue;
                                
                                try {
                                    const parsedChunk = JSON.parse(jsonData);
                                    
                                    // Accumulate content
                                    let textToAppend = "";
                                    if (parsedChunk?.choices?.[0]?.delta?.content) {
                                        textToAppend = parsedChunk.choices[0].delta.content;
                                    } else if (parsedChunk?.delta?.content) {
                                        textToAppend = parsedChunk.delta.content;
                                    } else if (typeof parsedChunk?.content === 'string') {
                                        textToAppend = parsedChunk.content;
                                    }
                                    if (textToAppend) {
                                        accumulatedResponse += textToAppend;
                                    }

                                    const dataPayload = { type: 'data', chunk: parsedChunk, messageId: messageId, context };
                                    if (webContents && !webContents.isDestroyed()) {
                                        webContents.send(streamChannel, dataPayload);
                                    }
                                } catch (e) {
                                    console.error(`[VCPClient] Failed to parse stream chunk for messageId: ${messageId}:`, e, '原始数据:', jsonData);
                                    const errorChunkPayload = { type: 'data', chunk: { raw: jsonData, error: 'json_parse_error' }, messageId: messageId, context };
                                    if (webContents && !webContents.isDestroyed()) {
                                        webContents.send(streamChannel, errorChunkPayload);
                                    }
                                }
                            }
                        }

                        if (done) {
                            console.log(`[VCPClient] Stream ended for messageId: ${messageId}`);
                            const endPayload = { type: 'end', messageId: messageId, context };
                            if (webContents && !webContents.isDestroyed()) {
                                webContents.send(streamChannel, endPayload);
                            }
                            if (onStreamEnd) {
                                onStreamEnd({ success: true, content: accumulatedResponse });
                            }
                            break;
                        }
                    }
                } catch (streamError) {
                    const streamErrPayload = { 
                        type: 'error', 
                        error: `VCP流读取错误: ${streamError.message}`, 
                        messageId: messageId,
                        accumulatedResponse: accumulatedResponse // Propagate partial data on error
                    };
                    if (context) streamErrPayload.context = context;
                    if (webContents && !webContents.isDestroyed()) {
                        webContents.send(streamChannel, streamErrPayload);
                    }
                    if (onStreamEnd) {
                        onStreamEnd({ success: false, error: streamError.message, content: accumulatedResponse });
                    }
                } finally {
                    reader.releaseLock();
                    activeRequests.delete(messageId); // Move cleanup here for streaming requests
                    console.log(`[VCPClient] Stream cleanup: Lock released and AbortController removed for messageId: ${messageId}`);
                }
            }

            processStream().then(() => {
                console.log(`[VCPClient] Stream processing completed for messageId: ${messageId}`);
            }).catch(err => {
                console.error(`[VCPClient] Stream processing error for messageId: ${messageId}:`, err);
                activeRequests.delete(messageId); // Extra safety cleanup
            });

            return { streamingStarted: true };
        } else {
            // === 处理非流式响应 ===
            console.log('[VCPClient] Processing non-streaming response');
            const vcpResponse = await response.json();
            return { response: vcpResponse, context };
        }

    } catch (error) {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError') {
            console.log(`[VCPClient] Request aborted for messageId: ${messageId}`);
            if (modelConfig.stream === true && webContents && !webContents.isDestroyed()) {
                const abortPayload = { type: 'error', error: '请求已中止', messageId: messageId, context };
                webContents.send(streamChannel, abortPayload);
            }
            return { aborted: true, error: '请求已中止' };
        }
        
        console.error('[VCPClient] Request error:', error);
        if (modelConfig.stream === true && webContents && !webContents.isDestroyed()) {
            const catchErrorPayload = { type: 'error', error: `VCP请求错误: ${error.message}`, messageId: messageId, context };
            webContents.send(streamChannel, catchErrorPayload);
            return { streamError: true, error: `VCP客户端请求错误`, errorDetail: { message: error.message, stack: error.stack } };
        }
        return { error: `VCP请求错误: ${error.message}` };
    } finally {
        // Only clean up here if we ARE NOT streaming. 
        // For streaming, the cleanup is handled in processStream's finally block to ensure the request is interruptible.
        if (modelConfig.stream !== true) {
            activeRequests.delete(messageId);
            console.log(`[VCPClient] SendToVCP cleanup: Cleaned up AbortController for non-streaming messageId: ${messageId}.`);
        } else {
            console.log(`[VCPClient] SendToVCP detour: Cleanup for streaming messageId ${messageId} deferred to processStream.`);
        }
    }
}

/**
 * 中止指定的 VCP 请求
 * @param {string} messageId - 要中止的消息ID
 * @returns {object} - { success: boolean, message?: string, error?: string }
 */
function interruptRequest(messageId) {
    console.log(`[VCPClient] interruptRequest called for messageId: ${messageId}. Active requests: ${activeRequests.size}`);
    
    const controller = activeRequests.get(messageId);
    if (controller) {
        console.log(`[VCPClient] Found AbortController for messageId: ${messageId}, aborting...`);
        controller.abort();
        activeRequests.delete(messageId);
        console.log(`[VCPClient] Request interrupted for messageId: ${messageId}. Remaining active requests: ${activeRequests.size}`);
        return { success: true, message: `请求 ${messageId} 已中止` };
    } else {
        console.log(`[VCPClient] No active request found for messageId: ${messageId}`);
        return { success: false, error: `未找到活跃的请求 ${messageId}` };
    }
}

/**
 * 获取当前活跃的请求数量（用于调试）
 * @returns {number}
 */
function getActiveRequestCount() {
    return activeRequests.size;
}

module.exports = {
    initialize,
    sendToVCP,
    interruptRequest,
    getActiveRequestCount
};
