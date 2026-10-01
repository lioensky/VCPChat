/**
 * modules/modelTrajectory.js
 * 模型调用轨迹的记录器：每一次发给模型的请求（含完整 messages）连同它的流式 / 非流式响应，
 * 整理成一条记录，按话题落盘成 JSONL，供侧栏「调用轨迹」标签查看。
 *
 * 记录结构与取舍参照 ZCode 的 model-io 轨迹
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/services/src/zcode-agent/modelTrajectory.ts）：
 * 一条记录 = 一次模型调用，请求侧是规范化后的消息分段，响应侧是 文本 / 思考过程 / 工具调用 / 结束原因 / token 用量，
 * 读取时只取尾部最近的若干条并标明是否被截断。
 * VCPChat 与 ZCode 不同的地方：
 * - 请求来自渲染进程的 IPC（主聊天）或群聊主进程模块，没有统一的 agent 层，所以由调用方 begin() / chunk() / finish()；
 * - 工具调用写在回答原文里（TOOL_REQUEST 块），不是 OpenAI tool_calls，原文原样记下，由界面解析；
 * - 服务端不一定回报 token 用量，缺失时按字符数粗估并标记 estimated；
 * - API Key 永远不进记录：begin() 根本不接收它，模型参数里疑似密钥的字段也会被剔除。
 * 记录器的任何方法都不会抛错、也不会阻塞聊天链路。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_MAX_FIELD_CHARS = 200000;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const SECRET_KEY = /(api[-_]?key|secret|authorization|password|bearer)/i;

function truncateText(value, max) {
    const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n…[已截断 ${text.length - max} 个字符]`;
}

function safeStringify(value, max) {
    try {
        return truncateText(JSON.stringify(value), max);
    } catch (_error) {
        return truncateText(String(value), max);
    }
}

/** 数据 URL 只留类型和大小，不把图片的 base64 写进轨迹。 */
function describeImage(url) {
    const text = typeof url === 'string' ? url : url?.url;
    const match = /^data:([^;,]+)[;,]/i.exec(String(text || ''));
    if (match) return { kind: 'image', mediaType: match[1], bytes: Math.round(String(text).length * 0.75) };
    return { kind: 'image', url: truncateText(text, 500) };
}

/** 一条 OpenAI 风格的消息 → { role, name?, parts: [...] }，和 ZCode 的轨迹消息形状一致。 */
function normalizeMessage(message, maxChars) {
    const role = typeof message?.role === 'string' ? message.role : 'user';
    const parts = [];
    const content = message?.content;
    if (typeof content === 'string') {
        if (content) parts.push({ kind: 'text', text: truncateText(content, maxChars) });
    } else if (Array.isArray(content)) {
        for (const part of content) {
            if (typeof part === 'string') parts.push({ kind: 'text', text: truncateText(part, maxChars) });
            else if (part?.type === 'text' || typeof part?.text === 'string') parts.push({ kind: 'text', text: truncateText(part.text, maxChars) });
            else if (part?.type === 'image_url' || part?.image_url) parts.push(describeImage(part.image_url));
            else parts.push({ kind: 'other', raw: safeStringify(part, 2000) });
        }
    } else if (content && typeof content === 'object') {
        parts.push({ kind: 'text', text: truncateText(typeof content.text === 'string' ? content.text : safeStringify(content, maxChars), maxChars) });
    }
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        parts.push({
            kind: 'tool-call',
            toolCallId: call?.id || undefined,
            toolName: call?.function?.name || call?.name || '',
            input: truncateText(call?.function?.arguments ?? call?.arguments ?? '', maxChars)
        });
    }
    if (role === 'tool') {
        const output = parts.filter(part => part.kind === 'text').map(part => part.text).join('\n');
        return { role, parts: [{ kind: 'tool-result', toolCallId: message?.tool_call_id || undefined, toolName: message?.name || undefined, output }] };
    }
    return { role, ...(typeof message?.name === 'string' && message.name ? { name: message.name } : {}), parts };
}

