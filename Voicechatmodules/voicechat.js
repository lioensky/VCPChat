// Voicechatmodules/voicechat.js
import { createMemoryChatRepository } from '../modules/chat/memoryChatRepository.js';
import { createTransientChatHistoryPersistence } from '../modules/chat/chatHistoryPersistence.js';
import { createChatHistoryMutationAuthority } from '../modules/chat/chatHistoryMutationAuthority.js';
import { createChatRepository } from '../modules/chat/chatRepository.js';
import { createWindowStreamRuntime } from '../modules/renderer/windowStreamRuntime.js';
import { createMessageRenderer } from '../modules/messageRenderer.js';
import { createStreamProjection } from '../modules/renderer/streamManager.js';
import { createStreamTransientHistory } from '../modules/chat/streamTransientHistory.js';
import { createTtsSurfaceOwner } from '../modules/renderer/ttsSurfaceOwner.js';

const streamManager = createStreamProjection();
const messageRenderer = createMessageRenderer({ streamManager });

document.addEventListener('DOMContentLoaded', () => {
    const chatMessagesDiv = document.getElementById('chatMessages');
    const messageInput = document.getElementById('messageInput');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    const agentAvatarImg = document.getElementById('agentAvatar');
    const agentNameSpan = document.getElementById('currentChatAgentName');
    const voiceInputShortcutStatus = document.getElementById('voiceInputShortcutStatus');
    const closeBtn = document.getElementById('close-btn-voicechat');
    const toggleInputModeBtn = document.getElementById('toggleInputModeBtn');
    const nativeVoiceInputMode = document.getElementById('nativeVoiceInputMode');
    const keyboardIcon = document.getElementById('keyboard-icon');
    const micIcon = document.getElementById('mic-icon');
    let historyMutationAuthority = null;
    let ttsSurfaceOwner = null;

    // Detect user gestures to unlock the shared Web Audio playback surface.
    function detectUserGesture() {
        ttsSurfaceOwner?.ensureAudioContext();
        document.querySelectorAll('.audio-playback-hint, .audio-playback-error').forEach(el => el.remove());
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
    let streamRuntime = null;
    let inputMode = 'text'; // 'text' or 'voice'
    const markedInstance = new window.marked.Marked({ gfm: true, breaks: true });

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
        closeBtn.disabled = true;
        try {
            if (activeStreamingMessageId) {
                await window.electronAPI.interruptVcpRequest?.({ messageId: activeStreamingMessageId });
                await streamRuntime?.cancel(activeStreamingMessageId, 'voice-window-close');
            }
            await saveVoiceChatToHistory();
        } finally {
            await ttsSurfaceOwner?.dispose();
            ttsSurfaceOwner = null;
            await streamRuntime?.dispose();
            await streamManager.dispose();
            await messageRenderer.disposeRootResources(chatMessagesDiv);
            messageRenderer.disposeRendererResources();
            await historyMutationAuthority?.dispose();
            window.close();
        }
    });

    function getVoiceTopicId() {
        return agentId ? `voicechat_${agentId}` : null;
    }

    function isEventForCurrentVoiceSession(eventData) {
        if (!eventData || !activeStreamingMessageId || eventData.messageId !== activeStreamingMessageId) {
            return false;
        }

        const expectedTopicId = getVoiceTopicId();
        const eventTopicId = eventData.context?.topicId;
        const eventAgentId = eventData.context?.agentId;

        return !!expectedTopicId && eventTopicId === expectedTopicId && eventAgentId === agentId;
    }

    function restoreComposerAfterStream() {
        activeStreamingMessageId = null;
        messageInput.disabled = false;
        sendMessageBtn.disabled = false;
        messageInput.focus();
    }

    async function saveVoiceChatToHistory() {
        if (!agentId) return;

        const persistedHistory = currentChatHistory.filter(msg => !msg.isThinking && msg.role !== 'system');
        if (persistedHistory.length === 0) return;

        console.log('[VoiceChat] Saving chat history before exit...');
        try {
            const timestamp = new Date().toLocaleString();
            const defaultTitle = `语音通话 ${timestamp}`;
            const result = await window.electronAPI.createNewTopicForAgent(agentId, defaultTitle);

            if (result && result.success && result.topicId) {
                const newTopicId = result.topicId;

                if (!historyMutationAuthority) throw new Error('Voice history mutation authority is not ready');
                await historyMutationAuthority.replace({ itemId: agentId, itemType: 'agent', topicId: newTopicId, category: 'voice-session-close' }, persistedHistory);
                console.log(`[VoiceChat] History saved to new topic: ${newTopicId}`);

                if (window.summarizeTopicFromMessages) {
                    const agentName = agentConfig?.name || 'AI';
                    const summarizedTitle = await window.summarizeTopicFromMessages(persistedHistory, agentName);
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
    // --- Click Handler for Images and Links ---
    chatMessagesDiv.addEventListener('click', (event) => {
        const target = event.target;

        // Handle image clicks
        if (target.tagName === 'IMG' && target.closest('.message-content')) {
            event.preventDefault();
            const imageUrl = target.src;
            const imageTitle = target.alt || '图片预览';
            const theme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
            console.log(`[VoiceChat] Image clicked. Opening in new window. URL: ${imageUrl}`);
            window.electronAPI.openImageInNewWindow(imageUrl, imageTitle, theme);
            return;
        }

        // Handle link clicks
        if (target.tagName === 'A' && target.href) {
            event.preventDefault();
            const url = target.href;
            // Ensure it's a web link before opening
            if (url.startsWith('http:') || url.startsWith('https:')) {
                console.log(`[VoiceChat] Link clicked. Opening externally. URL: ${url}`);
                window.electronAPI.sendOpenExternalLink(url);
            }
            return;
        }
    });

    sendMessageBtn.addEventListener('click', () => sendMessage(messageInput.value));
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(messageInput.value);
        }
    });
    toggleInputModeBtn.disabled = true;
    toggleInputModeBtn.title = '请使用全局按住说话快捷键';

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
            voiceMode: settings.voiceMode === 'network' ? 'network' : 'local',
            voiceInputMode: ['windows_voice_typing', 'right_alt_hold'].includes(settings.voiceInputMode)
                ? settings.voiceInputMode
                : 'windows_voice_typing',
            voiceInputShortcut: settings.voiceInputShortcut || 'F7',
            voiceNetworkSettings: settings.voiceNetworkSettings || { providerUrl: '', providerKey: '' },
            voiceLocalSettings: settings.voiceLocalSettings || { sovitsUrl: '', sovitsKey: '' }
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
        nativeVoiceInputMode.value = globalSettings.voiceInputMode;
        const nativeStatus = await window.electronAPI.getNativeVoiceInputStatus?.();
        renderVoiceInputShortcutStatus(
            nativeStatus?.shortcut?.registered
                ? {
                    success: true,
                    registered: true,
                    shortcut: nativeStatus.shortcut.value || globalSettings.voiceInputShortcut,
                }
                : {
                    success: false,
                    registered: false,
                    error: `快捷键 ${globalSettings.voiceInputShortcut} 未注册`,
                }
        );
        agentAvatarImg.src = agentConfig.avatarUrl || '../assets/default_avatar.png';
        agentNameSpan.textContent = `${agentConfig.name} - ${getVoiceModeLabel(globalSettings)}`;

        initializeRenderer();
        });
    });

    function initializeRenderer() {
        if (messageRenderer) {
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
                get: () => getVoiceTopicId(),
                set: () => {}
            };
            const chatRepository = createMemoryChatRepository({
                read: () => currentChatHistory,
                write: history => { currentChatHistory = history; },
            });
            const historyPersistence = createTransientChatHistoryPersistence(chatRepository);
            const transientStreamHistory = createStreamTransientHistory({
                repository: chatRepository,
                currentHistory: { get: () => chatHistoryRef.get(), replace: history => chatHistoryRef.set(history) },
            });
            historyMutationAuthority = createChatHistoryMutationAuthority({ repository: createChatRepository(window.electronAPI) });
            messageRenderer.initializeMessageRenderer({
                chatRepository,
                historyMutationAuthority,
                currentChatHistoryRef: chatHistoryRef,
                currentSelectedItemRef: selectedItemRef,
                currentTopicIdRef: topicIdRef,
                transientStreamHistory,
                viewAuthority: { isCurrent: context => context?.agentId === agentId && context?.topicId === getVoiceTopicId() },
                globalSettingsRef: globalSettingsRef,
                chatMessagesDiv: chatMessagesDiv,
                electronAPI: window.electronAPI,
                markedInstance: markedInstance,
                morphdom: window.morphdom,
                pretextBridge: window.pretextBridge,
                flowlockProtocol: window.flowlockProtocol,
                uiHelper: uiHelperFunctions, // Pass the local helper
                messageCommands: { handleSendMessage: text => sendMessage(text) },
                summarizeTopicFromMessages: window.summarizeTopicFromMessages || (async () => ""),
                handleCreateBranch: () => {} // Stub
            });
            ttsSurfaceOwner = createTtsSurfaceOwner({
                subscribePlay: callback => window.electronAPI.onPlayTtsAudio(callback),
                subscribeStop: callback => window.electronAPI.onStopTtsAudio(callback),
                createAudioContext: () => new (window.AudioContext || window.webkitAudioContext)(),
                decodeBase64: value => Uint8Array.from(
                    atob(value),
                    character => character.charCodeAt(0)
                ).buffer,
                updateSpeakingIndicator: (messageId, active) => {
                    const messageItem = chatMessagesDiv.querySelector(
                        `.message-item[data-message-id="${messageId}"]`
                    );
                    if (!messageItem) return;
                    const avatar = messageItem.querySelector('.chat-avatar');
                    messageItem.classList.toggle('speaking-active', active);
                    avatar?.classList.toggle('speaking', active);
                    if (avatar) {
                        avatar.title = active ? '正在朗读，点击头像停止' : '';
                        avatar.setAttribute('aria-label', active ? '停止朗读' : 'Agent 头像');
                    }
                },
                showError: message => console.error(`[VoiceChat] ${message}`),
            });
            ttsSurfaceOwner.mount();

            streamRuntime = createWindowStreamRuntime({
                root: chatMessagesDiv,
                streamProjection: streamManager,
                historyPersistence,
                getSelection: () => ({ id: agentId, type: 'agent' }),
                getTopicId: getVoiceTopicId,
                getMessageContext: () => ({
                    agentId, topicId: getVoiceTopicId(), agentName: agentConfig?.name,
                    avatarUrl: agentConfig?.avatarUrl, avatarColor: agentConfig?.avatarCalculatedColor,
                }),
                contextFilter: context => !!context && context.topicId === getVoiceTopicId() && context.agentId === agentId,
                dispatchTerminal: detail => window.dispatchEvent(new CustomEvent('vcp-chat-stream-terminal', { detail })),
                afterPersist: ({ terminal, finalized }) => {
                    if (terminal.kind !== 'completed') return;
                    if (finalized?.messageId) setTimeout(() => extractTextAndPlayTTS(finalized.messageId, 0), 100);
                },
                onSettled: restoreComposerAfterStream,
            });
            console.log('[VoiceChat] Shared messageRenderer initialized.');
        } else {
            console.error('[VoiceChat] shared message renderer provider is not available.');
        }
    }

    function applyNativeCapturePresentation(active) {
        inputMode = active ? 'voice' : 'text';
        keyboardIcon.style.display = active ? 'none' : 'block';
        micIcon.style.display = active ? 'block' : 'none';
        nativeVoiceInputMode.disabled = active;
        toggleInputModeBtn.setAttribute('aria-pressed', String(active));
        messageInput.placeholder = active
            ? `正在使用 ${nativeVoiceInputMode.selectedOptions[0]?.textContent || '系统听写'}...`
            : '输入消息...';
    }

    function renderVoiceInputShortcutStatus(status, state = null) {
        if (!voiceInputShortcutStatus) return;
        voiceInputShortcutStatus.classList.remove('is-ready', 'is-active', 'is-error');

        if (state === 'active') {
            voiceInputShortcutStatus.classList.add('is-active');
            voiceInputShortcutStatus.textContent = `${status?.shortcut || globalSettings.voiceInputShortcut || '快捷键'} 已触发`;
            return;
        }

        if (status?.success && status?.registered !== false) {
            voiceInputShortcutStatus.classList.add('is-ready');
            voiceInputShortcutStatus.textContent = `${status.shortcut || globalSettings.voiceInputShortcut || '快捷键'} 已注册`;
            return;
        }

        const error = status?.error || '快捷键未注册';
        voiceInputShortcutStatus.classList.add('is-error');
        voiceInputShortcutStatus.textContent = error;
        voiceInputShortcutStatus.title = error;
    }

    window.electronAPI.onVoiceInputShortcutStatus?.((status) => {
        applyNativeCapturePresentation(status?.active === true);
        renderVoiceInputShortcutStatus(status, status?.active === true ? 'active' : null);
        if (status?.success) return;
        const error = status?.error || '语音输入快捷键注册失败';
        console.warn('[VoiceChat] Voice input shortcut unavailable:', error);
        if (inputMode === 'text') {
            messageInput.placeholder = `快捷键不可用：${error}`;
        }
    });

    window.electronAPI.onVoiceInputCapturedText?.((payload) => {
        const text = String(payload?.text || '').trim();
        applyNativeCapturePresentation(false);
        if (!text) return;
        messageInput.value = text;
        sendMessage(text).catch(error => {
            console.error('[VoiceChat] Failed to send captured voice text:', error);
            messageInput.disabled = false;
            sendMessageBtn.disabled = false;
            messageInput.value = text;
        });
    });

    const sendMessage = async (messageContent) => {
        if (!messageContent.trim() || !agentConfig || !messageRenderer) return;

        const userMessage = { role: 'user', content: messageContent, timestamp: Date.now(), id: `user_msg_${Date.now()}` };
        await messageRenderer.renderMessage(userMessage);
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
        await messageRenderer.renderMessage(assistantMessagePlaceholder);

        const context = {
            agentId: agentId,
            topicId: getVoiceTopicId()
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
            const accepted = streamRuntime?.accept({
                    type: 'error', messageId: thinkingMessageId, error: error.message,
                    context: { agentId, topicId: getVoiceTopicId() },
                });
            if (!accepted) restoreComposerAfterStream();
        }
    };

    window.electronAPI.onVCPStreamEvent((eventData) => {
        if (!streamRuntime || !isEventForCurrentVoiceSession(eventData)) return;
        streamRuntime.accept(eventData);
    });
    
    // 新增：智能文本提取和TTS触发函数，包含重试机制
    function extractTextAndPlayTTS(messageId, retryCount = 0) {
        const maxRetries = 10;
        const retryDelay = 100;

        const messageElement = document.getElementById(`message-item-${messageId}`);
        let textToSpeak = '';

        if (messageElement) {
            const contentElement = messageElement.querySelector('.md-content');
            if (contentElement && messageRenderer?.extractSpeakableTextFromContentElement) {
                textToSpeak = messageRenderer.extractSpeakableTextFromContentElement(contentElement);
            } else if (contentElement) {
                const contentClone = contentElement.cloneNode(true);
                contentClone.querySelectorAll('.vcp-tool-use-bubble, .vcp-tool-result-bubble, .vcp-tool-call-summary-bubble, .maid-diary-bubble, .vcp-role-divider, .vcp-thought-chain-bubble, style, script').forEach(el => el.remove());
                textToSpeak = (contentClone.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
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
                            const backupText = messageRenderer?.extractSpeakableTextFromContentElement
                                ? messageRenderer.extractSpeakableTextFromContentElement(contentElement)
                                : (contentElement.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
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
            networkProviderUrl: globalSettings.voiceNetworkSettings?.providerUrl || '',
            localSovitsUrl: globalSettings.voiceLocalSettings?.sovitsUrl || ''
        });
        window.electronAPI.sovitsSpeak({
            text: text,
            voice: agentConfig.ttsVoicePrimary,
            speed: agentConfig.ttsSpeed,
            msgId: msgId,
            ttsRegex: agentConfig.ttsRegexPrimary,
            directorPrompts: agentConfig.ttsDirectorPrompts,
            voiceSecondary: agentConfig.ttsVoiceSecondary,
            ttsRegexSecondary: agentConfig.ttsRegexSecondary
        });
    }

    // Listen for theme updates from the main process
    window.electronAPI.onThemeUpdated((theme) => {
        console.log(`[VoiceChat Window] Theme updated to: ${theme}`);
        document.body.classList.toggle('light-theme', theme === 'light');
        document.body.classList.toggle('dark-theme', theme !== 'light');
    });

});
