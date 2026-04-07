// Voicechatmodules/voicechat.js

document.addEventListener('DOMContentLoaded', () => {
    const chatMessagesDiv = document.getElementById('chatMessages');
    const messageInput = document.getElementById('messageInput');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    const agentAvatarImg = document.getElementById('agentAvatar');
    const agentNameSpan = document.getElementById('currentChatAgentName');
    const closeBtn = document.getElementById('close-btn-voicechat');
    const toggleInputModeBtn = document.getElementById('toggleInputModeBtn');
    const keyboardIcon = document.getElementById('keyboard-icon');
    const micIcon = document.getElementById('mic-icon');

    // Initialize audio context on first user gesture
    function initAudioContext() {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            console.log('[VoiceChat] Audio context initialized');
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
    }

    // Detect user gestures to enable audio playback
    function detectUserGesture() {
        if (!userGestureDetected) {
            userGestureDetected = true;
            initAudioContext();
            console.log('[VoiceChat] User gesture detected, audio playback enabled');

            // Remove any existing hints or errors
            document.querySelectorAll('.audio-playback-hint, .audio-playback-error').forEach(el => el.remove());

            // Try to restart audio queue if there are pending items
            if (audioQueue.length > 0 && !isPlaying) {
                console.log('[VoiceChat] Restarting audio queue after user gesture');
                setTimeout(() => processAudioQueue(), 100);
            }
        }
    }

    // Add gesture listeners to enable audio
    document.addEventListener('click', detectUserGesture, { once: true });
    document.addEventListener('keydown', detectUserGesture, { once: true });
    chatMessagesDiv.addEventListener('click', detectUserGesture, { once: true });
    sendMessageBtn.addEventListener('click', detectUserGesture, { once: true });
    messageInput.addEventListener('keydown', detectUserGesture, { once: true });

    let agentConfig = null;
    let agentId = null;
    let globalSettings = {};
    let currentChatHistory = [];
    let activeStreamingMessageId = null;
    let inputMode = 'text'; // 'text' or 'voice'
    const markedInstance = new window.marked.Marked({ gfm: true, breaks: true });
    let speechRecognitionTimeout = null;
    const SPEECH_TIMEOUT_DURATION = 3000; // 3 seconds

    // Local UI Helper for this window
    const uiHelperFunctions = {
        scrollToBottom: () => {
            chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
        },
        autoResizeTextarea: (textarea) => {
            textarea.style.height = 'auto';
            const scrollHeight = textarea.scrollHeight;
            const maxHeight = parseInt(getComputedStyle(textarea).maxHeight, 10) || Infinity;
            textarea.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
        }
    };

    // --- Event Listeners ---
    closeBtn.addEventListener('click', async () => {
        await saveVoiceChatToHistory();
        window.close();
    });

    async function saveVoiceChatToHistory() {
        if (!agentId || currentChatHistory.length === 0) return;

        // Filter out thinking messages and system messages if they are just placeholders
        const validMessages = currentChatHistory.filter(msg => !msg.isThinking && msg.role !== 'system');
        if (validMessages.length === 0) return;

        console.log('[VoiceChat] Saving chat history before exit...');
        try {
            // 1. Create a new topic for this voice chat
            const timestamp = new Date().toLocaleString();
            const defaultTitle = `语音通话 ${timestamp}`;
            const result = await window.electronAPI.createNewTopicForAgent(agentId, defaultTitle);

            if (result && result.success && result.topicId) {
                const newTopicId = result.topicId;
                
                // 2. Save the history to the new topic
                await window.electronAPI.saveChatHistory(agentId, newTopicId, currentChatHistory);
                console.log(`[VoiceChat] History saved to new topic: ${newTopicId}`);

                // 3. Attempt to summarize the topic title
                if (window.summarizeTopicFromMessages) {
                    const agentName = agentConfig?.name || 'AI';
                    const summarizedTitle = await window.summarizeTopicFromMessages(validMessages, agentName);
                    if (summarizedTitle) {
                        await window.electronAPI.saveAgentTopicTitle(agentId, newTopicId, summarizedTitle);
                        console.log(`[VoiceChat] Topic summarized: ${summarizedTitle}`);
                    }
                }
            } else {
                console.error('[VoiceChat] Failed to create topic for saving history:', result?.error);
            }
        } catch (error) {
            console.error('[VoiceChat] Error saving voice chat history:', error);
        }
    }
    sendMessageBtn.addEventListener('click', () => sendMessage(messageInput.value));
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(messageInput.value);
        }
    });
    toggleInputModeBtn.addEventListener('click', toggleMode);

    // --- Initialization ---
    // 等待 electronAPI 加载完成
    function waitForElectronAPI(callback, maxAttempts = 50) {
        let attempts = 0;

        function check() {
            attempts++;
            if (window.electronAPI) {
                console.log('[VoiceChat] electronAPI 已加载');
                callback();
            } else if (attempts < maxAttempts) {
                console.log(`[VoiceChat] 等待 electronAPI 加载... (${attempts}/${maxAttempts})`);
                setTimeout(check, 100);
            } else {
                console.error('[VoiceChat] electronAPI 加载超时');
                agentNameSpan.textContent = "错误";
                chatMessagesDiv.innerHTML = `<div class="message-item system"><p style="color: var(--danger-color);">electronAPI加载失败，请重启应用</p></div>`;
            }
        }

        check();
    }

    function getVoiceRuntimeSettings(settings = {}) {
        return {
            voiceMode: settings.voiceMode || 'local',
            speechRecognizerBrowserPath: settings.speechRecognizerBrowserPath || '',
            speechRecognizerPagePath: settings.speechRecognizerPagePath || 'Voicechatmodules/recognizer.html',
            voiceNetworkSettings: settings.voiceNetworkSettings || { sovitsUrl: '', sovitsKey: '' },
            voiceLocalSettings: settings.voiceLocalSettings || { providerUrl: '', providerKey: '' }
        };
    }

    function getVoiceModeLabel(runtimeSettings) {
        return runtimeSettings.voiceMode === 'network' ? '网络语音模式' : '本地语音模式';
    }

    waitForElectronAPI(() => {
        window.electronAPI.onVoiceChatData(async (data) => {
        console.log('Received voice chat data:', data);
        const { agentId: receivedAgentId, theme } = data;
        
        agentId = receivedAgentId;
        globalSettings = await window.electronAPI.loadSettings();
        globalSettings = {
            ...globalSettings,
            ...getVoiceRuntimeSettings(globalSettings)
        };
        agentConfig = await window.electronAPI.getAgentConfig(agentId);

        if (!agentConfig || agentConfig.error) {
            agentNameSpan.textContent = "错误";
            chatMessagesDiv.innerHTML = `<div class="message-item system"><p style="color: var(--danger-color);">加载助手配置失败: ${agentConfig?.error || '未知错误'}</p></div>`;
            return;
        }

        document.body.classList.toggle('light-theme', theme === 'light');
        document.body.classList.toggle('dark-theme', theme === 'dark');
        agentAvatarImg.src = agentConfig.avatarUrl || '../assets/default_avatar.png';
        agentNameSpan.textContent = `${agentConfig.name} - ${getVoiceModeLabel(globalSettings)}`;

        initializeRenderer();
        });
    });

    function initializeRenderer() {
        if (window.messageRenderer) {
            const chatHistoryRef = {
                get: () => currentChatHistory,
                set: (newHistory) => { currentChatHistory = newHistory; }
            };
            const selectedItemRef = {
                get: () => ({
                    id: agentId,
                    type: 'agent',
                    name: agentConfig.name,
                    avatarUrl: agentConfig.avatarUrl,
                    config: agentConfig
                }),
                set: () => {}
            };
            const globalSettingsRef = {
                get: () => globalSettings,
                set: (newSettings) => { globalSettings = newSettings; }
            };
            const topicIdRef = {
                get: () => `voicechat_${agentId}`,
                set: () => {}
            };
            window.messageRenderer.initializeMessageRenderer({
                currentChatHistoryRef: chatHistoryRef,
                currentSelectedItemRef: selectedItemRef,
                currentTopicIdRef: topicIdRef,
                globalSettingsRef: globalSettingsRef,
                chatMessagesDiv: chatMessagesDiv,
                electronAPI: window.electronAPI,
                markedInstance: markedInstance,
                uiHelper: uiHelperFunctions, // Pass the local helper
                summarizeTopicFromMessages: window.summarizeTopicFromMessages || (async () => ""),
                handleCreateBranch: () => {} // Stub
            });
            console.log('[VoiceChat] Shared messageRenderer initialized.');
        } else {
            console.error('[VoiceChat] window.messageRenderer is not available.');
        }
    }

    function toggleMode() {
        if (inputMode === 'text') {
            inputMode = 'voice';
            keyboardIcon.style.display = 'none';
            micIcon.style.display = 'block';
            messageInput.placeholder = `正在聆听... (${getVoiceModeLabel(globalSettings)})`;
            messageInput.value = '';
            window.electronAPI.startSpeechRecognition();
        } else {
            inputMode = 'text';
            keyboardIcon.style.display = 'block';
            micIcon.style.display = 'none';
            messageInput.placeholder = '输入消息...';
            window.electronAPI.stopSpeechRecognition();
            clearTimeout(speechRecognitionTimeout);
        }
    }

    const sendMessage = async (messageContent) => {
        clearTimeout(speechRecognitionTimeout); // Stop any pending auto-send
        if (!messageContent.trim() || !agentConfig || !window.messageRenderer) return;

        const userMessage = { role: 'user', content: messageContent, timestamp: Date.now(), id: `user_msg_${Date.now()}` };
        await window.messageRenderer.renderMessage(userMessage);
        currentChatHistory.push(userMessage);

        messageInput.value = '';
        messageInput.disabled = true;
        sendMessageBtn.disabled = true;

        const thinkingMessageId = `assistant_msg_${Date.now()}`;
        activeStreamingMessageId = thinkingMessageId;

        const assistantMessagePlaceholder = {
            id: thinkingMessageId,
            role: 'assistant',
            content: '思考中',
            timestamp: Date.now(),
            isThinking: true,
            name: agentConfig.name,
            avatarUrl: agentConfig.avatarUrl
        };
        await window.messageRenderer.renderMessage(assistantMessagePlaceholder);

        const context = {
            agentId: agentId,
            topicId: `voicechat_${agentId}`
        };

        try {
            const voiceModePromptInjection = "\n\n当前处于语音模式中，你的回复应当口语化，内容简短直白。由于用户输入同样是语音识别模型构成，注意自主判断、理解其中的同音错别字或者错误语义识别。";
            const systemPrompt = (agentConfig.systemPrompt || '').replace(/\{\{AgentName\}\}/g, agentConfig.name) + voiceModePromptInjection;
            
            const messagesForVCP = [];
            if (systemPrompt) {
                messagesForVCP.push({ role: 'system', content: [{ type: 'text', text: systemPrompt }] });
            }

            const historyForVCP = currentChatHistory.filter(msg => !msg.isThinking).map(msg => {
                const contentPayload = (typeof msg.content === 'string')
                    ? [{ type: 'text', text: msg.content }]
                    : msg.content;
                return { role: msg.role, content: contentPayload };
            });
            messagesForVCP.push(...historyForVCP);

            const modelConfig = {
                model: agentConfig.model,
                temperature: agentConfig.temperature,
                stream: true,
                ...(agentConfig.maxOutputTokens && { max_tokens: parseInt(agentConfig.maxOutputTokens, 10) }),
                ...(agentConfig.contextTokenLimit && { contextTokenLimit: parseInt(agentConfig.contextTokenLimit, 10) }),
                ...(agentConfig.top_p && { top_p: parseFloat(agentConfig.top_p) }),
                ...(agentConfig.top_k && { top_k: parseInt(agentConfig.top_k, 10) })
            };

            await window.electronAPI.sendToVCP(globalSettings.vcpServerUrl, globalSettings.vcpApiKey, messagesForVCP, modelConfig, thinkingMessageId, false, context);

        } catch (error) {
            console.error('Error sending message to VCP:', error);
            if (window.messageRenderer) {
                window.messageRenderer.finalizeStreamedMessage(thinkingMessageId, 'error');
                const messageItemContent = document.querySelector(`.message-item[data-message-id="${thinkingMessageId}"] .md-content`);
                if (messageItemContent) {
                    messageItemContent.innerHTML = `<p style="color: var(--danger-color);">请求失败: ${error.message}</p>`;
                }
            }
            activeStreamingMessageId = null;
            messageInput.disabled = false;
            sendMessageBtn.disabled = false;
            messageInput.focus();
        }
    };

    const activeStreams = new Set();
    window.electronAPI.onVCPStreamEvent((eventData) => {
        if (!window.messageRenderer || eventData.messageId !== activeStreamingMessageId) return;

        const { messageId, type, chunk, error, context } = eventData;

        if (!activeStreams.has(messageId) && type === 'data') {
            window.messageRenderer.startStreamingMessage({
                id: messageId,
                role: 'assistant',
                name: agentConfig.name,
                avatarUrl: agentConfig.avatarUrl,
                context: context,
            });
            activeStreams.add(messageId);
        }

        if (type === 'data') {
            window.messageRenderer.appendStreamChunk(messageId, chunk, context);
        } else if (type === 'end') {
            console.log(`[VoiceChat] 收到流结束事件，messageId: ${messageId}`);
            console.log(`[VoiceChat] 当前activeStreamingMessageId: ${activeStreamingMessageId}`);
            console.log(`[VoiceChat] agentConfig状态: ${!!agentConfig}, TTS语音: ${agentConfig?.ttsVoicePrimary || '未设置'}`);

            window.messageRenderer.finalizeStreamedMessage(messageId, 'completed', context).then(() => {
                console.log(`[VoiceChat] finalizeStreamedMessage完成，准备TTS`);

                // 添加延迟以确保DOM完全渲染
                setTimeout(() => {
                    extractTextAndPlayTTS(messageId, 0);
                }, 100);
            });

            activeStreams.delete(messageId);
            activeStreamingMessageId = null;
            messageInput.disabled = false;
            sendMessageBtn.disabled = false;
            messageInput.focus();
        } else if (type === 'error') {
            window.messageRenderer.finalizeStreamedMessage(messageId, 'error', context);
            const messageItemContent = document.querySelector(`.message-item[data-message-id="${messageId}"] .md-content`);
            if (messageItemContent) {
                messageItemContent.innerHTML = `<p style="color: var(--danger-color);">${error || '未知流错误'}</p>`;
            }
            activeStreams.delete(messageId);
            activeStreamingMessageId = null;
            messageInput.disabled = false;
            sendMessageBtn.disabled = false;
            messageInput.focus();
        }
    });
    
    // 新增：智能文本提取和TTS触发函数，包含重试机制
    function extractTextAndPlayTTS(messageId, retryCount = 0) {
        const maxRetries = 10;
        const retryDelay = 100;

        const messageElement = document.getElementById(`message-item-${messageId}`);
        let textToSpeak = '';

        if (messageElement) {
            const contentElement = messageElement.querySelector('.md-content');
            if (contentElement) {
                const contentClone = contentElement.cloneNode(true);
                contentClone.querySelectorAll('.vcp-tool-use-bubble').forEach(el => el.remove());
                textToSpeak = contentClone.innerText || '';
            } else {
                textToSpeak = messageElement.textContent || messageElement.innerText;
            }
            console.log(`[VoiceChat] 提取到文本长度: ${textToSpeak.length}`);
            console.log(`[VoiceChat] 文本内容: ${textToSpeak.substring(0, 50)}...`);

            // 如果提取到文本，调用TTS
            if (textToSpeak.trim().length > 0) {
                console.log(`[VoiceChat] 调用playTTS，文本长度: ${textToSpeak.trim().length}`);
                playTTS(textToSpeak.trim(), messageId);
            } else {
                console.warn(`[VoiceChat] 警告：消息内容为空，跳过TTS`);
            }
        } else {
            if (retryCount < maxRetries) {
                console.log(`[VoiceChat] 消息元素未找到，${retryDelay}ms后重试 (${retryCount + 1}/${maxRetries}): message-item-${messageId}`);
                setTimeout(() => {
                    extractTextAndPlayTTS(messageId, retryCount + 1);
                }, retryDelay);
            } else {
                console.error(`[VoiceChat] 错误：${maxRetries}次重试后仍未找到消息元素 message-item-${messageId}`);

                // 最后尝试：直接从DOM中查找
                const allMessageItems = document.querySelectorAll('.message-item');
                console.log(`[VoiceChat] 找到 ${allMessageItems.length} 个消息元素，尝试匹配...`);

                allMessageItems.forEach(item => {
                    const idAttr = item.getAttribute('data-message-id');
                    if (idAttr && idAttr.includes(messageId)) {
                        console.log(`[VoiceChat] 找到备用匹配元素: ${idAttr}`);
                        const contentElement = item.querySelector('.md-content');
                        if (contentElement) {
                            const backupText = contentElement.innerText || '';
                            if (backupText.trim().length > 0) {
                                console.log(`[VoiceChat] 使用备用元素提取到文本长度: ${backupText.trim().length}`);
                                playTTS(backupText.trim(), messageId);
                                return;
                            }
                        }
                    }
                });
            }
        }
    }

    function playTTS(text, msgId) {
        if (!text) return;

        if (!agentConfig.ttsVoicePrimary || agentConfig.ttsVoicePrimary === "") {
            console.warn(`[VoiceChat] TTS voice not configured for this agent. Skipping TTS for message ${msgId}`);
            return;
        }

        console.log(`[VoiceChat] Requesting TTS for message ${msgId}`, {
            voiceMode: globalSettings.voiceMode || 'local',
            networkSovitsUrl: globalSettings.voiceNetworkSettings?.sovitsUrl || '',
            localProviderUrl: globalSettings.voiceLocalSettings?.providerUrl || ''
        });
        window.electronAPI.sovitsSpeak({
            text: text,
            voice: agentConfig.ttsVoicePrimary,
            speed: agentConfig.ttsSpeed,
            msgId: msgId,
            ttsRegex: agentConfig.ttsRegexPrimary,
            voiceSecondary: agentConfig.ttsVoiceSecondary,
            ttsRegexSecondary: agentConfig.ttsRegexSecondary
        });
    }

    // --- TTS Audio Playback Logic ---
    let currentAudio = null;
    let audioQueue = []; // Queue for pending audio clips
    let isPlaying = false;
    let audioContext = null;
    let userGestureDetected = false;

    function processAudioQueue() {
        if (isPlaying || audioQueue.length === 0) {
            return; // Don't start a new audio if one is already playing or queue is empty
        }

        isPlaying = true;
        const { audioData, msgId } = audioQueue.shift(); // Get the next audio from the queue

        console.log(`[VoiceChat] Processing audio from queue for msgId ${msgId}`);

        const byteCharacters = atob(audioData);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const audioBlob = new Blob([byteArray], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(audioBlob);

        currentAudio = new Audio(audioUrl);

        // Check if user gesture has been detected
        if (!userGestureDetected) {
            console.warn('[VoiceChat] No user gesture detected, audio may be blocked');
            // Show user a hint
            const messageElement = document.querySelector(`[data-message-id="${msgId}"]`);
            if (messageElement) {
                const hint = document.createElement('div');
                hint.className = 'audio-playback-hint';
                hint.textContent = '点击任意位置以启用语音播放';
                hint.style.cssText = 'color: var(--warning-color); font-size: 0.8em; margin-top: 5px; cursor: pointer;';
                hint.addEventListener('click', detectUserGesture);
                messageElement.appendChild(hint);

                // Remove hint after 5 seconds
                setTimeout(() => {
                    if (hint.parentNode) {
                        hint.remove();
                    }
                }, 5000);
            }
        }

        currentAudio.play().then(() => {
            console.log(`[VoiceChat] Audio playback started for msgId ${msgId}`);
        }).catch(e => {
            console.error("Audio playback failed:", e);

            // Show error message to user
            const messageElement = document.querySelector(`[data-message-id="${msgId}"]`);
            if (messageElement) {
                const errorMsg = document.createElement('div');
                errorMsg.className = 'audio-playback-error';
                errorMsg.textContent = '语音播放失败，请点击页面任意位置后重试';
                errorMsg.style.cssText = 'color: var(--danger-color); font-size: 0.8em; margin-top: 5px; cursor: pointer;';
                errorMsg.addEventListener('click', () => {
                    detectUserGesture();
                    errorMsg.remove();
                    // Retry playing this audio
                    audioQueue.unshift({ audioData, msgId });
                    processAudioQueue();
                });
                messageElement.appendChild(errorMsg);

                // Remove error after 10 seconds
                setTimeout(() => {
                    if (errorMsg.parentNode) {
                        errorMsg.remove();
                    }
                }, 10000);
            }

            isPlaying = false; // Reset flag on error
            processAudioQueue(); // Try to play the next one
        });

        currentAudio.onended = () => {
            console.log(`[VoiceChat] Audio for msgId ${msgId} finished playing.`);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            isPlaying = false;
            processAudioQueue(); // Play the next item in the queue
        };
    }

    window.electronAPI.onPlayTtsAudio((data) => {
        const { audioData, msgId } = data;
        console.log(`[VoiceChat] Queued audio for msgId ${msgId}`);
        audioQueue.push({ audioData, msgId });
        processAudioQueue(); // Attempt to process the queue
    });

    // Listen for stop command from main process
    window.electronAPI.onStopTtsAudio(() => {
        console.log('[VoiceChat] Received stop TTS command. Clearing queue and stopping current audio.');
        audioQueue = []; // Clear the pending audio queue
        if (currentAudio) {
            currentAudio.pause();
            URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        }
        isPlaying = false;
    });


    // Listen for theme updates from the main process
    window.electronAPI.onThemeUpdated((theme) => {
        console.log(`[VoiceChat Window] Theme updated to: ${theme}`);
        document.body.classList.toggle('light-theme', theme === 'light');
        document.body.classList.toggle('dark-theme', theme !== 'light');
    });

    // --- Speech Recognition IPC Listener ---
    window.electronAPI.onSpeechRecognitionResult((text) => {
        messageInput.value = text;

        // Reset the timeout every time new text is received
        clearTimeout(speechRecognitionTimeout);
        if (messageInput.value.trim() !== '') {
            speechRecognitionTimeout = setTimeout(() => {
                if (messageInput.value.trim()) {
                    console.log('Speech unchanged for 3 seconds, sending message.');
                    sendMessage(messageInput.value);
                }
            }, SPEECH_TIMEOUT_DURATION);
        }
    });
});