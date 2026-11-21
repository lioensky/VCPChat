'use strict';

const HEADER = '[VCP_TOPIC_RIVER_V2]';
const FOOTER = '[/VCP_TOPIC_RIVER_V2]';

// Keep quotes inert in generic Markdown and in processors that inspect raw markers.
const escapeQuoteText = text => text.replace(/[&<>[\]{}\\`*_~!#@|\u2028\u2029]/g,
    char => `&#${char.charCodeAt(0)};`);
const INTERNAL_BLOCKS = [
    /<!--\s*VCP_RAG_BLOCK_START\b[\s\S]*?<!--\s*VCP_RAG_BLOCK_END\s*-->/gi,
    /<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g,

    /\[本轮工具调用摘要:\][\s\S]*?\[本轮工具调用摘要结束\]/g,
    /<(style|script|think|thinking)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
];

const stripInlineBinary = text => text.replace(/data:[^,\s"'<>]*;base64,[A-Za-z0-9+/_=-]*/gi, '');
const MAX_TOOL_TEXT = 24000;

function limitToolText(text) {
    if (text.length <= MAX_TOOL_TEXT) return text;
    const head = text.slice(0, MAX_TOOL_TEXT * 0.75).replace(/[\uD800-\uDBFF]$/, '');
    const tail = text.slice(-MAX_TOOL_TEXT * 0.25).replace(/^[\uDC00-\uDFFF]/, '');
    return `${head}\n\n［工具结果过长，中段已截断］\n\n${tail}`;
}

function projectText(text) {
    if (/^\s*<!--\s*VCP_TOOL_PAYLOAD\s*-->/.test(text)
        || /^\s*\[(?:系统提示|系统邀请指令)[:：]?\]/.test(text)) return '';

    // Avoid exponential growth when a previously delivered quote is forwarded.
    text = text.replace(/^\[VCP_TOPIC_RIVER_(V[12])\]\r?\n[\s\S]*?^\[\/VCP_TOPIC_RIVER_\1\][ \t]*$/gm, '');
    for (const block of INTERNAL_BLOCKS) text = text.replace(block, '');
    return stripInlineBinary(text).trim();
}

async function formatTopicRiverQuote(messages) {
    if (!Array.isArray(messages) || !messages.length) return '';
    const [{ collectToolBatchRanges }, {
        collectToolResultRanges, isToolResultHidden, TOOL_RESULT_START_MARKER, TOOL_RESULT_END_MARKER,
    }] = await Promise.all([
        import('../renderer/toolBatchRegions.js'),
        import('../renderer/toolResultRegions.js'),
    ]);
    const rows = [];
    const append = (label, content) => {
        if (!content) return;
        const body = content.split(/\r\n?|\n/).map(line => line ? `> ${escapeQuoteText(line)}` : '>');
        rows.push([`#### ${rows.length + 1} · ${label}`, ...body].join('\n'));
    };

    for (const message of messages) {
        const role = message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
            ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
                .map(part => part.text).join('\n')
            : '';
        if (/^\s*<!--\s*VCP_TOOL_PAYLOAD\s*-->/.test(text)
            || /^\s*\[(?:系统提示|系统邀请指令)[:：]?\]/.test(text)) continue;

        const fallback = role === 'user' ? '用户' : '助手';
        const name = typeof message.name === 'string' ? message.name.replace(/\s+/gu, ' ').trim() : '';
        const label = name ? `${escapeQuoteText(name)}（${fallback}）` : fallback;
        const batches = collectToolBatchRanges(text);
        // Display recovery may fold a later receipt into a damaged one. Never forward that guess.
        const results = collectToolResultRanges(text, batches.map(batch => ({ ...batch, closed: false })));
        const appendDialogue = content => append(label, projectText(role === 'user'
            ? content.replace(/^[ \t]*\[系统通知\][ \t]*\r?\n[\s\S]*?^[ \t]*\[系统通知结束\][ \t]*(?=\r?\n|$)(?:\r?\n)?/gm, '')
            : content));
        const appendResult = ({ start, end, closed }) => {
            if (!closed) return;
            const raw = text.slice(start, end);
            if (isToolResultHidden(raw)) return;
            const payload = raw.slice(TOOL_RESULT_START_MARKER.length, -TOOL_RESULT_END_MARKER.length);
            const receipt = /^[ \t]*\r?\n[ \t]*-[ \t]*工具名称:[ \t]*([^\r\n]+)\r?\n[ \t]*-[ \t]*执行状态:[^\r\n]*\r?\n[ \t]*-[ \t]*返回内容:[ \t]?([\s\S]*)$/u.exec(payload);
            if (!receipt) return;
            const name = receipt[1].trim();
            const body = stripInlineBinary(receipt[2].replace(/\r?\n$/u, ''));
            if (name && body.trim()) append(`${escapeQuoteText(name)}（工具结果）`, limitToolText(body));
        };

        let cursor = 0;
        let index = 0;
        for (const batch of batches) {
            while (index < results.length && results[index].start < batch.start) {
                const range = results[index++];
                appendDialogue(text.slice(cursor, range.start));
                appendResult(range);
                cursor = range.end;
            }
            const before = text.slice(cursor, batch.start);
            const after = text.slice(batch.end);
            const open = /(?:^|\r?\n)[ \t]*<<<\[ROLE_DIVIDE_USER\]>>>\s*$/u.exec(before);
            const close = /^\s*<<<\[END_ROLE_DIVIDE_USER\]>>>[ \t]*(?=\r?\n|$)/u.exec(after);
            appendDialogue(open && close ? before.slice(0, open.index) : before);
            while (index < results.length && results[index].start < batch.end) {
                const range = results[index++];
                if (batch.closed) appendResult(range);
            }
            cursor = batch.end + (open && close ? close[0].length : 0);
        }
        while (index < results.length) {
            const range = results[index++];
            appendDialogue(text.slice(cursor, range.start));
            appendResult(range);
            cursor = range.end;
        }
        appendDialogue(text.slice(cursor));
    }
    return rows.length ? `${HEADER}\n${rows.join('\n\n')}\n${FOOTER}` : '';
}

module.exports = { formatTopicRiverQuote };