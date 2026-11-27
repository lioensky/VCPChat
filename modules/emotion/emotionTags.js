/* Inline emotion tags in assistant replies: <!--emo:happy 0.8-->.
 * stripEmotionTags() removes them from anything a person sees or hears; createEmotionTagScanner()
 * reads a streamed reply chunk by chunk and reports tags, visible text and the regions (code,
 * thoughts, tool calls) where tags do not count. No DOM or Electron dependency. */
import { normalizeEmotion, clampIntensity } from './emotionVocabulary.js';

// <!--emo:happy-->、<!--emo:happy 0.8-->、<!--emo:happy/bright_smile 0.8-->、<!-- emo: 开心 -->
const TAG_BODY = /^\s*emo\s*[:：]\s*([^\s/>]+?)(?:\/([A-Za-z0-9_+,\uFF0C-]+))?(?:\s+([^\s<>]{1,24}))?\s*$/i;
const TAG_OPEN = /<!--\s*emo\s*[:：]/iy;
const TAG_OPEN_ANYWHERE = /<!--\s*emo\s*[:：]/gi;
// 标签的结尾：同一行、80 个字符以内的第一个 >。模型偶尔把 --> 写成 >、->、--!>，也当结尾，
// 不然浏览器会把它当成没闭合的注释，把后面整段回复都藏掉；也不会一路找到很远处正文里的 "A --> B"
const TAG_MAX_BODY = 192;
const TAG_REST_CLOSED = /([^<>\r\n]{0,192}?)(?:--!?|-)?>/y;
// 没写结尾的标签：只认到情绪词、子表情和强度为止，后面的正文留着
const TAG_REST_BARE = /\s*([^\s/<>!-]{1,24})(?:\/([A-Za-z0-9_+,\uFF0C-]+))?(?:\s+(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)))?/y;
// 流式尾巴上还没写完的标签：<!-、<!--、<!--em、<!--emo:hap…（同一行、最多 64 个字符，避免吞掉普通长注释）
const PARTIAL_TAIL = /<!(?:-(?:-(?:\s*e(?:m(?:o(?:\s*[:：][^>\r\n]{0,64})?)?)?)?)?)?$/i;
// 代码围栏（``` 或 ~~~）和行内代码里的标签是在讲这个格式，不是在用它
const PROTECTED = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|`[^`\r\n]+`/g;
const PENDING = Object.freeze({ pending: true });

/** 解析一个注释体（<!-- 和 --> 之间的部分）；不是情绪标签或情绪认不出时返回 null */
export function parseEmotionTagBody(body) {
    const source = String(body ?? '');
    // 保留原英文子表情与无效强度容错；完整可读名称走下面的尾部数字解析。
    const legacy = TAG_BODY.exec(source);
    if (legacy && (!legacy[2] || !legacy[3] || /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(legacy[3])
        || /^(?:[em][a-f0-9]+)(?:[+,，](?:[em][a-f0-9]+|nod|shake|tilt|cheer|bow))*$/i.test(legacy[2]))) {
        const emotion = normalizeEmotion(legacy[1]);
        return emotion ? { emotion, variant: legacy[2] ? legacy[2].toLowerCase() : null, intensity: clampIntensity(legacy[3], 0.7) } : null;
    }
    const match = /^\s*emo\s*[:：]\s*([^\s/<>]+)\s*\/\s*([^<>\r\n]+?)\s*$/i.exec(source);
    if (!match) return null;
    const emotion = normalizeEmotion(match[1]);
    if (!emotion) return null;
    const tail = /\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(match[2]);
    const variant = (tail ? match[2].slice(0, tail.index) : match[2]).trim();
    if (!variant || /[!]/.test(variant)) return null;
    return { emotion, variant: variant.toLowerCase(), intensity: clampIntensity(tail?.[1], 0.7) };
}

/**
 * 从 index 处读一个情绪标签。不是情绪标签返回 null；final 为 false 且标签可能还没写完时返回 PENDING；
 * 否则返回 { end, tag }，tag 在情绪认不出时为 null（标签照样去掉）。
 */
function matchEmotionTag(text, index, final) {
    TAG_OPEN.lastIndex = index;
    if (!TAG_OPEN.test(text)) return null;
    const restAt = TAG_OPEN.lastIndex;
    TAG_REST_CLOSED.lastIndex = restAt;
    const closed = TAG_REST_CLOSED.exec(text);
    if (closed) {
        const body = text.slice(index + 4, restAt) + closed[1].replace(/[\s!-]+$/, '');
        return { end: TAG_REST_CLOSED.lastIndex, tag: parseEmotionTagBody(body) };
    }
    const rest = text.slice(restAt);
    if (!final && rest.length <= TAG_MAX_BODY && !/[<>\r\n]/.test(rest)) return PENDING;
    TAG_REST_BARE.lastIndex = restAt;
    const bare = TAG_REST_BARE.exec(text);
    const tag = bare ? parseEmotionTagBody(text.slice(index + 4, TAG_REST_BARE.lastIndex)) : null;
    return { end: tag ? TAG_REST_BARE.lastIndex : restAt, tag };
}

function stripOutsideCode(text, streaming) {
    const source = streaming ? text.replace(PARTIAL_TAIL, '') : text;
    let result = '';
    let cursor = 0;
    TAG_OPEN_ANYWHERE.lastIndex = 0;
    let match;
    while ((match = TAG_OPEN_ANYWHERE.exec(source)) !== null) {
        result += source.slice(cursor, match.index);
        cursor = matchEmotionTag(source, match.index, true).end;
        TAG_OPEN_ANYWHERE.lastIndex = cursor;
    }
    return result + source.slice(cursor);
}

/**
 * 去掉文本里的情绪标签。代码围栏和行内代码里的不动（那是在讲这个格式，不是在用它）。
 * streaming 为 true 时连尾巴上没写完的半个标签一起去掉，免得流式中途闪出 "<!--emo"。
 */
export function stripEmotionTags(text, { streaming = false } = {}) {
    if (typeof text !== 'string' || !text) return text;
    if (!/<!/.test(text)) return text;
    let result = '';
    let cursor = 0;
    PROTECTED.lastIndex = 0;
    let match;
    while ((match = PROTECTED.exec(text)) !== null) {
        if (match[0] === '') { PROTECTED.lastIndex += 1; continue; }
        result += stripOutsideCode(text.slice(cursor, match.index), false);
        result += match[0];
        cursor = match.index + match[0].length;
    }
    result += stripOutsideCode(text.slice(cursor), streaming && cursor < text.length);
    return result;
}

// 不计入情绪的区域：代码、思维链、工具调用与工具结果。区域里的标签不算，文字也不拿去做规则判断
const REGIONS = Object.freeze([
    { kind: 'code', open: '```', close: '```' },
    { kind: 'code', open: '~~~', close: '~~~' },
    { kind: 'thought', open: '<think>', close: '</think>' },
    { kind: 'thought', open: '<thinking>', close: '</thinking>' },
    { kind: 'thought', open: '<thought>', close: '</thought>' },
    { kind: 'thought', open: '<thoughts>', close: '</thoughts>' },
    { kind: 'thought', open: '<antthinking>', close: '</antthinking>' },
    { kind: 'thought', open: '[--- VCP元思考链', close: '[--- 元思考链结束 ---]' },
    { kind: 'tool', open: '<<<[TOOL_REQUEST]>>>', close: '<<<[END_TOOL_REQUEST]>>>' },
    { kind: 'tool', open: '[[VCP调用结果信息汇总:', close: 'VCP调用结果结束]]' },
    { kind: 'tool', open: '<<<[ROLE_DIVIDE_USER]>>>', close: '<<<[END_ROLE_DIVIDE_USER]>>>' },
    { kind: 'tool', open: '<<<[VCP_TOOL_BATCH_START:', close: '<<<[VCP_TOOL_BATCH_END:' },
]);
const THOUGHT_LINE_OPENERS = new Set([
    '<think>', '<thinking>', '<thought>', '<thoughts>', '<antthinking>',
    '[--- VCP元思考链', '<<<[ROLE_DIVIDE_USER]>>>', '<<<[VCP_TOOL_BATCH_START:',
]);
const STRICT_CHUNK_LINE_THOUGHT_OPENERS = new Set([
    '<thought>', '<thoughts>', '<antthinking>',
    '[--- VCP元思考链', '<<<[ROLE_DIVIDE_USER]>>>', '<<<[VCP_TOOL_BATCH_START:',
]);
const STRICT_LINE_END_THOUGHT_OPENERS = new Set([
    '<thought>', '<thoughts>', '<antthinking>',
]);
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
const OPENERS = [COMMENT_OPEN, ...REGIONS.map(region => region.open)];
// 超过这个长度还没闭合的注释不再等，当作普通注释跳过开头继续读
const MAX_PENDING_COMMENT = 240;

const TOOL_REQUEST_WALL_LINE_RE = /^[ \t]*(<<<\[ROLE_DIVIDE_USER\]>>>|\[\[VCP调用结果信息汇总:|<<<\[VCP_TOOL_BATCH_START:)/gm;
const ESCAPE_OPEN_RE = /(?:「始ESCAPE」|\{始ESCAPE\})/i;

function hasBalancedSummaryBlocksInEmotionTool(text) {
    let pos = 0;
    let depth = 0;
    while (pos < text.length) {
        const nextOpen = text.indexOf('[[VCP调用结果信息汇总:', pos);
        const nextClose = text.indexOf('VCP调用结果结束]]', pos);
        if (nextOpen === -1 && nextClose === -1) break;
        if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
            depth += 1;
            pos = nextOpen + '[[VCP调用结果信息汇总:'.length;
        } else {
            if (depth <= 0) return false;
            depth -= 1;
            pos = nextClose + 'VCP调用结果结束]]'.length;
        }
    }
    return depth === 0;
}

function hasBalancedRoleAndToolMarkersInEmotionTool(text) {
    for (const role of ['USER', 'SYSTEM', 'ASSISTANT']) {
        if (!hasBalancedMarkersInEmotionTool(
            text,
            new RegExp(`<<<\\[ROLE_DIVIDE_${role}\\]>>>`, 'g'),
            new RegExp(`<<<\\[END_ROLE_DIVIDE_${role}\\]>>>`, 'g')
        )) {
            return false;
        }
    }
    return hasBalancedMarkersInEmotionTool(
        text,
        /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi,
        /<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi
    );
}

function hasBalancedToolBatchMarkersInEmotionTool(text) {
    const hasStart = text.includes('<<<[VCP_TOOL_BATCH_START:');
    const hasEnd = text.includes('<<<[VCP_TOOL_BATCH_END:');
    if (!hasStart && !hasEnd) return true;
    const startRe = /<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>/g;
    const endRe = /<<<\[VCP_TOOL_BATCH_END:([^\]\r\n]+)\]>>>/g;
    const events = [];
    let startCount = 0;
    let endCount = 0;
    let m;
    while ((m = startRe.exec(text)) !== null) {
        startCount += 1;
        events.push({ idx: m.index, type: 'start', id: m[1] });
    }
    while ((m = endRe.exec(text)) !== null) {
        endCount += 1;
        events.push({ idx: m.index, type: 'end', id: m[1] });
    }
    if (startCount !== (text.match(/<<<\[VCP_TOOL_BATCH_START:/g) || []).length) return false;
    if (endCount !== (text.match(/<<<\[VCP_TOOL_BATCH_END:/g) || []).length) return false;
    events.sort((a, b) => a.idx - b.idx);
    const stack = [];
    for (const ev of events) {
        if (ev.type === 'start') {
            stack.push(ev.id);
        } else {
            if (stack.length === 0 || stack[stack.length - 1] !== ev.id) {
                return false;
            }
            stack.pop();
        }
    }
    return stack.length === 0;
}

function isSafeClosedFenceInEmotionTool(fenceText) {
    if (fenceText.includes('[[VCP协议纠偏指导:')) {
        return false;
    }
    if (!hasBalancedToolBatchMarkersInEmotionTool(fenceText)) {
        return false;
    }
    if (!fenceText.includes('[[VCP调用结果信息汇总:') && !fenceText.includes('<<<[VCP_TOOL_BATCH_START:')) {
        return true;
    }
    return hasBalancedSummaryBlocksInEmotionTool(fenceText) && hasBalancedRoleAndToolMarkersInEmotionTool(fenceText);
}

function findClosedFencesInToolSlice(text, fromIndex, limit) {
    const ranges = [];
    if (typeof text !== 'string' || fromIndex >= limit) return ranges;
    const slice = text.slice(fromIndex, limit);
    if (!slice.includes('```') && !slice.includes('~~~')) return ranges;

    const fenceOpenRe = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)/gm;
    let searchPos = 0;
    while (searchPos < slice.length) {
        fenceOpenRe.lastIndex = searchPos;
        const m = fenceOpenRe.exec(slice);
        if (!m) break;
        if (m.index === 0 && fromIndex > 0 && text[fromIndex - 1] !== '\n') {
            const nl = slice.indexOf('\n', 0);
            if (nl === -1) break;
            searchPos = nl + 1;
            continue;
        }
        const fenceChar = m[1][0];
        const fenceLen = m[1].length;
        const info = m[2] || '';
        const openNl = slice.indexOf('\n', m.index);
        if (fenceChar === '`' && info.includes('`')) {
            searchPos = openNl === -1 ? slice.length : openNl + 1;
            continue;
        }
        let scanPos = openNl === -1 ? slice.length : openNl + 1;
        let closeEnd = -1;
        while (scanPos < slice.length) {
            const cNl = slice.indexOf('\n', scanPos);
            const cLineEnd = cNl === -1 ? slice.length : cNl;
            const cRaw = slice.slice(scanPos, cLineEnd);
            const cLine = cRaw.endsWith('\r') ? cRaw.slice(0, -1) : cRaw;
            const closeMatch = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(cLine);
            if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
                closeEnd = cLineEnd;
                break;
            }
            if (cNl === -1) break;
            scanPos = cNl + 1;
        }
        if (closeEnd !== -1) {
            const afterCloseNl = slice.indexOf('\n', closeEnd);
            const nextPos = afterCloseNl === -1 ? slice.length : afterCloseNl + 1;
            const fenceText = slice.slice(m.index, closeEnd);
            if (isSafeClosedFenceInEmotionTool(fenceText)) {
                ranges.push({
                    start: fromIndex + m.index,
                    end: fromIndex + closeEnd,
                    nextPos: fromIndex + nextPos,
                });
            }
            searchPos = nextPos;
            continue;
        }
        searchPos = openNl === -1 ? slice.length : openNl + 1;
    }
    return ranges;
}

