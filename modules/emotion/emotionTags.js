/* Inline emotion tags in assistant replies: <!--emo:happy 0.8-->.
 * stripEmotionTags() removes them from anything a person sees or hears; createEmotionTagScanner()
 * reads a streamed reply chunk by chunk and reports tags, visible text and the regions (code,
 * thoughts, tool calls) where tags do not count. No DOM or Electron dependency. */
import { normalizeEmotion, clampIntensity } from './emotionVocabulary.js';

// <!--emo:happy-->、<!--emo:happy 0.8-->、<!--emo:happy/bright_smile 0.8-->、<!-- emo: 开心 -->
const TAG_BODY = /^\s*emo\s*[:：]\s*([^\s/>]+?)(?:\/([A-Za-z0-9_-]+))?(?:\s+([01](?:\.\d+)?|\.\d+))?\s*$/i;
const TAG_OPEN = /<!--\s*emo\s*[:：]/iy;
const TAG_OPEN_ANYWHERE = /<!--\s*emo\s*[:：]/gi;
// 标签的结尾：同一行、80 个字符以内的第一个 >。模型偶尔把 --> 写成 >、->、--!>，也当结尾，
// 不然浏览器会把它当成没闭合的注释，把后面整段回复都藏掉；也不会一路找到很远处正文里的 "A --> B"
const TAG_MAX_BODY = 80;
const TAG_REST_CLOSED = /([^<>\r\n]{0,80}?)(?:--!?|-)?>/y;
// 没写结尾的标签：只认到情绪词、子表情和强度为止，后面的正文留着
const TAG_REST_BARE = /\s*([^\s/<>!-]{1,24})(?:\/([A-Za-z0-9_-]+))?(?:\s+(?:[01](?:\.\d+)?|\.\d+))?/y;
// 流式尾巴上还没写完的标签：<!-、<!--、<!--em、<!--emo:hap…（同一行、最多 64 个字符，避免吞掉普通长注释）
const PARTIAL_TAIL = /<!(?:-(?:-(?:\s*e(?:m(?:o(?:\s*[:：][^>\r\n]{0,64})?)?)?)?)?)?$/i;
// 代码围栏（``` 或 ~~~）和行内代码里的标签是在讲这个格式，不是在用它
const PROTECTED = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|`[^`\r\n]+`/g;
const PENDING = Object.freeze({ pending: true });

/** 解析一个注释体（<!-- 和 --> 之间的部分）；不是情绪标签或情绪认不出时返回 null */
export function parseEmotionTagBody(body) {
    const match = TAG_BODY.exec(String(body ?? ''));
    if (!match) return null;
    const emotion = normalizeEmotion(match[1]);
    if (!emotion) return null;
    return { emotion, variant: match[2] ? match[2].toLowerCase() : null, intensity: clampIntensity(match[3], 0.7) };
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
    { kind: 'tool', open: '<<<[TOOL_REQUEST]>>>', close: '<<<[END_TOOL_REQUEST]>>>' },
    { kind: 'tool', open: '[[VCP调用结果信息汇总:', close: 'VCP调用结果结束]]' },
]);
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
const OPENERS = [COMMENT_OPEN, ...REGIONS.map(region => region.open)];
// 超过这个长度还没闭合的注释不再等，当作普通注释跳过开头继续读
const MAX_PENDING_COMMENT = 240;

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
export function createEmotionTagScanner() {
    let buffer = '';
    let region = null;

    function scan(final) {
        const events = [];
        let cursor = 0;
        while (cursor < buffer.length) {
            if (region) {
                const closeAt = buffer.indexOf(region.close, cursor);
                if (closeAt === -1) {
                    cursor = final ? buffer.length : Math.max(cursor, buffer.length - (region.close.length - 1));
                    break;
                }
                cursor = closeAt + region.close.length;
                events.push({ type: 'exit', region: region.kind });
                region = null;
                continue;
            }
            let nextAt = -1;
            let opener = null;
            for (const candidate of OPENERS) {
                const at = buffer.indexOf(candidate, cursor);
                if (at !== -1 && (nextAt === -1 || at < nextAt)) { nextAt = at; opener = candidate; }
            }
            if (nextAt === -1) {
                const keep = final ? 0 : heldTailLength(buffer.slice(cursor), OPENERS);
                const end = buffer.length - keep;
                if (end > cursor) events.push({ type: 'text', text: buffer.slice(cursor, end) });
                cursor = end;
                break;
            }
            if (nextAt > cursor) events.push({ type: 'text', text: buffer.slice(cursor, nextAt) });
            cursor = nextAt;
            if (opener === COMMENT_OPEN) {
                const found = matchEmotionTag(buffer, cursor, final);
                if (found === PENDING) break;
                if (found) {
                    if (found.tag) events.push({ type: 'tag', ...found.tag });
                    cursor = found.end;
                    continue;
                }
                const closeAt = buffer.indexOf(COMMENT_CLOSE, cursor + COMMENT_OPEN.length);
                if (closeAt === -1) {
                    if (!final && buffer.length - cursor < MAX_PENDING_COMMENT) break;
                    cursor += COMMENT_OPEN.length;
                    continue;
                }
                const tag = parseEmotionTagBody(buffer.slice(cursor + COMMENT_OPEN.length, closeAt));
                if (tag) events.push({ type: 'tag', ...tag });
                cursor = closeAt + COMMENT_CLOSE.length;
                continue;
            }
            region = REGIONS.find(candidate => candidate.open === opener);
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
            buffer = '';
            return events;
        },
        get region() { return region?.kind || null; },
    });
}
