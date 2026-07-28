'use strict';

const path = require('path');
const { spawn } = require('child_process');
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
    queryPreset: ''
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

    const request = buildCentralRequest(args, executionContext, query, runtime.config);

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
        maxChars: clampInteger(rawArgs.maxChars, null, 1, 1_000_000)
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
        queryPreset: firstNonEmptyString(config.QueryPreset)
    };
}

function combineQuery(keyword, preset) {
    return [keyword, preset]
        .map(value => typeof value === 'string' ? value.trim() : '')
        .filter(Boolean)
        .join(',');
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

    // Parse even fragmentary HTML. Cheerio repairs malformed markup and decodes
    // entities, while explicit removal prevents CSS/JS/accessibility-only text
    // from leaking into the model context.
    const $ = cheerio.load(content, {
        decodeEntities: true,
        xmlMode: false,
        scriptingEnabled: false
    }, false);

    $('style, script, noscript, template, svg, canvas, iframe, object, embed, head, meta, link')
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

function toBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return fallback;
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
        normalizeArgs,
        normalizeConfig,
        resetForTests,
        stripLeakedCss
    }
};