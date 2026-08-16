const TOOL_REQUEST_START_MARKER = '<<<[TOOL_REQUEST]>>>';
const TOOL_REQUEST_END_MARKER = '<<<[END_TOOL_REQUEST]>>>';

const FIELD_START_REGEX = /(^|\n|,)([ \t]*)([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/gi;

function isBacktickWrappedToolMarker(text, index, marker) {
    return text[index - 1] === '`' || text[index + marker.length] === '`';
}

function getFieldEndMarker(startMarker) {
    const usesBrace = startMarker[0] === '{';
    const isEscape = /escape/i.test(startMarker);
    return `${usesBrace ? '{' : '「'}末${isEscape ? 'ESCAPE' : ''}${usesBrace ? '}' : '」'}`;
}

function escapeRegexLiteral(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findFieldEnd(text, field) {
    const endRegex = new RegExp(escapeRegexLiteral(field.endMarker), 'ig');
    endRegex.lastIndex = field.markerEnd;
    const match = endRegex.exec(text);
    return match
        ? {
            start: match.index,
            end: match.index + match[0].length,
            marker: match[0]
        }
        : null;
}

function createFieldStartResult(match, matchIndex, declarationPrefixLength = 0) {
    const marker = match[4];
    const markerOffset = match[0].lastIndexOf(marker);
    const markerStart = matchIndex + markerOffset;

    return {
        fieldName: match[3],
        declarationStart: matchIndex + declarationPrefixLength + match[1].length,
        markerStart,
        markerEnd: markerStart + marker.length,
        startMarker: marker,
        endMarker: getFieldEndMarker(marker)
    };
}

function findNextFieldStart(text, fromIndex) {
    // 工具开始标记后字段可能直接紧接在同一位置，例如：
    // <<<[TOOL_REQUEST]>>>tool_name:「始」Demo「末」
    // 这种首字段没有行首/逗号前缀，但其匹配范围必须严格从当前游标开始，
    // 不放宽正文中任意位置的字段识别。
    const atCursorMatch = text.slice(fromIndex).match(
        /^[ \t]*([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/i
    );
    if (atCursorMatch) {
        const marker = atCursorMatch[2];
        const markerStart = fromIndex + atCursorMatch[0].lastIndexOf(marker);
        return {
            fieldName: atCursorMatch[1],
            declarationStart: fromIndex,
            markerStart,
            markerEnd: markerStart + marker.length,
            startMarker: marker,
            endMarker: getFieldEndMarker(marker)
        };
    }

    FIELD_START_REGEX.lastIndex = fromIndex;
    const match = FIELD_START_REGEX.exec(text);
    FIELD_START_REGEX.lastIndex = 0;

    if (!match) return null;

    return createFieldStartResult(match, match.index, match[1].length);
}

function findUnwrappedRequestEnd(text, fromIndex) {
    let cursor = fromIndex;

    while (cursor < text.length) {
        const index = text.indexOf(TOOL_REQUEST_END_MARKER, cursor);
        if (index === -1) return -1;

        if (!isBacktickWrappedToolMarker(text, index, TOOL_REQUEST_END_MARKER)) {
            return index;
        }

        cursor = index + TOOL_REQUEST_END_MARKER.length;
    }

    return -1;
}

/**
 * 从 TOOL_REQUEST 开始标记之后扫描请求边界。
 *
 * 字段开始标记只有位于合法的“字段名:「始...」”声明中才具有协议含义。
 * 一旦进入字段，工具请求结束标记只被视为字段载荷；必须先遇到与字段
 * 类型和括号风格严格对应的结束标记。
 *
 * @param {string} text 完整或流式中的消息文本
 * @param {number} contentStart TOOL_REQUEST 开始标记之后的偏移
 * @returns {{
 *   status: 'complete'|'incomplete-field'|'incomplete-request',
 *   endIndex: number,
 *   requestMarkerStart: number,
 *   field?: object
 * }}
 */
function scanToolRequestEnd(text, contentStart) {
    if (typeof text !== 'string') {
        return {
            status: 'incomplete-request',
            endIndex: -1,
            requestMarkerStart: -1
        };
    }

    let cursor = Math.max(0, contentStart);

    while (cursor <= text.length) {
        const requestEndStart = findUnwrappedRequestEnd(text, cursor);
        const field = findNextFieldStart(text, cursor);

        if (requestEndStart !== -1 && (!field || requestEndStart < field.declarationStart)) {
            return {
                status: 'complete',
                endIndex: requestEndStart + TOOL_REQUEST_END_MARKER.length,
                requestMarkerStart: requestEndStart
            };
        }

        if (!field) {
            return {
                status: 'incomplete-request',
                endIndex: -1,
                requestMarkerStart: -1
            };
        }

        const fieldEnd = findFieldEnd(text, field);
        if (!fieldEnd) {
            return {
                status: 'incomplete-field',
                endIndex: -1,
                requestMarkerStart: -1,
                field: {
                    ...field,
                    contentStart: field.markerEnd,
                    contentEnd: -1,
                    endMarkerStart: -1,
                    endMarkerEnd: -1
                }
            };
        }

        cursor = fieldEnd.end;
    }

    return {
        status: 'incomplete-request',
        endIndex: -1,
        requestMarkerStart: -1
    };
}

function findToolRequestEnd(text, contentStart) {
    return scanToolRequestEnd(text, contentStart).endIndex;
}

function replaceToolRequestBlocks(text, replacer) {
    if (typeof text !== 'string' || !text.includes(TOOL_REQUEST_START_MARKER)) {
        return text;
    }

    let result = '';
    let cursor = 0;

    while (cursor < text.length) {
        const startIndex = text.indexOf(TOOL_REQUEST_START_MARKER, cursor);
        if (startIndex === -1) {
            result += text.slice(cursor);
            break;
        }

        if (isBacktickWrappedToolMarker(text, startIndex, TOOL_REQUEST_START_MARKER)) {
            const markerEnd = startIndex + TOOL_REQUEST_START_MARKER.length;
            result += text.slice(cursor, markerEnd);
            cursor = markerEnd;
            continue;
        }

        const contentStart = startIndex + TOOL_REQUEST_START_MARKER.length;
        const scan = scanToolRequestEnd(text, contentStart);
        if (scan.status !== 'complete') {
            result += text.slice(cursor);
            break;
        }

        const fullMatch = text.slice(startIndex, scan.endIndex);
        const content = text.slice(contentStart, scan.requestMarkerStart);
        result += text.slice(cursor, startIndex);

        const replacement = replacer(fullMatch, content, startIndex, scan.endIndex, scan);
        if (typeof replacement === 'string' && replacement !== fullMatch) {
            // 工具请求可能与普通正文直接相邻。统一在替换结果边界补换行，
            // 避免 HTML 气泡/占位符与相邻 Markdown 粘连，导致流式尾部或
            // Markdown 解析器无法把两侧内容识别为独立块。
            const beforeReplacement = result[result.length - 1] || '';
            const afterReplacement = text[scan.endIndex] || '';
            if (beforeReplacement && beforeReplacement !== '\n' && !replacement.startsWith('\n')) {
                result += '\n';
            }
            result += replacement;
            if (afterReplacement && afterReplacement !== '\n' && !replacement.endsWith('\n')) {
                result += '\n';
            }
        } else {
            result += replacement ?? fullMatch;
        }

        cursor = scan.endIndex;
    }

    return result;
}

export {
    TOOL_REQUEST_START_MARKER,
    TOOL_REQUEST_END_MARKER,
    findToolRequestEnd,
    isBacktickWrappedToolMarker,
    replaceToolRequestBlocks,
    scanToolRequestEnd
};