function hasBalancedMarkersInEmotionTool(slice, openRe, closeRe) {
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

function isPureRoleExampleInEmotionTool(inner) {
    if (
        inner.includes('<<<[VCP_TOOL_BATCH_START:')
        || inner.includes('[[VCP调用结果信息汇总:')
        || inner.includes('[[VCP协议纠偏指导:')
        || /[【\[［]\s*VCP(?:\s*工具调用)?\s*协议规范\s*[】\]］]/i.test(inner)
    ) {
        return false;
    }
    for (const role of ['USER', 'SYSTEM', 'ASSISTANT']) {
        if (!hasBalancedMarkersInEmotionTool(
            inner,
            new RegExp(`<<<\\[ROLE_DIVIDE_${role}\\]>>>`, 'g'),
            new RegExp(`<<<\\[END_ROLE_DIVIDE_${role}\\]>>>`, 'g')
        )) {
            return false;
        }
    }
    return hasBalancedMarkersInEmotionTool(
        inner,
        /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi,
        /<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi
    );
}

function findLastUnclosedFenceStart(text, fromIndex, limit, startAtLineBreak = true) {
    if (typeof text !== 'string' || fromIndex >= limit) return -1;
    const slice = text.slice(fromIndex, limit);
    if (!slice.includes('```') && !slice.includes('~~~')) return -1;

    let openFence = null;
    let lineStart = 0;
    while (lineStart < slice.length) {
        const nl = slice.indexOf('\n', lineStart);
        const lineEnd = nl === -1 ? slice.length : nl;
        const rawLine = slice.slice(lineStart, lineEnd);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        const canBeLineStart = lineStart > 0 || (fromIndex === 0 ? startAtLineBreak : text[fromIndex - 1] === '\n');

        if (canBeLineStart) {
            if (openFence) {
                const closeMatch = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
                if (closeMatch && closeMatch[1][0] === openFence.ch && closeMatch[1].length >= openFence.len) {
                    openFence = null;
                }
            } else {
                const openMatch = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
                if (openMatch && (openMatch[1][0] !== '`' || !openMatch[2].includes('`'))) {
                    openFence = { start: fromIndex + lineStart, ch: openMatch[1][0], len: openMatch[1].length };
                }
            }
        }
        if (nl === -1) break;
        lineStart = nl + 1;
    }
    return openFence ? openFence.start : -1;
}

function findNextLineWallInToolRequest(buffer, pos, limit, closedFences) {
    let searchFrom = pos;
    while (searchFrom < limit) {
        TOOL_REQUEST_WALL_LINE_RE.lastIndex = searchFrom;
        const m = TOOL_REQUEST_WALL_LINE_RE.exec(buffer);
        TOOL_REQUEST_WALL_LINE_RE.lastIndex = 0;
        if (!m) return null;
        const marker = m[1];
        const markerAt = m.index + m[0].indexOf(marker);
        if (markerAt >= limit) return null;
        const fence = closedFences.find(f => markerAt >= f.start && markerAt < f.end);
        if (fence) {
            searchFrom = fence.nextPos;
            continue;
        }
        return { index: markerAt, marker };
    }
    return null;
}

function findProtocolWallInToolRequest(buffer, startCursor, closeAt, final, startAtLineBreak = true) {
    const limit = closeAt !== -1 ? closeAt : buffer.length;
    const closedFences = findClosedFencesInToolSlice(buffer, startCursor, limit);
    let pos = startCursor;
    while (pos < limit) {
        const slice = buffer.slice(pos, limit);
        const escMatch = ESCAPE_OPEN_RE.exec(slice);
        const wallMatch = findNextLineWallInToolRequest(buffer, pos, limit, closedFences);
        if (!wallMatch && !escMatch) return { wallAt: -1, pendingEscapeAt: -1 };
        const wallAt = wallMatch ? wallMatch.index : -1;
        if (wallMatch && (!escMatch || wallAt < pos + escMatch.index)) {
            if (wallMatch.marker === '<<<[ROLE_DIVIDE_USER]>>>') {
                const startTag = '<<<[ROLE_DIVIDE_USER]>>>';
                const endTag = '<<<[END_ROLE_DIVIDE_USER]>>>';
                const afterStart = wallAt + startTag.length;
                if (closeAt !== -1) {
                    const firstEnd = buffer.indexOf(endTag, afterStart);
                    const nextStart = buffer.indexOf(startTag, afterStart);
                    if (
                        firstEnd !== -1
                        && firstEnd + endTag.length <= closeAt
                        && (nextStart === -1 || firstEnd < nextStart)
                        && isPureRoleExampleInEmotionTool(buffer.slice(afterStart, firstEnd))
                    ) {
                        pos = firstEnd + endTag.length;
                        continue;
                    }
                } else if (!final) {
                    const tail = buffer.slice(wallAt, limit);
                    const hasReceiptSignal = tail.includes('[[VCP调用结果信息汇总:')
                        || tail.includes('[[VCP协议纠偏指导:')
                        || tail.includes('<<<[VCP_TOOL_BATCH_START:');
                    if (!hasReceiptSignal) {
                        const unclosedFenceAt = findLastUnclosedFenceStart(buffer, startCursor, wallAt, startAtLineBreak);
                        return { wallAt: -1, pendingEscapeAt: unclosedFenceAt !== -1 ? unclosedFenceAt : wallAt };
                    }
                }
            } else if (wallMatch.marker === '<<<[VCP_TOOL_BATCH_START:' && closeAt !== -1) {
                const headerMatch = /^<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>/.exec(buffer.slice(wallAt));
                if (headerMatch) {
                    const endToken = `<<<[VCP_TOOL_BATCH_END:${headerMatch[1]}]>>>`;
                    const batchEndAt = buffer.indexOf(endToken, wallAt + headerMatch[0].length);
                    const batchCloseEnd = batchEndAt !== -1 ? batchEndAt + endToken.length : -1;
                    if (batchCloseEnd !== -1 && batchCloseEnd <= closeAt) {
                        const batchSlice = buffer.slice(wallAt, batchCloseEnd);
                        if (
                            !batchSlice.includes('[[VCP协议纠偏指导:')
                            && hasBalancedToolBatchMarkersInEmotionTool(batchSlice)
                            && hasBalancedSummaryBlocksInEmotionTool(batchSlice)
                            && hasBalancedRoleAndToolMarkersInEmotionTool(batchSlice)
                        ) {
                            pos = batchCloseEnd;
                            continue;
                        }
                    }
                }
            } else if (wallMatch.marker === '[[VCP调用结果信息汇总:') {
                if (closeAt !== -1) {
                    let sPos = wallAt + '[[VCP调用结果信息汇总:'.length;
                    let sDepth = 1;
                    let closedEnd = -1;
                    while (sPos < closeAt && sDepth > 0) {
                        const nextOpen = buffer.indexOf('[[VCP调用结果信息汇总:', sPos);
                        const nextClose = buffer.indexOf('VCP调用结果结束]]', sPos);
                        if (nextClose === -1 || nextClose + 'VCP调用结果结束]]'.length > closeAt) break;
                        if (nextOpen !== -1 && nextOpen < nextClose) {
                            sDepth += 1;
                            sPos = nextOpen + '[[VCP调用结果信息汇总:'.length;
                        } else {
                            sDepth -= 1;
                            sPos = nextClose + 'VCP调用结果结束]]'.length;
                            if (sDepth === 0) closedEnd = sPos;
                        }
                    }
                    if (closedEnd !== -1) {
                        const docSlice = buffer.slice(wallAt, closedEnd);
                        if (
                            !docSlice.includes('[[VCP协议纠偏指导:')
                            && !docSlice.includes('<<<[VCP_TOOL_BATCH_START:')
                            && !docSlice.includes('<<<[ROLE_DIVIDE_USER]>>>')
                            && hasBalancedRoleAndToolMarkersInEmotionTool(docSlice)
                        ) {
                            pos = closedEnd;
                            continue;
                        }
                    }
                } else if (!final) {
                    const tail = buffer.slice(wallAt, limit);
                    const hasReceiptSignal = tail.includes('[[VCP协议纠偏指导:')
                        || tail.includes('<<<[VCP_TOOL_BATCH_START:')
                        || tail.includes('<<<[ROLE_DIVIDE_USER]>>>');
                    if (!hasReceiptSignal) {
                        const unclosedFenceAt = findLastUnclosedFenceStart(buffer, startCursor, wallAt, startAtLineBreak);
                        return { wallAt: -1, pendingEscapeAt: unclosedFenceAt !== -1 ? unclosedFenceAt : wallAt };
                    }
                }
            }
            return { wallAt, pendingEscapeAt: -1 };
        }
        const escOpenAt = pos + escMatch.index;
        const fenceForEsc = closedFences.find(f => escOpenAt >= f.start && escOpenAt < f.end);
        if (fenceForEsc) {
            pos = fenceForEsc.nextPos;
            continue;
        }
        const usesBrace = escMatch[0][0] === '{';
        const escCloseRe = usesBrace ? /\{末ESCAPE\}/i : /「末ESCAPE」/i;
        const afterEscOpen = escOpenAt + escMatch[0].length;
        const escCloseMatch = escCloseRe.exec(buffer.slice(afterEscOpen, limit));
        if (!escCloseMatch) {
            if (wallAt !== -1) {
                // 若尚未闭合，仅在流尾 final 或闭合法外层回执之后出现跨跳二次始ESCAPE时按硬墙退出，
                // 避免流式单跳 ESCAPE 内含 ROLE_DIVIDE_USER + 汇总块示例时提前破墙泄漏情绪与「末ESCAPE」
                const tail = buffer.slice(wallAt, limit);
                const secondEscRe = usesBrace ? /\{始ESCAPE\}/i : /「始ESCAPE」/i;
                const roleMatch = /<<<\[ROLE_DIVIDE_USER\]>>>([\s\S]*?)<<<\[END_ROLE_DIVIDE_USER\]>>>/.exec(tail);
                const hasRoleReceipt = Boolean(
                    roleMatch && (
                        roleMatch[1].includes('[[VCP调用结果信息汇总:')
                        || roleMatch[1].includes('[[VCP协议纠偏指导:')
                        || roleMatch[1].includes('<<<[VCP_TOOL_BATCH_START:')
                    )
                );
                let afterClosedReceipt = null;
                if (hasRoleReceipt) {
                    afterClosedReceipt = tail.slice(roleMatch.index + roleMatch[0].length);
                } else {
                    const infoMatch = /\[\[VCP调用结果信息汇总:[\s\S]*?VCP调用结果结束\]\]/.exec(tail);
                    if (infoMatch) {
                        afterClosedReceipt = tail.slice(infoMatch.index + infoMatch[0].length);
                    } else {
                        const batchMatch = /<<<\[VCP_TOOL_BATCH_START:[^\]\r\n]+\]>>>[\s\S]*?<<<\[VCP_TOOL_BATCH_END:[^\]\r\n]+\]>>>/.exec(tail);
                        if (batchMatch) {
                            afterClosedReceipt = tail.slice(batchMatch.index + batchMatch[0].length);
                        }
                    }
                }
                const hasCrossJumpEscape = Boolean(afterClosedReceipt && secondEscRe.test(afterClosedReceipt));
                if (final || hasCrossJumpEscape) {
                    return { wallAt, pendingEscapeAt: -1 };
                }
            }
            return { wallAt: -1, pendingEscapeAt: escOpenAt };
        }
        const escCloseStart = afterEscOpen + escCloseMatch.index;
        const escCloseEnd = escCloseStart + escCloseMatch[0].length;
        if (wallAt !== -1 && wallAt < escCloseStart) {
            const inner = buffer.slice(afterEscOpen, escCloseStart);
            const secondEsc = /(?:「始ESCAPE」|\{始ESCAPE\})/i.test(inner.slice(wallAt - afterEscOpen));
            if (secondEsc) {
                return { wallAt, pendingEscapeAt: -1 };
            }
        }
        pos = escCloseEnd;
    }
    return { wallAt: -1, pendingEscapeAt: -1 };
}