function sanitizeParams(params) {
    const result = {};
    for (const [key, value] of Object.entries(params && typeof params === 'object' ? params : {})) {
        if (SECRET_KEY.test(key) || key === 'messages' || key === 'requestId') continue;
        if (value === undefined || typeof value === 'function') continue;
        result[key] = typeof value === 'string' ? truncateText(value, 500) : value;
    }
    return result;
}

/** 服务端没回报 token 用量时的粗估：中日韩字符按 1 个、其余约 4 个字符 1 个。 */
function estimateTokens(text) {
    const source = String(text || '');
    let cjk = 0;
    for (const char of source) if (/[⺀-鿿豈-﫿＀-￯]/u.test(char)) cjk += 1;
    return Math.ceil(cjk + (source.length - cjk) / 4);
}

function messageText(message) {
    return (message.parts || []).map(part => (part.kind === 'text' ? part.text : part.kind === 'tool-result' ? part.output : part.kind === 'tool-call' ? `${part.toolName}${part.input}` : '')).join('\n');
}

function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const input = Number(raw.prompt_tokens ?? raw.input_tokens);
    const output = Number(raw.completion_tokens ?? raw.output_tokens);
    const total = Number(raw.total_tokens);
    if (![input, output, total].some(Number.isFinite)) return null;
    return {
        inputTokens: Number.isFinite(input) ? input : undefined,
        outputTokens: Number.isFinite(output) ? output : undefined,
        totalTokens: Number.isFinite(total) ? total : (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)
    };
}

function sanitizeFileKey(sessionKey) {
    const key = String(sessionKey || 'unscoped').replace(/[^\w.\-一-鿿]+/gu, '_').slice(0, 120);
    return key || 'unscoped';
}

