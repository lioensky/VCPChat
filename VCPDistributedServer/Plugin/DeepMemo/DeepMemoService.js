'use strict';

const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const cheerio = require('cheerio');
const TurndownService = require('turndown');

const DEFAULTS = Object.freeze({
    backend: 'central',
    legacyFallback: false,
    excludeCurrentTopic: true,
    maxMemoChars: 60_000,
    candidateLimit: 50,
    resultLimit: 8,
    timeoutMs: 30_000,
    queryPreset: '',
    rerankSearch: false,
    rerankUrl: '',
    rerankApi: '',
    rerankModel: '',
    rerankCandidateMultiplier: 3,
    rerankMaxDocumentsPerBatch: 25,
    rerankMaxTokensPerBatch: 60_000,
    rerankTimeoutMs: 30_000
});

let runtime = {
    chatDataService: null,
    config: { ...DEFAULTS },
    logger: console
};

function initialize(options = {}) {
    runtime = {
        chatDataService: options.services?.chatDataService || options.chatDataService || null,
        config: normalizeConfig(options.config || {}),
        logger: options.logger || console
    };
}

async function processToolCall(rawArgs = {}, executionContext = {}) {
    const args = normalizeArgs(rawArgs);
    const trustedContext = normalizeExecutionContext(executionContext);
    const legacyArgs = {
        ...args,
        maid: trustedContext.agentName || args.maid
    };
    const query = combineQuery(args.keyword, runtime.config.queryPreset);
    if (!query) {
        throw new Error('[DeepMemo] 请求中缺少 keyword 参数。');
    }

    const finalResultLimit = args.resultLimit || runtime.config.resultLimit;
    const finalMaxChars = args.maxChars || runtime.config.maxMemoChars;
    const rerankRequested = args.rerank ?? runtime.config.rerankSearch;
    const rerankEnabled = rerankRequested && Boolean(runtime.config.rerankUrl);
    const request = buildCentralRequest(args, executionContext, query, runtime.config);
    if (rerankEnabled) {
        request.resultLimit = Math.min(
            100,
            finalResultLimit * runtime.config.rerankCandidateMultiplier
        );
        request.maxChars = Math.min(
            1_000_000,
            finalMaxChars * runtime.config.rerankCandidateMultiplier
        );
    }

    if (runtime.config.backend === 'legacy') {
        return executeLegacy(legacyArgs);
    }

    try {
        const client = runtime.chatDataService?.client;
        if (!client) {
            const error = new Error('VCP-CDS is unavailable.');
            error.code = 'UNAVAILABLE';
            throw error;
        }

        const response = await client.searchMemories(request, {
            timeoutMs: runtime.config.timeoutMs
        });
        if (!response || !Array.isArray(response.windows)) {
            const error = new Error('VCP-CDS returned an invalid memory search response.');
            error.code = 'INVALID_RESPONSE';
            throw error;
        }

        if (rerankEnabled && response.windows.length > 0) {
            try {
                const reranked = await rerankWindows(
                    response.windows,
                    query,
                    runtime.config
                );
                const selected = selectWindowsWithinBudget(
                    reranked,
                    finalResultLimit,
                    finalMaxChars
                );
                const formatted = formatMemoryWindows(selected);
                if (formatted) return formatted;
            } catch (error) {
                runtime.logger.warn?.(
                    `[DeepMemo] Rerank failed; using CDS ranking: ${error.message}`
                );
                const fallbackWindows = selectWindowsWithinBudget(
                    response.windows,
                    finalResultLimit,
                    finalMaxChars
                );
                const fallbackFormatted = formatMemoryWindows(fallbackWindows);
                if (fallbackFormatted) return fallbackFormatted;
            }
        }

        const formatted = typeof response.formattedResult === 'string'
            ? cleanMemoryOutput(response.formattedResult)
            : '';
        return formatted || `[DeepMemo] 未找到与关键词“${args.keyword}”相关的回忆。`;
    } catch (error) {
        runtime.logger.warn?.(
            `[DeepMemo] Central search failed (${error.code || 'CDS_ERROR'}): ${error.message}`
        );
        if (runtime.config.legacyFallback) {
            runtime.logger.warn?.('[DeepMemo] Falling back to the legacy executable.');
            return executeLegacy(legacyArgs);
        }
        throw new Error(`[DeepMemo] 中央聊天数据服务搜索失败：${error.message}`);
    }
}