// 文本末尾可能是某个开标记的前半截时，留着等下一块再判断
function heldTailLength(text, markers) {
    let held = 0;
    for (const marker of markers) {
        for (let length = Math.min(marker.length - 1, text.length); length > held; length -= 1) {
            if (text.endsWith(marker.slice(0, length))) { held = length; break; }
        }
    }
    return held;
}

/**
 * 增量读取一条流式回复。push(delta) 返回这一块里新确定的事件：
 *   { type: 'text', text }                    正文里可见的文字（已去掉标签和各区域）
 *   { type: 'tag', emotion, variant, intensity }
 *   { type: 'enter', region } / { type: 'exit', region }   region 为 code | thought | tool
 * finish() 把留着的尾巴当正文吐出来。
 */
const RECEIPT_WALL_OPENERS = new Set([
    '<<<[ROLE_DIVIDE_USER]>>>',
    '[[VCP调用结果信息汇总:',
    '<<<[VCP_TOOL_BATCH_START:',
]);

function findNextRawClosedFence(text, fromIndex) {
    if (typeof text !== 'string' || (!text.includes('```') && !text.includes('~~~'))) return null;
    const fenceOpenRe = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)/gm;
    let searchPos = fromIndex;
    while (searchPos < text.length) {
        fenceOpenRe.lastIndex = searchPos;
        const m = fenceOpenRe.exec(text);
        if (!m) return null;
        if (m.index === 0 && fromIndex > 0 && text[fromIndex - 1] !== '\n') {
            const nl = text.indexOf('\n', 0);
            if (nl === -1) return null;
            searchPos = nl + 1;
            continue;
        }
        const fenceChar = m[1][0];
        const fenceLen = m[1].length;
        const info = m[2] || '';
        const openNl = text.indexOf('\n', m.index);
        if (fenceChar === '`' && info.includes('`')) {
            searchPos = openNl === -1 ? text.length : openNl + 1;
            continue;
        }
        let scanPos = openNl === -1 ? text.length : openNl + 1;
        let closeEnd = -1;
        while (scanPos < text.length) {
            const cNl = text.indexOf('\n', scanPos);
            const cLineEnd = cNl === -1 ? text.length : cNl;
            const cRaw = text.slice(scanPos, cLineEnd);
            const cLine = cRaw.endsWith('\r') ? cRaw.slice(0, -1) : cRaw;
            const closeMatch = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(cLine);
            if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
                closeEnd = cLineEnd;
                break;
            }
            if (cNl === -1) break;
            scanPos = cNl + 1;
        }
        if (closeEnd !== -1) {
            const afterCloseNl = text.indexOf('\n', closeEnd);
            return {
                start: m.index,
                end: closeEnd,
                nextPos: afterCloseNl === -1 ? text.length : afterCloseNl + 1,
            };
        }
        searchPos = openNl === -1 ? text.length : openNl + 1;
    }
    return null;
}