function createModelTrajectoryRecorder({
    rootDir,
    now = () => Date.now(),
    maxRecords = DEFAULT_MAX_RECORDS,
    maxFieldChars = DEFAULT_MAX_FIELD_CHARS,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES
} = {}) {
    /** @type {Map<string, Map<string, object>>} sessionKey → 进行中的调用 */
    const pending = new Map();
    const listeners = new Set();
    const writeChains = new Map();
    let counter = 0;

    const fileOf = sessionKey => path.join(rootDir, `${sanitizeFileKey(sessionKey)}.jsonl`);

    function emit(event) {
        for (const listener of [...listeners]) {
            try { listener(event); } catch (_error) { /* 订阅方出错不影响记录 */ }
        }
    }

    function enqueueWrite(sessionKey, task) {
        const file = fileOf(sessionKey);
        const chain = (writeChains.get(file) || Promise.resolve()).then(task).catch(() => {});
        writeChains.set(file, chain);
        return chain;
    }

    function readRecordsFromFile(file) {
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (_error) {
            return [];
        }
        const records = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try { records.push(JSON.parse(line)); } catch (_error) { /* 半行 / 坏行跳过 */ }
        }
        return records;
    }

    async function persist(sessionKey, record) {
        await enqueueWrite(sessionKey, async () => {
            const file = fileOf(sessionKey);
            await fs.promises.mkdir(rootDir, { recursive: true });
            await fs.promises.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
            const { size } = await fs.promises.stat(file);
            if (size > maxFileBytes) {
                const kept = readRecordsFromFile(file).slice(-maxRecords);
                await fs.promises.writeFile(file, kept.map(item => `${JSON.stringify(item)}\n`).join(''), 'utf8');
            }
        });
    }

    function snapshotOf(call, status) {
        return {
            id: call.id,
            requestId: call.requestId,
            sessionKey: call.sessionKey,
            startedAt: call.startedAt,
            ...(call.endedAt ? { endedAt: call.endedAt, durationMs: call.endedAt - call.startedAt } : {}),
            status,
            source: call.source,
            model: { modelId: call.modelId, params: call.params },
            request: { messages: call.messages },
            response: call.buildResponse(),
            ...(call.error ? { error: call.error } : {})
        };
    }

    function begin({ sessionKey, requestId = null, source = {}, model = '', params = {}, messages = [] } = {}) {
        const noop = { id: null, chunk() {}, finish() {} };
        try {
            const normalized = (Array.isArray(messages) ? messages : []).map(message => normalizeMessage(message, maxFieldChars));
            counter += 1;
            const call = {
                id: `call_${now().toString(36)}_${counter}`,
                requestId: requestId ? String(requestId) : null,
                sessionKey: sessionKey || 'unscoped',
                startedAt: now(),
                endedAt: 0,
                source: { kind: 'main', ...source },
                modelId: String(model || params?.model || ''),
                params: sanitizeParams(params),
                messages: normalized,
                text: '',
                reasoning: '',
                toolCalls: new Map(),
                finishReason: null,
                usage: null,
                responseModel: null,
                error: null,
                done: false
            };
            call.buildResponse = () => {
                const toolCalls = [...call.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => ({
                    kind: 'tool-call', toolCallId: entry.id || undefined, toolName: entry.name, input: entry.args
                }));
                if (!call.text && !call.reasoning && toolCalls.length === 0 && !call.finishReason && !call.usage) return null;
                return {
                    text: truncateText(call.text, maxFieldChars),
                    reasoningText: truncateText(call.reasoning, maxFieldChars),
                    toolCalls,
                    finishReason: call.finishReason || undefined,
                    usage: call.usage || undefined,
                    modelId: call.responseModel || undefined
                };
            };
            if (!pending.has(call.sessionKey)) pending.set(call.sessionKey, new Map());
            pending.get(call.sessionKey).set(call.id, call);
            emit({ sessionKey: call.sessionKey, id: call.id, status: 'running' });

            const addToolDelta = (delta, fallbackIndex) => {
                const index = Number.isInteger(delta?.index) ? delta.index : fallbackIndex;
                const entry = call.toolCalls.get(index) || { id: '', name: '', args: '' };
                if (delta?.id) entry.id = delta.id;
                const fn = delta?.function || {};
                if (fn.name) entry.name += fn.name;
                if (typeof fn.arguments === 'string') entry.args += fn.arguments;
                call.toolCalls.set(index, entry);
            };

            const handle = {
                id: call.id,
                /** 一个已解析的 SSE 数据块（OpenAI chat.completion.chunk）。 */
                chunk(parsed) {
                    try {
                        if (call.done || !parsed || typeof parsed !== 'object' || parsed.error === 'json_parse_error') return;
                        if (typeof parsed.model === 'string') call.responseModel = parsed.model;
                        const choice = parsed.choices?.[0];
                        const delta = choice?.delta ?? parsed.delta ?? null;
                        if (delta) {
                            if (typeof delta.content === 'string') call.text += delta.content;
                            const reasoning = delta.reasoning_content ?? delta.reasoning;
                            if (typeof reasoning === 'string') call.reasoning += reasoning;
                            (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).forEach((toolCall, i) => addToolDelta(toolCall, i));
                        }
                        if (choice?.finish_reason) call.finishReason = choice.finish_reason;
                        const usage = normalizeUsage(parsed.usage);
                        if (usage) call.usage = usage;
                    } catch (_error) { /* 记录失败不影响聊天 */ }
                },
                /** 结束一次调用；response 是非流式的完整响应体，error 为 {name, message, stack?}，aborted 表示被用户中止。 */
                finish({ response = null, error = null, aborted = false } = {}) {
                    try {
                        if (call.done) return;
                        call.done = true;
                        call.endedAt = now();
                        if (response && typeof response === 'object') {
                            const choice = response.choices?.[0];
                            const message = choice?.message ?? {};
                            if (typeof response.model === 'string') call.responseModel = response.model;
                            if (typeof message.content === 'string') call.text = message.content;
                            else if (Array.isArray(message.content)) call.text = message.content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
                            const reasoning = message.reasoning_content ?? message.reasoning;
                            if (typeof reasoning === 'string') call.reasoning = reasoning;
                            (Array.isArray(message.tool_calls) ? message.tool_calls : []).forEach((toolCall, i) => addToolDelta(toolCall, i));
                            if (choice?.finish_reason) call.finishReason = choice.finish_reason;
                            const usage = normalizeUsage(response.usage);
                            if (usage) call.usage = usage;
                        }
                        if (error) {
                            call.error = {
                                name: String(error.name || 'Error'),
                                message: truncateText(error.message ?? error, 2000),
                                ...(error.stack ? { stack: truncateText(error.stack, 4000) } : {})
                            };
                        }
                        if (!call.usage && (call.text || call.reasoning || call.toolCalls.size > 0)) {
                            const inputTokens = call.messages.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0);
                            const outputTokens = estimateTokens(call.text + call.reasoning);
                            call.usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true };
                        }
                        const status = aborted ? 'aborted' : error ? 'error' : 'completed';
                        const record = snapshotOf(call, status);
                        pending.get(call.sessionKey)?.delete(call.id);
                        if (pending.get(call.sessionKey)?.size === 0) pending.delete(call.sessionKey);
                        emit({ sessionKey: call.sessionKey, id: call.id, status });
                        void persist(call.sessionKey, record);
                    } catch (_error) { /* 记录失败不影响聊天 */ }
                }
            };
            return handle;
        } catch (_error) {
            return noop;
        }
    }

    /** 某话题最近的调用（落盘的 + 进行中的），按开始时间从旧到新；truncated 表示还有更早的没返回。 */
    async function list(sessionKey, { limit = DEFAULT_MAX_RECORDS } = {}) {
        const cap = Math.max(1, Math.min(maxRecords, Math.floor(Number(limit)) || maxRecords));
        await (writeChains.get(fileOf(sessionKey)) || Promise.resolve());
        const stored = readRecordsFromFile(fileOf(sessionKey));
        const running = [...(pending.get(sessionKey)?.values() || [])].map(call => snapshotOf(call, 'running'));
        const all = [...stored, ...running].sort((a, b) => a.startedAt - b.startedAt);
        return { records: all.slice(-cap), truncated: all.length > cap, total: all.length };
    }

    async function clear(sessionKey) {
        await enqueueWrite(sessionKey, async () => {
            await fs.promises.rm(fileOf(sessionKey), { force: true });
        });
        emit({ sessionKey, id: null, status: 'cleared' });
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    return { begin, list, clear, subscribe, getDirectory: () => rootDir, fileOf };
}

