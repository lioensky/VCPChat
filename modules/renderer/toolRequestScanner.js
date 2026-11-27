import {
    TOOL_RESULT_START_MARKER,
    TOOL_RESULT_END_MARKER,
    collectToolDataRanges as collectToolResultRanges,
    collectCodeDomainsOutsideToolResults,
    findToolResultRangeAt,
} from './toolResultRegions.js';
import {
    findSafeClosedFenceRanges,
    blankInlineBackticksOutsideFences,
} from '../shared/vcpResilienceMaskEsm.js';

const TOOL_REQUEST_START_MARKER = '<<<[TOOL_REQUEST]>>>';
const TOOL_REQUEST_END_MARKER = '<<<[END_TOOL_REQUEST]>>>';
const DESKTOP_PUSH_START_MARKER = '<<<[DESKTOP_PUSH]>>>';
const DESKTOP_PUSH_END_MARKER = '<<<[DESKTOP_PUSH_END]>>>';

// VCP 后端对协议标记采用语义理解，实际输出偶尔会丢失或多输出尖括号。
// 这里允许左右各 2–4 个尖括号；中间的协议名称仍保持严格，避免把普通文本误判为结束标记。
const TOOL_REQUEST_FUZZY_START_REGEX = /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
const TOOL_REQUEST_END_REGEX = /<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
const ROLE_DIVIDE_USER_WALL_REGEX = /<<<\[(?:END_)?ROLE_DIVIDE_USER\]>>>/g;
const FIELD_WALL_LINE_REGEX = /^[ \t]*(<<<\[(?:END_)?ROLE_DIVIDE_(USER|SYSTEM|ASSISTANT)\]>>>|<<<\[VCP_TOOL_BATCH_START:[^\]\r\n]+\]>>>|\[\[VCP调用结果信息汇总:|\[\[VCP协议纠偏指导:|<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4})/gm;
const FIELD_RECEIPT_WALL_LINE_REGEX = /^[ \t]*(?:<<<\[(?:END_)?ROLE_DIVIDE_(?:USER|SYSTEM|ASSISTANT)\]>>>|<<<\[VCP_TOOL_BATCH_START:[^\]\r\n]+\]>>>|\[\[VCP调用结果信息汇总:|\[\[VCP协议纠偏指导:)/m;

function hasBalancedDelimiterPair(slice, openRe, closeRe) {
    const events = [];
    let m;
    openRe.lastIndex = 0;
    while ((m = openRe.exec(slice)) !== null) events.push({ idx: m.index, delta: 1 });
    closeRe.lastIndex = 0;
    while ((m = closeRe.exec(slice)) !== null) events.push({ idx: m.index, delta: -1 });
    if (events.length === 0) return true;
    events.sort((a, b) => a.idx - b.idx);
    let depth = 0;
    for (const ev of events) {
        depth += ev.delta;
        if (depth < 0) return false;
    }
    return depth === 0;
}

function isPureRoleExampleInner(inner, allowFuzzyStart = false) {
    if (
        inner.includes('<<<[VCP_TOOL_BATCH_START:')
        || inner.includes('[[VCP调用结果信息汇总:')
        || inner.includes('[[VCP协议纠偏指导:')
        || /[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/i.test(inner)
    ) {
        return false;
    }
    for (const role of ['USER', 'SYSTEM', 'ASSISTANT']) {
        if (!hasBalancedDelimiterPair(
            inner,
            new RegExp(`<<<\\[ROLE_DIVIDE_${role}\\]>>>`, 'g'),
            new RegExp(`<<<\\[END_ROLE_DIVIDE_${role}\\]>>>`, 'g')
        )) {
            return false;
        }
    }
    const toolOpenRe = allowFuzzyStart
        ? /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi
        : /<<<\[TOOL_REQUEST(?:_ESCAPE)?\]>>>/g;
    const toolCloseRe = allowFuzzyStart
        ? /<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi
        : /<<<\[END_TOOL_REQUEST(?:_ESCAPE)?\]>>>/g;
    return hasBalancedDelimiterPair(inner, toolOpenRe, toolCloseRe);
}

const FIELD_START_REGEX = /(^|\n|,)([ \t]*)([^\s,:：「」{}]+)[ \t]*[:：][ \t]*(「始(?:escape)?」|\{始(?:escape)?\})/gi;

function isBacktickWrappedToolMarker(text, index, marker) {
    return text[index - 1] === '`' || text[index + marker.length] === '`';
}

const FIELD_DECLARATION_AFTER_TOOL_RE = /^[ \t]*\r?\n?[ \t]*(?:(?:tool_name|maid|maidname|valet|valetname|command|jev|archery)\s*[:：]|[^\s,:：「」{}<>()[\]]+\s*[:：]\s*(?:「始(?:escape)?」|\{始(?:escape)?\})|<tool_name>)/i;

function hasBalancedToolBatchMarkersInSlice(slice) {
    const hasStart = slice.includes('<<<[VCP_TOOL_BATCH_START:');
    const hasEnd = slice.includes('<<<[VCP_TOOL_BATCH_END:');
    if (!hasStart && !hasEnd) return true;
    const startRe = /<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>/g;
    const endRe = /<<<\[VCP_TOOL_BATCH_END:([^\]\r\n]+)\]>>>/g;
    const events = [];
    let startCount = 0;
    let endCount = 0;
    let m;
    while ((m = startRe.exec(slice)) !== null) {
        startCount += 1;
        events.push({ idx: m.index, type: 'start', id: m[1] });
    }
    while ((m = endRe.exec(slice)) !== null) {
        endCount += 1;
        events.push({ idx: m.index, type: 'end', id: m[1] });
    }
    if (startCount !== (slice.match(/<<<\[VCP_TOOL_BATCH_START:/g) || []).length) return false;
    if (endCount !== (slice.match(/<<<\[VCP_TOOL_BATCH_END:/g) || []).length) return false;
    events.sort((a, b) => a.idx - b.idx);
    const stack = [];
    for (const ev of events) {
        if (ev.type === 'start') {
            stack.push(ev.id);
        } else {
            if (stack.length === 0 || stack[stack.length - 1] !== ev.id) return false;
            stack.pop();
        }
    }
    return stack.length === 0;
}

function hasUnclosedToolRequestBefore(text, limit, rawDomains = [], toolResultRanges = []) {
    const rawPrefix = text.slice(0, limit);
    if (!/<{2,4}\[TOOL_REQUEST/i.test(rawPrefix)) return false;
    const prefixExclusions = [
        ...rawDomains.filter(r => r.end <= limit),
        ...toolResultRanges.filter(r => r.end <= limit),
    ].sort((a, b) => a.start - b.start || b.end - a.end);
    let maskedPrefix = rawPrefix;
    if (prefixExclusions.length > 0) {
        const chars = rawPrefix.split('');
        for (const r of prefixExclusions) {
            const s = Math.max(0, r.start);
            const e = Math.min(rawPrefix.length, r.end);
            for (let i = s; i < e; i += 1) {
                if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
            }
        }
        maskedPrefix = chars.join('');
    }
    let prefix = blankInlineBackticksOutsideFences(maskedPrefix, prefixExclusions);
    prefix = prefix
        .replace(/「始ESCAPE」[\s\S]*?「末ESCAPE」/gi, m => m.replace(/[^\r\n]/g, ' '))
        .replace(/\{始ESCAPE\}[\s\S]*?\{末ESCAPE\}/gi, m => m.replace(/[^\r\n]/g, ' '));
    const openRe = new RegExp(TOOL_REQUEST_FUZZY_START_REGEX.source, 'gi');
    const endRe = new RegExp(TOOL_REQUEST_END_REGEX.source, 'gi');
    const events = [];
    let m;
    while ((m = openRe.exec(prefix)) !== null) {
        if (!isBacktickWrappedToolMarker(prefix, m.index, m[0])) {
            events.push({ idx: m.index, delta: 1 });
        }
    }
    while ((m = endRe.exec(prefix)) !== null) {
        if (!isBacktickWrappedToolMarker(prefix, m.index, m[0])) {
            events.push({ idx: m.index, delta: -1 });
        }
    }
    events.sort((a, b) => a.idx - b.idx);
    let depth = 0;
    for (const ev of events) {
        depth += ev.delta;
        if (depth < 0) depth = 0;
    }
    return depth > 0;
}

function hasUnbalancedInnerFence(inner, outerChar = '`') {
    const fenceCh = outerChar === '~' ? '~' : '`';
    let openLen = 0;
    let lineStart = 0;
    while (lineStart < inner.length) {
        const nl = inner.indexOf('\n', lineStart);
        const lineEnd = nl === -1 ? inner.length : nl;
        const rawLine = inner.slice(lineStart, lineEnd);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (openLen > 0) {
            const closeMatch = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
            if (closeMatch && closeMatch[1][0] === fenceCh && closeMatch[1].length >= openLen) {
                openLen = 0;
            }
        } else {
            const openMatch = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
            if (openMatch && openMatch[1][0] === fenceCh && (fenceCh !== '`' || !openMatch[2].includes('`'))) {
                openLen = openMatch[1].length;
            }
        }
        if (nl === -1) break;
        lineStart = nl + 1;
    }
    return openLen > 0;
}

function hasBalancedSummaryBlocksInSlice(slice) {
    let pos = 0;
    let depth = 0;
    while (pos < slice.length) {
        const nextOpen = slice.indexOf(TOOL_RESULT_START_MARKER, pos);
        const nextClose = slice.indexOf(TOOL_RESULT_END_MARKER, pos);
        if (nextOpen === -1 && nextClose === -1) break;
        if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
            depth += 1;
            pos = nextOpen + TOOL_RESULT_START_MARKER.length;
        } else {
            if (depth <= 0) return false;
            depth -= 1;
            pos = nextClose + TOOL_RESULT_END_MARKER.length;
        }
    }
    return depth === 0;
}

function hasBalancedRoleDividersInSlice(slice) {
    for (const role of ['USER', 'SYSTEM', 'ASSISTANT']) {
        if (!hasBalancedDelimiterPair(
            slice,
            new RegExp(`<<<\\[ROLE_DIVIDE_${role}\\]>>>`, 'g'),
            new RegExp(`<<<\\[END_ROLE_DIVIDE_${role}\\]>>>`, 'g')
        )) {
            return false;
        }
    }
    return true;
}

function findCrossWallLiteralFenceSplit(text, range, toolResultRanges, rawDomains = []) {
    const slice = text.slice(range.start, range.end);
    const openNl = slice.indexOf('\n');
    if (openNl === -1) return null;
    const trimmedEnd = range.closed && slice.endsWith('\n')
        ? (slice.endsWith('\r\n') ? slice.length - 2 : slice.length - 1)
        : slice.length;
    const closeLineStart = range.closed ? slice.lastIndexOf('\n', trimmedEnd - 1) + 1 : slice.length;
    if (closeLineStart <= openNl + 1) return null;
    const innerAbsStart = range.start + openNl + 1;
    const outerCloseLineStart = range.start + closeLineStart;
    const inner = slice.slice(openNl + 1, closeLineStart);

    const wallRe = /^[ \t]*(?:<<<\[(?:END_)?ROLE_DIVIDE_(?:USER|SYSTEM|ASSISTANT)\]>>>|<<<\[VCP_TOOL_BATCH_START:[^\]\r\n]+\]>>>|\[\[VCP协议纠偏指导:|<!--(?:__)?VCP_TOOL_RESULT_(?:DOM_)?(?:[a-z0-9]+_)?\d+(?:__)?-->)/im;
    const firstWall = wallRe.exec(inner);
    const innerResult = toolResultRanges.find(r => r.start >= innerAbsStart && r.start < outerCloseLineStart);
    if (!firstWall && !innerResult) return null;

    let wallRelStart = firstWall ? firstWall.index : Infinity;
    let wallRelEnd = firstWall ? firstWall.index + firstWall[0].length : Infinity;
    if (innerResult) {
        const resRel = innerResult.start - innerAbsStart;
        if (resRel < wallRelStart) {
            wallRelStart = resRel;
            wallRelEnd = Math.min(inner.length, innerResult.end - innerAbsStart);
        }
    }

    const hasUnbalancedFence = hasUnbalancedInnerFence(inner, range.marker);
    const hasOpenToolBefore = hasUnclosedToolRequestBefore(text, range.start, rawDomains, toolResultRanges);
    const hasHardReceipt = /<!--(?:__)?VCP_TOOL_RESULT_(?:DOM_)?(?:[a-z0-9]+_)?\d+(?:__)?-->/i.test(inner)
        || /^[ \t]*(?:\[\[VCP协议纠偏指导:|<<<\[VCP_TOOL_BATCH_START:)/m.test(inner);
    const hasRoleEnvelope = /<<<\[ROLE_DIVIDE_(USER|SYSTEM|ASSISTANT)\]>>>[\s\S]*?<<<\[END_ROLE_DIVIDE_\1\]>>>/.test(inner);
    const hasUnbalancedRole = (hasOpenToolBefore || hasHardReceipt || Boolean(innerResult))
        && /<<<\[(?:END_)?ROLE_DIVIDE_(?:USER|SYSTEM|ASSISTANT)\]>>>/.test(inner)
        && !hasBalancedRoleDividersInSlice(inner)
        && (inner.includes('<<<[END_ROLE_DIVIDE_') || Boolean(innerResult));
    const hasUnbalancedSummary = Boolean(innerResult) && !hasBalancedSummaryBlocksInSlice(inner);

    const shouldSplit = hasHardReceipt
        || hasUnbalancedFence
        || hasUnbalancedRole
        || hasUnbalancedSummary
        || (hasOpenToolBefore && (hasRoleEnvelope || Boolean(innerResult)));

    if (!shouldSplit) {
        return null;
    }

    return {
        innerAbsStart,
        wallAbs: innerAbsStart + wallRelStart,
        afterWall: Math.min(outerCloseLineStart, innerAbsStart + wallRelEnd),
        outerCloseLineStart,
        hasOpenToolBefore,
        hasRightUnclosedFence: hasUnbalancedInnerFence(
            text.slice(Math.min(outerCloseLineStart, innerAbsStart + wallRelEnd), outerCloseLineStart),
            range.marker
        ),
    };
}

function collectProtocolLiteralCodeRanges(text, toolResultRanges = collectToolResultRanges(text), offset = 0) {
    if (typeof text !== 'string' || (!text.includes('`') && !text.includes('~'))) {
        return [];
    }

    // 未闭合 fenced code 在流式阶段同样拥有当前流尾；其中出现的协议标记
    // 只是代码字面量，不能建立工具调用或桌面推送隔离边界。
    //
    // 行内代码域额外限制为同一行。Markdown code span 虽可容纳换行，但聊天
    // 正文中的颜文字（如 `(・`ω´・)`）常含不成对反引号；若允许它与数百字后
    // 工具载荷中的反引号跨行配对，会把真实 TOOL_REQUEST 错误覆盖为代码示例。
    //
    // 工具结果数据域先被遮蔽：其中的反引号/围栏不得生成代码域，
    // 也不得与外部正文配对而吞掉工具结果之后的真实协议块。
    const rawDomains = collectCodeDomainsOutsideToolResults(text, toolResultRanges).filter(range => (
        range.kind === 'fence'
        || !text.slice(range.start, range.end).includes('\n')
    ));
    const result = [];
    for (let i = 0; i < rawDomains.length; i += 1) {
        const range = rawDomains[i];
        if (range.kind === 'fence') {
            const split = findCrossWallLiteralFenceSplit(text, range, toolResultRanges, rawDomains);
            if (split) {
                if (split.wallAbs > range.start) {
                    if (!split.hasOpenToolBefore) {
                        result.push({
                            kind: 'fence',
                            marker: range.marker,
                            length: range.length,
                            closed: false,
                            start: offset + range.start,
                            end: offset + split.wallAbs,
                        });
                    } else if (split.wallAbs > split.innerAbsStart) {
                        const preSlice = text.slice(split.innerAbsStart, split.wallAbs);
                        const preResults = toolResultRanges
                            .filter(r => r.end > split.innerAbsStart && r.start < split.wallAbs)
                            .map(r => ({
                                ...r,
                                start: Math.max(0, r.start - split.innerAbsStart),
                                end: Math.min(preSlice.length, r.end - split.innerAbsStart),
                            }));
                        result.push(...collectProtocolLiteralCodeRanges(preSlice, preResults, offset + split.innerAbsStart));
                    }
                }
                const rightEnd = split.hasRightUnclosedFence ? range.end : split.outerCloseLineStart;
                if (rightEnd > split.afterWall) {
                    const rightSlice = text.slice(split.afterWall, rightEnd);
                    const rightResults = toolResultRanges
                        .filter(r => r.end > split.afterWall && r.start < rightEnd)
                        .map(r => ({
                            ...r,
                            start: Math.max(0, r.start - split.afterWall),
                            end: Math.min(rightSlice.length, r.end - split.afterWall),
                        }));
                    result.push(...collectProtocolLiteralCodeRanges(rightSlice, rightResults, offset + split.afterWall));
                }
                continue;
            }
        }
        result.push(offset === 0 ? range : { ...range, start: range.start + offset, end: range.end + offset });
    }
    return result;
}

function isIndexInCodeDomain(index, codeRanges) {
    return codeRanges.some(range => index >= range.start && index < range.end);
}

/**
 * 协议标记是否只是字面量：反引号包裹、位于代码域内，或位于工具结果数据域内。
 * 工具结果优先级最高，其内部任何 TOOL_REQUEST / DESKTOP_PUSH 都不具备协议含义。
 */
function isLiteralProtocolMarker(text, index, marker, codeRanges, toolResultRanges = null) {
    return isBacktickWrappedToolMarker(text, index, marker)
        || isIndexInCodeDomain(index, codeRanges)
        || !!findToolResultRangeAt(index, toolResultRanges);
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

/** Read a declared field, skipping preceding payloads. Set trim:false for lossless diary text. */
export function readToolRequestField(source, name, { trim = true } = {}) {
    if (typeof source !== 'string') return null;
    let cursor = 0;
    while (cursor < source.length) {
        const field = findNextFieldStart(source, cursor);
        if (!field) return null;
        const end = findFieldEnd(source, field);
        if (!end) return null;
        if (field.fieldName.toLowerCase() === name.toLowerCase()) {
            const value = source.slice(field.markerEnd, end.start);
            return trim ? value.trim() : value;
        }
        cursor = end.end;
    }
    return null;
}

function findUnwrappedRequestEnd(text, fromIndex) {
    TOOL_REQUEST_END_REGEX.lastIndex = Math.max(0, fromIndex);

    let match;
    while ((match = TOOL_REQUEST_END_REGEX.exec(text)) !== null) {
        const marker = match[0];
        if (!isBacktickWrappedToolMarker(text, match.index, marker)) {
            TOOL_REQUEST_END_REGEX.lastIndex = 0;
            return {
                start: match.index,
                end: match.index + marker.length,
                marker
            };
        }
    }

    TOOL_REQUEST_END_REGEX.lastIndex = 0;
    return null;
}

function hasCrossJumpEscapeReceipt(slice, usesBrace) {
    if (typeof slice !== 'string') return false;
    const secondEscapeRe = usesBrace
        ? /(?:<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}|^|\n|,)[ \t]*[^\s,:：「」{}]+[ \t]*[:：][ \t]*\{始ESCAPE\}/i
        : /(?:<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}|^|\n|,)[ \t]*[^\s,:：「」{}]+[ \t]*[:：][ \t]*「始ESCAPE」/i;

    if (slice.includes('<<<[ROLE_DIVIDE_USER]>>>') && slice.includes('<<<[END_ROLE_DIVIDE_USER]>>>')) {
        const envelopeRe = /<<<\[ROLE_DIVIDE_USER\]>>>([\s\S]*?)<<<\[END_ROLE_DIVIDE_USER\]>>>/g;
        let m;
        while ((m = envelopeRe.exec(slice)) !== null) {
            const body = m[1];
            if (
                (body.includes('[[VCP调用结果信息汇总:') && body.includes('VCP调用结果结束]]'))
                || /<!--(?:__)?VCP_TOOL_RESULT_(?:DOM_)?(?:[a-z0-9]+_)?\d+(?:__)?-->/.test(body)
                || /\[\[VCP协议纠偏指导:\s*code=[A-Z0-9_]+/i.test(body)
            ) {
                if (secondEscapeRe.test(slice.slice(m.index + m[0].length))) {
                    return true;
                }
            }
        }
    }

    if (slice.includes('<<<[VCP_TOOL_BATCH_START:')) {
        const batchRe = /<<<\[VCP_TOOL_BATCH_START:[^\]\r\n]+\]>>>([\s\S]*?)<<<\[VCP_TOOL_BATCH_END:[^\]\r\n]+\]>>>/g;
        let bm;
        while ((bm = batchRe.exec(slice)) !== null) {
            if (bm[1].includes('[[VCP协议纠偏指导:') && secondEscapeRe.test(slice.slice(bm.index + bm[0].length))) {
                return true;
            }
        }
    }

    if (slice.includes('[[VCP调用结果信息汇总:')) {
        const infoRe = /\[\[VCP调用结果信息汇总:([\s\S]*?)VCP调用结果结束\]\]/g;
        let im;
        while ((im = infoRe.exec(slice)) !== null) {
            if (im[1].includes('[[VCP协议纠偏指导:') && secondEscapeRe.test(slice.slice(im.index + im[0].length))) {
                return true;
            }
        }
    }

    if (/<!--(?:__)?VCP_TOOL_RESULT_/.test(slice)) {
        const placeholderRe = /<!--(?:__)?VCP_TOOL_RESULT_(?:DOM_)?(?:[a-z0-9]+_)?\d+(?:__)?-->/g;
        let pm;
        while ((pm = placeholderRe.exec(slice)) !== null) {
            if (secondEscapeRe.test(slice.slice(pm.index + pm[0].length))) {
                return true;
            }
        }
    }

    return false;
}

function findNextUnwrappedToolStart(text, fromIndex, allowFuzzyStart = false) {
    let cursor = Math.max(0, fromIndex);
    while (cursor < text.length) {
        const match = findNextToolRequestStart(text, cursor, allowFuzzyStart);
        if (!match) return null;
        if (!isBacktickWrappedToolMarker(text, match.index, match.marker)) {
            return match;
        }
        cursor = match.index + match.marker.length;
    }
    return null;
}

function findFieldProtocolWall(text, fromIndex, rawFieldEndStart = -1, allowFuzzyStart = false) {
    const limit = rawFieldEndStart !== -1 ? rawFieldEndStart : text.length;
    const closedFenceRanges = rawFieldEndStart !== -1
        ? findSafeClosedFenceRanges(text, fromIndex, limit)
        : [];
    let cursor = Math.max(0, fromIndex);
    while (cursor < limit) {
        FIELD_WALL_LINE_REGEX.lastIndex = cursor;
        const match = FIELD_WALL_LINE_REGEX.exec(text);
        FIELD_WALL_LINE_REGEX.lastIndex = 0;
        if (!match) return null;

        const marker = match[1];
        const roleName = match[2];
        const markerIndex = match.index + match[0].indexOf(marker);
        if (markerIndex >= limit) return null;

        const containingFence = closedFenceRanges.find(f => markerIndex >= f.start && markerIndex < f.end);
        if (containingFence) {
            cursor = containingFence.nextPos;
            continue;
        }

        if (roleName) {
            if (!marker.startsWith('<<<[END_') && rawFieldEndStart !== -1) {
                const startTag = `<<<[ROLE_DIVIDE_${roleName}]>>>`;
                const endTag = `<<<[END_ROLE_DIVIDE_${roleName}]>>>`;
                const afterStart = markerIndex + marker.length;
                const firstEnd = text.indexOf(endTag, afterStart);
                const nextStart = text.indexOf(startTag, afterStart);
                if (
                    firstEnd !== -1
                    && firstEnd + endTag.length <= rawFieldEndStart
                    && (nextStart === -1 || firstEnd < nextStart)
                    && isPureRoleExampleInner(text.slice(afterStart, firstEnd), allowFuzzyStart)
                ) {
                    cursor = firstEnd + endTag.length;
                    continue;
                }
            }
            return { index: markerIndex, marker };
        }

        if (marker === TOOL_RESULT_START_MARKER && rawFieldEndStart !== -1) {
            const sliceToFieldEnd = text.slice(markerIndex, rawFieldEndStart);
            const hasReceiptStructure = sliceToFieldEnd.includes(TOOL_RESULT_END_MARKER)
                || sliceToFieldEnd.includes('[[VCP协议纠偏指导:')
                || /^[ \t]*-[ \t]*(?:工具名称|执行状态)[:：]/m.test(sliceToFieldEnd);
            if (!hasReceiptStructure) {
                cursor = markerIndex + marker.length;
                continue;
            }
            // 自包含闭合纯文档型 [[VCP调用结果信息汇总:...VCP调用结果结束]] 放行
            let sPos = markerIndex + TOOL_RESULT_START_MARKER.length;
            let sDepth = 1;
            let closedEnd = -1;
            while (sPos < rawFieldEndStart && sDepth > 0) {
                const nextOpen = text.indexOf(TOOL_RESULT_START_MARKER, sPos);
                const nextClose = text.indexOf(TOOL_RESULT_END_MARKER, sPos);
                if (nextClose === -1 || nextClose + TOOL_RESULT_END_MARKER.length > rawFieldEndStart) break;
                if (nextOpen !== -1 && nextOpen < nextClose) {
                    sDepth += 1;
                    sPos = nextOpen + TOOL_RESULT_START_MARKER.length;
                } else {
                    sDepth -= 1;
                    sPos = nextClose + TOOL_RESULT_END_MARKER.length;
                    if (sDepth === 0) closedEnd = sPos;
                }
            }
            if (closedEnd !== -1 && isPureRoleExampleInner(
                text.slice(markerIndex, closedEnd).replaceAll(TOOL_RESULT_START_MARKER, ''),
                allowFuzzyStart
            )) {
                cursor = closedEnd;
                continue;
            }
        }

        if (marker.startsWith('<<<[VCP_TOOL_BATCH_START:') && rawFieldEndStart !== -1) {
            const headerMatch = /^<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>/.exec(text.slice(markerIndex));
            if (headerMatch) {
                const endToken = `<<<[VCP_TOOL_BATCH_END:${headerMatch[1]}]>>>`;
                const batchEndAt = text.indexOf(endToken, markerIndex + headerMatch[0].length);
                const batchCloseEnd = batchEndAt !== -1 ? batchEndAt + endToken.length : -1;
                if (batchCloseEnd !== -1 && batchCloseEnd <= rawFieldEndStart) {
                    const batchSlice = text.slice(markerIndex, batchCloseEnd);
                    if (
                        !batchSlice.includes('[[VCP协议纠偏指导:')
                        && hasBalancedToolBatchMarkersInSlice(batchSlice)
                        && hasBalancedSummaryBlocksInSlice(batchSlice)
                        && isPureRoleExampleInner(
                            batchSlice
                                .replace(/<<<\[VCP_TOOL_BATCH_(?:START|END):[^\]\r\n]+\]>>>/g, '')
                                .replace(/\[\[VCP调用结果信息汇总:|VCP调用结果结束\]\]/g, ''),
                            allowFuzzyStart
                        )
                    ) {
                        cursor = batchCloseEnd;
                        continue;
                    }
                }
            }
        }

        if (!marker.startsWith('<') || !/TOOL_REQUEST/i.test(marker)) {
            return { index: markerIndex, marker };
        }

        if (!allowFuzzyStart && marker !== TOOL_REQUEST_START_MARKER) {
            cursor = markerIndex + marker.length;
            continue;
        }
        if (isBacktickWrappedToolMarker(text, markerIndex, marker)) {
            cursor = markerIndex + marker.length;
            continue;
        }

        if (rawFieldEndStart !== -1) {
            const innerEnd = findUnwrappedRequestEnd(text, markerIndex + marker.length);
            if (
                innerEnd
                && innerEnd.end <= rawFieldEndStart
                && !FIELD_RECEIPT_WALL_LINE_REGEX.test(text.slice(markerIndex, innerEnd.start))
            ) {
                cursor = innerEnd.end;
                continue;
            }
            if (!FIELD_DECLARATION_AFTER_TOOL_RE.test(text.slice(markerIndex + marker.length, rawFieldEndStart))) {
                cursor = markerIndex + marker.length;
                continue;
            }
        }

        return { index: markerIndex, marker };
    }
    return null;
}

function findNextProtocolWall(text, fromIndex, allowFuzzyStart = false) {
    ROLE_DIVIDE_USER_WALL_REGEX.lastIndex = Math.max(0, fromIndex);
    const roleMatch = ROLE_DIVIDE_USER_WALL_REGEX.exec(text);
    ROLE_DIVIDE_USER_WALL_REGEX.lastIndex = 0;

    const nextTool = findNextUnwrappedToolStart(text, fromIndex, allowFuzzyStart);
    if (!roleMatch && !nextTool) return null;
    if (roleMatch && (!nextTool || roleMatch.index <= nextTool.index)) {
        return { index: roleMatch.index, marker: roleMatch[0] };
    }
    return nextTool;
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
 * @param {{ allowFuzzyStart?: boolean, stopAtProtocolWalls?: boolean }} [options]
 * @returns {{
 *   status: 'complete'|'incomplete-field'|'incomplete-request',
 *   endIndex: number,
 *   requestMarkerStart: number,
 *   field?: object
 * }}
 */
function scanToolRequestEnd(text, contentStart, options = {}) {
    if (typeof text !== 'string') {
        return {
            status: 'incomplete-request',
            endIndex: -1,
            requestMarkerStart: -1
        };
    }

    const allowFuzzyStart = Boolean(options?.allowFuzzyStart);
    const stopAtProtocolWalls = Boolean(options?.stopAtProtocolWalls);
    let cursor = Math.max(0, contentStart);

    while (cursor <= text.length) {
        const requestEnd = findUnwrappedRequestEnd(text, cursor);
        const field = findNextFieldStart(text, cursor);
        const wall = stopAtProtocolWalls
            ? findNextProtocolWall(text, cursor, allowFuzzyStart)
            : null;

        if (
            wall
            && (!requestEnd || wall.index < requestEnd.start)
            && (!field || wall.index < field.declarationStart)
        ) {
            return {
                status: 'incomplete-request',
                endIndex: -1,
                requestMarkerStart: -1
            };
        }

        if (requestEnd && (!field || requestEnd.start < field.declarationStart)) {
            return {
                status: 'complete',
                endIndex: requestEnd.end,
                requestMarkerStart: requestEnd.start
            };
        }

        if (!field) {
            return {
                status: 'incomplete-request',
                endIndex: -1,
                requestMarkerStart: -1
            };
        }

        const rawFieldEnd = findFieldEnd(text, field);
        const isEscapeField = /escape/i.test(field.startMarker);
        const wallBeforeFieldEnd = (stopAtProtocolWalls && rawFieldEnd && !isEscapeField)
            ? findFieldProtocolWall(text, field.markerEnd, rawFieldEnd.start, allowFuzzyStart)
            : null;
        const crossJumpEscapeLeak = Boolean(
            stopAtProtocolWalls
            && rawFieldEnd
            && isEscapeField
            && hasCrossJumpEscapeReceipt(text.slice(field.markerEnd, rawFieldEnd.start), field.startMarker[0] === '{')
        );
        const fieldEnd = (
            crossJumpEscapeLeak
            || (wallBeforeFieldEnd && wallBeforeFieldEnd.index < rawFieldEnd.start)
        )
            ? null
            : rawFieldEnd;
        if (!fieldEnd) {
            // 流式输出或模型格式轻微损坏时，字段闭合符可能缺失，但请求围栏
            // 已经完整生成。此时请求结束标记优先作为整个请求的兜底边界，
            // 否则前端会把一个后端已经成功调用的请求永久当成未完成。
            // 若开启了 stopAtProtocolWalls，则禁止跨越硬墙借用后续跳次的结束标记。
            const fallbackRequestEnd = findUnwrappedRequestEnd(text, field.markerEnd);
            const fallbackWall = stopAtProtocolWalls
                ? findFieldProtocolWall(text, field.markerEnd, -1, allowFuzzyStart)
                : null;
            if (fallbackRequestEnd && (!fallbackWall || fallbackRequestEnd.start < fallbackWall.index)) {
                return {
                    status: 'complete',
                    endIndex: fallbackRequestEnd.end,
                    requestMarkerStart: fallbackRequestEnd.start,
                    field: {
                        ...field,
                        contentStart: field.markerEnd,
                        contentEnd: fallbackRequestEnd.start,
                        endMarkerStart: -1,
                        endMarkerEnd: -1,
                        recoveredFromUnclosedField: true
                    }
                };
            }

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

function findToolRequestEnd(text, contentStart, options = {}) {
    return scanToolRequestEnd(text, contentStart, options).endIndex;
}

function findNextToolRequestStart(text, fromIndex, allowFuzzyStart = false) {
    if (!allowFuzzyStart) {
        const idx = text.indexOf(TOOL_REQUEST_START_MARKER, fromIndex);
        return idx === -1 ? null : { index: idx, marker: TOOL_REQUEST_START_MARKER };
    }
    TOOL_REQUEST_FUZZY_START_REGEX.lastIndex = Math.max(0, fromIndex);
    const m = TOOL_REQUEST_FUZZY_START_REGEX.exec(text);
    TOOL_REQUEST_FUZZY_START_REGEX.lastIndex = 0;
    return m ? { index: m.index, marker: m[0] } : null;
}

function findUnclosedToolRequest(text, options = {}) {
    const allowFuzzyStart = Boolean(options?.allowFuzzyStart);
    const stopAtProtocolWalls = Boolean(options?.stopAtProtocolWalls);
    if (typeof text !== 'string' || (!allowFuzzyStart ? !text.includes(TOOL_REQUEST_START_MARKER) : !/<{2,4}\[TOOL_REQUEST/i.test(text))) {
        return null;
    }

    const toolResultRanges = collectToolResultRanges(text);
    const codeRanges = collectProtocolLiteralCodeRanges(text, toolResultRanges);
    let cursor = 0;
    while (cursor < text.length) {
        const startMatch = findNextToolRequestStart(text, cursor, allowFuzzyStart);
        if (!startMatch) return null;
        const startIndex = startMatch.index;
        const startMarker = startMatch.marker;

        if (isLiteralProtocolMarker(text, startIndex, startMarker, codeRanges, toolResultRanges)) {
            cursor = startIndex + startMarker.length;
            continue;
        }

        const contentStart = startIndex + startMarker.length;
        const endIndex = findToolRequestEnd(text, contentStart, { allowFuzzyStart, stopAtProtocolWalls });
        if (endIndex === -1) {
            return {
                type: 'tool-request',
                startIndex,
                prefix: text.slice(0, startIndex),
                content: text.slice(startIndex)
            };
        }

        cursor = endIndex;
    }

    return null;
}

function findUnclosedToolResult(text) {
    if (typeof text !== 'string' || !text.includes(TOOL_RESULT_START_MARKER)) {
        return null;
    }

    // 嵌套感知配对：内层成对的字面量标记被整体包含在外层工具结果中。
    const unclosed = collectToolResultRanges(text).find(range => !range.closed);
    if (!unclosed) return null;

    return {
        type: 'tool-result',
        startIndex: unclosed.start,
        prefix: text.slice(0, unclosed.start),
        content: text.slice(unclosed.start)
    };
}

function findUnclosedDesktopPush(text) {
    if (typeof text !== 'string' || !text.includes(DESKTOP_PUSH_START_MARKER)) {
        return null;
    }

    const toolResultRanges = collectToolResultRanges(text);
    let cursor = 0;
    while (cursor < text.length) {
        const startIndex = text.indexOf(DESKTOP_PUSH_START_MARKER, cursor);
        if (startIndex === -1) return null;

        // 工具结果内的推送标记是数据，直接跳过整个工具结果区间。
        const containingToolResult = findToolResultRangeAt(startIndex, toolResultRanges);
        if (containingToolResult) {
            cursor = containingToolResult.end;
            continue;
        }

        if (isBacktickWrappedToolMarker(text, startIndex, DESKTOP_PUSH_START_MARKER)) {
            cursor = startIndex + DESKTOP_PUSH_START_MARKER.length;
            continue;
        }

        const endIndex = text.indexOf(
            DESKTOP_PUSH_END_MARKER,
            startIndex + DESKTOP_PUSH_START_MARKER.length
        );
        if (endIndex === -1) {
            return {
                type: 'desktop-push',
                startIndex,
                prefix: text.slice(0, startIndex),
                content: text.slice(startIndex)
            };
        }

        cursor = endIndex + DESKTOP_PUSH_END_MARKER.length;
    }

    return null;
}

/**
 * 返回流式文本中最早出现的未闭合工具/推送协议块。
 * 工具请求、工具结果以及桌面推送载荷均属于不可信数据域；调用方必须在任何 HTML/CSS
 * 副作用处理之前，以 startIndex 为边界隔离到当前流尾。
 */
function findEarliestUnclosedToolBlock(text) {
    return [findUnclosedToolRequest(text), findUnclosedToolResult(text), findUnclosedDesktopPush(text)]
        .filter(Boolean)
        .sort((a, b) => a.startIndex - b.startIndex)[0] || null;
}

function replaceToolRequestBlocks(text, replacer, options = {}) {
    const allowFuzzyStart = Boolean(options?.allowFuzzyStart);
    const stopAtProtocolWalls = Boolean(options?.stopAtProtocolWalls);
    if (typeof text !== 'string' || (!allowFuzzyStart ? !text.includes(TOOL_REQUEST_START_MARKER) : !/<{2,4}\[TOOL_REQUEST/i.test(text))) {
        return text;
    }

    const sourceIndex = options.sourceIndex;
    if (sourceIndex && sourceIndex.source !== text) {
        throw new TypeError('Tool request index belongs to a different source version');
    }
    const indexedTools = sourceIndex?.toolData();
    const toolResultRanges = options.toolResultRanges ?? indexedTools ?? collectToolResultRanges(text);
    // An explicit caller mask remains authoritative. Reuse code ranges only when
    // that mask is equivalent to the source index's data-domain mask.
    const sameMask = indexedTools && (toolResultRanges === indexedTools
        || (toolResultRanges.length === indexedTools.length && toolResultRanges.every((range, i) =>
            range.start === indexedTools[i].start && range.end === indexedTools[i].end)));
    // Protocol policy intentionally rejects multiline inline spans. Do not consume
    // the document partition here: it has different HTML/thought precedence.
    const codeRanges = sameMask
        ? sourceIndex.codes('protocol')
        : collectProtocolLiteralCodeRanges(text, toolResultRanges);
    let result = '';
    let cursor = 0;

    while (cursor < text.length) {
        const startMatch = findNextToolRequestStart(text, cursor, allowFuzzyStart);
        if (!startMatch) {
            result += text.slice(cursor);
            break;
        }
        const startIndex = startMatch.index;
        const startMarker = startMatch.marker;

        if (isLiteralProtocolMarker(text, startIndex, startMarker, codeRanges, toolResultRanges)) {
            const markerEnd = startIndex + startMarker.length;
            result += text.slice(cursor, markerEnd);
            cursor = markerEnd;
            continue;
        }

        const contentStart = startIndex + startMarker.length;
        const scan = (sourceIndex && !stopAtProtocolWalls)
            ? sourceIndex.requestEnd(contentStart)
            : scanToolRequestEnd(text, contentStart, { allowFuzzyStart, stopAtProtocolWalls });
        if (scan.status !== 'complete') {
            if (stopAtProtocolWalls) {
                const markerEnd = startIndex + startMarker.length;
                result += text.slice(cursor, markerEnd);
                cursor = markerEnd;
                continue;
            }
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
    TOOL_RESULT_START_MARKER,
    TOOL_RESULT_END_MARKER,
    DESKTOP_PUSH_START_MARKER,
    DESKTOP_PUSH_END_MARKER,
    findToolRequestEnd,
    findUnclosedToolRequest,
    findUnclosedToolResult,
    findUnclosedDesktopPush,
    findEarliestUnclosedToolBlock,
    findNextToolRequestStart,
    isBacktickWrappedToolMarker,
    replaceToolRequestBlocks,
    scanToolRequestEnd
};