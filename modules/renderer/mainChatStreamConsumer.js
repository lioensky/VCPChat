import { normalizeStreamChunk } from '../chat/contentRuntime.js';

const terminalTypes = new Set(['completed', 'failed', 'cancelled', 'discarded']);

const buildMessage = event => {
    const context = event.context || {};
    return {
        id: event.messageId,
        role: 'assistant',
        name: context.agentName,
        agentId: context.agentId,
        avatarUrl: context.avatarUrl,
        avatarColor: context.avatarColor,
        content: event.type === 'agent_thinking' ? '思考中...' : '',
        timestamp: Date.now(),
        isThinking: event.type === 'agent_thinking',
        isGroupMessage: context.isGroupMessage || false,
        groupId: context.groupId,
        topicId: context.topicId,
        context,
    };
};

/** Main-window projection of stream facts. All powers are explicit capabilities. */
export function createMainChatStreamConsumer(initialEvent, capabilities) {
    const { messageId } = initialEvent;
    let context = initialEvent.context || {};
    let preparedType = null;
    const projection = capabilities.resolveProjection?.(messageId) || null;

    return Object.freeze({
        surfaceGeneration: capabilities.getSurfaceGeneration?.(),
        normalizeChunk: normalizeStreamChunk,
        async prepare(event) {
            context = event.context || context;
            if ((event.type === 'agent_thinking' || event.type === 'start') && preparedType !== event.type) {
                preparedType = event.type;
                await (projection?.start || capabilities.start)(buildMessage(event));
            }
        },
        consume(event) {
            if (event.type === 'chunk') capabilities.append(messageId, event.text, context);
            if (!terminalTypes.has(event.type)) return;
            const finalized = event.outcome?.persistence?.value;
            capabilities.dispatchTerminal?.({
                type: event.outcome?.transport?.kind === 'failed' ? 'error' : event.type,
                messageId,
                context,
                error: event.outcome?.transport?.error || event.outcome?.persistence?.error || null,
            });
            if (event.type === 'failed') capabilities.renderError?.({ event, finalized, context });
        },
        async persist(value) {
            const terminal = value.terminal || {};
            let fullResponse = terminal.fullResponse || value.snapshot?.text || '';
            const error = terminal.error?.message || terminal.error || '';
            if (terminal.kind === 'failed' && fullResponse.trim()) {
                fullResponse += `\n\n> [!WARNING]\n> **流式响应中断**: ${error || '未知连接错误'}。已保存已接收的部分内容。`;
            }
            const finalized = await capabilities.finalize(
                messageId,
                terminal.kind === 'completed' ? (terminal.finishReason || 'completed') : terminal.kind,
                terminal.context || context,
                { fullResponse, error },
            );
            await capabilities.afterPersist?.({ terminal, finalized, context, messageId });
            return finalized;
        },
        dispose() { projection?.release?.(); },
    });
}
