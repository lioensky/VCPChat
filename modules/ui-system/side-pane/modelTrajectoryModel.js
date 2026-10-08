/**
 * modules/ui-system/side-pane/modelTrajectoryModel.js
 * 「调用轨迹」侧栏标签的纯数据层：把记录器给的调用记录整理成界面要画的时间线，不碰 DOM。
 *
 * 取舍与算法照 ZCode 的 ModelTrajectory*
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/ModelTrajectoryTimeline.tsx / ModelTrajectorySearch.ts /
 * ModelTrajectoryToolPayload.ts / ModelTrajectoryFormat.ts）：
 * - 主会话的调用只展示相对上一次调用新增的输入消息（首条展示完整上下文，后续把 assistant 消息交给上一条的输出展示）；
 *   标题生成等辅助请求有独立 prompt，永远完整展示。
 * - 搜索按「折叠空白 + 不区分大小写」匹配，并能命中工具名 / 工具 ID，命中位置映射回原文偏移。
 * VCPChat 与原实现不同的地方：工具调用不是 OpenAI tool_calls，而是写在助手回答原文里的 TOOL_REQUEST 块，
 * 工具结果则是下一轮 user 消息里的「VCP调用结果」块，所以这里先把它们从文本里还原成 tool-call / tool-result 分段，再套用原实现的展示模型。
 */

'use strict';

import { replaceToolRequestBlocks } from '../../renderer/toolRequestScanner.js';
import { collectToolResultRanges, TOOL_RESULT_START_MARKER, TOOL_RESULT_END_MARKER } from '../../renderer/toolResultRegions.js';
import { parseToolFields } from '../message-file-changes.js';

// ------------------------------------------------------------------ 格式化

export function formatClockTime(value) {
    const time = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(time)) return '';
    return new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatDateTime(value) {
    const time = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '';
}