function normalizeArgs(rawArgs) {
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
        throw new Error('[DeepMemo] 无效的工具参数。');
    }

    const keyword = firstNonEmptyString(
        rawArgs.keyword,
        rawArgs.key_word,
        rawArgs.KeyWord
    );
    const maid = firstNonEmptyString(rawArgs.maid);
    const owner = rawArgs.owner && typeof rawArgs.owner === 'object'
        ? {
            type: firstNonEmptyString(rawArgs.owner.type, rawArgs.owner.ownerType),
            id: firstNonEmptyString(rawArgs.owner.id, rawArgs.owner.ownerId)
        }
        : null;

    return {
        keyword,
        maid,
        owner,
        agentId: firstNonEmptyString(rawArgs.agentId),
        windowSize: clampInteger(
            rawArgs.window_size ?? rawArgs.windowsize ?? rawArgs.windowSize,
            6,
            1,
            100
        ),
        candidateLimit: clampInteger(rawArgs.candidateLimit, null, 1, 500),
        resultLimit: clampInteger(rawArgs.resultLimit ?? rawArgs.limit, null, 1, 100),
        maxChars: clampInteger(rawArgs.maxChars, null, 1, 1_000_000),
        rerank: toOptionalBoolean(rawArgs.rerank)
    };
}

function buildCentralRequest(args, executionContext, query, config) {
    const trustedContext = normalizeExecutionContext(executionContext);
    const ownerId = trustedContext.agentId || args.owner?.id || args.agentId || null;
    const ownerType = trustedContext.ownerType || args.owner?.type || 'agent';
    const maid = trustedContext.agentName || args.maid || null;

    if (!ownerId && !maid) {
        throw new Error('[DeepMemo] 缺少可用于定位记忆所有者的 Agent 上下文或 maid 参数。');
    }

    const request = {
        query,
        ownerType: ownerType === 'group' ? 'group' : 'agent',
        currentTopicId: trustedContext.topicId || undefined,
        excludeCurrentTopic: config.excludeCurrentTopic,
        windowBefore: args.windowSize,
        windowAfter: args.windowSize,
        candidateLimit: args.candidateLimit || config.candidateLimit,
        resultLimit: args.resultLimit || config.resultLimit,
        maxChars: args.maxChars || config.maxMemoChars
    };

    if (ownerId) {
        request.ownerId = ownerId;
    } else {
        request.maid = maid;
    }
    return request;
}

function normalizeExecutionContext(context) {
    if (!context || typeof context !== 'object') return {};
    const supplied = context.vcpContext && typeof context.vcpContext === 'object'
        ? context.vcpContext
        : context;
    return {
        requestId: firstNonEmptyString(context.requestId, supplied.requestId),
        agentId: firstNonEmptyString(supplied.agentId, supplied.ownerId),
        agentName: firstNonEmptyString(supplied.agentName, supplied.ownerName),
        topicId: firstNonEmptyString(supplied.topicId, supplied.currentTopicId),
        ownerType: firstNonEmptyString(supplied.ownerType)
    };
}

function normalizeConfig(config) {
    return {
        backend: String(config.DeepMemoBackend || DEFAULTS.backend).trim().toLowerCase() === 'legacy'
            ? 'legacy'
            : 'central',
        legacyFallback: toBoolean(
            config.DeepMemoLegacyFallback,
            DEFAULTS.legacyFallback
        ),
        excludeCurrentTopic: toBoolean(
            config.DeepMemoExcludeCurrentTopic,
            DEFAULTS.excludeCurrentTopic
        ),
        maxMemoChars: clampInteger(
            config.MaxMemoTokens,
            DEFAULTS.maxMemoChars,
            1,
            1_000_000
        ),
        candidateLimit: clampInteger(
            config.DeepMemoCandidateLimit,
            DEFAULTS.candidateLimit,
            1,
            500
        ),
        resultLimit: clampInteger(
            config.DeepMemoResultLimit,
            DEFAULTS.resultLimit,
            1,
            100
        ),
        timeoutMs: clampInteger(
            config.DeepMemoTimeoutMs,
            DEFAULTS.timeoutMs,
            100,
            120_000
        ),
        queryPreset: firstNonEmptyString(config.QueryPreset),
        rerankSearch: toBoolean(config.RerankSearch, DEFAULTS.rerankSearch),
        rerankUrl: firstNonEmptyString(config.RerankUrl),
        rerankApi: firstNonEmptyString(config.RerankApi),
        rerankModel: firstNonEmptyString(config.RerankModel),
        rerankCandidateMultiplier: clampInteger(
            config.RerankCandidateMultiplier,
            DEFAULTS.rerankCandidateMultiplier,
            1,
            10
        ),
        rerankMaxDocumentsPerBatch: clampInteger(
            config.RerankMaxDocumentsPerBatch,
            DEFAULTS.rerankMaxDocumentsPerBatch,
            1,
            25
        ),
        rerankMaxTokensPerBatch: clampInteger(
            config.RerankMaxTokensPerBatch,
            DEFAULTS.rerankMaxTokensPerBatch,
            1_000,
            64_000
        ),
        rerankTimeoutMs: clampInteger(
            config.RerankTimeoutMs,
            DEFAULTS.rerankTimeoutMs,
            100,
            120_000
        )
    };
}

