'use strict';

// Memory-only projection: never write the projected text back to history/CDS.
const REQUEST = '<<<[TOOL_REQUEST]>>>';
const RESULT = '[[VCP调用结果信息汇总:';
const RESULT_END = 'VCP调用结果结束]]';
const SUMMARY = '[本轮工具调用摘要:]';
const SUMMARY_END = '[本轮工具调用摘要结束]';

function resultEnd(text, start) {
    let depth = 1;
    let cursor = start + RESULT.length;
    while (cursor < text.length) {
        const open = text.indexOf(RESULT, cursor);
        const close = text.indexOf(RESULT_END, cursor);
        if (close < 0) return -1;
        if (open >= 0 && open < close) {
            depth++;
            cursor = open + RESULT.length;
        } else {
            cursor = close + RESULT_END.length;
            if (--depth === 0) return cursor;
        }
    }
    return -1;
}

function requestInfo(text, start) {
    const fields = new Map();
    let cursor = start + REQUEST.length;
    const xmlName = text.slice(cursor).match(/^\s*<tool_name>([^<\r\n]+)<\/tool_name>/i);
    if (xmlName) fields.set('tool_name', xmlName[1].trim());
    while (cursor < text.length) {
        const end = /<{2,4}\[END_TOOL_REQUEST\]>{2,4}/ig;
        end.lastIndex = cursor;
        const close = end.exec(text);
        const field = /(?:^|\n|,)[ \t]*([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/ig;
        field.lastIndex = cursor;
        let next = field.exec(text);
        const immediate = text.slice(cursor).match(/^[ \t]*([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/i);
        if (immediate) next = { ...immediate, index: cursor };
        if (close && (!next || close.index < next.index)) {
            return { end: close.index + close[0].length, fields };
        }
        if (!next) return { end: text.length, fields };
        const marker = next[2];
        const valueStart = next.index + next[0].length;
        const endMarker = `${marker[0] === '{' ? '{' : '「'}末${/escape/i.test(marker) ? 'ESCAPE' : ''}${marker[0] === '{' ? '}' : '」'}`;
        const valueEnd = text.toLowerCase().indexOf(endMarker.toLowerCase(), valueStart);
        if (valueEnd < 0) {
            return { end: close ? close.index + close[0].length : text.length, fields };
        }
        fields.set(next[1].toLowerCase(), text.slice(valueStart, valueEnd).trim());
        cursor = valueEnd + endMarker.length;
    }
    return { end: text.length, fields };
}

function safeName(value) {
    return String(value || '').replace(/[<>\r\n「」{}[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function requestLabel(fields) {
    let name = fields.get('tool_name');
    if (!name && fields.has('jev')) {
        const jev = fields.get('jev');
        name = jev.match(/`([^`]+)`|'([^']+)'/)?.slice(1).find(Boolean);
    }
    return name ? `调用了 ${safeName(name)} 工具。` : '调用了工具（名称未记录）。';
}

function projectMemoryProtocols(input) {
    if (typeof input !== 'string') return '';
    input = input.replace(
        /(?:\x26lt;|\x26#0*60;|\x26#x0*3c;){3}\[(?:(?:END_)?TOOL_REQUEST|(?:END_)?ROLE_DIVIDE_(?:SYSTEM|ASSISTANT|USER)|VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+)\](?:\x26gt;|\x26#0*62;|\x26#x0*3e;){3}/gi,
        marker => marker.replace(/\x26lt;|\x26#0*60;|\x26#x0*3c;/gi, '<').replace(/\x26gt;|\x26#0*62;|\x26#x0*3e;/gi, '>')
    );
    let output = '';
    let cursor = 0;
    // Scan in source order: a result/request owns its entire payload. Protocol
    // tokens inside that payload must never be interpreted as outer summaries.
    const tokens = /<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>|<<<\[TOOL_REQUEST\]>>>|\[\[VCP调用结果信息汇总:|\[本轮工具调用摘要:\]/g;
    while (cursor < input.length) {
        tokens.lastIndex = cursor;
        const match = tokens.exec(input);
        if (!match) {
            output += input.slice(cursor);
            break;
        }
        output += input.slice(cursor, match.index);
        if (match[1] !== undefined) {
            const endToken = `<<<[VCP_TOOL_BATCH_END:${match[1]}]>>>`;
            const end = input.indexOf(endToken, tokens.lastIndex);
            // Batch is a hard boundary even when old nested result markers are broken.
            const body = input.slice(tokens.lastIndex, end < 0 ? input.length : end);
            output += '\n' + projectMemoryProtocols(body) + '\n';
            cursor = end < 0 ? input.length : end + endToken.length;
        } else if (match[0] === RESULT) {
            cursor = resultEnd(input, match.index);
            if (cursor < 0) cursor = input.length;
            output += '\n';
        } else if (match[0] === REQUEST) {
            const request = requestInfo(input, match.index);
            output += `\n${requestLabel(request.fields)}\n`;
            cursor = request.end;
        } else {
            const end = input.indexOf(SUMMARY_END, tokens.lastIndex);
            const body = input.slice(tokens.lastIndex, end < 0 ? input.length : end);
            output += `\n工具调用摘要：${projectMemoryProtocols(body).trim()}\n`;
            cursor = end < 0 ? input.length : end + SUMMARY_END.length;
        }
    }
    return output
        .replace(/<<<\[(?:END_)?ROLE_DIVIDE_(?:SYSTEM|ASSISTANT|USER)\]>>>/g, '\n')
        .replace(/<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>/g, '\n')
        .replace(/<{2,4}\[(?:END_)?TOOL_REQUEST\]>{2,4}/gi, '')
        .replaceAll(RESULT_END, '')
        .replaceAll(SUMMARY_END, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

module.exports = { projectMemoryProtocols };