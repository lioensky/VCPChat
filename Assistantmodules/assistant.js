// Assistantmodules/assistant.js

document.addEventListener('DOMContentLoaded', () => {
    const chatMessagesDiv = document.getElementById('chatMessages');
    const messageInput = document.getElementById('messageInput');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    const agentAvatarImg = document.getElementById('agentAvatar');
    const agentNameSpan = document.getElementById('currentChatAgentName');
    const closeBtn = document.getElementById('close-btn-assistant');

    let agentConfig = null;
    let agentId = null;
    let globalSettings = {};
    let currentChatHistory = [];
    let activeStreamingMessageId = null;
    const markedInstance = new window.marked.Marked({ gfm: true, breaks: true });

    const scrollToBottom = () => {
        chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
    };

    // --- Main Logic ---

    closeBtn.addEventListener('click', () => window.close());
// --- Click Handler for Images and Links ---
chatMessagesDiv.addEventListener('click', (event) => {
    const target = event.target;

    // Handle image clicks
    if (target.tagName === 'IMG' && target.closest('.message-content')) {
        event.preventDefault();
        const imageUrl = target.src;
        const imageTitle = target.alt || '图片预览';
        const theme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
        console.log(`[Assistant] Image clicked. Opening in new window. URL: ${imageUrl}`);
        window.electronAPI.openImageInNewWindow(imageUrl, imageTitle, theme);
        return;
    }

    // Handle link clicks
    if (target.tagName === 'A' && target.href) {
        event.preventDefault();
        const url = target.href;
        // Ensure it's a web link before opening
        if (url.startsWith('http:') || url.startsWith('https:')) {
            console.log(`[Assistant] Link clicked. Opening externally. URL: ${url}`);
            window.electronAPI.sendOpenExternalLink(url);
        }
        return;
    }
});

window.electronAPI.onAssistantData(async (data) => {
        console.log('Received assistant data:', data);
        const { selectedText, action, agentId: receivedAgentId, theme } = data;
        
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
        agentNameSpan.textContent = agentConfig.name;

        // --- Initialize Shared Renderer ---
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
                set: () => {} // Not needed in assistant
            };
            const globalSettingsRef = {
                get: () => globalSettings,
                set: (newSettings) => { globalSettings = newSettings; }
            };
            const topicIdRef = {
                get: () => 'assistant_chat', // Assistant has a single, non-persistent topic
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
                uiHelper: window.uiHelperFunctions,
                summarizeTopicFromMessages: async () => "", // Stub
                handleCreateBranch: () => {} // Stub
            });
            console.log('[Assistant] Shared messageRenderer initialized.');
        } else {
            console.error('[Assistant] window.messageRenderer is not available. Cannot initialize shared renderer.');
            agentNameSpan.textContent = "错误";
            chatMessagesDiv.innerHTML = `<div class="message-item system"><p style="color: var(--danger-color);">加载渲染模块失败，请重启应用。</p></div>`;
            return;
        }

        const prompts = {
            translate: '请将上方文本翻译为简体中文；若原文为中文，则翻译为英文。',
            summarize: '请提取上方文本的核心要点，若含有数据内容可以MD列表等形式呈现。',
            explain: '请通俗易懂地解释上方文本中的关键概念或术语。',
            search: '请从上方文本中获取相关核心关键词进行Tavily网络搜索，并返回最相关的结果摘要。',
            image:'请根据引用文本内容，调用已有生图工具生成一张配图。',
            table: '根据引用文本内容，构建摘要来生成一个MD表格'
        };
        const actionPrompt = prompts[action] || '';
        const initialPrompt = `[引用文本：${selectedText}]\n\n${actionPrompt}`;

        // Clear previous state and send the new prompt
        chatMessagesDiv.innerHTML = '';
        currentChatHistory = [];
        sendMessage(initialPrompt);
    });

    window.electronAPI.onThemeUpdated((theme) => {
        console.log(`[Assistant Window] Theme updated to: ${theme}`);
        document.body.classList.toggle('light-theme', theme === 'light');
        document.body.classList.toggle('dark-theme', theme !== 'light'); // Ensure dark is set correctly
    });

    const sendMessage = async (messageContent) => {
        if (!messageContent.trim() || !agentConfig || !window.messageRenderer) return;

        const userMessage = { role: 'user', content: messageContent, timestamp: Date.now(), id: `user_msg_${Date.now()}` };
        await window.messageRenderer.renderMessage(userMessage, false);

        messageInput.value = '';
        messageInput.disabled = true;
        sendMessageBtn.disabled = true;

        const thinkingMessageId = `assistant_msg_${Date.now()}`;
        activeStreamingMessageId = thinkingMessageId; // Set active stream ID

        const assistantMessagePlaceholder = {
            id: thinkingMessageId,
            role: 'assistant',
            content: '思考中',
            timestamp: Date.now(),
            isThinking: true,
            name: agentConfig.name,
            avatarUrl: agentConfig.avatarUrl
        };
        await window.messageRenderer.renderMessage(assistantMessagePlaceholder, false);

        // Context is required for the new sendToVCP API
        const context = {
            agentId: agentId,
            topicId: 'assistant_chat'
        };

        try {
            const latestAgentConfig = await window.electronAPI.getAgentConfig(agentId);
            if (!latestAgentConfig || latestAgentConfig.error) throw new Error(`无法获取最新的助手配置: ${latestAgentConfig?.error || '未知错误'}`);
            agentConfig = latestAgentConfig;

            const systemPrompt = (agentConfig.systemPrompt || '').replace(/\{\{AgentName\}\}/g, agentConfig.name);
            const messagesForVCP = [];
            if (systemPrompt) messagesForVCP.push({ role: 'system', content: systemPrompt });
            
            const historyForVCP = currentChatHistory.map(msg => ({ role: msg.role, content: msg.content }));
            messagesForVCP.push(...historyForVCP);

            const modelConfig = {
                model: agentConfig.model,
                temperature: agentConfig.temperature,
                stream: true,
                max_tokens: agentConfig.maxOutputTokens
            };

            // Call with new signature, including context. isGroupCall is false.
            await window.electronAPI.sendToVCP(globalSettings.vcpServerUrl, globalSettings.vcpApiKey, messagesForVCP, modelConfig, thinkingMessageId, false, context);

        } catch (error) {
            console.error('Error sending message to VCP:', error);
            if (window.messageRenderer) {
                // Finalize without context to prevent history saving, then update UI
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
    // Listen to the new, unified stream event
    window.electronAPI.onVCPStreamEvent((eventData) => {
        if (!window.messageRenderer || eventData.messageId !== activeStreamingMessageId) return;

        const { messageId, type, chunk, error } = eventData;

        // The 'start' event is implicit. The first 'data' chunk will trigger startStreamingMessage.
        if (!activeStreams.has(messageId) && type === 'data') {
            window.messageRenderer.startStreamingMessage({
                id: messageId,
                role: 'assistant',
                name: agentConfig.name,
                avatarUrl: agentConfig.avatarUrl,
            });
            activeStreams.add(messageId);
        }

        if (type === 'data') {
            // No context needed for assistant window
            window.messageRenderer.appendStreamChunk(messageId, chunk);
        } else if (type === 'end') {
            // No context needed, and no fullText. This prevents history saving.
            window.messageRenderer.finalizeStreamedMessage(messageId, 'completed');
            activeStreams.delete(messageId);
            activeStreamingMessageId = null;
            messageInput.disabled = false;
            sendMessageBtn.disabled = false;
            messageInput.focus();
        } else if (type === 'error') {
            // No context needed.
            window.messageRenderer.finalizeStreamedMessage(messageId, 'error');
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

    sendMessageBtn.addEventListener('click', () => sendMessage(messageInput.value));
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(messageInput.value);
        }
    });
});