function combineQuery(keyword, preset) {
    return [keyword, preset]
        .map(value => typeof value === 'string' ? value.trim() : '')
        .filter(Boolean)
        .join(',');
}

function formatWindowDocument(window) {
    const topic = firstNonEmptyString(window?.topicName);
    const messages = Array.isArray(window?.messages)
        ? window.messages
            .map(message => {
                const content = firstNonEmptyString(message?.contentText);
                if (!content) return '';
                const name = firstNonEmptyString(message?.speakerName)
                    || (message?.role === 'user' ? '用户' : 'Assistant');
                return `${name}: ${content}`;
            })
            .filter(Boolean)
        : [];
    return [topic ? `主题: ${topic}` : '', ...messages].filter(Boolean).join('\n');
}

function formatMemoryWindows(windows) {
    if (!Array.isArray(windows)) return '';
    return windows
        .map((window, index) => {
            const document = formatWindowDocument(window);
            return document ? `[回忆片段${index + 1}]:\n${document}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
}

function estimateTokens(content) {
    // One Unicode code point per token is deliberately conservative for CJK.
    return Array.from(String(content || '')).length;
}

function truncateToTokenBudget(content, budget) {
    const characters = Array.from(String(content || ''));
    return characters.length <= budget
        ? characters.join('')
        : characters.slice(0, Math.max(0, budget)).join('');
}

function createRerankBatches(windows, query, config) {
    const maxDocuments = config.rerankMaxDocumentsPerBatch;
    const maxTokens = config.rerankMaxTokensPerBatch;
    const baseTokens = estimateTokens(query) + 256;
    const documents = windows
        .map((window, originalIndex) => ({
            originalIndex,
            document: formatWindowDocument(window)
        }))
        .filter(item => item.document);

    const batches = [];
    let batch = [];
    let batchTokens = baseTokens;
    for (const item of documents) {
        const documentBudget = Math.max(1, maxTokens - baseTokens - 32);
        const document = truncateToTokenBudget(item.document, documentBudget);
        const documentTokens = estimateTokens(document) + 32;
        if (
            batch.length > 0
            && (batch.length >= maxDocuments || batchTokens + documentTokens > maxTokens)
        ) {
            batches.push(batch);
            batch = [];
            batchTokens = baseTokens;
        }
        batch.push({ ...item, document });
        batchTokens += documentTokens;
    }
    if (batch.length > 0) batches.push(batch);
    return batches;
}

async function rerankWindows(windows, query, config) {
    const endpoint = `${config.rerankUrl.replace(/\/+$/, '')}/v1/rerank`;
    const batches = createRerankBatches(windows, query, config);
    const responses = await Promise.all(batches.map(async batch => {
        const response = await axios.post(endpoint, {
            model: config.rerankModel,
            query,
            documents: batch.map(item => item.document),
            top_n: batch.length
        }, {
            headers: {
                'Content-Type': 'application/json',
                ...(config.rerankApi
                    ? { Authorization: `Bearer ${config.rerankApi}` }
                    : {})
            },
            timeout: config.rerankTimeoutMs
        });
        if (!response?.data || !Array.isArray(response.data.results)) {
            throw new Error('Rerank API returned an invalid response.');
        }
        return response.data.results.map(result => {
            const localIndex = Number.parseInt(result.index, 10);
            const score = Number(result.relevance_score);
            if (
                !Number.isInteger(localIndex)
                || localIndex < 0
                || localIndex >= batch.length
                || !Number.isFinite(score)
            ) {
                throw new Error('Rerank API returned an invalid result item.');
            }
            return {
                originalIndex: batch[localIndex].originalIndex,
                score
            };
        });
    }));

    const scores = new Map();
    for (const result of responses.flat()) {
        const previous = scores.get(result.originalIndex);
        if (previous === undefined || result.score > previous) {
            scores.set(result.originalIndex, result.score);
        }
    }
    if (scores.size !== windows.length) {
        throw new Error('Rerank API did not score every candidate window.');
    }

    return windows
        .map((window, originalIndex) => ({
            window,
            originalIndex,
            score: scores.get(originalIndex)
        }))
        .sort((left, right) => (
            right.score - left.score || left.originalIndex - right.originalIndex
        ))
        .map(item => item.window);
}

function selectWindowsWithinBudget(windows, resultLimit, maxChars) {
    const selected = [];
    let totalChars = 0;
    for (const window of windows) {
        if (selected.length >= resultLimit) break;
        const chars = estimateTokens(formatWindowDocument(window));
        if (selected.length > 0 && totalChars + chars > maxChars) break;
        selected.push(window);
        totalChars += chars;
    }
    return selected;
}

function executeLegacy(args) {
    const executable = path.join(__dirname, 'deepmemo_rust.exe');
    const payload = JSON.stringify({
        maid: args.maid,
        keyword: args.keyword,
        window_size: args.windowSize
    });

    return new Promise((resolve, reject) => {
        const child = spawn(executable, [], {
            cwd: __dirname,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timeout = setTimeout(() => {
            child.kill();
            finish(reject, new Error('[DeepMemo] 旧版回退执行超时。'));
        }, 180_000);

        const finish = (handler, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            handler(value);
        };

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.once('error', error => finish(
            reject,
            new Error(`[DeepMemo] 无法启动旧版回退程序：${error.message}`)
        ));
        child.once('exit', code => {
            if (code !== 0) {
                finish(reject, new Error(
                    `[DeepMemo] 旧版回退程序执行失败：${stderr.trim() || `exit ${code}`}`
                ));
                return;
            }
            try {
                const parsed = JSON.parse(stdout.trim());
                if (parsed.status !== 'success') {
                    throw new Error(parsed.error || 'Legacy DeepMemo reported an error.');
                }
                finish(resolve, String(parsed.result || ''));
            } catch (error) {
                finish(reject, new Error(`[DeepMemo] 旧版回退响应无效：${error.message}`));
            }
        });
        child.stdin.end(payload);
    });
}

function cleanMemoryOutput(content) {
    if (typeof content !== 'string' || !content.trim()) return '';

    if (!/<[a-z][\s\S]*?>/i.test(content)) {
        return stripLeakedCss(content)
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // Parse even fragmentary HTML. Cheerio repairs malformed markup and decodes
    // entities, while explicit removal prevents CSS/JS/accessibility-only text
    // from leaking into the model context.
    const $ = cheerio.load(content, {
        decodeEntities: true,
        xmlMode: false,
        scriptingEnabled: false
    }, false);

    $('style, script, noscript, template, svg, canvas, iframe, object, embed, head, meta, link, img, audio, video, source')
        .remove();
    $('[hidden], [aria-hidden="true"]').remove();
    $('[style]').each((_, element) => {
        const style = String($(element).attr('style') || '');
        if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/i.test(style)) {
            $(element).remove();
        } else {
            $(element).removeAttr('style');
        }
    });
    $('*').removeAttr('class').removeAttr('id').removeAttr('onclick');

    const turndown = new TurndownService({
        headingStyle: 'atx',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        strongDelimiter: '**'
    });
    turndown.remove(['img', 'audio', 'video', 'source']);
    turndown.addRule('safeLinks', {
        filter: 'a',
        replacement(innerContent, node) {
            const label = innerContent.trim();
            const href = node.getAttribute('href') || '';
            if (!label) return '';
            return /^(?:https?:|mailto:)/i.test(href)
                ? `[${label}](${href})`
                : label;
        }
    });

    let markdown = turndown.turndown($.html() || '');
    markdown = stripLeakedCss(markdown);

    return markdown
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function stripLeakedCss(content) {
    // Handles CSS accidentally persisted as visible text by older renderers.
    // The balanced scanner is deliberately limited to @keyframes blocks; it
    // avoids broad "{...}" regexes that could destroy normal chat/code.
    let output = content
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/@(?:charset|import|namespace)\b[^;\n]*;?/gi, '');

    const keyframes = /@(?:-\w+-)?keyframes\b/ig;
    let match;
    while ((match = keyframes.exec(output)) !== null) {
        const open = output.indexOf('{', match.index + match[0].length);
        if (open === -1) {
            output = output.slice(0, match.index);
            break;
        }

        let depth = 0;
        let quote = null;
        let escaped = false;
        let end = output.length;
        for (let index = open; index < output.length; index++) {
            const character = output[index];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (character === '\\') {
                escaped = true;
                continue;
            }
            if (quote) {
                if (character === quote) quote = null;
                continue;
            }
            if (character === '"' || character === '\'') {
                quote = character;
                continue;
            }
            if (character === '{') depth++;
            if (character === '}' && --depth === 0) {
                end = index + 1;
                break;
            }
        }
        output = output.slice(0, match.index) + output.slice(end);
        keyframes.lastIndex = match.index;
    }
    return output;
}

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function clampInteger(value, fallback, minimum, maximum) {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

function toOptionalBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return null;
}

function toBoolean(value, fallback) {
    return toOptionalBoolean(value) ?? fallback;
}

function resetForTests() {
    runtime = {
        chatDataService: null,
        config: { ...DEFAULTS },
        logger: console
    };
}

module.exports = {
    initialize,
    processToolCall,
    _test: {
        buildCentralRequest,
        cleanMemoryOutput,
        combineQuery,
        createRerankBatches,
        estimateTokens,
        formatMemoryWindows,
        formatWindowDocument,
        normalizeArgs,
        normalizeConfig,
        rerankWindows,
        resetForTests,
        selectWindowsWithinBudget,
        stripLeakedCss
    }
};