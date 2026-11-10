import { collectToolDataRanges, collectCodeDomainsOutsideToolResults } from './toolResultRegions.js';
import { findUnclosedToolRequest, replaceToolRequestBlocks } from './toolRequestScanner.js';

/**
 * 返回最后一个安全回执的结束偏移；0 表示仍需等待。
 * 原子批次必须整体闭合，内部旧结果闭合不构成提前切断的许可。
 * 请求结束符和角色分隔符都不是工具已执行的证明。
 */
export function findToolReturnBoundary(text) {
    if (typeof text !== 'string') return 0;
    const ranges = collectToolDataRanges(text);
    if (!ranges.length) return 0;
    if (findUnclosedToolRequest(text)) return 0;
    const requests = [];
    replaceToolRequestBlocks(text, (match, _content, start, end) => {
        requests.push({ start, end });
        return match;
    });
    const code = collectCodeDomainsOutsideToolResults(text, ranges);
    const receipts = ranges.filter(range => ![...code, ...requests].some(domain =>
        range.start >= domain.start && range.start < domain.end));
    const last = receipts.at(-1);
    if (!last?.closed) return 0;
    const tail = text.slice(last.end);
    if (requests.some(request => request.start >= last.end)) return 0;
    // 起始标记也可能跨网络分片；不可在新调用的半截协议头上中止。
    for (const marker of ['<<<[TOOL_REQUEST]>>>', '<<<[VCP_TOOL_BATCH_START:', '[[VCP调用结果信息汇总:']) {
        for (let size = 1; size < marker.length; size += 1) {
            if (tail.endsWith(marker.slice(0, size))) return 0;
        }
    }
    return last.end;
}