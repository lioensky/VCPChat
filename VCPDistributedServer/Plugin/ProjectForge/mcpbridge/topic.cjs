'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
    executeTopicMemo,
    findOwnerByTopicId,
    findUserName,
    loadTopicHistory,
    cleanHtmlContent,
    safeSlice,
} = require('../../TopicMemo/TopicMemo.js');

const DEFAULT_VCP_URL = 'http://127.0.0.1:6005';
const DEFAULT_TIMEOUT_MS = 45000;
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const MAX_RIVER_ITEM_CHARS = 8000;
const MAX_RIVER_TOTAL_CHARS = 32000;

const BLOCK_START = '<<<[' + 'TOOL_REQUEST]>>>';
const BLOCK_END = '<<<[' + 'END_TOOL_REQUEST]>>>';
const ESCAPE_START = '「始' + 'ESCAPE」';
const ESCAPE_END = '「末' + 'ESCAPE」';
const RIVER_V2_HEADER = '[VCP_TOPIC_RIVER_V2]';
const RIVER_V2_FOOTER = '[/VCP_TOPIC_RIVER_V2]';
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const RESERVED_ESCAPE = /[「{](?:始|末)ESCAPE[」}]|<<<\[(?:END_)?TOOL_REQUEST_ESCAPE\]>>>/i;

const identifier = {
    type: 'string',
    minLength: 1,
    maxLength: 256,
    pattern: '^[^\\r\\n\\x00-\\x1f\\x7f]*\\S[^\\r\\n\\x00-\\x1f\\x7f]*$',
};
const contentText = {
    type: 'string',
    minLength: 1,
    pattern: '[\\s\\S]*\\S[\\s\\S]*',
};
const boolean = { type: 'boolean' };
const positive = { type: 'integer', minimum: 1 };
const natural = { type: 'integer', minimum: 0 };

const contextItemSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['content'],
    properties: {
        kind: { type: 'string', enum: ['user', 'assistant', 'tool'] },
        name: identifier,
        content: contentText,
    },
};

const schema = (properties = {}, required = [], constraints = {}) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    ...constraints,
});

function defineTopicTool(name, plugin, command, description, inputSchema, readOnly, toArgs = args => args) {
    return {
        name,
        plugin,
        command,
        description,
        inputSchema,
        toArgs,
        annotations: {
            readOnlyHint: readOnly,
            destructiveHint: false,
            idempotentHint: readOnly,
            openWorldHint: false,
        },
    };
}

