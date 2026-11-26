const { createNativeToolCallStream } = require('../modules/chat/nativeToolCallStream.js');
const { appendAssistantSegmentText, expandHostedHistoryMessage } = require('../modules/chat/hostedToolHistory.js');

function createGroupStreamHistory() {
    const decoder = createNativeToolCallStream();
    let text = '', segments;
    function consume(item) {
        if (typeof item === 'string') {
            text += item;
            if (segments) segments = appendAssistantSegmentText(segments, item);
        } else {
            segments ??= text ? [{ content: text }] : [];
            segments.push({ tool_calls: item.vcpHostedToolCalls });
        }
    }
    return {
        push(chunk) {
            const before = text.length;
            const normalized = typeof chunk.message?.content === 'string' && !chunk.choices?.length && !chunk.content && !chunk.delta?.content
                ? { ...chunk, content: chunk.message.content } : chunk;
            decoder.push(normalized).forEach(consume);
            return text.length !== before;
        },
        get text() { return text; },
        fields(finalText = text) {
            decoder.flush().forEach(consume);
            if (!segments || !finalText.startsWith(text)) return {};
            return { assistantSegments: finalText === text ? segments : [...segments, { content: finalText.slice(text.length) }] };
        },
    };
}

// Return one floor (possibly a message array) until Tavern has applied floor depth.
function projectGroupFloor(msg, parts, speaker, augmentedText, stamp) {
    const ordinary = () => stamp({ role: msg.role, content: parts }, msg);
    if (msg.role !== 'assistant' || !Array.isArray(msg.assistantSegments) || typeof msg.content !== 'string') return ordinary();
    const turns = expandHostedHistoryMessage(msg);
    if (turns.length === 1 && turns[0].content === msg.content && !turns[0].tool_calls) return ordinary();
    const suffix = augmentedText.slice(msg.content.length);
    let first = true;
    return turns.map(turn => {
        if (turn.role !== 'assistant') return turn;
        const prose = turn.content + (first ? suffix : '');
        const media = first ? parts.slice(1) : [];
        first = false;
        const prefix = `[${speaker}的发言]`;
        const content = prose || media.length ? [{ type: 'text', text: prose.startsWith(prefix) ? prose : `${prefix}: ${prose}` }, ...media] : null;
        return stamp({ role: 'assistant', content, ...(turn.tool_calls ? { tool_calls: turn.tool_calls } : {}) }, msg);
    });
}
module.exports = { createGroupStreamHistory, projectGroupFloor };
