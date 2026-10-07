/**
 * modules/modelTrajectory.js
 * 模型调用轨迹的记录器：每一次发给模型的请求（含完整 messages）连同它的流式 / 非流式响应，
 * 整理成一条记录，按话题落盘成 JSONL，供侧栏「调用轨迹」标签查看。
 *
 * 记录结构与取舍参照 ZCode 的 model-io 轨迹
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/services/src/zcode-agent/modelTrajectory.ts）：
 * 一条记录 = 一次模型调用，请求侧是规范化后的消息分段，响应侧是 文本 / 思考过程 / 工具调用 / 结束原因 / token 用量，
 * 读取时只取尾部最近的若干条并标明是否被截断。
 * 存储同样照原实现：同一话题里后一次调用只存相对上一条记录新增的消息（messagesKind: 'delta' + messageOffset），
 * 读出时按文件顺序拼回完整上下文；每隔若干条写一次完整基线，尾部读取丢掉开头时最多只有几条拼不全（标 omittedMessages）。
 * 读取从文件尾部异步读固定上限，读过的话题在内存里缓存（消息对象在相邻记录间共享），之后只追加不重读。
 * VCPChat 与原实现不同的地方：
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
const MAX_TAIL_READ_BYTES = 32 * 1024 * 1024;
const BASELINE_EVERY = 25;
const MAX_CACHED_SESSIONS = 16;
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

/** 一条 OpenAI 风格的消息 → { role, name?, parts: [...] }，和轨迹消息的通用形状一致。 */
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

const finiteOrUndefined = value => (value === undefined || value === null || !Number.isFinite(Number(value)) ? undefined : Number(value));

/** OpenAI / Anthropic / DeepSeek 几种用量写法 → { inputTokens, outputTokens, totalTokens, cachedInputTokens?, reasoningTokens? }。 */
function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const input = finiteOrUndefined(raw.prompt_tokens ?? raw.input_tokens);
    const output = finiteOrUndefined(raw.completion_tokens ?? raw.output_tokens);
    const total = finiteOrUndefined(raw.total_tokens);
    if ([input, output, total].every(value => value === undefined)) return null;
    const cached = finiteOrUndefined(raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens
        ?? raw.cache_read_input_tokens ?? raw.prompt_cache_hit_tokens);
    const reasoning = finiteOrUndefined(raw.completion_tokens_details?.reasoning_tokens ?? raw.output_tokens_details?.reasoning_tokens);
    return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: total ?? (input ?? 0) + (output ?? 0),
        ...(cached ? { cachedInputTokens: cached } : {}),
        ...(reasoning ? { reasoningTokens: reasoning } : {})
    };
}

/** 流式请求要求服务端在最后一个数据块里带上 token 用量（OpenAI 的 stream_options.include_usage）；调用方已指定时不覆盖。 */
function withStreamUsage(body) {
    if (!body || typeof body !== 'object' || body.stream !== true || body.stream_options !== undefined) return body;
    body.stream_options = { include_usage: true };
    return body;
}

const nonNegativeInteger = value => (Number.isInteger(value) && value >= 0 ? value : undefined);

/** 消息的比较键；同一个对象只序列化一次。 */
const messageKeys = new WeakMap();
function messageKey(message) {
    if (!message || typeof message !== 'object') return String(message);
    let key = messageKeys.get(message);
    if (key === undefined) {
        key = JSON.stringify(message);
        messageKeys.set(message, key);
    }
    return key;
}

/** 两段上下文的公共前缀长度。 */
function commonPrefixLength(previous, next) {
    const limit = Math.min(previous.length, next.length);
    let offset = 0;
    while (offset < limit && (previous[offset] === next[offset] || messageKey(previous[offset]) === messageKey(next[offset]))) offset += 1;
    return offset;
}

/** 落盘形状：有公共前缀且不强制基线时只存新增部分。 */
function encodeRecord(record, previousMessages, baseline) {
    const messages = record.request?.messages || [];
    if (baseline || !previousMessages) return record;
    const offset = commonPrefixLength(previousMessages, messages);
    if (offset === 0) return record;
    return { ...record, request: { ...record.request, messagesKind: 'delta', messageOffset: offset, messages: messages.slice(offset) } };
}

/**
 * 按文件顺序把增量记录拼回完整上下文；拼出的消息数组和上一条共享消息对象。
 * 增量的基线不在读到的范围里（尾部读取丢了开头）时保留已有部分，标 omittedMessages，直到下一条基线。
 */
