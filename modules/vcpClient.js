// modules/vcpClient.js - 缁熶竴鐨?VCP 璇锋眰澶勭悊妯″潡
const fs = require('fs-extra');
const path = require('path');

// 鍏ㄥ眬鐨?AbortController 鏄犲皠锛歮essageId -> AbortController
const activeRequests = new Map();

// 妯″潡閰嶇疆锛堝皢鍦ㄥ垵濮嬪寲鏃惰缃級
let moduleConfig = {
    APP_DATA_ROOT_IN_PROJECT: null,
    getMusicState: null
};

/**
 * 鍒濆鍖?VCP 瀹㈡埛绔ā鍧?
 * @param {object} config - 閰嶇疆瀵硅薄
 */
function initialize(config) {
    moduleConfig = {
        APP_DATA_ROOT_IN_PROJECT: config.APP_DATA_ROOT_IN_PROJECT,
        getMusicState: config.getMusicState
    };
    console.log('[VCPClient] Initialized successfully.');
}

/**
 * 缁熶竴鐨?VCP 璇锋眰鍑芥暟
 * @param {object} params - 璇锋眰鍙傛暟
 * @param {string} params.vcpUrl - VCP鏈嶅姟鍣║RL
 * @param {string} params.vcpApiKey - API瀵嗛挜
 * @param {array} params.messages - 娑堟伅鏁扮粍
 * @param {object} params.modelConfig - 妯″瀷閰嶇疆
 * @param {string} params.messageId - 娑堟伅ID锛堢敤浜庝腑姝級
 * @param {object} params.context - 涓婁笅鏂囦俊鎭紙agentId, topicId绛夛級
 * @param {object} params.webContents - The webContents of the main window for sending events.
 * @param {string} params.streamChannel - 娴佸紡鏁版嵁棰戦亾鍚嶇О
 * @param {function} [params.onStreamEnd] - (optional) Callback for when stream ends, receives { success, content, error }
 * @returns {Promise<object>} - 杩斿洖鍝嶅簲瀵硅薄
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

    let messages = [...originalMessages]; // 鍒涘缓鍓湰浠ラ伩鍏嶄慨鏀瑰師濮嬫暟缁?

    // === 鏁版嵁楠岃瘉鍜岃鑼冨寲 ===
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
            
            // 馃洝锔?涓ユ牸鑴辨晱锛氬彧杩斿洖鐢?OpenAI/Gemini 绛?API 瑙勮寖瑕佹眰鐨勫瓧娈?
            // 鍓旈櫎 attachments, isThinking 绛夌鏈夊厓鏁版嵁锛岄槻姝㈡硠闇茬粰妯″瀷
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
        return { error: `娑堟伅鏍煎紡楠岃瘉澶辫触: ${validationError.message}` };
    }

    // === URL 鍒囨崲锛堟牴鎹伐鍏锋敞鍏ヨ缃級===
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

    // === 闊充箰鎺у埗娉ㄥ叆 ===
    if (moduleConfig.getMusicState) {
        try {
            const { musicWindow, currentSongInfo } = moduleConfig.getMusicState();
            const topParts = [];
            const bottomParts = [];

            if (currentSongInfo) {
                bottomParts.push(`[褰撳墠鎾斁闊充箰锛?{currentSongInfo.title} - ${currentSongInfo.artist} (${currentSongInfo.album || '鏈煡涓撹緫'})]`);
            }

            if (settings.agentMusicControl) {
                const songlistPath = path.join(moduleConfig.APP_DATA_ROOT_IN_PROJECT, 'songlist.json');
                if (await fs.pathExists(songlistPath)) {
                    const songlistJson = await fs.readJson(songlistPath);
                    if (Array.isArray(songlistJson) && songlistJson.length > 0) {
                        const titles = songlistJson.map(song => song.title).filter(Boolean);
                        if (titles.length > 0) {
                            topParts.push(`[鎾斁鍒楄〃鈥斺€擻n${titles.join('\n')}\n]`);
                        }
                    }
                }
                bottomParts.push(`鐐规瓕鍙皗{VCPMusicController}}`);
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

    // === Agent Bubble Theme 娉ㄥ叆 ===
    try {
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
        console.error('[VCPClient] Failed to inject bubble theme info:', e);
    }

    // === 鍑嗗璇锋眰浣?===
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


    let serializedBody;
    try {
        serializedBody = JSON.stringify(requestBody);
    } catch (serializeError) {
        console.error('[VCPClient] Failed to serialize request body:', serializeError);
        return { error: `璇锋眰浣撳簭鍒楀寲澶辫触: ${serializeError.message}` };
    }

    // === 鍒涘缓 AbortController 骞舵敞鍐?===
    const controller = new AbortController();
    activeRequests.set(messageId, controller);
    console.log(`[VCPClient] Registered AbortController for messageId: ${messageId}. Active requests: ${activeRequests.size}`);

    // 璁剧疆瓒呮椂锛?00绉掞紝閫傚簲闀挎帹鐞嗘ā鍨嬪拰娴佸紡浼犺緭锛?
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
            
            let errorData = { message: `鏈嶅姟鍣ㄨ繑鍥炵姸鎬?${response.status}`, details: errorText };
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
                errorMessage = '鏈煡鏈嶅姟绔敊璇?;
            }
            
            const errorMessageToPropagate = `VCP璇锋眰澶辫触: ${response.status} - ${errorMessage}`;
            
            if (modelConfig.stream === true && webContents && !webContents.isDestroyed()) {
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

            const errorPayload = { type: 'error', error: `VCP璇锋眰澶辫触: ${detailedErrorMessage}`, details: errorData, messageId: messageId, accumulatedResponse: "" };
                if (context) errorPayload.context = context;
                webContents.send(streamChannel, errorPayload);
                
                return { streamError: true, error: `VCP璇锋眰澶辫触 (${response.status})`, errorDetail: { message: errorMessageToPropagate, originalData: errorData } };
            }
            
            const err = new Error(errorMessageToPropagate);
            err.details = errorData;
            err.status = response.status;
            throw err;
        }

        // === 澶勭悊娴佸紡鍝嶅簲 ===
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
                                    console.error(`[VCPClient] Failed to parse stream chunk for messageId: ${messageId}:`, e, '鍘熷鏁版嵁:', jsonData);
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
                        error: `VCP娴佽鍙栭敊璇? ${streamError.message}`, 
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
            // === 澶勭悊闈炴祦寮忓搷搴?===
            console.log('[VCPClient] Processing non-streaming response');
            const vcpResponse = await response.json();
            return { response: vcpResponse, context };
        }

    } catch (error) {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError') {
            console.log(`[VCPClient] Request aborted for messageId: ${messageId}`);
            if (modelConfig.stream === true && webContents && !webContents.isDestroyed()) {
                const abortPayload = { type: 'error', error: '璇锋眰宸蹭腑姝?, messageId: messageId, context };
                webContents.send(streamChannel, abortPayload);
            }
            return { aborted: true, error: '璇锋眰宸蹭腑姝? };
        }
        
        console.error('[VCPClient] Request error:', error);
        if (modelConfig.stream === true && webContents && !webContents.isDestroyed()) {
            const catchErrorPayload = { type: 'error', error: `VCP璇锋眰閿欒: ${error.message}`, messageId: messageId, context };
            webContents.send(streamChannel, catchErrorPayload);
            return { streamError: true, error: `VCP瀹㈡埛绔姹傞敊璇痐, errorDetail: { message: error.message, stack: error.stack } };
        }
        return { error: `VCP璇锋眰閿欒: ${error.message}` };
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
 * 涓鎸囧畾鐨?VCP 璇锋眰
 * @param {string} messageId - 瑕佷腑姝㈢殑娑堟伅ID
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
        return { success: true, message: `璇锋眰 ${messageId} 宸蹭腑姝 };
    } else {
        console.log(`[VCPClient] No active request found for messageId: ${messageId}`);
        return { success: false, error: `鏈壘鍒版椿璺冪殑璇锋眰 ${messageId}` };
    }
}

/**
 * 鑾峰彇褰撳墠娲昏穬鐨勮姹傛暟閲忥紙鐢ㄤ簬璋冭瘯锛?
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
