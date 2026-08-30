import '../tavernRulesEngine.js';

function requireDependency(value, name) {
    if (!value) throw new Error(`SingleChatRequestOrchestrator requires ${name}`);
    return value;
}

function normalizeText(value) {
    return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function normalizeContentParts(content) {
    if (Array.isArray(content)) {
        return content.map(part => ({ ...part }));
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return [{ type: 'text', text: content.text }];
    }
    return [{ type: 'text', text: normalizeText(content) }];
}

function updateFirstTextPart(content, transform) {
    const parts = normalizeContentParts(content);
    const textIndex = parts.findIndex(part => part?.type === 'text');
    if (textIndex >= 0) {
        parts[textIndex] = {
            ...parts[textIndex],
            text: transform(normalizeText(parts[textIndex].text)),
        };
    } else {
        parts.unshift({ type: 'text', text: transform('') });
    }
    return parts;
}

function attachTimestampMetadata(vcpMessage, historyMessage) {
    if (
        !historyMessage?.id
        || typeof historyMessage.timestamp !== 'number'
        || !Number.isFinite(historyMessage.timestamp)
    ) {
        return vcpMessage;
    }

    return {
        ...vcpMessage,
        __vcpchatTimestampMeta: {
            messageId: historyMessage.id,
            role: historyMessage.role,
            timestamp: historyMessage.timestamp,
        },
    };
}

function getAttachmentData(attachment) {
    return {
        ...(attachment || {}),
        ...((attachment && attachment._fileManagerData) || {}),
    };
}

function getAttachmentPath(attachment, data) {
    // Every stored attachment receives a complete file:// internalPath from
    // fileManager. Preserve that URL regardless of attachment type so Agent
    // tools can locate images, documents, presentations, media and unknown
    // files alike. `src` is the UI-facing alias of the same capability.
    return attachment?.src
        || attachment?.internalPath
        || data?.internalPath
        || attachment?.name
        || data?.name
        || '未知文件';
}

function getAttachmentType(attachment, data) {
    return attachment?.type || data?.type || 'application/octet-stream';
}

function appendAttachmentContext(text, attachment, data) {
    const path = getAttachmentPath(attachment, data);
    const name = attachment?.name || data?.name || '未知文件';
    const type = getAttachmentType(attachment, data);
    const imageFrames = data?.imageFrames || attachment?.imageFrames;
    const extractedText = data?.extractedText || attachment?.extractedText;

    if (Array.isArray(imageFrames) && imageFrames.length > 0) {
        return `${text}\n\n[附加文件: ${path} (扫描版PDF，已转换为图片)]`;
    }
    if (extractedText) {
        return `${text}\n\n[附加文件: ${path}]\n${extractedText}\n[/附加文件结束: ${name}]`;
    }
    if (type.startsWith('image/')) {
        return `${text}\n\n[附加图片: ${path}]`;
    }
    return `${text}\n\n[附加文件: ${path}]`;
}

async function readAttachmentFrames(electronAPI, attachment, data) {
    const embeddedFrames = data?.imageFrames || attachment?.imageFrames;
    if (Array.isArray(embeddedFrames) && embeddedFrames.length > 0) {
        return {
            type: 'image/jpeg',
            frames: embeddedFrames,
        };
    }

    const type = getAttachmentType(attachment, data);
    const supportsInlinePayload = type.startsWith('image/')
        || type.startsWith('audio/')
        || type.startsWith('video/');
    if (!supportsInlinePayload || typeof electronAPI.getFileAsBase64 !== 'function') {
        return null;
    }

    const source = attachment?.src || attachment?.internalPath || data?.internalPath;
    if (!source) return null;

    try {
        const result = await electronAPI.getFileAsBase64(source);
        if (!result?.success || !Array.isArray(result.base64Frames)) {
            console.warn(
                `[SingleChatRequestOrchestrator] 跳过无法读取的附件 ${attachment?.name || source}:`,
                result?.error || '无法读取附件内容'
            );
            return null;
        }
        return {
            type: type.startsWith('image/') ? 'image/jpeg' : type,
            frames: result.base64Frames,
        };
    } catch (error) {
        console.warn(
            `[SingleChatRequestOrchestrator] 读取附件 ${attachment?.name || source} 时发生异常，已跳过:`,
            error
        );
        return null;
    }
}

async function buildDefaultMessageContent({ message, electronAPI }) {
    let text = normalizeText(message?.content);
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const mediaParts = [];

    for (const attachment of attachments) {
        const data = getAttachmentData(attachment);
        text = appendAttachmentContext(text, attachment, data);
        const framePayload = await readAttachmentFrames(electronAPI, attachment, data);
        if (!framePayload) continue;

        for (const frame of framePayload.frames) {
            mediaParts.push({
                type: 'image_url',
                image_url: {
                    url: `data:${framePayload.type};base64,${frame}`,
                },
            });
        }
    }

    const parts = [];
    if (text.trim()) parts.push({ type: 'text', text });
    parts.push(...mediaParts);
    if (parts.length === 0 && message?.role === 'user') {
        parts.push({ type: 'text', text: '(用户发送了附件，但无文本或可内联内容)' });
    }
    return parts;
}

function buildModelConfig(agentConfig = {}, overrides = {}) {
    const streamSetting = agentConfig.streamOutput;
    const stream = streamSetting === undefined
        ? true
        : streamSetting === true || streamSetting === 'true';

    return {
        model: agentConfig.model || 'gemini-pro',
        ...(agentConfig.temperature !== undefined
            && agentConfig.temperature !== null
            && agentConfig.temperature !== ''
            ? { temperature: Number.parseFloat(agentConfig.temperature) }
            : {}),
        ...(agentConfig.maxOutputTokens
            ? { max_tokens: Number.parseInt(agentConfig.maxOutputTokens, 10) }
            : {}),
        ...(agentConfig.contextTokenLimit !== undefined
            && agentConfig.contextTokenLimit !== null
            && agentConfig.contextTokenLimit !== ''
            ? { contextTokenLimit: Number.parseInt(agentConfig.contextTokenLimit, 10) }
            : {}),
        ...(agentConfig.top_p !== undefined
            && agentConfig.top_p !== null
            && agentConfig.top_p !== ''
            ? { top_p: Number.parseFloat(agentConfig.top_p) }
            : {}),
        ...(agentConfig.top_k !== undefined
            && agentConfig.top_k !== null
            && agentConfig.top_k !== ''
            ? { top_k: Number.parseInt(agentConfig.top_k, 10) }
            : {}),
        stream,
        ...overrides,
    };
}

async function loadTavernRules(electronAPI) {
    if (typeof electronAPI.tavernGetRules !== 'function') return [];
    try {
        const result = await electronAPI.tavernGetRules();
        if (!result?.success || !Array.isArray(result.store?.rules)) {
            if (result?.error) {
                console.warn('[SingleChatRequestOrchestrator] Failed to load Tavern rules:', result.error);
            }
            return [];
        }
        return result.store.rules;
    } catch (error) {
        console.warn(
            '[SingleChatRequestOrchestrator] Tavern rules unavailable; continuing without injection:',
            error
        );
        return [];
    }
}

function resolveTavernEngine(explicitEngine) {
    return explicitEngine || globalThis.TavernRulesEngine || null;
}

function applySystemRules(systemPrompt, rules, engine) {
    if (!engine || rules.length === 0) return systemPrompt;
    return engine.applySystemSuffix(systemPrompt, rules, 'agent');
}

function applyUserRules(content, rules, engine) {
    if (!engine || rules.length === 0) return normalizeContentParts(content);
    return updateFirstTextPart(content, text => engine.applyUserSuffix(text, rules, 'agent'));
}

function applyContextRules(messages, rules, engine) {
    if (!engine || rules.length === 0) return messages;
    const systemMessages = messages.filter(message => message.role === 'system');
    const conversationMessages = messages.filter(message => message.role !== 'system');
    const injected = engine.applyContextInject(conversationMessages, rules, 'agent', {
        makeMessage: (role, text) => ({
            role,
            content: [{ type: 'text', text }],
            __tavernInjected: true,
        }),
    });
    return [...systemMessages, ...injected];
}

function createSingleChatRequestOrchestrator({
    electronAPI,
    tavernEngine = null,
} = {}) {
    requireDependency(electronAPI, 'electronAPI');

    async function buildRequest({
        settings,
        agentConfig,
        history,
        messageId,
        context,
        currentUserMessageId,
        systemPromptAppend = '',
        systemPromptPrefix = '',
        modelConfigOverrides = {},
        transformMessageText = null,
        buildMessageContent = null,
        postProcessMessageContent = null,
        tavernRules = null,
    }) {
        requireDependency(settings, 'settings');
        requireDependency(agentConfig, 'agentConfig');
        if (!Array.isArray(history)) throw new TypeError('Single chat history must be an array');
        if (!messageId) throw new Error('Single chat messageId is required');
        if (!context?.agentId || !context?.topicId) {
            throw new Error('Single chat context requires agentId and topicId');
        }

        const engine = resolveTavernEngine(tavernEngine);
        const rules = Array.isArray(tavernRules)
            ? tavernRules
            : await loadTavernRules(electronAPI);
        const contentBuilder = buildMessageContent || buildDefaultMessageContent;
        const effectiveHistory = history.filter(message => message && message.isThinking !== true);
        const messages = [];

        for (let index = 0; index < effectiveHistory.length; index += 1) {
            const historyMessage = effectiveHistory[index];
            let content = await contentBuilder({
                message: historyMessage,
                index,
                history: effectiveHistory,
                electronAPI,
            });
            content = normalizeContentParts(content);

            if (typeof transformMessageText === 'function') {
                content = updateFirstTextPart(content, text => transformMessageText({
                    text,
                    message: historyMessage,
                    index,
                    history: effectiveHistory,
                }));
            }
            if (historyMessage.role === 'user' && historyMessage.id === currentUserMessageId) {
                content = applyUserRules(content, rules, engine);
            }
            if (typeof postProcessMessageContent === 'function') {
                content = normalizeContentParts(await postProcessMessageContent({
                    content,
                    message: historyMessage,
                    index,
                    history: effectiveHistory,
                    electronAPI,
                }));
            }

            messages.push(attachTimestampMetadata({
                role: historyMessage.role,
                content,
                ...(historyMessage.name ? { name: historyMessage.name } : {}),
                ...(historyMessage.tool_calls ? { tool_calls: historyMessage.tool_calls } : {}),
                ...(historyMessage.tool_call_id ? { tool_call_id: historyMessage.tool_call_id } : {}),
            }, historyMessage));
        }

        const agentName = agentConfig.name || context.agentName || context.agentId;
        const baseSystemPrompt = normalizeText(agentConfig.systemPrompt)
            .replace(/\{\{AgentName\}\}/g, agentName);
        const systemParts = [
            normalizeText(systemPromptPrefix).trim(),
            baseSystemPrompt.trim(),
            normalizeText(systemPromptAppend).trim(),
        ].filter(Boolean);
        const systemPrompt = applySystemRules(systemParts.join('\n\n'), rules, engine);
        if (systemPrompt.trim()) {
            messages.unshift({ role: 'system', content: systemPrompt });
        }

        return {
            messages: applyContextRules(messages, rules, engine),
            modelConfig: buildModelConfig(agentConfig, modelConfigOverrides),
            messageId,
            context: {
                ...context,
                agentName,
                isGroupMessage: false,
            },
        };
    }

    async function sendPrepared(request, settings) {
        requireDependency(request, 'request');
        requireDependency(settings, 'settings');
        if (!settings.vcpServerUrl) throw new Error('请先配置 VCP 服务器 URL。');

        return electronAPI.sendToVCP(
            settings.vcpServerUrl,
            settings.vcpApiKey,
            request.messages,
            request.modelConfig,
            request.messageId,
            false,
            request.context,
        );
    }

    async function send(options) {
        const request = await buildRequest(options);
        const response = await sendPrepared(request, options.settings);
        return { response, request };
    }

    return Object.freeze({ buildRequest, sendPrepared, send });
}

export {
    attachTimestampMetadata,
    buildDefaultMessageContent,
    buildModelConfig,
    createSingleChatRequestOrchestrator,
    normalizeContentParts,
    updateFirstTextPart,
};