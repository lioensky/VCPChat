// Assistantmodules/assistant.js

document.addEventListener('DOMContentLoaded', () => {
    const chatMessagesDiv = document.getElementById('chatMessages');
    const messageInput = document.getElementById('messageInput');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    const attachFileBtn = document.getElementById('attachFileBtn');
    const attachmentPreviewArea = document.getElementById('attachmentPreviewArea');
    const agentAvatarImg = document.getElementById('agentAvatar');
    const agentNameSpan = document.getElementById('currentChatAgentName');
    const closeBtn = document.getElementById('close-btn-assistant');

    let agentConfig = null;
    let agentId = null;
    let globalSettings = {};
    let currentChatHistory = [];
    let attachedFiles = [];
    let activeStreamingMessageId = null;
    const markedInstance = new window.marked.Marked({ gfm: true, breaks: true });

    const scrollToBottom = () => {
        chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
    };

    // --- Main Logic ---

    let isClosing = false;
    closeBtn.addEventListener('click', async () => {
        if (isClosing) return;
        isClosing = true;

        // 立即隐藏窗口，解决“卡顿”感
        if (window.electronAPI.hideWindow) {
            window.electronAPI.hideWindow();
        } else {
            // 退而求其次，改变透明度
            document.body.style.opacity = '0';
            document.body.style.pointerEvents = 'none';
        }

        try {
            await saveAssistantChatToHistory();
        } catch (error) {
            console.error('[Assistant] Error saving history on close:', error);
        } finally {
            window.close();
        }
    });

    async function saveAssistantChatToHistory() {
        if (!agentId || currentChatHistory.length === 0) return;

        // Filter out thinking messages and system messages if they are just placeholders
        const validMessages = currentChatHistory.filter(msg => !msg.isThinking && msg.role !== 'system');
        if (validMessages.length === 0) return;

        console.log('[Assistant] Saving chat history before exit...');
        try {
            // 1. Create a new topic for this assistant chat
            const timestamp = new Date().toLocaleString();
            const defaultTitle = `划词助手 ${timestamp}`;
            const result = await window.electronAPI.createNewTopicForAgent(agentId, defaultTitle);

            if (result && result.success && result.topicId) {
                const newTopicId = result.topicId;
                
                // 2. Save the history to the new topic
                await window.electronAPI.saveChatHistory(agentId, newTopicId, currentChatHistory);
                console.log(`[Assistant] History saved to new topic: ${newTopicId}`);

                // 3. Attempt to summarize the topic title
                if (window.summarizeTopicFromMessages) {
                    const agentName = agentConfig?.name || 'AI';
                    const summarizedTitle = await window.summarizeTopicFromMessages(validMessages, agentName);
                    if (summarizedTitle) {
                        await window.electronAPI.saveAgentTopicTitle(agentId, newTopicId, summarizedTitle);
                        console.log(`[Assistant] Topic summarized: ${summarizedTitle}`);
                    }
                }
            } else {
                console.error('[Assistant] Failed to create topic for saving history:', result?.error);
            }
        } catch (error) {
            console.error('[Assistant] Error saving assistant chat history:', error);
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
            const interruptHandler = {
                interrupt: async (messageId) => {
                    console.log(`[Assistant] Interrupting via handler for message: ${messageId}`);
                    if (activeStreamingMessageId === messageId) {
                        // Notify the main process to stop the VCP request.
                        // The main process should then send an 'end' or 'error' stream event,
                        // which will trigger finalizeStreamedMessage correctly.
                        await window.electronAPI.interruptVcpRequest({ messageId });
                        return { success: true };
                    }
                    return { success: false, error: "Message not actively streaming." };
                }
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
                summarizeTopicFromMessages: window.summarizeTopicFromMessages || (async () => ""),
                handleCreateBranch: () => {}, // Stub
                interruptHandler: interruptHandler // Provide the interrupt handler
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
        if (action === 'open') {
            chatMessagesDiv.innerHTML = '';
            currentChatHistory = [];
            messageInput.focus();
            return;
        }

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

    const updateAttachmentPreview = () => {
        if (!attachmentPreviewArea) return;
        attachmentPreviewArea.innerHTML = '';
        attachedFiles.forEach((fileObj, index) => {
            const item = document.createElement('div');
            item.className = 'attachment-preview-item';
            
            const isImage = fileObj.file.type.startsWith('image/');
            if (isImage) {
                const img = document.createElement('img');
                img.src = fileObj.localPath;
                item.appendChild(img);
            } else {
                const icon = document.createElement('div');
                icon.className = 'file-icon';
                icon.textContent = '📄';
                item.appendChild(icon);
            }

            const removeBtn = document.createElement('div');
            removeBtn.className = 'remove-attachment';
            removeBtn.textContent = '×';
            removeBtn.onclick = () => {
                attachedFiles.splice(index, 1);
                updateAttachmentPreview();
            };
            item.appendChild(removeBtn);
            attachmentPreviewArea.appendChild(item);
        });
    };

    const sendMessage = async (messageContent) => {
        if (!messageContent.trim() && attachedFiles.length === 0) return;
        if (!agentConfig || !window.messageRenderer) return;

        const uiAttachments = [];
        if (attachedFiles.length > 0) {
            attachedFiles.forEach(af => {
                const fileManagerData = af._fileManagerData || {};
                uiAttachments.push({
                    type: fileManagerData.type,
                    src: af.localPath,
                    name: af.originalName,
                    size: af.file.size,
                    _fileManagerData: fileManagerData
                });
            });
        }

        const userMessage = {
            role: 'user',
            content: messageContent,
            timestamp: Date.now(),
            id: `user_msg_${Date.now()}`,
            attachments: uiAttachments
        };
        await window.messageRenderer.renderMessage(userMessage, false);
        currentChatHistory.push(userMessage);

        messageInput.value = '';
        attachedFiles = [];
        updateAttachmentPreview();

        messageInput.disabled = true;
        sendMessageBtn.disabled = true;
        if (attachFileBtn) attachFileBtn.disabled = true;

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
            if (systemPrompt) {
                messagesForVCP.push({ role: 'system', content: [{ type: 'text', text: systemPrompt }] });
            }

            const historyForVCP = await Promise.all(currentChatHistory.filter(msg => !msg.isThinking).map(async msg => {
                let currentMessageTextContent = msg.content;
                let vcpImageAttachmentsPayload = [];

                if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
                    let appendedText = "";
                    for (const att of msg.attachments) {
                        const fileManagerData = att._fileManagerData || {};
                        const filePathForContext = att.src || att.name;

                        if (fileManagerData.extractedText) {
                            appendedText += `\n\n[附加文件: ${filePathForContext}]\n${fileManagerData.extractedText}\n[/附加文件结束: ${att.name}]`;
                        } else {
                            appendedText += `\n\n[附加文件: ${filePathForContext}]`;
                        }

                        if (att.type.startsWith('image/')) {
                            const result = await window.electronAPI.getFileAsBase64(att.src);
                            if (result && result.success) {
                                result.base64Frames.forEach(frameData => {
                                    vcpImageAttachmentsPayload.push({
                                        type: 'image_url',
                                        image_url: { url: `data:image/jpeg;base64,${frameData}` }
                                    });
                                });
                            }
                        }
                    }
                    currentMessageTextContent += appendedText;
                }

                const contentPayload = [{ type: 'text', text: currentMessageTextContent }];
                contentPayload.push(...vcpImageAttachmentsPayload);

                return {
                    role: msg.role,
                    content: contentPayload
                };
            }));
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
            if (attachFileBtn) attachFileBtn.disabled = false;
            messageInput.focus();
        }
    };

    const activeStreams = new Set();
    // Listen to the new, unified stream event
    window.electronAPI.onVCPStreamEvent((eventData) => {
        if (!window.messageRenderer || eventData.messageId !== activeStreamingMessageId) return;

        const { messageId, type, chunk, error, context } = eventData;

        // The 'start' event is implicit. The first 'data' chunk will trigger startStreamingMessage.
        if (!activeStreams.has(messageId) && type === 'data') {
            window.messageRenderer.startStreamingMessage({
                id: messageId,
                role: 'assistant',
                name: agentConfig.name,
                avatarUrl: agentConfig.avatarUrl,
                context: context, // Pass context
            });
            activeStreams.add(messageId);
        }

        if (type === 'data') {
            window.messageRenderer.appendStreamChunk(messageId, chunk, context);
        } else if (type === 'end') {
            window.messageRenderer.finalizeStreamedMessage(messageId, 'completed', context);
            activeStreams.delete(messageId);
            activeStreamingMessageId = null;
            messageInput.disabled = false;
            sendMessageBtn.disabled = false;
            if (attachFileBtn) attachFileBtn.disabled = false;
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
            if (attachFileBtn) attachFileBtn.disabled = false;
            messageInput.focus();
        }
    });

    if (attachFileBtn) {
        attachFileBtn.addEventListener('click', async () => {
            if (!agentId) return;
            const result = await window.electronAPI.selectFilesToSend(agentId, 'assistant_chat');
            if (result && result.success && result.attachments) {
                result.attachments.forEach(att => {
                    if (!att.error) {
                        attachedFiles.push({
                            file: { name: att.name, type: att.type, size: att.size },
                            localPath: att.internalPath,
                            originalName: att.name,
                            _fileManagerData: att
                        });
                    }
                });
                updateAttachmentPreview();
                // 修复：附加文件后强制聚焦输入框，防止窗口丢失焦点
                messageInput.focus();
            }
        });
    }

    sendMessageBtn.addEventListener('click', () => sendMessage(messageInput.value));
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(messageInput.value);
        }
    });

    // --- Paste Handler ---
    messageInput.addEventListener('paste', async (event) => {
        const clipboardData = event.clipboardData || window.clipboardData;
        if (!clipboardData) return;

        const items = clipboardData.items;
        let hasFile = false;
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
                hasFile = true;
                break;
            }
        }

        if (hasFile) {
            event.preventDefault();
            if (!agentId) return;
            for (let i = 0; i < items.length; i++) {
                if (items[i].kind === 'file') {
                    const file = items[i].getAsFile();
                    if (file) {
                        await handlePastedFile(file);
                    }
                }
            }
        }
    });

    async function handlePastedFile(file) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const arrayBuffer = e.target.result;
            const fileBuffer = new Uint8Array(arrayBuffer);
            const results = await window.electronAPI.handleFileDrop(agentId, 'assistant_chat', [{
                name: file.name,
                type: file.type || 'application/octet-stream',
                data: fileBuffer,
                size: file.size
            }]);
            if (results && results.length > 0 && results[0].success && results[0].attachment) {
                const att = results[0].attachment;
                attachedFiles.push({
                    file: { name: att.name, type: att.type, size: att.size },
                    localPath: att.internalPath,
                    originalName: att.name,
                    _fileManagerData: att
                });
                updateAttachmentPreview();
                // 修复：粘贴文件后强制聚焦输入框，防止窗口丢失焦点
                messageInput.focus();
            }
        };
        reader.readAsArrayBuffer(file);
    }
});