function findRoleDivideEndInBuffer(buffer, startCursor, final) {
    let pos = startCursor;
    while (pos < buffer.length) {
        const endAt = buffer.indexOf('<<<[END_ROLE_DIVIDE_USER]>>>', pos);
        const infoAt = buffer.indexOf('[[VCP调用结果信息汇总:', pos);
        const batchAt = buffer.indexOf('<<<[VCP_TOOL_BATCH_START:', pos);
        const fenceM = findNextRawClosedFence(buffer, pos);

        let earliestKind = null;
        let earliestIdx = -1;
        for (const [kind, idx] of [
            ['end', endAt],
            ['info', infoAt],
            ['batch', batchAt],
            ['fence', fenceM ? fenceM.start : -1],
        ]) {
            if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
                earliestIdx = idx;
                earliestKind = kind;
            }
        }
        if (earliestKind === null) {
            const unclosedFenceAt = findLastUnclosedFenceStart(buffer, pos, buffer.length, pos === 0);
            return { closeAt: -1, holdAt: (!final && unclosedFenceAt !== -1) ? unclosedFenceAt : -1 };
        }
        if (earliestKind === 'end') {
            return { closeAt: endAt, holdAt: -1 };
        }
        if (earliestKind === 'fence') {
            if (isSafeClosedFenceInEmotionTool(buffer.slice(fenceM.start, fenceM.end))) {
                pos = fenceM.nextPos;
            } else {
                pos = fenceM.start + 3;
            }
            continue;
        }
        if (earliestKind === 'info') {
            let sPos = infoAt + '[[VCP调用结果信息汇总:'.length;
            let depth = 1;
            let infoEnd = -1;
            while (sPos < buffer.length && depth > 0) {
                const nextOpen = buffer.indexOf('[[VCP调用结果信息汇总:', sPos);
                const nextClose = buffer.indexOf('VCP调用结果结束]]', sPos);
                if (nextClose === -1) break;
                if (nextOpen !== -1 && nextOpen < nextClose) {
                    depth += 1;
                    sPos = nextOpen + '[[VCP调用结果信息汇总:'.length;
                } else {
                    depth -= 1;
                    sPos = nextClose + 'VCP调用结果结束]]'.length;
                    if (depth === 0) infoEnd = sPos;
                }
            }
            if (infoEnd !== -1) {
                pos = infoEnd;
                continue;
            }
            if (!final) {
                return { closeAt: -1, holdAt: infoAt };
            }
            if (endAt !== -1) return { closeAt: endAt, holdAt: -1 };
            return { closeAt: -1, holdAt: -1 };
        }
        const headerMatch = /^<<<\[VCP_TOOL_BATCH_START:([^\]\r\n]+)\]>>>/.exec(buffer.slice(batchAt));
        if (!headerMatch) {
            if (!final && !/[\r\n]/.test(buffer.slice(batchAt))) {
                return { closeAt: -1, holdAt: batchAt };
            }
            if (endAt !== -1) return { closeAt: endAt, holdAt: -1 };
            return { closeAt: -1, holdAt: -1 };
        }
        const endToken = `<<<[VCP_TOOL_BATCH_END:${headerMatch[1]}]>>>`;
        const bEnd = buffer.indexOf(endToken, batchAt + headerMatch[0].length);
        if (bEnd !== -1) {
            pos = bEnd + endToken.length;
            continue;
        }
        if (!final) {
            return { closeAt: -1, holdAt: batchAt };
        }
        if (endAt !== -1) return { closeAt: endAt, holdAt: -1 };
        return { closeAt: -1, holdAt: -1 };
    }
    return { closeAt: -1, holdAt: -1 };
}