/** 话题的轨迹键：群聊按 群组 + 话题，单聊按 Agent + 话题；上下文不全时归到 unscoped。 */
function sessionKeyFromContext(context) {
    const owner = context?.groupId || context?.agentId;
    const topic = context?.topicId;
    return owner && topic ? `${owner}__${topic}` : 'unscoped';
}

function sourceFromContext(context, kind) {
    const group = Boolean(context?.isGroupMessage || context?.groupId);
    return {
        kind: kind || (group ? 'group' : 'main'),
        ...(context?.agentId ? { agentId: String(context.agentId) } : {}),
        ...(context?.agentName ? { agentName: String(context.agentName) } : {}),
        ...(context?.groupId ? { groupId: String(context.groupId) } : {}),
        ...(context?.topicId ? { topicId: String(context.topicId) } : {})
    };
}

const NOOP_CALL = Object.freeze({ id: null, chunk() {}, finish() {} });
let sharedRecorder = null;

/** 主进程启动时配置一次；聊天链路上的各处用 beginTrajectoryCall()，没配置（如单元测试）时是空操作。 */
function configureSharedRecorder(options) {
    sharedRecorder = createModelTrajectoryRecorder(options);
    return sharedRecorder;
}

function getSharedRecorder() {
    return sharedRecorder;
}

function beginTrajectoryCall(args) {
    try {
        return sharedRecorder && args ? sharedRecorder.begin(args) : NOOP_CALL;
    } catch (_error) {
        return NOOP_CALL;
    }
}

module.exports = {
    createModelTrajectoryRecorder,
    configureSharedRecorder,
    getSharedRecorder,
    beginTrajectoryCall,
    sessionKeyFromContext,
    sourceFromContext,
    normalizeMessage,
    estimateTokens,
    sanitizeFileKey
};
