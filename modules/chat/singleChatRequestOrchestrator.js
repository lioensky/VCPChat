import { assembleRequestMessages, buildModelConfig } from './chatContextPipeline.js';
export {
    attachTimestampMetadata, expandWorkspacePlaceholdersInPrompt, describeLiveReference,
    buildDefaultMessageContent, buildModelConfig, normalizeContentParts, updateFirstTextPart,
} from './chatContextPipeline.js';

export function createSingleChatRequestOrchestrator({ electronAPI, tavernEngine = null } = {}) {
    if (!electronAPI) throw new Error('SingleChatRequestOrchestrator requires electronAPI');
    async function buildRequest(options) {
        const { settings, agentConfig, history, messageId, context, modelConfigOverrides = {} } = options;
        if (!settings || !agentConfig) throw new Error('Single chat requires settings and agentConfig');
        if (!messageId) throw new Error('Single chat messageId is required');
        if (!context?.agentId || !context?.topicId) throw new Error('Single chat context requires agentId and topicId');
        const { messagesForVCP } = await assembleRequestMessages({
            ...options, electronAPI, tavernEngine, history,
        });
        return {
            messages: messagesForVCP,
            modelConfig: buildModelConfig(agentConfig, modelConfigOverrides),
            messageId,
            context: {
                ...context,
                agentName: agentConfig.name || context.agentName || context.agentId,
                isGroupMessage: false,
            },
        };
    }
    async function sendPrepared(request, settings) {
        if (!request || !settings) throw new Error('Single chat requires request and settings');
        if (!settings.vcpServerUrl) throw new Error('请先配置 VCP 服务器 URL。');
        return electronAPI.sendToVCP(
            settings.vcpServerUrl, settings.vcpApiKey, request.messages,
            request.modelConfig, request.messageId, false, request.context,
        );
    }
    async function send(options) {
        const request = await buildRequest(options);
        return { response: await sendPrepared(request, options.settings), request };
    }
    return Object.freeze({ buildRequest, sendPrepared, send });
}