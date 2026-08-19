'use strict';

const MCP_ENDPOINT = 'https://mcp.deepwiki.com/mcp';
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_QUESTION_LENGTH = 12000;
const MAX_CONTENT_LENGTH = 120000;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CONTENT_LENGTH = 24000;

const TARGETS = Object.freeze({
    frontend: Object.freeze({
        id: 'frontend',
        title: 'VCPChat WikiBot',
        repoName: 'lioensky/VCPChat',
        url: 'https://deepwiki.com/lioensky/VCPChat'
    }),
    backend: Object.freeze({
        id: 'backend',
        title: 'VCPToolBox WikiBot',
        repoName: 'lioensky/VCPToolBox',
        url: 'https://deepwiki.com/lioensky/VCPToolBox'
    }),
    fullstack: Object.freeze({
        id: 'fullstack',
        title: 'VCP Fullstack WikiBot',
        repoName: Object.freeze(['lioensky/VCPToolBox', 'lioensky/VCPChat']),
        url: 'https://deepwiki.com/search?q=lioensky%2FVCPToolBox%20lioensky%2FVCPChat'
    })
});

function getTarget(targetId) {
    return TARGETS[String(targetId || '').toLowerCase()] || null;
}

function extractText(result) {
    if (!result) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result.content)) {
        return result.content
            .filter(item => item && item.type === 'text')
            .map(item => item.text || '')
            .join('\n\n');
    }
    if (result.result) return extractText(result.result);
    if (result.answer) return String(result.answer);
    if (result.text) return String(result.text);
    return JSON.stringify(result, null, 2);
}

function extractQueryId(result) {
    if (!result || typeof result !== 'object') return null;
    const candidates = [
        result.queryId,
        result.query_id,
        result.id,
        result.conversationId,
        result.conversation_id,
        result.sessionId,
        result.session_id,
        result.result?.queryId,
        result.result?.query_id,
        result.result?.id,
        result.metadata?.queryId,
        result.metadata?.query_id,
        result.meta?.queryId,
        result.meta?.query_id
    ];
    return candidates.find(value => typeof value === 'string' && value.trim())?.trim() || null;
}

