import { collectToolBatchRanges } from '../renderer/toolBatchRegions.js';

const ROLE_START = /^\s*<<<\[ROLE_DIVIDE_USER\]>>>\s*/u;
const ROLE_END = /^\s*<<<\[END_ROLE_DIVIDE_USER\]>>>[ \t]*(?:\r?\n|$)/u;

/** Only an immediately following, fully closed receipt can close a structured FC. */
export function splitLeadingReceipt(text) {
    const opening = ROLE_START.exec(text);
    const start = opening?.[0].length ?? text.length - text.trimStart().length;
    if (!text.startsWith('<<<[VCP_TOOL_BATCH_START:', start)) return null;
    const [batch] = collectToolBatchRanges(text);
    if (!batch?.closed || batch.start !== start) return null;
    const closing = opening && ROLE_END.exec(text.slice(batch.end));
    if (opening && !closing) return null;
    const end = batch.end + (closing?.[0].length ?? 0);
    return { receipt: text.slice(batch.start, batch.end), raw: text.slice(0, end), rest: text.slice(end) };
}

/** One boundary rule for the session snapshot and the live DOM projection. */
export function appendAssistantSegmentText(segments, text) {
    const tail = segments.at(-1);
    const extend = typeof tail?.content === 'string' && !tail.receipt;
    const prefix = extend ? segments.slice(0, -1) : segments;
    const incoming = (extend ? tail.content : '') + text;
    const sealed = prefix.at(-1)?.tool_calls && splitLeadingReceipt(incoming);
    if (!sealed) return [...prefix, Object.freeze({ content: incoming })];
    return [...prefix, Object.freeze({ content: sealed.raw, receipt: true }),
        ...(sealed.rest ? [Object.freeze({ content: sealed.rest })] : [])];
}
/** Storage remains one chat bubble; only this projection builds replayable turns. */
export function splitHostedAssistantTurns(segments) {
    const turns = [];
    let content = '';
    let pending = null;
    const flush = () => {
        if (content.trim()) turns.push({ content });
        content = '';
        pending = null;
    };
    for (const segment of segments) {
        if (Array.isArray(segment?.tool_calls) && segment.tool_calls.length) {
            if (pending) flush();
            pending = segment.tool_calls;
            continue;
        }
        if (typeof segment?.content !== 'string') continue;
        if (!pending) {
            content += segment.content;
            continue;
        }
        const sealed = splitLeadingReceipt(segment.content);
        if (sealed) {
            const { rest, receipt } = sealed;
            turns.push({ content, tool_calls: pending, receipt });
            content = rest;
            pending = null;
        } else {
            flush();
            // With a role wrapper or bare batch prefix this is a partial receipt,
            // not model prose. Leave it in history, but never replay it as dialogue.
            if (!/^\s*<<<\[(?:ROLE_DIVIDE_USER|VCP_TOOL_BATCH_START)/u.test(segment.content)) content = segment.content;
        }
    }
    flush();
    return turns;
}

/** Project the local bubble into ordinary Chat Completions messages. */
export function expandHostedHistoryMessage(message) {
    if (message?.role !== 'assistant' || !Array.isArray(message.assistantSegments)) return [message];
    const { assistantSegments, ...base } = message;
    const flat = assistantSegments.map(segment => segment?.content ?? '').join('');
    if (typeof base.content === 'string' && flat !== base.content) return [base];
    return splitHostedAssistantTurns(assistantSegments).flatMap(({ content, receipt, tool_calls }, index) => {
        const assistant = {
            ...base,
            content,
            ...(index > 0 ? { attachments: [] } : {}),
            ...(tool_calls ? { tool_calls } : {}),
        };
        if (!tool_calls) return [assistant];
        return [
            assistant,
            ...tool_calls.map(({ id }) => ({
                role: 'tool', tool_call_id: id, content: '原始结果保留上下文摘要',
            })),
            { role: 'user', content: receipt },
        ];
    });
}

/** The flat editor edits text, never the structured call records. */
export function reconcileEditedAssistantSegments(segments, text) {
    if (!Array.isArray(segments) || typeof text !== 'string') return segments;
    const original = segments.map(segment => segment.content ?? '').join('');
    if (text === original) return segments;
    let start = 0;
    while (start < original.length && start < text.length && original[start] === text[start]) start++;
    let end = original.length, newEnd = text.length;
    while (end > start && newEnd > start && original[end - 1] === text[newEnd - 1]) { end--; newEnd--; }
    const inserted = text.slice(start, newEnd);
    const result = segments.slice();
    let offset = 0, placed = false;
    for (const [index, segment] of segments.entries()) {
        if (typeof segment.content !== 'string') continue;
        const next = offset + segment.content.length;
        if (next > start && offset < end || !placed && start >= offset && start < next) {
            const from = Math.max(0, start - offset);
            const to = Math.min(segment.content.length, end - offset);
            result[index] = { ...segment, content: segment.content.slice(0, from) + (placed ? '' : inserted) + segment.content.slice(to) };
            placed = true;
        }
        offset = next;
    }
    if (!placed && inserted) result.push({ content: inserted });
    return result;
}