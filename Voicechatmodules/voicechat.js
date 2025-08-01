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

    let agentConfig = null;
    let agentId = null;
    let globalSettings = {};
    let currentChatHistory = [];
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
    closeBtn.addEventListener('click', () => window.close());
    sendMessageBtn.addEventListener('click', () => sendMessage(messageInput.value));
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(messageInput.value);
        }
    });
    toggleInputModeBtn.addEventListener('click', toggleMode);

    // --- Initialization ---
    window.electronAPI.onVoiceChatData(async (data) => {
        console.log('Received voice chat data:', data);
        const { agentId: receivedAgentId, theme } = data;
        
        agentId = receivedAgentId;
        globalSettings = await window.electronAPI.loadSettings();
        agentConfig = await window.electronAPI.getAgentConfig(agentId);

        if (!agentConfig || agentConfig.error) {
            agentNameSpan.textContent = "错误";
            chatMessagesDiv.innerHTML = `<div class="message-item system"><p style="color: var(--danger-color);">加载助手配置失败: ${agentConfig?.error || '未知错误'}</p></div>`;
            return;
        }

        document.body.classList.toggle('light-theme', theme === 'light');
        document.body.classList.toggle('dark-theme', theme === 'dark');
        agentAvatarImg.src = agentConfig.avatarUrl || '../assets/default_avatar.png';
        agentNameSpan.textContent = `${agentConfig.name} - 语音模式`;

        initializeRenderer();
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
                summarizeTopicFromMessages: async () => "", // Stub
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
            messageInput.placeholder = '正在聆听...';
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
        await window.messageRenderer.renderMessage(userMessage); // This will also update history

        messageInput.value = '';
        messageInput.disabled = true;
        sendMessageBtn.disabled = true;

        const thinkingMessageId = `assistant_msg_${Date.now()}`;
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

        // Send to main process for handling
        window.electronAPI.sendVoiceChatMessage({
            agentId: agentId,
            history: currentChatHistory.filter(m => !m.isThinking), // Send history without the placeholder
            thinkingMessageId: thinkingMessageId
        });
    };

    // Listen for the reply from the main process
    window.electronAPI.onVoiceChatReply(async (reply) => {
        const { thinkingMessageId, error, fullText } = reply;

        // Always remove the placeholder
        await window.messageRenderer.removeMessageById(thinkingMessageId);

        if (error) {
            console.error('Error from voice chat backend:', error);
            const errorMessage = {
                id: thinkingMessageId,
                role: 'system',
                content: `请求失败: ${error}`,
                timestamp: Date.now(),
            };
            await window.messageRenderer.renderMessage(errorMessage);
        } else {
            const finalMessage = {
                id: thinkingMessageId,
                role: 'assistant',
                content: fullText,
                timestamp: Date.now(),
                name: agentConfig.name,
                avatarUrl: agentConfig.avatarUrl
            };
            await window.messageRenderer.renderMessage(finalMessage);

            // After rendering, find the message element and get its text content for TTS
            // After rendering, find the message element and get its text content for TTS
            // This reuses the same logic as the "Read Aloud" context menu item for consistency.
            const messageElement = document.getElementById(`message-item-${thinkingMessageId}`);
            let textToSpeak = '';
            if (messageElement) {
                const contentElement = messageElement.querySelector('.md-content');
                if (contentElement) {
                    // Clone the content element to avoid modifying the actual displayed content
                    const contentClone = contentElement.cloneNode(true);
                    
                    // Remove all tool-use bubbles from the clone
                    contentClone.querySelectorAll('.vcp-tool-use-bubble').forEach(el => el.remove());
                    
                    // Now, get the innerText from the cleaned-up clone
                    textToSpeak = contentClone.innerText || '';
                } else {
                    // Fallback for safety, though .md-content should exist
                    textToSpeak = messageElement.textContent || messageElement.innerText;
                }
            } else {
                // If the element can't be found, fall back to parsing the raw HTML as a last resort.
                // This is less ideal as it doesn't benefit from the DOM-based filtering.
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = fullText;
                // A simple regex to strip tool blocks from the raw text as a fallback.
                const toolRegex = /<<<\[TOOL_REQUEST\]>>>(.*?)<<<\[END_TOOL_REQUEST\]>>>/gs;
                const cleanedFullText = fullText.replace(toolRegex, '');
                tempDiv.innerHTML = cleanedFullText;
                textToSpeak = tempDiv.textContent || tempDiv.innerText || '';
            }
            
            playTTS(textToSpeak.trim(), thinkingMessageId);
        }

        messageInput.disabled = false;
        sendMessageBtn.disabled = false;
        messageInput.focus();
    });
    
    function playTTS(text, msgId) {
        if (!text || !agentConfig.ttsVoicePrimary) return;
        
        console.log(`[VoiceChat] Requesting TTS for message ${msgId}`);
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

    function processAudioQueue() {
        if (isPlaying || audioQueue.length === 0) {
            return; // Don't start a new audio if one is already playing or queue is empty
        }

        isPlaying = true;
        const { audioData, msgId } = audioQueue.shift(); // Get the next audio from the queue

        console.log(`[VoiceChat] Playing audio from queue for msgId ${msgId}`);

        const byteCharacters = atob(audioData);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const audioBlob = new Blob([byteArray], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(audioBlob);

        currentAudio = new Audio(audioUrl);

        currentAudio.play().catch(e => {
            console.error("Audio playback failed:", e);
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