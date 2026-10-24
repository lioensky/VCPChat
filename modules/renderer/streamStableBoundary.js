import { collectToolResultRanges, collectCodeDomainsOutsideToolResults, findToolResultEnd, findToolResultRangeAt, indexOfOutsideToolResults } from './toolResultRegions.js';
import { findToolRequestEnd } from './toolRequestScanner.js';

const TOOL_REQUEST_START = '<<<[TOOL_REQUEST]>>>';
const TOOL_REQUEST_END = '<<<[END_TOOL_REQUEST]>>>';
const TOOL_RESULT_START = '[[VCP调用结果信息汇总:';
const TOOL_RESULT_END = 'VCP调用结果结束]]';
const TOOL_CALL_SUMMARY_START = '[本轮工具调用摘要:]';
const TOOL_CALL_SUMMARY_END = '[本轮工具调用摘要结束]';
const ROLE_DIVIDER_REGEX = /<<<\[(END_)?ROLE_DIVIDE_(SYSTEM|ASSISTANT|USER)\]>>>/g;
const DESKTOP_PUSH_START = '<<<[DESKTOP_PUSH]>>>';
const DESKTOP_PUSH_END = '<<<[DESKTOP_PUSH_END]>>>';
const THOUGHT_CHAIN_START = '[--- VCP元思考链';
const THOUGHT_CHAIN_END = '[--- 元思考链结束 ---]';
const THOUGHT_CHAIN_START_LINE_REGEX = /^[ \t]*\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\][ \t]*(?:\r?\n|$)/gm;
const THOUGHT_CHAIN_END_LINE_REGEX = /^[ \t]*\[--- 元思考链结束 ---\][ \t]*(?:\r?\n|$)/gm;
const THINK_START_REGEX = /^[ \t]*<think(?:ing)?>[ \t]*(?:\r?\n|$)/gim;
const THINK_END_REGEX = /^[ \t]*<\/think(?:ing)?>[ \t]*(?:\r?\n|$)/gim;
const DAILY_NOTE_START = '<<<DailyNoteStart>>>';
const DAILY_NOTE_END = '<<<DailyNoteEnd>>>';
const MARKDOWN_SECTION_BREAK_TOKEN = '---';
const STREAM_PARAGRAPH_SAFETY_BLOCKS = 1;
const HTML_ISLAND_MAX_STACK_DEPTH = 128;
const HTML_ISLAND_MAX_CHARS = 256 * 1024;
const HTML_RAWTEXT_TAGS = new Set(['script', 'style']);
const HTML_VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);
const HTML_ISLAND_STACK_TAGS = new Set([
    'a', 'article', 'aside', 'b', 'blockquote', 'button', 'canvas', 'code',
    'defs', 'div', 'em', 'figcaption', 'figure', 'filter', 'footer', 'form',
    'g', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'i', 'label', 'li',
    'lineargradient', 'main', 'nav', 'ol', 'p', 'path', 'pre', 'radialgradient',
    'section', 'select', 'span', 'strong', 'svg', 'table', 'tbody', 'td',
    'textarea', 'th', 'thead', 'tr', 'ul', ...HTML_RAWTEXT_TAGS
]);