const topicTools = [
    defineTopicTool(
        'ts_list_agents',
        'TopicSponsor',
        'ListAgents',
        '列出所有注册 Agent 的完整 name、id 和 type，只读地址簿。',
        schema(),
        true,
        () => ({}),
    ),
    defineTopicTool(
        'ts_list_groups',
        'TopicSponsor',
        'ListGroups',
        '列出所有注册群组的完整 name、id 和 type，只读地址簿。',
        schema(),
        true,
        () => ({}),
    ),
    defineTopicTool(
        'ts_list_recent_topics',
        'TopicSponsor',
        'ListRecentTopics',
        '查询指定 Agent 或群组最新创建的 5 个话题元数据（标题、topic_id、创建时间），不读取正文。query 为 ID 或名称；多候选可用 targetType 消歧。',
        schema(
            { query: identifier, targetType: { type: 'string', enum: ['agent', 'group'] } },
            ['query'],
        ),
        true,
        args => ({ query: args.query, target_type: args.targetType }),
    ),
    defineTopicTool(
        'ts_check_new_topics',
        'TopicSponsor',
        'CheckNewTopics',
        '查询指定 Agent 或群组最近几日的新话题元数据；maid 为目标名称或 ID，days 默认 3。',
        schema(
            { maid: identifier, days: { type: 'number', minimum: 0, maximum: 3650 } },
            ['maid'],
        ),
        true,
        args => ({ maid: args.maid, days: args.days }),
    ),
    defineTopicTool(
        'ts_check_unread_messages',
        'TopicSponsor',
        'CheckUnreadMessages',
        '查询指定 Agent 或群组是否存在标记为未读的话题。',
        schema({ maid: identifier }, ['maid']),
        true,
        args => ({ maid: args.maid }),
    ),
    defineTopicTool(
        'ts_check_topic_ownership',
        'TopicSponsor',
        'CheckTopicOwnership',
        '检查单聊或群聊话题是否由 callerName 创建；maid 可选，省略时按 topicId 全域寻址。',
        schema(
            { topicId: identifier, callerName: identifier, maid: identifier },
            ['topicId', 'callerName'],
        ),
        true,
        args => ({ topic_id: args.topicId, caller_name: args.callerName, maid: args.maid }),
    ),
    defineTopicTool(
        'ts_create_topic',
        'TopicSponsor',
        'CreateTopic',
        '在指定 Agent 下创建新话题并写入首条消息，默认置顶且标记未读。maid 为发起话题的注册 Agent 名称或 ID。',
        schema(
            { maid: identifier, topicName: identifier, initialMessage: contentText },
            ['maid', 'topicName', 'initialMessage'],
        ),
        false,
        args => ({
            maid: args.maid,
            topic_name: args.topicName,
            initial_message: args.initialMessage,
        }),
    ),
    defineTopicTool(
        'ts_create_flowlock_topic',
        'TopicSponsor',
        'CreateFlowlockTopic',
        '创建带持久化 Flowlock 自主接力请求的新话题（最终回复落盘后由前端原子认领并按心跳推进）。maid、topicName、initialMessage 必填；flowlockHeartbeat 可选（1–86400 秒，默认 5）。',
        schema(
            {
                maid: identifier,
                topicName: identifier,
                initialMessage: contentText,
                flowlockHeartbeat: { type: 'integer', minimum: 1, maximum: 86400 },
                flowlockPrompt: contentText,
            },
            ['maid', 'topicName', 'initialMessage'],
        ),
        false,
        args => ({
            maid: args.maid,
            topic_name: args.topicName,
            initial_message: args.initialMessage,
            flowlock_heartbeat: args.flowlockHeartbeat,
            flowlock_prompt: args.flowlockPrompt,
        }),
    ),
    defineTopicTool(
        'ts_reply_to_topic',
        'TopicSponsor',
        'ReplyToTopic',
        '向已有话题留言（传 topicId，省略 mode），或从当前话题向目标 Agent 派工创建独立任务话题（传 mode="new_topic"、sourceTopicId、targetAgent，不传 topicId）。支持可选 riverLast（从源话题提取最近 N 轮干净对话）与 contextItems（附加结构化代码切片/诊断/工具结果），自动封装为 VChat 原生 [VCP_TOPIC_RIVER_V2] 折叠引用卡。',
        schema(
            {
                message: contentText,
                senderId: identifier,
                senderName: identifier,
                mode: { type: 'string', enum: ['new_topic'] },
                topicId: identifier,
                sourceTopicId: identifier,
                targetAgent: identifier,
                topicName: identifier,
                flowlock: boolean,
                riverTopicId: identifier,
                riverLast: { type: 'integer', minimum: 1, maximum: 20 },
                contextItems: { type: 'array', minItems: 1, maxItems: 16, items: contextItemSchema },
            },
            ['message'],
            {
                allOf: [
                    { anyOf: [{ required: ['senderId'] }, { required: ['senderName'] }] },
                    {
                        oneOf: [
                            {
                                required: ['topicId'],
                                not: {
                                    anyOf: [
                                        { required: ['mode'] },
                                        { required: ['targetAgent'] },
                                        { required: ['topicName'] },
                                        { required: ['flowlock'] },
                                    ],
                                },
                            },
                            {
                                required: ['mode', 'sourceTopicId', 'targetAgent'],
                                not: { required: ['topicId'] },
                            },
                        ],
                    },
                ],
            },
        ),
        false,
        args => ({
            mode: args.mode,
            topic_id: args.topicId,
            source_topic_id: args.sourceTopicId,
            target_agent: args.targetAgent,
            topic_name: args.topicName,
            sender_id: args.senderId,
            sender_name: args.senderName,
            message: args.message,
            flowlock: args.flowlock,
        }),
    ),
    defineTopicTool(
        'tm_list_topics',
        'TopicMemo',
        'ListTopics',
        '获取指定 Agent 或群组的话题列表（标题、topic_id、创建时间与未读标记）。支持关键词 query 过滤、unreadOnly 筛选及 limit/offset 分页。',
        schema(
            {
                maid: identifier,
                query: identifier,
                unreadOnly: boolean,
                limit: { type: 'integer', minimum: 1, maximum: 200 },
                offset: natural,
            },
            ['maid'],
        ),
        true,
        args => ({
            maid: args.maid,
            query: args.query,
            unreadOnly: args.unreadOnly,
            limit: args.limit,
            offset: args.offset,
        }),
    ),
    defineTopicTool(
        'tm_outline_topic',
        'TopicMemo',
        'OutlineTopic',
        '渐进阅读 L1：获取指定话题的轻量楼层大纲（#seq 序号、发言者、时间、字数、工具/附件计数与首行摘要），避免直接拉取长正文；支持 startSeq/endSeq/limit。',
        schema(
            {
                topicId: identifier,
                maid: identifier,
                startSeq: positive,
                endSeq: positive,
                limit: { type: 'integer', minimum: 1, maximum: 200 },
            },
            ['topicId'],
        ),
        true,
        args => ({
            topic_id: args.topicId,
            maid: args.maid,
            startSeq: args.startSeq,
            endSeq: args.endSeq,
            limit: args.limit,
        }),
    ),
    defineTopicTool(
        'tm_search_topic',
        'TopicMemo',
        'SearchTopic',
        '渐进阅读 L2：在单话题内部按字面量或正则检索匹配楼层，返回命中 #seq 序号与上下文片段，用于精准定位后再点读正文。',
        schema(
            {
                topicId: identifier,
                query: identifier,
                maid: identifier,
                isRegex: boolean,
                caseSensitive: boolean,
                includeTools: boolean,
                maxResults: { type: 'integer', minimum: 1, maximum: 100 },
            },
            ['topicId', 'query'],
        ),
        true,
        args => ({
            topic_id: args.topicId,
            query: args.query,
            maid: args.maid,
            isRegex: args.isRegex,
            caseSensitive: args.caseSensitive,
            includeTools: args.includeTools,
            maxResults: args.maxResults,
        }),
    ),
    defineTopicTool(
        'tm_get_topic_content',
        'TopicMemo',
        'GetTopicContent',
        '渐进阅读 L3：按 topicId 读取单聊或群聊对话历史。超长话题默认自动截取尾部窗口；支持 tail、startSeq/endSeq 精确翻页、maxCharsPerTurn 单楼上限与 includeTools 展开可见工具结果；代码缩进与泛型尖括号完整保留。',
        schema(
            {
                topicId: identifier,
                maid: identifier,
                tail: positive,
                startSeq: positive,
                endSeq: positive,
                maxCharsPerTurn: { type: 'integer', minimum: 200, maximum: 200000 },
                includeTools: boolean,
            },
            ['topicId'],
        ),
        true,
        args => ({
            topic_id: args.topicId,
            maid: args.maid,
            tail: args.tail,
            startSeq: args.startSeq,
            endSeq: args.endSeq,
            maxCharsPerTurn: args.maxCharsPerTurn,
            includeTools: args.includeTools,
        }),
    ),
];

