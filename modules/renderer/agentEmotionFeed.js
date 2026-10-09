/* Feed one agent's streamed replies into an emotion director.
 * A passive listener on the VCP stream channel: it only reads events (never consumes or changes
 * them), keeps only the agent isActive() names, and maps start / data / end / error onto the
 * director's begin / append / end / fail. Group chat replies are skipped: they belong to the group's
 * conversation, not to the agent being viewed, and a background group turn must not take over the
 * portrait from the reply on screen. */
import { normalizeStreamChunk } from '../chat/contentRuntime.js';

export function createAgentEmotionFeed({ chatAPI, director, getAgentId, isActive = () => true }) {
    if (typeof chatAPI?.onVCPStreamEvent !== 'function' || !director) {
        return Object.freeze({ dispose() {} });
    }
    let disposed = false;
    const unsubscribe = chatAPI.onVCPStreamEvent((event) => {
        if (disposed || !event || !isActive()) return;
        const agentId = event.context?.agentId;
        const messageId = event.messageId ? String(event.messageId) : '';
        if (!agentId || !messageId || agentId !== getAgentId() || event.context?.isGroupMessage) return;
        try {
            switch (event.type) {
                case 'agent_thinking':
                case 'start':
                    director.begin(messageId);
                    break;
                case 'data': {
                    const text = normalizeStreamChunk(event.chunk);
                    if (text) director.append(messageId, text);
                    else if (director.activeMessageId !== messageId) director.begin(messageId);
                    break;
                }
                case 'end':
                    director.end(messageId);
                    break;
                case 'error':
                    director.fail(messageId);
                    break;
                default:
                    break;
            }
        } catch (error) {
            console.warn('[AgentEmotionFeed] Failed to read stream event:', error);
        }
    });
    return Object.freeze({
        dispose() {
            disposed = true;
            if (typeof unsubscribe === 'function') unsubscribe();
            else unsubscribe?.dispose?.();
        },
    });
}
