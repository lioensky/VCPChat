// modules/renderer/toolResultRegions.js
import { collectMarkdownCodeDomains } from './markdownCodeDomainScanner.js';

/**
 * VCPToolResult 是后端一次性注入的权威数据域，优先级高于 AI 生成的任何语法。
 * 其内部出现的 DESKTOP_PUSH、TOOL_REQUEST、<think>、代码围栏、HTML 注释、persona 回填等
 * 都只是工具数据，不得开启、闭合或截断任何外层协议块。
 *
 * 本模块不依赖其他协议扫描器，toolRequestScanner 从这里取得标记常量，避免循环导入。
 */
export const TOOL_RESULT_START_MARKER = '[[VCP调用结果信息汇总:';
export const TOOL_RESULT_END_MARKER = 'VCP调用结果结束]]';

/**
 * 嵌套感知地查找工具结果的结束位置。
 *
 * 工具结果内部可能包含字面量起止标记（例如 AI 读取渲染器源码，源码里就写着这两个常量）。
 * 采用简单的深度计数：起始标记 +1，结束标记 -1，深度回到 0 时外层工具结果才闭合。
 * 这样成对出现的内层标记会被整体吞进外层，不会在第一个内层结束标记处截断外层。
 *
 * @param {string} text
 * @param {number} startIndex 外层起始标记所在偏移
 * @returns {number} 外层结束标记之后的偏移；未闭合返回 -1
 */
export function findToolResultEnd(text, startIndex) {
    let depth = 1;
    let cursor = startIndex + TOOL_RESULT_START_MARKER.length;
    // 缓存下一个起始标记位置，避免每次迭代都从 cursor 重新扫描到文末。
    let nextStart = text.indexOf(TOOL_RESULT_START_MARKER, cursor);

    while (cursor <= text.length) {
        const nextEnd = text.indexOf(TOOL_RESULT_END_MARKER, cursor);
        if (nextEnd === -1) return -1;

        if (nextStart !== -1 && nextStart < nextEnd) {
            depth += 1;
            cursor = nextStart + TOOL_RESULT_START_MARKER.length;
            nextStart = text.indexOf(TOOL_RESULT_START_MARKER, cursor);
            continue;
        }

        depth -= 1;
        cursor = nextEnd + TOOL_RESULT_END_MARKER.length;
        if (depth === 0) return cursor;
        if (nextStart !== -1 && nextStart < cursor) {
            nextStart = text.indexOf(TOOL_RESULT_START_MARKER, cursor);
        }
    }

    return -1;
}

/**
 * 收集最外层工具结果区间（嵌套感知，见 findToolResultEnd）。
 * 未闭合区间延伸到文末（closed: false），在流式中间态拥有当前尾部。
 * 深度为 0 时出现的孤立结束标记不具备协议含义，直接忽略。
 *
 * @param {string} text
 * @returns {Array<{start: number, end: number, closed: boolean}>} 按源码顺序排列、互不重叠
 */
export function collectToolResultRanges(text) {
    const ranges = [];
    if (typeof text !== 'string' || !text.includes(TOOL_RESULT_START_MARKER)) return ranges;

    let cursor = 0;
    while (cursor < text.length) {
        const start = text.indexOf(TOOL_RESULT_START_MARKER, cursor);
        if (start === -1) break;

        const end = findToolResultEnd(text, start);
        if (end === -1) {
            ranges.push({ start, end: text.length, closed: false });
            break;
        }

        ranges.push({ start, end, closed: true });
        cursor = end;
    }

    return ranges;
}

/** 返回包含 index 的工具结果区间；不在任何区间内时返回 null。 */
export function findToolResultRangeAt(index, ranges) {
    if (!ranges) return null;
    for (const range of ranges) {
        if (index < range.start) return null;
        if (index < range.end) return range;
    }
    return null;
}

/**
 * 与 String#indexOf 相同，但跳过落在工具结果区间内的命中。
 * 用于外层协议块寻找结束标记：工具数据里的同名结束标记不能提前闭合外层块。
 */
export function indexOfOutsideToolResults(text, token, fromIndex, ranges) {
    let cursor = Math.max(0, fromIndex);
    while (cursor <= text.length) {
        const index = text.indexOf(token, cursor);
        if (index === -1) return -1;
        const range = findToolResultRangeAt(index, ranges);
        if (!range) return index;
        cursor = range.end;
    }
    return -1;
}

/**
 * 只对工具结果区间之外的片段应用 transform，工具结果原样保留。
 * 片段以工具结果为硬边界，transform 内“剥离到文末”之类的行为不会越过工具结果。
 */
export function transformOutsideToolResults(text, transform, ranges = collectToolResultRanges(text)) {
    if (typeof text !== 'string' || ranges.length === 0) return transform(text);

    let result = '';
    let cursor = 0;
    for (const range of ranges) {
        if (range.start > cursor) result += transform(text.slice(cursor, range.start));
        result += text.slice(range.start, range.end);
        cursor = range.end;
    }
    if (cursor < text.length) result += transform(text.slice(cursor));
    return result;
}

/**
 * 以等长空白遮蔽工具结果区间，保持原始偏移与换行结构不变。
 * 语义等价于完整渲染中“工具结果先替换为不透明占位符”的顺序：
 * 工具数据内的反引号/围栏不再参与任何 Markdown 代码域配对。
 * 保留换行，确保区间之后内容的行首判定（围栏开启等）不受影响。
 */
export function maskToolResults(text, ranges) {
    if (typeof text !== 'string' || !ranges || ranges.length === 0) return text;

    let result = '';
    let cursor = 0;
    for (const range of ranges) {
        result += text.slice(cursor, range.start) + text.slice(range.start, range.end).replace(/[^\n]/g, ' ');
        cursor = range.end;
    }
    return result + text.slice(cursor);
}

/** 只返回已闭合的最外层工具结果区间；完整渲染、删除定位、TTS 剥离共用这一配对规则。 */
export function collectClosedToolResultRanges(text) {
    return collectToolResultRanges(text).filter(range => range.closed);
}

/** 收集工具结果区间之外的 Markdown 代码域；返回的偏移基于原始 text。 */
export function collectCodeDomainsOutsideToolResults(text, ranges, options = {}) {
    return collectMarkdownCodeDomains(maskToolResults(text, ranges), options);
}