function normalizeVcpUrl(rawUrl = DEFAULT_VCP_URL) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new Error('vcpUrl must be a non-empty string');
    let parsed;
    try { parsed = new URL(rawUrl.trim()); }
    catch { throw new Error('vcpUrl must be a valid HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('vcpUrl must use http or https');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('vcpUrl must not include credentials, query or hash');
    }
    return parsed.toString().replace(/\/+$/, '');
}

function assertSafeValue(key, value) {
    const text = String(value);
    if (CONTROL_CHARS.test(text)) throw new Error(`Invalid control character in ${key}`);
    if (RESERVED_ESCAPE.test(text)) throw new Error(`Reserved VCP escape marker is not allowed in ${key}`);
    return text;
}

// 与前端 modules/services/topicRiverQuote.js 对齐的纯 CJS V2 引用编码器（保持双层折叠卡片完全惰性且零 DOM 副作用）
const escapeQuoteText = text => String(text).replace(/[&<>[\]{}\\`*_~!#@|\u2028\u2029]/g,
    char => `&#${char.charCodeAt(0)};`);

function clipQuoteContent(text, maxChars = MAX_RIVER_ITEM_CHARS) {
    const normalized = String(text || '').trim();
    if (normalized.length <= maxChars) return normalized;
    const headLen = Math.floor(maxChars * 0.75);
    const tailLen = Math.max(50, Math.floor(maxChars * 0.25));
    return `${safeSlice(normalized, 0, headLen)}\n\n［随附内容过长，中段已截断］\n\n${safeSlice(normalized, normalized.length - tailLen, normalized.length)}`;
}

function encodeV2RiverRows(items = []) {
    if (!Array.isArray(items) || !items.length) return '';
    const rows = [];
    let totalChars = 0;
    for (const item of items) {
        if (!item || typeof item.content !== 'string' || !item.content.trim()) continue;
        const kind = item.kind === 'tool' ? '工具结果' : item.kind === 'user' ? '用户' : '助手';
        const cleanName = typeof item.name === 'string' ? item.name.replace(/\s+/gu, ' ').trim() : '';
        const label = cleanName ? `${escapeQuoteText(cleanName)}（${kind}）` : kind;
        const remaining = MAX_RIVER_TOTAL_CHARS - totalChars;
        if (remaining < 200) break;
        const clipped = clipQuoteContent(item.content, Math.min(MAX_RIVER_ITEM_CHARS, remaining));
        totalChars += clipped.length;
        const body = clipped.split(/\r\n?|\n/).map(line => (line ? `> ${escapeQuoteText(line)}` : '>'));
        rows.push([`#### ${rows.length + 1} · ${label}`, ...body].join('\n'));
    }
    return rows.length ? `${RIVER_V2_HEADER}\n${rows.join('\n\n')}\n${RIVER_V2_FOOTER}` : '';
}

async function readLocalSourceRows(vchatDataDir, topicId, lastN) {
    if (!vchatDataDir || !topicId || !lastN) return [];
    const owner = await findOwnerByTopicId(vchatDataDir, topicId);
    if (!owner) return [];
    let history = [];
    try {
        ({ history } = await loadTopicHistory(vchatDataDir, owner, topicId));
    } catch {
        return [];
    }
    const userName = await findUserName(vchatDataDir);
    const recent = [];
    for (let i = history.length - 1; i >= 0 && recent.length < lastN; i--) {
        const entry = history[i];
        if (!entry || entry.isThinking === true || (entry.role !== 'user' && entry.role !== 'assistant')) continue;
        const rawText = typeof entry.content === 'string'
            ? entry.content
            : (Array.isArray(entry.content)
                ? entry.content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n')
                : (entry.content?.text || ''));
        if (/^\s*<!--\s*VCP_TOOL_PAYLOAD\s*-->/.test(rawText) || /^\s*\[(?:系统提示|系统邀请指令)[:：]?\]/.test(rawText)) {
            continue;
        }
        let bodyText = rawText.replace(/^\[VCP_TOPIC_RIVER_(V[12])\]\r?\n[\s\S]*?^\[\/VCP_TOPIC_RIVER_\1\][ \t]*$/gm, '');
        if (entry.role === 'user') {
            bodyText = bodyText.replace(/^[ \t]*\[系统通知\][ \t]*\r?\n[\s\S]*?^[ \t]*\[系统通知结束\][ \t]*(?=\r?\n|$)(?:\r?\n)?/gm, '');
        }
        const cleaned = cleanHtmlContent(bodyText);
        if (!cleaned) continue;
        const speaker = entry.role === 'user'
            ? (entry.name || userName)
            : (entry.name || entry.speakerName || entry._metadata?.speaker_name || owner.name);
        recent.unshift({ kind: entry.role, name: speaker, content: cleaned });
    }
    return recent;
}

function parseMarkdownTopicTurns(markdownText, lastN) {
    if (typeof markdownText !== 'string' || !markdownText.trim()) return [];
    const rows = [];
    const blocks = markdownText.split(/(?:^|\n)### \[#\d+\]\s+/);
    for (let i = 1; i < blocks.length; i++) {
        const idx = blocks[i].indexOf('\n');
        if (idx < 0) continue;
        const speaker = blocks[i].slice(0, idx).trim();
        const body = blocks[i].slice(idx + 1).trim();
        if (speaker && body) rows.push({ kind: 'assistant', name: speaker, content: body });
    }
    return rows.slice(-lastN);
}

function formatToolRequest(plugin, command, rawFields = {}) {
    assertSafeValue('tool_name', plugin);
    assertSafeValue('command', command);
    const lines = [
        BLOCK_START,
        `tool_name:${ESCAPE_START}${plugin}${ESCAPE_END},`,
        `command:${ESCAPE_START}${command}${ESCAPE_END}`,
    ];
    for (const [key, value] of Object.entries(rawFields)) {
        if (value === undefined || value === null) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid field name: ${key}`);
        const safe = assertSafeValue(key, value);
        lines[lines.length - 1] += ',';
        lines.push(`${key}:${ESCAPE_START}${safe}${ESCAPE_END}`);
    }
    lines.push(BLOCK_END);
    return lines.join('\n');
}

async function readBoundedText(response, limit = RESPONSE_LIMIT) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let total = 0;
    let output = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel().catch(() => {});
            throw new Error(`VCP response exceeded ${limit} bytes`);
        }
        output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
}

function extractErrorText(status, rawText, parsed) {
    if (parsed && typeof parsed === 'object') {
        if (typeof parsed.plugin_error === 'string' && parsed.plugin_error.trim()) return parsed.plugin_error;
        if (typeof parsed.plugin_execution_error === 'string' && parsed.plugin_execution_error.trim()) return parsed.plugin_execution_error;
        if (parsed.error === 'Internal Server Error' && typeof parsed.details === 'string' && parsed.details.trim()) {
            return parsed.details;
        }
        if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
        if (typeof parsed.details === 'string' && parsed.details.trim()) return parsed.details;
        if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message;
    }
    const trimmed = String(rawText || '').trim();
    return trimmed ? `HTTP ${status}: ${trimmed}` : `HTTP ${status}`;
}

function formatTopicReceiptMarkdown(toolName, payload) {
    if (!payload || typeof payload !== 'object') return String(payload ?? '');
    if (toolName === 'ts_list_agents' && Array.isArray(payload.agents)) {
        const rows = payload.agents.map(a => `- ${a.name}（id: \`${a.id}\`）`);
        return `## 已注册 Agent 地址簿（共 ${payload.total ?? payload.agents.length} 位）\n\n${rows.join('\n') || '（空）'}`;
    }
    if (toolName === 'ts_list_groups' && Array.isArray(payload.groups)) {
        const rows = payload.groups.map(g => `- ${g.name}（id: \`${g.id}\`）`);
        return `## 已注册群组地址簿（共 ${payload.total ?? payload.groups.length} 个）\n\n${rows.join('\n') || '（空）'}`;
    }
    if (toolName === 'ts_list_recent_topics' && Array.isArray(payload.topics)) {
        const ownerLabel = payload.owner ? `${payload.owner.name} (\`${payload.owner.id}\`, ${payload.owner.type})` : '';
        const rows = payload.topics.map((t, i) => `${i + 1}. ${t.title || '(无标题)'} · \`${t.topic_id}\``);
        return `## ${ownerLabel} 最近话题（共 ${payload.total ?? payload.topics.length} 个，展示最新 ${payload.topics.length} 条）\n\n${rows.join('\n') || '（暂无话题）'}`;
    }
    if (toolName === 'ts_check_unread_messages') {
        const list = Array.isArray(payload.unread_topics) ? payload.unread_topics : [];
        const rows = list.map(t => `- **${t.topic_name}** (\`${t.topic_id}\`) · ${t.message_count ?? '?'} 条消息`);
        return `## 未读状态检查：${payload.agent_name || ''}（${payload.has_unread ? `有 ${list.length} 个未读话题` : '暂无未读'}）\n\n${rows.join('\n')}`;
    }
    if (toolName === 'ts_check_new_topics') {
        const list = Array.isArray(payload.topics) ? payload.topics : [];
        const rows = list.map(t => `- **${t.topic_name}** (\`${t.topic_id}\`) · ${Number(t.age_hours || 0).toFixed(1)}h 前`);
        return `## 近期新话题检查：${payload.agent_name || ''}（命中 ${payload.new_topics_count ?? list.length} 条）\n\n${rows.join('\n')}`;
    }
    if (toolName === 'ts_check_topic_ownership') {
        return `## 话题归属核验\n- 话题：${payload.topic_name || '-'}\n- 创建者：${payload.creator_name || 'unknown'}\n- 是否归属调用方：${payload.is_owner ? '是' : '否'}`;
    }
    if (toolName === 'ts_reply_to_topic') {
        const lines = [
            `## 话题投递回执`,
            `- 状态：${payload.accepted ? '已受理并入队' : (payload.queued ? '已进入中央队列' : '已提交')}${payload.replayed ? '（幂等复放）' : ''}`,
            `- 目标话题：\`${payload.topic_id || '-'}\` (${payload.target_type || '-'} · \`${payload.target_id || '-'}\`)`,
            ...(payload.message_id ? [`- 消息 ID：\`${payload.message_id}\``] : []),
            ...(payload.entryId ? [`- 入场队列 ID：\`${payload.entryId}\``] : []),
            ...(payload.flowlock_requested ? ['- 心流认领：已预约（首轮落盘后按空闲条件认领）'] : []),
        ];
        return lines.join('\n');
    }
    if (toolName === 'ts_create_topic' || toolName === 'ts_create_flowlock_topic') {
        return [
            `## ${payload.message || '话题创建成功'}`,
            `- 目标：${payload.agent_name || '-'} (\`${payload.agent_id || '-'}\`)`,
            `- 新话题 ID：\`${payload.topic_id || '-'}\``,
            ...(payload.flowlock_status ? [`- 心流状态：${payload.flowlock_status}（心跳 ${payload.heartbeat_seconds ?? 5}s）`] : []),
        ].join('\n');
    }
    return JSON.stringify(payload, null, 2);
}

function resolveDefaultLocalAppDataDir(config) {
    if (typeof config.vcpAppDataPath === 'string' && config.vcpAppDataPath.trim()) {
        return path.resolve(config.vcpAppDataPath);
    }
    if (config.topicReadMode === 'http') return null;
    const baseUrl = normalizeVcpUrl(config.vcpUrl || DEFAULT_VCP_URL);
    // 仅当保持默认本机主服务地址或显式要求 local 模式时启用同仓直读，避免干扰自定义远端或 Mock 测试端口。
    if (config.topicReadMode !== 'local' && baseUrl !== DEFAULT_VCP_URL) return null;
    const candidate = path.resolve(__dirname, '../../../../AppData');
    return fs.existsSync(path.join(candidate, 'Agents')) ? candidate : null;
}

function createTopicClient(config = {}) {
    const baseUrl = normalizeVcpUrl(config.vcpUrl || DEFAULT_VCP_URL);
    const endpoint = `${baseUrl}/v1/human/tool`;
    const apiKey = typeof config.vcpKey === 'string' ? config.vcpKey.trim() : '';
    if (!apiKey) throw new Error('enableTopic requires vcpKey or VCP_API_KEY');
    const timeoutMs = Number.isInteger(config.topicTimeoutMs) && config.topicTimeoutMs > 0
        ? config.topicTimeoutMs
        : DEFAULT_TIMEOUT_MS;
    const localAppDataDir = resolveDefaultLocalAppDataDir(config);
    const inflight = new Set();
    let closed = false;

    async function callViaHttp(tool, pluginArgs) {
        let body;
        try {
            body = formatToolRequest(tool.plugin, tool.command, pluginArgs);
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: error.message }] };
        }
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        inflight.add(controller);
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body,
                signal: controller.signal,
            });
            const rawText = await readBoundedText(response);
            let parsed = null;
            if (rawText.trim()) {
                try { parsed = JSON.parse(rawText); }
                catch {
                    if (response.ok) {
                        return { isError: true, content: [{ type: 'text', text: 'Invalid JSON response from VCP /v1/human/tool' }] };
                    }
                }
            } else if (response.ok) {
                return { isError: true, content: [{ type: 'text', text: 'Empty response from VCP /v1/human/tool' }] };
            }

            const isPluginError = parsed && typeof parsed === 'object' && (
                parsed.status === 'error' ||
                typeof parsed.plugin_error === 'string' ||
                typeof parsed.plugin_execution_error === 'string'
            );
            if (!response.ok || isPluginError) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: extractErrorText(response.status, rawText, parsed) }],
                };
            }

            if (tool.plugin === 'TopicMemo') {
                const text = typeof parsed?.original_plugin_output === 'string'
                    ? parsed.original_plugin_output
                    : typeof parsed?.result === 'string'
                        ? parsed.result
                        : JSON.stringify(parsed, null, 2);
                return { content: [{ type: 'text', text }] };
            }

            const payload = parsed && typeof parsed === 'object' ? parsed : { value: parsed };
            return {
                content: [{ type: 'text', text: formatTopicReceiptMarkdown(tool.name, payload) }],
                structuredContent: payload,
            };
        } catch (error) {
            const reason = timedOut
                ? `VCP /v1/human/tool request timed out after ${timeoutMs}ms`
                : closed
                    ? 'Topic request aborted because bridge is closing'
                    : `VCP /v1/human/tool request failed: ${error.message}`;
            return { isError: true, content: [{ type: 'text', text: reason }] };
        } finally {
            clearTimeout(timer);
            inflight.delete(controller);
        }
    }

    return {
        async call(tool, args = {}) {
            if (closed) return { isError: true, content: [{ type: 'text', text: 'Topic client is closed.' }] };
            const pluginArgs = { ...tool.toArgs(args) };

            if (tool.plugin === 'TopicMemo' && localAppDataDir) {
                try {
                    const text = await executeTopicMemo({ ...pluginArgs, command: tool.command }, { vchatDataDir: localAppDataDir });
                    return {
                        content: [{ type: 'text', text }],
                        structuredContent: { mode: 'local_direct', command: tool.command, textLength: text.length },
                    };
                } catch (error) {
                    return { isError: true, content: [{ type: 'text', text: `[TopicMemo] ${error.message}` }] };
                }
            }

            if (tool.name === 'ts_reply_to_topic' && (args.riverLast || args.contextItems)) {
                try {
                    const rows = [];
                    if (args.riverLast) {
                        const sourceId = args.riverTopicId || args.sourceTopicId;
                        if (!sourceId) {
                            return { isError: true, content: [{ type: 'text', text: 'riverLast requires sourceTopicId or riverTopicId' }] };
                        }
                        if (localAppDataDir) {
                            const localRows = await readLocalSourceRows(localAppDataDir, sourceId, args.riverLast);
                            rows.push(...localRows);
                        } else {
                            const remoteGet = topicTools.find(t => t.name === 'tm_get_topic_content');
                            const remoteRes = await callViaHttp(remoteGet, { topic_id: sourceId, tail: args.riverLast });
                            if (!remoteRes.isError && remoteRes.content?.[0]?.text) {
                                rows.push(...parseMarkdownTopicTurns(remoteRes.content[0].text, args.riverLast));
                            }
                        }
                    }
                    if (Array.isArray(args.contextItems)) {
                        for (const item of args.contextItems) {
                            assertSafeValue('contextItems.content', item.content);
                            if (item.name) assertSafeValue('contextItems.name', item.name);
                            rows.push({ kind: item.kind || 'tool', name: item.name, content: item.content });
                        }
                    }
                    const suffix = encodeV2RiverRows(rows);
                    if (suffix) {
                        pluginArgs.message = `${String(pluginArgs.message).trimEnd()}\n\n${suffix}`;
                    }
                } catch (error) {
                    return { isError: true, content: [{ type: 'text', text: error.message }] };
                }
            }

            return callViaHttp(tool, pluginArgs);
        },
        async close() {
            closed = true;
            for (const controller of inflight) controller.abort();
            inflight.clear();
        },
    };
}

module.exports = {
    DEFAULT_VCP_URL,
    topicTools,
    normalizeVcpUrl,
    formatToolRequest,
    encodeV2RiverRows,
    createTopicClient,
};