function truncate(text, maxLength = MAX_CONTENT_LENGTH) {
    const normalized = String(text || '');
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}\n\n---\n内容已截断：原始 ${normalized.length} 字符，保留前 ${maxLength} 字符。`;
}

function parseSSEText(text) {
    let lastData = null;
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            lastData = JSON.parse(payload);
        } catch {
            // Ignore malformed keepalive or partial SSE frames.
        }
    }
    if (!lastData) return { content: [{ type: 'text', text: String(text || '') }] };
    if (lastData.error) throw new Error(`DeepWiki MCP: ${JSON.stringify(lastData.error)}`);
    return lastData.result || lastData;
}

function buildQuestion(question, deepResearch) {
    const normalized = String(question || '').trim();
    if (!deepResearch || normalized.startsWith('[DEEP RESEARCH]')) return normalized;
    return `[DEEP RESEARCH] ${normalized}`;
}

function buildFirstTurnQuestion(target, question, history = []) {
    const targetContext = target.id === 'fullstack'
        ? '当前为全栈联动模式。请同时参考 VCPToolBox 与 VCPChat，并解释前后端之间的职责、调用链和数据流。'
        : `当前查询目标仓库为 ${target.repoName}。`;
    const conversationContext = history.length
        ? ['此前对话上下文：', ...history.map(message => `${message.role === 'assistant' ? 'Nova' : '用户'}：${message.content}`)].join('\n')
        : '这是本次对话的第一个问题。';
    return [
        '<hidden_vcp_service_prompt>',
        '你是 VCP 官方源码导览助手 Nova。请用友好、准确、专业的方式帮助用户理解 VCP 的架构、源码路径、模块职责和调用关系。如果证据不足，请明确说明。',
        '</hidden_vcp_service_prompt>',
        targetContext,
        conversationContext,
        `用户问题：${question}`
    ].join('\n\n');
}

function normalizeHistory(history) {
    if (!Array.isArray(history)) return [];
    const normalized = history
        .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
        .map(message => ({ role: message.role, content: String(message.content || '').trim() }))
        .filter(message => message.content)
        .slice(-MAX_HISTORY_MESSAGES);
    let totalLength = normalized.reduce((total, message) => total + message.content.length, 0);
    while (normalized.length && totalLength > MAX_HISTORY_CONTENT_LENGTH) {
        totalLength -= normalized.shift().content.length;
    }
    return normalized;
}

function validateRequest(input) {
    const target = getTarget(input?.target);
    if (!target) throw new TypeError('Ask Nova 目标无效。');
    const question = String(input?.question || '').trim();
    if (!question) throw new TypeError('Ask Nova 问题不能为空。');
    if (question.length > MAX_QUESTION_LENGTH) {
        throw new RangeError(`Ask Nova 问题不能超过 ${MAX_QUESTION_LENGTH} 个字符。`);
    }
    return {
        target,
        question,
        history: normalizeHistory(input?.history),
        deepResearch: input?.deepResearch === true
    };
}

function ensureMcpSuccess(result) {
    if (result?.isError === true) {
        throw new Error(extractText(result) || 'DeepWiki MCP 返回错误。');
    }
    return result;
}

function createDeepWikiService(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const endpoint = options.endpoint || MCP_ENDPOINT;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const maxContentLength = Number.isFinite(options.maxContentLength)
        ? options.maxContentLength
        : MAX_CONTENT_LENGTH;

    if (typeof fetchImpl !== 'function') throw new TypeError('DeepWiki service requires fetch.');

    async function mcpCall(toolName, args, externalSignal) {
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const abortFromExternal = () => controller.abort();
        externalSignal?.addEventListener?.('abort', abortFromExternal, { once: true });

        try {
            if (externalSignal?.aborted) controller.abort();
            const response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'tools/call',
                    params: { name: toolName, arguments: args },
                    id: Date.now()
                }),
                signal: controller.signal
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => 'Unknown error');
                throw new Error(`DeepWiki MCP HTTP ${response.status}: ${detail.slice(0, 800)}`);
            }
            const contentType = response.headers?.get?.('content-type') || '';
            if (contentType.includes('application/json')) {
                const data = await response.json();
                if (data.error) throw new Error(`DeepWiki MCP: ${JSON.stringify(data.error)}`);
                return ensureMcpSuccess(data.result || data);
            }
            const text = await response.text();
            if (contentType.includes('text/event-stream')) return ensureMcpSuccess(parseSSEText(text));
            try {
                const data = JSON.parse(text);
                if (data.error) throw new Error(`DeepWiki MCP: ${JSON.stringify(data.error)}`);
                return ensureMcpSuccess(data.result || data);
            } catch (error) {
                if (/^DeepWiki MCP:/.test(error?.message || '')) throw error;
                return { content: [{ type: 'text', text }] };
            }
        } catch (error) {
            if (error?.name === 'AbortError') {
                if (timedOut) throw new Error(`DeepWiki MCP 请求超时（${Math.round(timeoutMs / 1000)} 秒）。`);
                const cancelled = new Error('Ask Nova 请求已取消。');
                cancelled.code = 'ASK_NOVA_CANCELLED';
                throw cancelled;
            }
            throw error;
        } finally {
            clearTimeout(timeout);
            externalSignal?.removeEventListener?.('abort', abortFromExternal);
        }
    }

    async function ask(input, options = {}) {
        const { target, question, history, deepResearch } = validateRequest(input);
        // The current public DeepWiki MCP schema accepts only repoName and
        // question. Conversation continuity is therefore carried as a bounded
        // transcript instead of sending the website's obsolete queryId fields.
        const result = await mcpCall('ask_question', {
            repoName: target.repoName,
            question: buildQuestion(buildFirstTurnQuestion(target, question, history), deepResearch)
        }, options.signal);

        return {
            answer: truncate(extractText(result) || '(DeepWiki 没有返回文本内容)', maxContentLength),
            queryId: extractQueryId(result),
            target: target.id
        };
    }

    return Object.freeze({ ask, targets: TARGETS });
}

module.exports = {
    MCP_ENDPOINT,
    TARGETS,
    DEFAULT_TIMEOUT_MS,
    MAX_QUESTION_LENGTH,
    MAX_CONTENT_LENGTH,
    MAX_HISTORY_MESSAGES,
    createDeepWikiService,
    extractQueryId,
    extractText,
    getTarget,
    parseSSEText,
    truncate,
    validateRequest
};