function startsWithAt(text, index, token) {
    return text.startsWith(token, index);
}
function findFenceOpeningAt(text, startIndex) {
    const lineStart = startIndex === 0 ? 0 : text.lastIndexOf('\n', startIndex - 1) + 1;
    const prefix = text.slice(lineStart, startIndex);
    if (!/^[ \t]{0,3}$/.test(prefix)) return null;
    const match = text.slice(startIndex).match(/^(`{3,}|~{3,})([^\n]*)/);
    if (!match) return null;
    return { markerChar: match[1][0], markerLength: match[1].length };
}

function findMatchingFenceEnd(text, startIndex) {
    const opening = findFenceOpeningAt(text, startIndex);
    if (!opening) return -1;
    const openEnd = text.indexOf('\n', startIndex);
    if (openEnd === -1) return -1;

    let lineStart = openEnd + 1;
    while (lineStart <= text.length) {
        const lineEndIndex = text.indexOf('\n', lineStart);
        const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
        const line = text.slice(lineStart, lineEnd);
        const closeMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
        if (
            closeMatch &&
            closeMatch[1][0] === opening.markerChar &&
            closeMatch[1].length >= opening.markerLength
        ) {
            return lineEndIndex === -1 ? text.length : lineEndIndex + 1;
        }
        if (lineEndIndex === -1) break;
        lineStart = lineEndIndex + 1;
    }

    return -1;
}

function isLineOnlyToken(text, tokenStart, tokenLength) {
    const lineStart = tokenStart === 0 ? 0 : text.lastIndexOf('\n', tokenStart - 1) + 1;
    const lineEndIndex = text.indexOf('\n', tokenStart + tokenLength);
    const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
    const before = text.slice(lineStart, tokenStart);
    const after = text.slice(tokenStart + tokenLength, lineEnd);

    return before.trim() === '' && after.trim() === '';
}
function findDisplayMathBlockEnd(text, startIndex, openDelimiter, closeDelimiter = openDelimiter) {
    if (!isLineOnlyToken(text, startIndex, openDelimiter.length)) {
        return -1;
    }

    let searchIndex = startIndex + openDelimiter.length;
    while (searchIndex < text.length) {
        const closeIndex = text.indexOf(closeDelimiter, searchIndex);
        if (closeIndex === -1) return -1;

        if (isLineOnlyToken(text, closeIndex, closeDelimiter.length)) {
            const lineEnd = text.indexOf('\n', closeIndex + closeDelimiter.length);
            return lineEnd === -1 ? text.length : lineEnd + 1;
        }

        searchIndex = closeIndex + closeDelimiter.length;
    }

    return -1;
}

/**
 * 查找行级结束标记。落在工具结果区间内的命中只是工具数据，跳过整个区间继续查找，
 * 避免工具结果里的同名结束行提前闭合外层思维链。
 */
function findLineDelimitedBlockEnd(text, startIndex, endRegex, toolResultRanges = null) {
    endRegex.lastIndex = startIndex;
    let match;
    while ((match = endRegex.exec(text)) !== null) {
        const range = findToolResultRangeAt(match.index, toolResultRanges);
        if (!range) break;
        endRegex.lastIndex = range.end;
    }
    endRegex.lastIndex = 0;
    return match ? match.index + match[0].length : -1;
}

function findLineDelimitedBlockStart(text, startIndex, startRegex) {
    startRegex.lastIndex = startIndex;
    const match = startRegex.exec(text);
    startRegex.lastIndex = 0;
    return match ? match.index : -1;
}

function findConventionalThinkEnd(text, startIndex, toolResultRanges = null) {
    return findLineDelimitedBlockEnd(text, startIndex, THINK_END_REGEX, toolResultRanges);
}

function findConventionalThinkStart(text, startIndex) {
    return findLineDelimitedBlockStart(text, startIndex, THINK_START_REGEX);
}

function findThoughtChainEnd(text, startIndex, toolResultRanges = null) {
    return findLineDelimitedBlockEnd(text, startIndex, THOUGHT_CHAIN_END_LINE_REGEX, toolResultRanges);
}

function findThoughtChainStart(text, startIndex) {
    return findLineDelimitedBlockStart(text, startIndex, THOUGHT_CHAIN_START_LINE_REGEX);
}
function findParagraphStableCutoff(text, floorOffset) {
    const recentBoundaries = [];
    const retainedBoundaryCount = STREAM_PARAGRAPH_SAFETY_BLOCKS + 1;
    let searchIndex = Math.max(0, floorOffset);

    while (searchIndex < text.length) {
        const boundary = /\r?\n[ \t]*\r?\n/g;
        boundary.lastIndex = searchIndex;
        const match = boundary.exec(text);
        if (!match) break;
        const cutoff = match.index + match[0].length;
        if (cutoff > floorOffset) {
            recentBoundaries.push(cutoff);
            if (recentBoundaries.length > retainedBoundaryCount) recentBoundaries.shift();
        }
        searchIndex = cutoff;
    }

    return recentBoundaries.length < retainedBoundaryCount
        ? floorOffset
        : recentBoundaries[0];
}

function findHtmlTagEnd(text, tagStart) {
    let quote = null;

    for (let i = tagStart + 1; i < text.length; i++) {
        const char = text[i];

        if (quote) {
            if (char === quote) {
                quote = null;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (char === '>') {
            return i;
        }
    }

    return -1;
}

function parseHtmlTagToken(text, tagStart) {
    if (startsWithAt(text, tagStart, '<!--')) {
        return { type: 'comment' };
    }

    const tagEnd = findHtmlTagEnd(text, tagStart);
    if (tagEnd === -1) {
        return { type: 'incomplete' };
    }

    const raw = text.slice(tagStart + 1, tagEnd);
    const trimmed = raw.trim();

    if (!trimmed) {
        return { type: 'unknown', tagEnd };
    }

    if (trimmed[0] === '!' || trimmed[0] === '?') {
        return { type: 'declaration', tagEnd };
    }

    const isClosing = trimmed[0] === '/';
    const nameSource = isClosing ? trimmed.slice(1).trimStart() : trimmed;
    const nameMatch = nameSource.match(/^([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!nameMatch) {
        return { type: 'unknown', tagEnd };
    }

    const name = nameMatch[1].toLowerCase();
    return {
        type: 'tag',
        tagEnd,
        name,
        isClosing,
        isSelfClosing: /\/\s*$/.test(trimmed)
    };
}

function popHtmlIslandStack(stack, tagName) {
    const topIndex = stack.lastIndexOf(tagName);
    if (topIndex === -1) {
        return false;
    }

    stack.splice(topIndex);
    return true;
}

function isBareDivIslandLineStart(text, tagStart) {
    const lineStart = tagStart === 0 ? 0 : text.lastIndexOf('\n', tagStart - 1) + 1;
    const prefix = text.slice(lineStart, tagStart);

    // 只把“新行上暴露的裸 <div>”视为动画岛入口。
    // 行内代码 `... <div> ...`、普通 Markdown 文本中的 <div> 提及、反引号包裹的 `<div>` 都不会触发。
    return prefix.trim() === '';
}

function scanBareDivIslandEnd(text, startIndex) {
    const stack = [];
    let index = startIndex;
    const lowerText = text.toLowerCase();

    while (index < text.length) {
        if (index - startIndex > HTML_ISLAND_MAX_CHARS) {
            return { end: -1, blocked: true, abandoned: true };
        }

        const tagStart = text.indexOf('<', index);
        if (tagStart === -1) {
            return { end: -1, blocked: true };
        }

        if (tagStart - startIndex > HTML_ISLAND_MAX_CHARS) {
            return { end: -1, blocked: true, abandoned: true };
        }

        if (startsWithAt(text, tagStart, '<!--')) {
            const commentEnd = text.indexOf('-->', tagStart + 4);
            if (commentEnd === -1) {
                return { end: -1, blocked: true };
            }
            index = commentEnd + 3;
            continue;
        }

        const token = parseHtmlTagToken(text, tagStart);
        if (token.type === 'incomplete') {
            return { end: -1, blocked: true };
        }

        if (token.type !== 'tag') {
            index = (token.tagEnd ?? tagStart) + 1;
            continue;
        }

        const { name, tagEnd, isClosing, isSelfClosing } = token;

        if (isClosing) {
            popHtmlIslandStack(stack, name);
            index = tagEnd + 1;

            if (stack.length === 0) {
                return { end: index, blocked: false };
            }

            continue;
        }

        const shouldPush = !isSelfClosing && !HTML_VOID_TAGS.has(name) && HTML_ISLAND_STACK_TAGS.has(name);
        if (!shouldPush) {
            index = tagEnd + 1;
            continue;
        }

        stack.push(name);
        if (stack.length > HTML_ISLAND_MAX_STACK_DEPTH) {
            return { end: -1, blocked: true, abandoned: true };
        }

        index = tagEnd + 1;

        if (HTML_RAWTEXT_TAGS.has(name)) {
            const rawTextCloseStart = lowerText.indexOf(`</${name}`, index);
            if (rawTextCloseStart === -1) {
                return { end: -1, blocked: true };
            }

            const rawTextCloseToken = parseHtmlTagToken(text, rawTextCloseStart);
            if (rawTextCloseToken.type === 'incomplete') {
                return { end: -1, blocked: true };
            }

            if (rawTextCloseToken.type === 'tag' && rawTextCloseToken.isClosing && rawTextCloseToken.name === name) {
                popHtmlIslandStack(stack, name);
                index = rawTextCloseToken.tagEnd + 1;

                if (stack.length === 0) {
                    return { end: index, blocked: false };
                }
            } else {
                index = rawTextCloseStart + 2;
            }
        }
    }

    return { end: -1, blocked: true };
}

function findBareDivIslandStableCutoff(text, startOffset = 0, codeDomains = []) {
    if (typeof text !== 'string') {
        return { cutoff: startOffset, blocked: false };
    }

    let index = Math.max(0, startOffset);
    let cutoff = startOffset;
    let codeDomainIndex = 0;

    while (codeDomainIndex < codeDomains.length && codeDomains[codeDomainIndex].end <= index) {
        codeDomainIndex += 1;
    }

    while (index < text.length) {
        const tagStart = text.indexOf('<', index);
        if (tagStart === -1) {
            break;
        }

        while (
            codeDomainIndex < codeDomains.length
            && codeDomains[codeDomainIndex].end <= tagStart
        ) {
            codeDomainIndex += 1;
        }
        const containingCodeDomain = codeDomains[codeDomainIndex];
        if (
            containingCodeDomain
            && tagStart >= containingCodeDomain.start
            && tagStart < containingCodeDomain.end
        ) {
            // Markdown code 域中的 <div>/<style>/<script> 都只是字面量，
            // 不得进入 HTML 岛标签栈或触发递归闭合扫描。
            index = containingCodeDomain.end;
            continue;
        }

        if (startsWithAt(text, tagStart, '<!--')) {
            const commentEnd = text.indexOf('-->', tagStart + 4);
            if (commentEnd === -1) {
                return { cutoff, blocked: true };
            }
            index = commentEnd + 3;
            continue;
        }

        if (!/^<(?:[a-zA-Z][a-zA-Z0-9:-]*(?:\s|\/?>|$)|\/[a-zA-Z]|!)/.test(text.slice(tagStart))) {
            index = tagStart + 1;
            continue;
        }
        const token = parseHtmlTagToken(text, tagStart);
        if (token.type === 'incomplete') {
            return { cutoff, blocked: true };
        }

        if (token.type !== 'tag') {
            index = (token.tagEnd ?? tagStart) + 1;
            continue;
        }

        if (!token.isClosing && token.name === 'div' && !token.isSelfClosing && isBareDivIslandLineStart(text, tagStart)) {
            const island = scanBareDivIslandEnd(text, tagStart);
            if (island.end > tagStart) {
                cutoff = island.end;
                index = island.end;
                continue;
            }

            return {
                cutoff,
                blocked: true,
                abandoned: island.abandoned === true
            };
        }

        index = token.tagEnd + 1;
    }

    return { cutoff, blocked: false };
}

function hasLikelyUnclosedHtmlIsland(text, startOffset = 0) {
    return findBareDivIslandStableCutoff(text, startOffset).blocked;
}

function findToolRequestBlockEnd(text, startIndex) {
    const contentStart = startIndex + TOOL_REQUEST_START.length;

    // 与完整渲染共享 ESCAPE 感知扫描器：工具参数中的「始ESCAPE」...「末ESCAPE」
    // 可能包含结束标记文本，不能用简单 indexOf 提前截断请求。
    if (typeof findToolRequestEnd === 'function') {
        return findToolRequestEnd(text, contentStart);
    }

    const endIndex = text.indexOf(TOOL_REQUEST_END, contentStart);
    return endIndex === -1 ? -1 : endIndex + TOOL_REQUEST_END.length;
}

function findRoleDividerSectionEnd(text, startIndex, toolResultRanges = null) {
    ROLE_DIVIDER_REGEX.lastIndex = startIndex;
    const startMatch = ROLE_DIVIDER_REGEX.exec(text);
    ROLE_DIVIDER_REGEX.lastIndex = 0;

    if (!startMatch || startMatch.index !== startIndex || startMatch[1]) {
        return -1;
    }

    const role = startMatch[2];
    const endToken = `<<<[END_ROLE_DIVIDE_${role}]>>>`;
    const endIndex = indexOfOutsideToolResults(text, endToken, startIndex + startMatch[0].length, toolResultRanges);
    return endIndex === -1 ? -1 : endIndex + endToken.length;
}

export function findExplicitStablePrefix(text, startOffset = 0) {
    // 仅稳定区判定信任此独立行：VCP 用它宣布本轮工具回执已经结束。
    // 必须先于工具结果/代码/HTML 扫描，载荷里的不配对字面量不能阻止封口。
    // 这不是工具结果配对或安全隔离规则；完整渲染仍使用原来的数据域扫描器。
    // 流式 EOF 尚不能证明独立行，等待 LF（兼容 CRLF）确认右边界。
    const trustedEndLine = /^[ \t]*<<<\[END_ROLE_DIVIDE_USER\]>>>[ \t]*\r?\n/gm;
    trustedEndLine.lastIndex = Math.max(0, startOffset);
    let trustedCutoff = 0;
    let trustedMatch;
    while ((trustedMatch = trustedEndLine.exec(text)) !== null) {
        trustedCutoff = trustedMatch.index + trustedMatch[0].length;
    }
    if (trustedCutoff > startOffset) {
        // 已封口源码不再参与本次后续结构扫描；只检查封口之后的新 tail。
        return trustedCutoff + findExplicitStablePrefix(text.slice(trustedCutoff), 0);
    }

    let index = Math.max(0, startOffset);
    let stableCutoff = startOffset;
    let paragraphFloor = startOffset;
    let blockedByUnclosedExplicitBlock = false;
    // 工具结果是最高优先级的数据域：代码域收集前先遮蔽工具结果，
    // 其中孤立的反引号/围栏不会生成延伸到文末的未闭合代码域而永久冻结稳定区；
    // 外层块查找结束标记时也跳过工具结果内的同名标记。
    const toolResultRanges = collectToolResultRanges(text);
    const codeDomains = collectCodeDomainsOutsideToolResults(text, toolResultRanges, {
        includeUnclosedInline: true,
    });
    let codeDomainIndex = 0;

    while (codeDomainIndex < codeDomains.length && codeDomains[codeDomainIndex].end <= index) {
        codeDomainIndex += 1;
    }

    while (index < text.length) {
        while (
            codeDomainIndex < codeDomains.length
            && codeDomains[codeDomainIndex].end <= index
        ) {
            codeDomainIndex += 1;
        }
        // 独立 raw-text 标签也拥有内部的空行；不能在 CSS/JS 中途提交段落。
        const rawTextOpen = text.slice(index).match(/^<(style|script)\b[^>]*>/i);
        if (rawTextOpen) {
            const close = new RegExp('</' + rawTextOpen[1] + '\\s*>', 'ig');
            close.lastIndex = index + rawTextOpen[0].length;
            const match = close.exec(text);
            if (!match) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            index = match.index + match[0].length;
            stableCutoff = index;
            paragraphFloor = index;
            continue;
        }
        // HTML islands own all inner delimiters, including Markdown-looking text.
        if (text[index] === '<' && /^<div(?:\s|>)/i.test(text.slice(index)) && isBareDivIslandLineStart(text, index)) {
            const island = scanBareDivIslandEnd(text, index);
            if (island.end < 0) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = island.end;
            paragraphFloor = island.end;
            index = island.end;
            continue;
        }
        const codeDomain = codeDomains[codeDomainIndex];
        if (codeDomain && index >= codeDomain.start && index < codeDomain.end) {
            if (!codeDomain.closed) {
                // 流式未闭合代码域拥有当前 tail。其内部任何 HTML/VCP 标记都只是
                // 尚未完成的代码字面量，不能据此产生 stable 副作用。
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            if (codeDomain.kind === 'fence') {
                if (codeDomain.end === text.length && !text.endsWith('\n')) {
                    blockedByUnclosedExplicitBlock = true;
                    break;
                }
                stableCutoff = Math.max(stableCutoff, codeDomain.end);
                paragraphFloor = Math.max(paragraphFloor, codeDomain.end);
            }
            index = codeDomain.end;
            codeDomainIndex += 1;
            continue;
        }

        if ((text[index] === '`' || text[index] === '~') && findFenceOpeningAt(text, index)) {
            const fenceEnd = findMatchingFenceEnd(text, index);
            if (fenceEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = fenceEnd;
            paragraphFloor = fenceEnd;
            index = fenceEnd;
            continue;
        }

        if (startsWithAt(text, index, '$$') && isLineOnlyToken(text, index, 2)) {
            const mathEnd = findDisplayMathBlockEnd(text, index, '$$');
            if (mathEnd === -1 || (mathEnd === text.length && !text.endsWith('\n'))) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = mathEnd;
            paragraphFloor = mathEnd;
            index = mathEnd;
            continue;
        }

        if (startsWithAt(text, index, '\\[') && isLineOnlyToken(text, index, 2)) {
            const mathEnd = findDisplayMathBlockEnd(text, index, '\\[', '\\]');
            if (mathEnd === -1 || (mathEnd === text.length && !text.endsWith('\n'))) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = mathEnd;
            paragraphFloor = mathEnd;
            index = mathEnd;
            continue;
        }

        if (startsWithAt(text, index, TOOL_REQUEST_START)) {
            const requestEnd = findToolRequestBlockEnd(text, index);
            if (requestEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = requestEnd;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        if (startsWithAt(text, index, TOOL_RESULT_START)) {
            // 嵌套感知：内层成对的字面量标记不会在第一个结束标记处截断外层工具结果。
            const toolResultEnd = findToolResultEnd(text, index);
            if (toolResultEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = toolResultEnd;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        if (startsWithAt(text, index, TOOL_CALL_SUMMARY_START)) {
            const endIndex = indexOfOutsideToolResults(text, TOOL_CALL_SUMMARY_END, index + TOOL_CALL_SUMMARY_START.length, toolResultRanges);
            if (endIndex === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = endIndex + TOOL_CALL_SUMMARY_END.length;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        if (startsWithAt(text, index, '<<<[ROLE_DIVIDE_')) {
            const sectionEnd = findRoleDividerSectionEnd(text, index, toolResultRanges);
            if (sectionEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = sectionEnd;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        if (startsWithAt(text, index, DESKTOP_PUSH_START)) {
            const endIndex = indexOfOutsideToolResults(text, DESKTOP_PUSH_END, index + DESKTOP_PUSH_START.length, toolResultRanges);
            if (endIndex === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = endIndex + DESKTOP_PUSH_END.length;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        const thoughtChainStart = findThoughtChainStart(text, index);
        if (thoughtChainStart === index) {
            const thoughtChainEnd = findThoughtChainEnd(text, index, toolResultRanges);
            if (thoughtChainEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = thoughtChainEnd;
            paragraphFloor = thoughtChainEnd;
            index = thoughtChainEnd;
            continue;
        }

        if (startsWithAt(text, index, DAILY_NOTE_START)) {
            const endIndex = indexOfOutsideToolResults(text, DAILY_NOTE_END, index + DAILY_NOTE_START.length, toolResultRanges);
            if (endIndex === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = endIndex + DAILY_NOTE_END.length;
            paragraphFloor = stableCutoff;
            index = stableCutoff;
            continue;
        }

        if (startsWithAt(text, index, MARKDOWN_SECTION_BREAK_TOKEN)) {
            if (isLineOnlyToken(text, index, MARKDOWN_SECTION_BREAK_TOKEN.length) && text.indexOf('\n', index) !== -1) {
                // 独立行 Markdown 文档分段符 --- 可作为稳定切点；
                // 目前只处理严格的 ---，暂不扩展到 ***/___ 或带空格变体。
                stableCutoff = index + MARKDOWN_SECTION_BREAK_TOKEN.length;
                paragraphFloor = stableCutoff;
            }
            index += MARKDOWN_SECTION_BREAK_TOKEN.length;
            continue;
        }

        const thinkStart = findConventionalThinkStart(text, index);
        if (thinkStart === index) {
            const thinkEnd = findConventionalThinkEnd(text, index, toolResultRanges);
            if (thinkEnd === -1) {
                blockedByUnclosedExplicitBlock = true;
                break;
            }
            stableCutoff = thinkEnd;
            paragraphFloor = thinkEnd;
            index = thinkEnd;
            continue;
        }

        index += 1;
    }

    if (blockedByUnclosedExplicitBlock) {
        // The unfinished tail cannot revoke already complete paragraphs before it.
        return Math.max(stableCutoff, findParagraphStableCutoff(text.slice(0, index), paragraphFloor));
    }

    const divIslandResult = findBareDivIslandStableCutoff(text, paragraphFloor, codeDomains);
    if (divIslandResult.cutoff > stableCutoff) {
        stableCutoff = divIslandResult.cutoff;
        paragraphFloor = divIslandResult.cutoff;
    }

    if (divIslandResult.blocked) {
        return stableCutoff;
    }

    const paragraphCutoff = findParagraphStableCutoff(text, paragraphFloor);
    return Math.max(stableCutoff, paragraphCutoff);
}