function expandRecords(rawRecords) {
    const expanded = [];
    let previous = null;
    for (const raw of rawRecords) {
        if (!raw || typeof raw !== 'object') continue;
        const { messagesKind, messageOffset, ...request } = raw.request && typeof raw.request === 'object' ? raw.request : {};
        let messages = Array.isArray(request.messages) ? request.messages : [];
        if (messagesKind === 'delta') {
            const offset = nonNegativeInteger(messageOffset);
            if (previous && offset !== undefined && offset <= previous.length) messages = [...previous.slice(0, offset), ...messages];
            else request.omittedMessages = offset || 0;
        }
        expanded.push({ ...raw, request: { ...request, messages } });
        previous = request.omittedMessages ? null : messages;
    }
    return expanded;
}

/** 从文件尾部异步读最多 maxBytes；从行中间开始时丢掉不完整的第一行。 */
async function readFileTail(file, maxBytes) {
    let handle;
    try {
        handle = await fs.promises.open(file, 'r');
    } catch (error) {
        if (error?.code === 'ENOENT') return { text: '', size: 0, truncated: false };
        throw error;
    }
    try {
        const { size } = await handle.stat();
        const start = Math.max(0, size - maxBytes);
        const length = size - start;
        const buffer = Buffer.allocUnsafe(length);
        let bytesRead = 0;
        while (bytesRead < length) {
            const result = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        let text = buffer.subarray(0, bytesRead).toString('utf8');
        if (start > 0) {
            const firstNewline = text.indexOf('\n');
            text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
        }
        return { text, size, truncated: start > 0 };
    } finally {
        await handle.close();
    }
}

function parseLines(text) {
    const records = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch (_error) { /* 半行 / 坏行跳过 */ }
    }
    return records;
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
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxReadBytes = MAX_TAIL_READ_BYTES,
    baselineEvery = BASELINE_EVERY
} = {}) {
    /** @type {Map<string, Map<string, object>>} sessionKey → 进行中的调用 */
    const pending = new Map();
    const listeners = new Set();
    const writeChains = new Map();
    /**
     * 文件 → 读写状态（最近用过的若干个话题）：
     * records 是读出并拼好的最近记录（未读过时为 null），lastMessages 是最后一条的完整上下文，
     * sinceBaseline 是最后一条基线之后的增量条数，size / count 是文件当前的字节数和记录数（未知时为 null），
     * trimAt 是下一次压缩的字节阈值。被挤出缓存只意味着下次要重读、下一条写基线。
     */
    const sessions = new Map();
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

    function stateOf(file) {
        let state = sessions.get(file);
        if (state) {
            sessions.delete(file);
        } else {
            state = { records: null, truncated: false, lastMessages: null, sinceBaseline: 0, size: null, count: null, trimAt: maxFileBytes };
        }
        sessions.set(file, state);
        while (sessions.size > MAX_CACHED_SESSIONS) sessions.delete(sessions.keys().next().value);
        return state;
    }

    /** 写链上的任务出错时丢掉这个文件的状态，下次重读、写基线，避免内存和文件对不上。 */
    function guarded(file, task) {
        return async () => {
            try {
                await task();
            } catch (error) {
                sessions.delete(file);
                throw error;
            }
        };
    }

    /** 读文件尾部、拼回完整上下文，填进状态（只在写链上调用）。 */
    async function loadState(file, state) {
        if (state.records) return;
        const tail = await readFileTail(file, maxReadBytes);
        const raw = parseLines(tail.text);
        const records = expandRecords(raw);
        let sinceBaseline = 0;
        for (let i = raw.length - 1; i >= 0 && raw[i]?.request?.messagesKind === 'delta'; i -= 1) sinceBaseline += 1;
        const last = records.at(-1);
        state.records = records.slice(-maxRecords);
        state.truncated = tail.truncated || records.length > maxRecords;
        state.count = records.length;
        state.size = tail.size;
        state.lastMessages = last && !last.request.omittedMessages ? last.request.messages : null;
        state.sinceBaseline = state.lastMessages ? sinceBaseline : 0;
    }

    /**
     * 压缩：只留最近 maxRecords 条里、增量编码后不超过一半上限的那些，第一条重写成基线，先写临时文件再替换。
     * 下一次压缩至少要等文件再长半个上限，单条记录本身就很大时也不会每次追加都重写。
     */
    async function compact(file, state) {
        const tail = await readFileTail(file, maxReadBytes);
        const records = expandRecords(parseLines(tail.text)).slice(-maxRecords);
        const encode = (list) => {
            let previous = null;
            return list.map((record, index) => {
                const line = `${JSON.stringify(encodeRecord(record, previous, index % baselineEvery === 0))}\n`;
                previous = record.request.omittedMessages ? null : record.request.messages;
                return line;
            });
        };
        const target = Math.floor(maxFileBytes / 2);
        let lines = encode(records);
        let start = records.length;
        let bytes = 0;
        while (start > 0) {
            const next = bytes + Buffer.byteLength(lines[start - 1]);
            if (next > target && start < records.length) break;
            bytes = next;
            start -= 1;
        }
        const kept = records.slice(start);
        if (start > 0) lines = encode(kept);
        const text = lines.join('');
        const temp = `${file}.${process.pid}.tmp`;
        await fs.promises.writeFile(temp, text, 'utf8');
        await fs.promises.rename(temp, file);
        const size = Buffer.byteLength(text);
        const last = kept.at(-1);
        state.records = kept;
        state.truncated = false;
        state.count = kept.length;
        state.size = size;
        state.lastMessages = last && !last.request.omittedMessages ? last.request.messages : null;
        state.sinceBaseline = state.lastMessages ? (kept.length - 1) % baselineEvery : 0;
        state.trimAt = Math.max(maxFileBytes, size + Math.floor(maxFileBytes / 2));
    }

    const needsCompaction = state => state.size > state.trimAt || (state.count !== null && state.count > maxRecords * 2);

    async function persist(sessionKey, record) {
        const file = fileOf(sessionKey);
        await enqueueWrite(sessionKey, guarded(file, async () => {
            const state = stateOf(file);
            await fs.promises.mkdir(rootDir, { recursive: true });
            if (state.size === null) {
                try { state.size = (await fs.promises.stat(file)).size; } catch (_error) { state.size = 0; }
            }
            const messages = record.request.messages;
            const baseline = !state.lastMessages || state.sinceBaseline >= baselineEvery - 1;
            const line = `${JSON.stringify(encodeRecord(record, state.lastMessages, baseline))}\n`;
            await fs.promises.appendFile(file, line, 'utf8');
            // 内存里也和上一条共享相同的消息对象，缓存的最近记录不会各自持有一份完整上下文
            const offset = state.lastMessages ? commonPrefixLength(state.lastMessages, messages) : 0;
            const shared = offset > 0 ? [...state.lastMessages.slice(0, offset), ...messages.slice(offset)] : messages;
            state.lastMessages = shared;
            state.sinceBaseline = baseline ? 0 : state.sinceBaseline + 1;
            state.size += Buffer.byteLength(line);
            if (state.count !== null) state.count += 1;
            if (state.records) {
                state.records.push({ ...record, request: { ...record.request, messages: shared } });
                if (state.records.length > maxRecords) {
                    state.records.splice(0, state.records.length - maxRecords);
                    state.truncated = true;
                }
            }
            if (needsCompaction(state)) await compact(file, state);
        }));
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
        const file = fileOf(sessionKey);
        let snapshot = { records: [], truncated: false, count: 0 };
        await enqueueWrite(sessionKey, guarded(file, async () => {
            const state = stateOf(file);
            await loadState(file, state);
            // 旧版本每条都存整份上下文，文件可能早已超限，第一次读到时顺手压缩
            if (needsCompaction(state)) await compact(file, state);
            snapshot = { records: state.records.slice(), truncated: state.truncated, count: state.count };
        }));
        const running = [...(pending.get(sessionKey)?.values() || [])].map(call => snapshotOf(call, 'running'));
        const all = [...snapshot.records, ...running].sort((a, b) => a.startedAt - b.startedAt);
        const total = Math.max(snapshot.count, snapshot.records.length) + running.length;
        return { records: all.slice(-cap), truncated: snapshot.truncated || all.length > cap, total };
    }

    async function clear(sessionKey) {
        const file = fileOf(sessionKey);
        await enqueueWrite(sessionKey, async () => {
            sessions.delete(file);
            await fs.promises.rm(file, { force: true });
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

/** 话题（含辅助对话子话题）删掉时一并删掉它的轨迹文件，否则每个删过的话题都在磁盘上留一份；没配置或键不完整时什么也不做。 */
function clearTrajectoryOf(context) {
    const sessionKey = sessionKeyFromContext(context);
    if (!sharedRecorder || sessionKey === 'unscoped') return Promise.resolve();
    return sharedRecorder.clear(sessionKey).catch(() => {});
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
    clearTrajectoryOf,
    sessionKeyFromContext,
    sourceFromContext,
    normalizeMessage,
    normalizeUsage,
    estimateTokens,
    sanitizeFileKey,
    withStreamUsage,
    expandRecords
};