export function createEmotionTagScanner() {
    let buffer = '';
    let region = null;
    let lineHasNonSpace = false;
    let brokenToolFence = null;

    const advanceLineState = (segment) => {
        if (!segment) return;
        const lastNl = segment.lastIndexOf('\n');
        if (lastNl !== -1) {
            lineHasNonSpace = /[^\s\r\n]/.test(segment.slice(lastNl + 1));
        } else if (/[^\s\r\n]/.test(segment)) {
            lineHasNonSpace = true;
        }
    };

    function scan(final) {
        const events = [];
        let cursor = 0;
        while (cursor < buffer.length) {
            if (region) {
                if (region.open === '<<<[VCP_TOOL_BATCH_START:' && region.batchId === null) {
                    const tailSlice = buffer.slice(cursor);
                    const headerMatch = /^([^\]\r\n]+)\]>>>/.exec(tailSlice);
                    if (!headerMatch) {
                        const hasLineBreak = /[\r\n]/.test(tailSlice);
                        const badBracket = tailSlice.includes(']') && !/^[^\]\r\n]*\](?:>{0,2})$/.test(tailSlice);
                        if (final || hasLineBreak || badBracket) {
                            advanceLineState(tailSlice);
                            cursor = buffer.length;
                        }
                        break;
                    }
                    region.batchId = headerMatch[1];
                    region.close = `<<<[VCP_TOOL_BATCH_END:${region.batchId}]>>>`;
                    advanceLineState(headerMatch[0]);
                    cursor += headerMatch[0].length;
                    continue;
                }
                let closeAt = buffer.indexOf(region.close, cursor);
                if (region.open === '<<<[ROLE_DIVIDE_USER]>>>') {
                    const roleScan = findRoleDivideEndInBuffer(buffer, cursor, final);
                    closeAt = roleScan.closeAt;
                    if (closeAt === -1) {
                        let nextCursor = final ? buffer.length : Math.max(cursor, buffer.length - (region.close.length - 1));
                        if (!final && roleScan.holdAt !== -1 && roleScan.holdAt < nextCursor) {
                            nextCursor = roleScan.holdAt;
                        }
                        advanceLineState(buffer.slice(cursor, nextCursor));
                        cursor = nextCursor;
                        break;
                    }
                } else if (region.open === '<<<[TOOL_REQUEST]>>>') {
                    const { wallAt, pendingEscapeAt } = findProtocolWallInToolRequest(
                        buffer,
                        cursor,
                        closeAt,
                        final,
                        !lineHasNonSpace
                    );
                    if (wallAt !== -1) {
                        const unclosedFenceAt = findLastUnclosedFenceStart(buffer, cursor, wallAt, !lineHasNonSpace);
                        if (unclosedFenceAt !== -1) {
                            const fenceOpenMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(buffer.slice(unclosedFenceAt, wallAt));
                            brokenToolFence = fenceOpenMatch
                                ? { ch: fenceOpenMatch[1][0], len: fenceOpenMatch[1].length }
                                : null;
                        } else {
                            brokenToolFence = null;
                        }
                        events.push({ type: 'exit', region: region.kind });
                        region = null;
                        advanceLineState(buffer.slice(cursor, wallAt));
                        cursor = wallAt;
                        continue;
                    }
                    if (closeAt === -1) {
                        if (final) {
                            advanceLineState(buffer.slice(cursor));
                            cursor = buffer.length;
                        } else if (pendingEscapeAt !== -1) {
                            advanceLineState(buffer.slice(cursor, Math.max(cursor, pendingEscapeAt)));
                            cursor = Math.max(cursor, pendingEscapeAt);
                        } else {
                            const hold = Math.max(region.close.length, 32) - 1;
                            let nextCursor = Math.max(cursor, buffer.length - hold);
                            const unclosedFenceAt = findLastUnclosedFenceStart(buffer, cursor, buffer.length, !lineHasNonSpace);
                            if (unclosedFenceAt !== -1 && unclosedFenceAt < nextCursor) {
                                nextCursor = unclosedFenceAt;
                            } else {
                                const closedInBuf = findClosedFencesInToolSlice(buffer, cursor, buffer.length);
                                for (const f of closedInBuf) {
                                    if (nextCursor > f.start && nextCursor < f.nextPos) {
                                        nextCursor = f.nextPos > f.end ? f.nextPos : f.start;
                                        break;
                                    }
                                }
                            }
                            advanceLineState(buffer.slice(cursor, nextCursor));
                            cursor = nextCursor;
                        }
                        break;
                    }
                } else if (closeAt === -1) {
                    const nextCursor = final ? buffer.length : Math.max(cursor, buffer.length - (region.close.length - 1));
                    advanceLineState(buffer.slice(cursor, nextCursor));
                    cursor = nextCursor;
                    break;
                }
                advanceLineState(buffer.slice(cursor, closeAt + region.close.length));
                cursor = closeAt + region.close.length;
                events.push({ type: 'exit', region: region.kind });
                region = null;
                continue;
            }
            let nextAt = -1;
            let opener = null;
            for (const candidate of OPENERS) {
                let searchFrom = cursor;
                while (searchFrom < buffer.length) {
                    const at = buffer.indexOf(candidate, searchFrom);
                    if (at === -1) break;
                    // 反引号紧邻包裹的字面量（如 `<think>`）不开启区域
                    if (buffer[at - 1] === '`' || buffer[at + candidate.length] === '`') {
                        searchFrom = at + candidate.length;
                        continue;
                    }
                    // 思维链标签要求位于行首（左侧仅空白），避免正文句中提及 `<think>` 时吞没整条回复
                    if (THOUGHT_LINE_OPENERS.has(candidate)) {
                        const nlBefore = at === 0 ? -1 : buffer.lastIndexOf('\n', at - 1);
                        const lineStart = nlBefore + 1;
                        const prefixOnLine = buffer.slice(lineStart, at);
                        const blockedByPriorChunk = STRICT_CHUNK_LINE_THOUGHT_OPENERS.has(candidate)
                            && nlBefore === -1
                            && (lineHasNonSpace || !/^[ \t]*$/.test(buffer.slice(cursor, at)));
                        if (blockedByPriorChunk || !/^[ \t]*$/.test(prefixOnLine)) {
                            searchFrom = at + candidate.length;
                            continue;
                        }
                        if (STRICT_LINE_END_THOUGHT_OPENERS.has(candidate)) {
                            const afterOpen = buffer.slice(at + candidate.length);
                            const nlAfter = afterOpen.indexOf('\n');
                            const lineRest = (nlAfter === -1 ? afterOpen : afterOpen.slice(0, nlAfter)).replace(/\r$/, '');
                            if (!/^[ \t]*$/.test(lineRest)) {
                                searchFrom = at + candidate.length;
                                continue;
                            }
                        } else if (candidate === '[--- VCP元思考链') {
                            const afterOpen = buffer.slice(at + candidate.length);
                            const nlAfter = afterOpen.indexOf('\n');
                            const lineRest = (nlAfter === -1 ? afterOpen : afterOpen.slice(0, nlAfter)).replace(/\r$/, '');
                            const headerEndIdx = lineRest.indexOf('---]');
                            if (headerEndIdx === -1) {
                                if (nlAfter !== -1 || final || lineRest.length >= 160) {
                                    searchFrom = at + candidate.length;
                                    continue;
                                }
                            } else {
                                const afterHeader = lineRest.slice(headerEndIdx + 4);
                                const isInlineClosed = afterHeader.includes('[--- 元思考链结束 ---]');
                                if (!isInlineClosed && !/^[ \t]*$/.test(afterHeader) && (nlAfter !== -1 || final)) {
                                    searchFrom = at + candidate.length;
                                    continue;
                                }
                            }
                        }
                    }
                    if (nextAt === -1 || at < nextAt) { nextAt = at; opener = candidate; }
                    break;
                }
            }
            if (nextAt === -1) {
                const keep = final ? 0 : heldTailLength(buffer.slice(cursor), OPENERS);
                const end = buffer.length - keep;
                if (end > cursor) {
                    const chunk = buffer.slice(cursor, end);
                    if (brokenToolFence && /[^\s\r\n]/.test(chunk)) {
                        brokenToolFence = null;
                    }
                    events.push({ type: 'text', text: chunk });
                    advanceLineState(chunk);
                }
                cursor = end;
                break;
            }
            if (nextAt > cursor) {
                const chunk = buffer.slice(cursor, nextAt);
                if (brokenToolFence && /[^\s\r\n]/.test(chunk)) {
                    brokenToolFence = null;
                }
                events.push({ type: 'text', text: chunk });
                advanceLineState(chunk);
            }
            cursor = nextAt;
            if (!final && STRICT_LINE_END_THOUGHT_OPENERS.has(opener)) {
                const afterOpen = buffer.slice(cursor + opener.length);
                if (afterOpen.indexOf('\n') === -1 && /^[ \t]*\r?$/.test(afterOpen)) {
                    break;
                }
            } else if (!final && opener === '[--- VCP元思考链') {
                const afterOpen = buffer.slice(cursor + opener.length);
                if (afterOpen.indexOf('\n') === -1) {
                    const headerEndIdx = afterOpen.indexOf('---]');
                    if (headerEndIdx === -1) {
                        if (afterOpen.length < 160) break;
                    } else {
                        const afterHeader = afterOpen.slice(headerEndIdx + 4);
                        if (!afterHeader.includes('[--- 元思考链结束 ---]')) {
                            break;
                        }
                    }
                }
            }
            if (opener === COMMENT_OPEN) {
                const found = matchEmotionTag(buffer, cursor, final);
                if (found === PENDING) break;
                if (found) {
                    brokenToolFence = null;
                    if (found.tag) events.push({ type: 'tag', ...found.tag });
                    advanceLineState(buffer.slice(cursor, found.end));
                    cursor = found.end;
                    continue;
                }
                const closeAt = buffer.indexOf(COMMENT_CLOSE, cursor + COMMENT_OPEN.length);
                if (closeAt === -1) {
                    if (!final && buffer.length - cursor < MAX_PENDING_COMMENT) break;
                    brokenToolFence = null;
                    advanceLineState(COMMENT_OPEN);
                    cursor += COMMENT_OPEN.length;
                    continue;
                }
                brokenToolFence = null;
                const tag = parseEmotionTagBody(buffer.slice(cursor + COMMENT_OPEN.length, closeAt));
                if (tag) events.push({ type: 'tag', ...tag });
                advanceLineState(buffer.slice(cursor, closeAt + COMMENT_CLOSE.length));
                cursor = closeAt + COMMENT_CLOSE.length;
                continue;
            }
            if (brokenToolFence && (opener === '```' || opener === '~~~') && opener[0] === brokenToolFence.ch) {
                const nlBefore = cursor === 0 ? -1 : buffer.lastIndexOf('\n', cursor - 1);
                const lineStart = nlBefore + 1;
                const prefixOnLine = buffer.slice(lineStart, cursor);
                const blockedByPriorChunk = nlBefore === -1 && lineHasNonSpace;
                if (!blockedByPriorChunk && /^[ \t]{0,3}$/.test(prefixOnLine)) {
                    const nlAfter = buffer.indexOf('\n', cursor);
                    if (nlAfter === -1 && !final && /^(`{3,}|~{3,})[ \t]*\r?$/.test(buffer.slice(cursor))) {
                        break;
                    }
                    const lineRest = buffer.slice(cursor, nlAfter === -1 ? buffer.length : nlAfter).replace(/\r$/, '');
                    const closeFenceMatch = /^(`{3,}|~{3,})[ \t]*$/.exec(lineRest);
                    if (
                        closeFenceMatch
                        && closeFenceMatch[1][0] === brokenToolFence.ch
                        && closeFenceMatch[1].length >= brokenToolFence.len
                    ) {
                        advanceLineState(closeFenceMatch[0]);
                        cursor += closeFenceMatch[0].length;
                        brokenToolFence = null;
                        continue;
                    }
                }
                brokenToolFence = null;
            }
            if (brokenToolFence && !RECEIPT_WALL_OPENERS.has(opener)) {
                brokenToolFence = null;
            }
            const matchedRegion = REGIONS.find(candidate => candidate.open === opener);
            region = matchedRegion.open === '<<<[VCP_TOOL_BATCH_START:'
                ? { ...matchedRegion, batchId: null }
                : matchedRegion;
            advanceLineState(opener);
            cursor += opener.length;
            events.push({ type: 'enter', region: region.kind });
        }
        buffer = buffer.slice(cursor);
        return events;
    }

    return Object.freeze({
        push(delta) {
            if (typeof delta !== 'string' || !delta) return [];
            buffer += delta;
            return scan(false);
        },
        finish() {
            const events = scan(true);
            if (region) {
                events.push({ type: 'exit', region: region.kind });
                region = null;
            }
            brokenToolFence = null;
            buffer = '';
            return events;
        },
        get region() { return region?.kind || null; },
    });
}
