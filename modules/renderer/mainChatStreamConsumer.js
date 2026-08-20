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
        streamOperationId: event.streamOperationId || event.operationId || null,
    };
};

/** Main-window projection of stream facts. All powers are explicit capabilities. */
export function createMainChatStreamConsumer(initialEvent, capabilities) {
    const { messageId } = initialEvent;
    const operationId = initialEvent.streamOperationId || initialEvent.operationId || messageId;
    let context = initialEvent.context || {};
    let preparedType = null;
    const projection = capabilities.resolveProjection?.(messageId) || null;

    return Object.freeze({
        surfaceGeneration: capabilities.getSurfaceGeneration?.(),
        normalizeChunk: normalizeStreamChunk,
        async prepare(event) {
            context = { ...context, ...(event.context || {}) };
            if (preparedType === null) {
                preparedType = event.type;
                await (projection?.start || capabilities.start)(buildMessage({ ...event, context, streamOperationId: operationId }));
            }
        },
        consume(event) {
            const terminal = terminalTypes.has(event.type);
            if (projection?.suppressed) {
                if (terminal) projection.settle?.({ event, finalized: event.outcome?.persistence?.value, context, messageId });
                return;
            }
            if (event.type === 'chunk') (projection?.append || capabilities.append)(messageId, event.text, context, operationId);
            if (!terminal) return;
            const finalized = event.outcome?.persistence?.value;
            capabilities.dispatchTerminal?.({
                type: event.outcome?.transport?.kind === 'failed' ? 'error' : event.type,
                messageId,
                context,
                error: event.outcome?.transport?.error || event.outcome?.persistence?.error || null,
            });
            if (event.type === 'failed') capabilities.renderError?.({ event, finalized, context });
            projection?.settle?.({ event, finalized, context, messageId, streamOperationId: operationId });
            capabilities.onSettled?.({ event, finalized, context, messageId });
        },
        async persist(value) {
            if (projection?.suppressed) return null;
            const terminal = value.terminal || {};
            if (terminal.phase === 'projection') {
                throw terminal.error || new Error(`Stream projection failed: ${messageId}`);
            }
            let fullResponse = terminal.fullResponse || value.snapshot?.text || '';
            const error = terminal.error?.message || terminal.error || '';
            if (terminal.kind === 'failed' && fullResponse.trim()) {
                fullResponse += `\n\n> [!WARNING]\n> **流式响应中断**: ${error || '未知连接错误'}。已保存已接收的部分内容。`;
            }
            const projectTerminal = projection?.projectTerminal || capabilities.projectTerminal;
            const projected = await projectTerminal(
                messageId,
                terminal.kind === 'completed' ? (terminal.finishReason || 'completed') : terminal.kind,
                terminal.context || context,
                { fullResponse, error, streamOperationId: operationId },
            );
            if (!projected) throw new Error(`Stream terminal projection failed: ${messageId}`);
            const finalized = await capabilities.persistTerminal(projected);
            try {
                await capabilities.afterPersist?.({ terminal, finalized, context, messageId });
            } catch (sideEffectError) {
                capabilities.reportError?.('[MainChatStreamConsumer] post-commit side effect failed', sideEffectError);
            }
            return finalized;
        },
        dispose() { projection?.release?.(); },
    });
}
