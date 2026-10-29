/**
 * 后端原子工具回执边界。时间戳只用于精确配对，不参与日期转换。
 * 不解释载荷中的 Markdown/HTML；缺失结束符属于损坏输入，保守隔离到文末。
 */
export const TOOL_BATCH_START_PREFIX = '<<<[VCP_TOOL_BATCH_START:';
const START_PATTERN = /<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>/g;

export function collectToolBatchRanges(text) {
    if (typeof text !== 'string' || !text.includes(TOOL_BATCH_START_PREFIX)) return [];
    const ranges = [];
    const starts = new RegExp(START_PATTERN.source, 'g');
    let match;
    while ((match = starts.exec(text))) {
        const contentStart = match.index + match[0].length;
        const endToken = `<<<[VCP_TOOL_BATCH_END:${match[1]}]>>>`;
        const contentEnd = text.indexOf(endToken, contentStart);
        const closed = contentEnd !== -1;
        const end = closed ? contentEnd + endToken.length : text.length;
        ranges.push({
            start: match.index, end, contentStart,
            contentEnd: closed ? contentEnd : text.length,
            closed, batchId: match[1],
        });
        starts.lastIndex = end;
        if (!closed) break;
    }
    return ranges;
}

export function transformOutsideToolBatches(text, transform) {
    const ranges = collectToolBatchRanges(text);
    if (!ranges.length) return transform(text);
    let result = '';
    let cursor = 0;
    for (const range of ranges) {
        result += transform(text.slice(cursor, range.start));
        result += text.slice(range.start, range.end);
        cursor = range.end;
    }
    return result + transform(text.slice(cursor));
}

export function stripToolBatches(text) {
    if (typeof text !== 'string') return text;
    let result = '';
    let cursor = 0;
    for (const range of collectToolBatchRanges(text)) {
        result += text.slice(cursor, range.start) + '\n';
        cursor = range.end;
    }
    return result + text.slice(cursor);
}