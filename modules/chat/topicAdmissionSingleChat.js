import { createSingleChatRequestOrchestrator } from './singleChatRequestOrchestrator.js';

export const DEFAULT_TOPIC_REPLY_INVITE = '[系统提示:] 话题中有新的伙伴留言，现在请结合上下文回应。需要回信时可自行调用 TopicSponsor；无需回信时正常回复即可。';

/** Prepare before acknowledging acceptance. No GUI selection or Flowlock session mutation. */
export async function prepareTopicAdmissionSingleChat({
    request, api, settings, persistAssistant, onCommitted, onFinalized, onStarting, createRequestTextOptions,
}) {
    if (request.scope.itemType !== 'agent') throw new TypeError('Single chat requires agent target');
    const { itemId: agentId, topicId } = request.scope;
    const [agentConfig, history] = await Promise.all([
        api.getAgentConfig(agentId), api.getChatHistory(agentId, topicId),
    ]);
    if (!agentConfig || agentConfig.error || !Array.isArray(history)) {
        throw new Error(agentConfig?.error || '无法读取目标话题');
    }
    const orchestrator = createSingleChatRequestOrchestrator({ electronAPI: api });
    const messageId = `admission_${request.token}`;
    const context = {
        agentId, topicId, itemType: 'agent', agentName: agentConfig.name,
        avatarUrl: agentConfig.avatarUrl,
        avatarColor: agentConfig.avatarCalculatedColor || agentConfig.avatarColor,
        admissionToken: request.token,
    };
    const currentUserMessageId = request.automatic ? undefined : request.messageId;
    const requestHistory = history.filter(message => !message.isThinking);
    const prepared = await orchestrator.buildRequest({
        ...createRequestTextOptions?.(agentConfig, requestHistory, currentUserMessageId),
        settings, agentConfig,
        history: history.filter(message => !message.isThinking),
        messageId, context,
        currentUserMessageId: request.automatic ? undefined : request.messageId,
        temporaryPrompt: request.automatic ? request.invitePrompt || DEFAULT_TOPIC_REPLY_INVITE : undefined,
    });
    if (!settings.vcpServerUrl) throw new Error('VCP 服务器 URL 未配置');
    return {
        messageId,
        async start() {
            await onStarting?.({
                scope: request.scope, streaming: prepared.modelConfig.stream === true,
                message: {
                    id: messageId, role: 'assistant', name: agentConfig.name, agentId, topicId,
                    admissionToken: request.token, context,
                    avatarUrl: context.avatarUrl, avatarColor: context.avatarColor,
                    content: '', isThinking: true, timestamp: Date.now(),
                },
            });
            const result = await orchestrator.sendPrepared(prepared, settings);
            if (prepared.modelConfig.stream === true) {
                if (!result?.streamingStarted || result.streamError) {
                    throw new Error(result?.errorDetail || result?.error || '流式启动失败');
                }
                // StreamCoordinator persists the response and releases admissionToken.
                return;
            }
            const response = result?.response ?? result;
            if (response?.error || !response?.choices?.length) {
                throw new Error(response?.error || '未知响应格式');
            }
            const message = {
                id: messageId, role: 'assistant', name: agentConfig.name, agentId,
                admissionToken: request.token, admissionTerminal: true,
                avatarUrl: context.avatarUrl, avatarColor: context.avatarColor,
                content: response.choices[0].message.content,
                timestamp: Date.now(), finishReason: 'completed', isThinking: false,
            };
            await persistAssistant(request.scope, message);
            const released = await api.topicAdmissionRelease(request.scope, request.token, { saved: true });
            if (!released?.success) throw new Error(released?.error || released?.code || '入场租约释放失败');
            try { await onCommitted?.(request.scope); }
            catch (error) { console.error('[AdmissionSingleChat] post-commit projection failed', error); }
            try {
                await onFinalized?.({
                    type: 'end', messageId, context, content: message.content,
                    finishReason: message.finishReason, error: null,
                });
            } catch (error) {
                console.error('[AdmissionSingleChat] post-commit finalization failed', error);
            }
        },
    };
}