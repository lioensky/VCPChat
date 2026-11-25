'use strict';

const DEFAULT_VCP_URL = 'http://127.0.0.1:6005';
const DEFAULT_TIMEOUT_MS = 45000;
const RESPONSE_LIMIT = 16 * 1024 * 1024;

const BLOCK_START = '<<<[' + 'TOOL_REQUEST]>>>';
const BLOCK_END = '<<<[' + 'END_TOOL_REQUEST]>>>';
const ESCAPE_START = '「始' + 'ESCAPE」';
const ESCAPE_END = '「末' + 'ESCAPE」';
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
        'ts_reply_to_topic',
        'TopicSponsor',
        'ReplyToTopic',
        '向已有话题留言（传 topicId，省略 mode），或从当前话题向目标 Agent 派工创建独立任务话题（传 mode="new_topic"、sourceTopicId、targetAgent，不传 topicId）。必须提供注册发言者 senderId 或 senderName；不包含 river 自动注入，如需上下文请直接写入 message。',
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
        '获取指定 Agent 或群组的全部历史话题列表（名称、topic_id、创建时间）。',
        schema({ maid: identifier }, ['maid']),
        true,
        args => ({ maid: args.maid }),
    ),
    defineTopicTool(
        'tm_get_topic_content',
        'TopicMemo',
        'GetTopicContent',
        '按 topicId 读取单聊或群聊完整历史对话 Markdown 记录；maid 可选，省略时全域自动反查定位。',
        schema({ topicId: identifier, maid: identifier }, ['topicId']),
        true,
        args => ({ topic_id: args.topicId, maid: args.maid }),
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

function createTopicClient(config = {}) {
    const baseUrl = normalizeVcpUrl(config.vcpUrl || DEFAULT_VCP_URL);
    const endpoint = `${baseUrl}/v1/human/tool`;
    const apiKey = typeof config.vcpKey === 'string' ? config.vcpKey.trim() : '';
    if (!apiKey) throw new Error('enableTopic requires vcpKey or VCP_API_KEY');
    const timeoutMs = Number.isInteger(config.topicTimeoutMs) && config.topicTimeoutMs > 0
        ? config.topicTimeoutMs
        : DEFAULT_TIMEOUT_MS;
    const inflight = new Set();
    let closed = false;

    return {
        async call(tool, args = {}) {
            if (closed) return { isError: true, content: [{ type: 'text', text: 'Topic client is closed.' }] };
            let body;
            try {
                body = formatToolRequest(tool.plugin, tool.command, tool.toArgs(args));
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
                    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
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
    createTopicClient,
};