export function formatDuration(durationMs) {
    if (!Number.isFinite(durationMs)) return '—';
    if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
    return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 2 : 1)}s`;
}

const FINISH_LABELS = { stop: '正常结束', 'tool-call': '工具调用', 'tool-calls': '工具调用', length: '达到长度限制', 'content-filter': '内容过滤', error: '服务端报错' };
/**
 * 一次调用的结束原因。VCP 服务器在连不上上游模型时会照常以 200 流式返回一段 `[ERROR] …` 文本，
 * 上游给的 finish_reason 仍是 stop；只看 finish_reason 会把失败显示成「正常结束」。
 */
export function effectiveFinishReason(response) {
    const reason = response?.finishReason;
    if ((!reason || String(reason).toLowerCase() === 'stop') && /^\s*\[ERROR\]/.test(response?.text || '')) return 'error';
    return reason;
}

export function finishReasonLabel(reason) {
    const key = String(reason || '').toLowerCase().replaceAll('_', '-');
    return FINISH_LABELS[key] || String(reason || '');
}

const SOURCE_LABELS = { main: '主会话', group: '群聊', title: '标题生成', compact: '上下文压缩', sidecar: '辅助请求' };
export function sourceLabel(source) {
    return SOURCE_LABELS[source?.kind] || SOURCE_LABELS.main;
}

export const ROLE_LABELS = { system: '系统提示词', user: '用户消息', assistant: '助手消息', tool: '工具结果' };

// ------------------------------------------------------------------ VCP 文本 → 分段

const unquote = value => String(value || '').replace(/["'「」]/gu, '').trim();

/** 一个 TOOL_REQUEST 块 → 工具调用分段；input 是逐行的 `字段: 值`，与原文一一对应。 */
function toolCallFromRequest(content) {
    const fields = parseToolFields(content);
    const nameKey = Object.keys(fields).find(key => key.toLowerCase() === 'tool_name');
    const toolName = nameKey ? unquote(fields[nameKey]) : '';
    const lines = Object.entries(fields)
        .filter(([key]) => key !== nameKey)
        .map(([key, value]) => `${key}: ${value}`);
    return { kind: 'tool-call', toolName: toolName || 'unknown', input: lines.length ? lines.join('\n') : String(content || '').trim() };
}

/** 文本里的 TOOL_REQUEST 块 → { text: 去掉工具块后的正文, toolCalls }。 */
export function extractToolCalls(text) {
    const source = typeof text === 'string' ? text : '';
    const toolCalls = [];
    const stripped = replaceToolRequestBlocks(source, (_match, content) => {
        toolCalls.push(toolCallFromRequest(content));
        return '';
    });
    return { text: stripped.replace(/\n{3,}/g, '\n\n').trim(), toolCalls };
}

function toolResultFromBlock(block) {
    let body = block;
    if (body.startsWith(TOOL_RESULT_START_MARKER)) body = body.slice(TOOL_RESULT_START_MARKER.length);
    if (body.endsWith(TOOL_RESULT_END_MARKER)) body = body.slice(0, -TOOL_RESULT_END_MARKER.length);
    body = body.trim();
    const toolName = /工具名称:\s*([^\n]+)/u.exec(body)?.[1]?.trim() || '';
    const status = /执行状态:\s*([^\n]+)/u.exec(body)?.[1]?.trim() || '';
    const failed = status !== '' && !/^(success|succeeded|ok|成功)/iu.test(status);
    return { kind: 'tool-result', toolName, output: failed ? { type: 'error-text', value: body } : body };
}

/** 一段文本 → 按「正文 / VCP调用结果块」切开的有序分段。 */
function splitToolResults(text) {
    const ranges = collectToolResultRanges(text);
    if (ranges.length === 0) return [{ type: 'text', text }];
    const pieces = [];
    let cursor = 0;
    for (const range of ranges) {
        if (range.start > cursor) pieces.push({ type: 'text', text: text.slice(cursor, range.start) });
        pieces.push({ type: 'result', text: text.slice(range.start, range.end) });
        cursor = range.end;
    }
    if (cursor < text.length) pieces.push({ type: 'text', text: text.slice(cursor) });
    return pieces;
}

function partsText(message) {
    return (message.parts || []).map(part => (part.kind === 'text' ? part.text : '')).filter(Boolean).join('\n\n');
}

/**
 * 记录里的一条消息 → 界面里的若干条：user 消息里的「VCP调用结果」块拆成单独的 tool 消息，
 * assistant 消息里的 TOOL_REQUEST 块拆成 tool-call 分段。其它消息原样。
 */
export function expandMessage(message) {
    if (!message || !Array.isArray(message.parts)) return [];
    const nonText = message.parts.filter(part => part.kind !== 'text');
    const text = partsText(message);
    if (message.role === 'user' && text.includes(TOOL_RESULT_START_MARKER)) {
        const expanded = [];
        for (const piece of splitToolResults(text)) {
            if (piece.type === 'result') expanded.push({ role: 'tool', parts: [toolResultFromBlock(piece.text)] });
            else if (piece.text.trim()) expanded.push({ role: 'user', ...(message.name ? { name: message.name } : {}), parts: [{ kind: 'text', text: piece.text.trim() }] });
        }
        if (nonText.length && expanded.length) expanded[expanded.length - 1].parts.push(...nonText);
        return expanded.length ? expanded : [message];
    }
    if (message.role === 'assistant' && text.includes('TOOL_REQUEST')) {
        const { text: plain, toolCalls } = extractToolCalls(text);
        if (toolCalls.length === 0) return [message];
        return [{ role: 'assistant', ...(message.name ? { name: message.name } : {}), parts: [...(plain ? [{ kind: 'text', text: plain }] : []), ...toolCalls, ...nonText] }];
    }
    return [message];
}

/** 响应 → 输出区的行：思考过程 / 助手回答 / 每个工具调用（OpenAI tool_calls 与回答原文里的 TOOL_REQUEST 都算）。 */
export function buildOutputRows(response) {
    if (!response) return [];
    const rows = [];
    if (response.reasoningText) {
        rows.push({ key: 'reasoning', visualRole: 'reasoning', roleLabel: '思考过程', message: { role: 'assistant', parts: [{ kind: 'text', text: response.reasoningText }] } });
    }
    const { text, toolCalls: textToolCalls } = extractToolCalls(response.text || '');
    if (text) rows.push({ key: 'message', visualRole: 'assistant', roleLabel: ROLE_LABELS.assistant, message: { role: 'assistant', parts: [{ kind: 'text', text }] } });
    [...(response.toolCalls || []), ...textToolCalls].forEach((toolCall, index) => {
        rows.push({ key: `tool-call:${index}`, visualRole: 'tool-call', roleLabel: '工具调用', message: { role: 'assistant', parts: [toolCall] } });
    });
    return rows;
}

// ------------------------------------------------------------------ 工具负载

function isErrorText(value) {
    return typeof value === 'object' && value !== null && value.type === 'error-text' && typeof value.value === 'string';
}

export function formatToolPayload(value) {
    if (typeof value === 'string') return value;
    if (isErrorText(value)) return value.value;
    if (value && typeof value === 'object' && typeof value.content === 'string') return value.content;
    if (value === undefined || value === null) return '—';
    try { return JSON.stringify(value, null, 2); } catch (_error) { return String(value); }
}

export const toolOutputs = message => (message.parts || []).flatMap(part => (part.kind === 'tool-result' ? [formatToolPayload(part.output)] : []));
export const toolCallInputs = message => (message.parts || []).flatMap(part => (part.kind === 'tool-call' ? [formatToolPayload(part.input)] : []));
export const toolHasError = message => (message.parts || []).some(part => (part.kind === 'tool-result' && isErrorText(part.output)) || (part.kind === 'tool-call' && isErrorText(part.input)));

export function toolMetadata(message) {
    const parts = (message.parts || []).filter(part => part.kind === 'tool-result' || part.kind === 'tool-call');
    return {
        names: parts.flatMap(part => (part.toolName ? [part.toolName] : [])).join(', '),
        ids: parts.flatMap(part => (part.toolCallId ? [part.toolCallId.startsWith('call_') ? part.toolCallId.slice(5) : part.toolCallId] : [])).join(', ')
    };
}

/** 一条消息的可复制 / 可搜索正文。 */
export function messageContent(message) {
    if ((message.parts || []).some(part => part.kind === 'tool-result')) return toolOutputs(message).join('\n\n');
    if ((message.parts || []).some(part => part.kind === 'tool-call')) return toolCallInputs(message).join('\n\n');
    return (message.parts || []).map(part => (typeof part.text === 'string' ? part.text : part.kind === 'image' ? `[image${part.mediaType ? ` · ${part.mediaType}` : ''}]` : '')).filter(Boolean).join('\n\n');
}

export function visualRoleOf(message, override) {
    if (override) return override;
    if (message.parts?.some(part => part.kind === 'tool-result')) return 'tool-result';
    if (message.parts?.some(part => part.kind === 'tool-call')) return 'tool-call';
    return message.role === 'tool' ? 'tool-result' : message.role;
}

const compact = text => String(text || '').replace(/\s+/g, ' ').trim();

/** 折叠时显示的一行预览。 */
export function messagePreview(message) {
    if ((message.parts || []).some(part => part.kind === 'tool-result')) return compact(toolOutputs(message).join(' ')) || '—';
    if ((message.parts || []).some(part => part.kind === 'tool-call')) return compact(toolCallInputs(message).join(', ')) || '—';
    if (message.role === 'system') {
        const first = messageContent(message).split(/\r?\n/).map(line => line.trim()).find(Boolean);
        return first || '—';
    }
    return compact(messageContent(message)) || '—';
}

// ------------------------------------------------------------------ 时间线

const usesConversationDelta = record => {
    const kind = record?.source?.kind;
    return kind === undefined || kind === 'main' || kind === 'group';
};

/**
 * 每条调用要展示的输入消息。主会话首条完整、后续只展示相对上一条新增的非 assistant 消息；
 * 标题生成等辅助请求完整展示。消息数变少（历史被截断 / 删除）时回退为完整展示。
 */
export function buildTimeline(records) {
    let previousCount = 0;
    return (records || []).map((record, index) => {
        const messages = record.request?.messages || [];
        let inputs = messages;
        if (usesConversationDelta(record)) {
            if (index === 0) inputs = messages;
            else if (messages.length > previousCount) inputs = messages.slice(previousCount).filter(message => message.role !== 'assistant');
            else if (messages.length < previousCount) inputs = messages.filter(message => message.role !== 'assistant');
            else inputs = [];
            previousCount = messages.length;
        }
        const inputMessages = inputs.flatMap(expandMessage);
        return {
            key: `${record.id || record.requestId}:${index}`,
            record,
            inputMessages,
            outputRows: buildOutputRows(record.response)
        };
    });
}

export function summarizeRecords(records) {
    let totalTokens = 0;
    let estimated = false;
    const models = new Set();
    for (const record of records || []) {
        const usage = record.response?.usage;
        if (typeof usage?.totalTokens === 'number') {
            totalTokens += usage.totalTokens;
            if (usage.estimated) estimated = true;
        }
        const model = record.model?.modelId || record.response?.modelId;
        if (model) models.add(model);
    }
    return { totalTokens, estimated, models: [...models] };
}

// ------------------------------------------------------------------ 搜索

/** 折叠空白、转小写，并保留每个归一化字符对应的原文偏移，命中后能映射回原文。 */
function normalizeSearchText(source) {
    let text = '';
    const starts = [];
    const ends = [];
    let inWhitespace = false;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        if (/\s/.test(character)) {
            if (!inWhitespace) {
                text += ' ';
                starts.push(index);
                ends.push(index + 1);
                inWhitespace = true;
            } else {
                ends[ends.length - 1] = index + 1;
            }
            continue;
        }
        inWhitespace = false;
        const lowered = character.toLocaleLowerCase();
        text += lowered;
        for (let offset = 0; offset < lowered.length; offset += 1) {
            starts.push(index);
            ends.push(index + 1);
        }
    }
    return { text, starts, ends };
}

export function normalizeQuery(query) {
    return normalizeSearchText(String(query || '')).text.trim();
}

export function findTextMatches(source, normalizedQuery) {
    const normalized = normalizeSearchText(String(source || ''));
    const matches = [];
    let searchStart = 0;
    while (normalizedQuery && searchStart < normalized.text.length) {
        const at = normalized.text.indexOf(normalizedQuery, searchStart);
        if (at === -1) break;
        const end = at + normalizedQuery.length;
        const sourceStart = normalized.starts[at] ?? 0;
        matches.push({ sourceStart, sourceEnd: normalized.ends[end - 1] ?? sourceStart });
        searchStart = end;
    }
    return matches;
}

/** 一行消息的搜索目标：正文、工具名、工具 ID 各一个。 */
function messageTargets(callKey, callIndex, expansionKey, message) {
    const metadata = toolMetadata(message);
    const content = messageContent(message);
    const base = { callKey, callIndex, expansionKey };
    return [
        ...(content ? [{ ...base, field: 'content', text: content }] : []),
        ...(metadata.names ? [{ ...base, field: 'tool-name', text: metadata.names }] : []),
        ...(metadata.ids ? [{ ...base, field: 'tool-id', text: metadata.ids }] : [])
    ];
}

export const inputRowKey = (item, index) => `${item.key}:input:${index}`;
export const outputRowKey = (item, row) => `${item.key}:output:${row.key}`;

export function buildSearchIndex(items, query) {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) return { query: '', matches: [] };
    const matches = [];
    items.forEach((item, callIndex) => {
        const targets = [
            ...item.inputMessages.flatMap((message, index) => messageTargets(item.key, callIndex, inputRowKey(item, index), message)),
            ...item.outputRows.flatMap(row => messageTargets(item.key, callIndex, outputRowKey(item, row), row.message))
        ];
        for (const target of targets) {
            findTextMatches(target.text, normalizedQuery).forEach(({ sourceStart, sourceEnd }, fieldMatchIndex) => {
                matches.push({ ...target, key: `${target.expansionKey}:${target.field}:${fieldMatchIndex}:${sourceStart}`, fieldMatchIndex, sourceStart, sourceEnd });
            });
        }
    });
    return { query: normalizedQuery, matches };
}
