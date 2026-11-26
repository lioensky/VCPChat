import { effectiveContextHistory, isContextCheckpoint, prepareCompactionState } from './contextCompactionState.js';
import { assembleRequestMessages, buildDefaultMessageContent, normalizeAgentContextWindowSize } from './chatContextPipeline.js';
import { readCompactionResponse } from './contextCompactionStream.js';
import { compactionSettings, buildCompactionMessages, createCheckpointMessage } from './contextCompactionPrompts.js';
import { vcpChatUrl } from '../utils/vcpServerRoutes.mjs';

const scopeKey = scope => `${scope.itemType || 'agent'}:${scope.itemId}:${scope.topicId}`;

/** Compare consumed state, not renderer/runtime metadata or JSON object key order. */
function serializeCompactionState(state) {
    return JSON.stringify(state, (_key, value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    });
}

// 计数方式：以最近一条带上游用量的 assistant 为基准（上游实际计费的输入），
// 只对它及之后新增的内容做本地估算；没有用量时整段估算。
// 估算公式：汉字按 2 个字符、其余按 1 个字符计，再除以 3。
const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;
const IMAGE_TOKEN_ESTIMATE = 765;
const IMAGE_ATTACHMENT = /^image\//i;

/** Local heuristic for text the provider has not counted yet. */
export function estimateTextTokens(text) {
    const source = String(text ?? '');
    if (!source) return 0;
    // Counted in a loop: a global regex match over megabytes of history allocates one string per character.
    let chineseChars = 0;
    for (let index = 0; index < source.length; index++) {
        const code = source.charCodeAt(index);
        if (code >= 0x4e00 && code <= 0x9fff) chineseChars++;
    }
    return Math.ceil((chineseChars + source.length) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

function estimateMessageTokens(message) {
    const content = message?.content;
    let text = '';
    let images = 0;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
        for (const part of content) {
            if (typeof part === 'string') text += part;
            else if (part?.type === 'text') text += String(part.text ?? '');
            else if (part?.type === 'image_url') images += 1;
        }
    } else if (content != null) text = JSON.stringify(content);
    if (message?.contextCompaction?.checkpoint) text += message.contextCompaction.checkpoint;
    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
        const data = attachment?._fileManagerData || attachment;
        text += `${attachment?.name || ''}${data?.extractedText || attachment?.extractedText || ''}`;
        const frames = data?.imageFrames || attachment?.imageFrames;
        if (Array.isArray(frames) && frames.length) images += frames.length;
        else if (IMAGE_ATTACHMENT.test(String(attachment?.type || data?.type || ''))) images += 1;
    }
    return estimateTextTokens(text) + images * IMAGE_TOKEN_ESTIMATE;
}

function latestUsageAnchor(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        const usage = message?.role === 'assistant' ? message.contextUsage : undefined;
        if (Number.isFinite(usage?.inputTokens) && usage.inputTokens > 0) {
            const prefixEstimate = Number.isFinite(usage.prefixEstimate) && usage.prefixEstimate >= 0
                ? usage.prefixEstimate : undefined;
            return { index, inputTokens: usage.inputTokens, prefixEstimate };
        }
    }
    return null;
}

/**
 * Local estimate of the effective messages before `index`, recorded beside a
 * provider usage so later edits or deletions of those messages can be applied
 * to the provider count.
 */
export function estimateHistoryPrefixTokens(history, index) {
    if (!Array.isArray(history) || index <= 0) return 0;
    return effectiveContextHistory(history.slice(0, index))
        .reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/**
 * The usage anchor stored on an assistant reply that arrived whole (streaming off):
 * provider input tokens plus the local estimate of the messages they covered.
 */
export function providerUsageAnchor(usage, history, index) {
    if (!usage || typeof usage !== 'object' || usage.estimated === true) return undefined;
    const inputTokens = Number(usage.inputTokens ?? usage.prompt_tokens);
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return undefined;
    const outputTokens = Number(usage.outputTokens ?? usage.completion_tokens);
    return {
        inputTokens: Math.round(inputTokens),
        ...(Number.isFinite(outputTokens) && outputTokens >= 0 ? { outputTokens: Math.round(outputTokens) } : {}),
        prefixEstimate: estimateHistoryPrefixTokens(history, index),
    };
}

/**
 * Context size in provider tokens. With a provider-reported anchor `total` is
 * the anchor's input tokens plus a local estimate of the anchor reply and every
 * later message; without one the system prompt and all messages are estimated.
 * `fixed` is the part compaction cannot shrink (expanded system prompt, tool
 * definitions, server-side injections): anchor input minus the estimated
 * messages it covered, or the estimated system prompt without an anchor.
 * When the anchor recorded the estimate of the messages it covered, messages
 * edited or deleted since then are re-estimated instead of trusting the stale
 * provider count.
 */
export function measureContextTokens(history, systemPrompt = '') {
    const messages = effectiveContextHistory(history);
    const anchor = latestUsageAnchor(messages);
    const estimates = messages.map(estimateMessageTokens);
    const sum = list => list.reduce((total, value) => total + value, 0);
    if (!anchor) {
        const fixed = estimateTextTokens(systemPrompt);
        return { total: fixed + sum(estimates), fixed, source: 'estimate' };
    }
    const coveredNow = sum(estimates.slice(0, anchor.index));
    const covered = anchor.prefixEstimate ?? coveredNow;
    if (covered > 0 && anchor.inputTokens < covered) {
        // The provider received less than the local estimate of these messages: the server
        // shortened old tool results before sending, or the estimate runs high for this text.
        // Either way the provider count is what the next request will weigh, so the covered
        // messages are scaled to it instead of being counted at full local size.
        return {
            total: Math.round(coveredNow * (anchor.inputTokens / covered)) + sum(estimates.slice(anchor.index)),
            fixed: 0,
            source: 'provider_usage',
        };
    }
    const fixed = Math.max(0, anchor.inputTokens - covered);
    return {
        total: fixed + coveredNow + sum(estimates.slice(anchor.index)),
        fixed,
        source: 'provider_usage',
    };
}

export function estimateContextTokens(history, systemPrompt = '') {
    return measureContextTokens(history, systemPrompt).total;
}

/** True when compaction is both needed and able to bring the context under `limit`. */
export function contextExceedsCompactableBudget(history, systemPrompt, limit) {
    const { total, fixed } = measureContextTokens(history, systemPrompt);
    return fixed < limit && total >= limit;
}

export function shouldCompactContext(history, agentConfig, pendingText = '') {
    const limit = Number(agentConfig?.contextTokenLimit);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    const effective = effectiveContextHistory(history);
    if (!effective.length) return false;
    // A checkpoint alone cannot be compressed endlessly when diary retention exceeds the budget.
    if (effective.length === 1 && effective[0].contextCompaction) return false;
    // 不可压缩的部分已超过阈值时压缩无济于事，否则每轮都会重新压缩；交给服务端裁剪兜底。
    return contextExceedsCompactableBudget([...effective, { role: 'user', content: pendingText }], agentConfig.systemPrompt || '', limit * 0.85);
}

/**
 * Hard check for sends that do not go through the full preflight (continue,
 * regenerate, heartbeat): refuse instead of sending a request the limit cannot hold.
 * Uses the same measurement as the compaction trigger.
 */
export function assertContextWithinLimit(history, agentConfig, pendingText = '') {
    const limit = Number(agentConfig?.contextTokenLimit);
    if (!Number.isFinite(limit) || limit <= 0) return;
    const effective = effectiveContextHistory(history);
    let messages = pendingText ? [...effective, { role: 'user', content: pendingText }] : effective;
    // A message window sends only the newest messages, so neither the older ones nor a
    // provider count taken over the whole topic say anything about the request size.
    const windowSize = normalizeAgentContextWindowSize(agentConfig.contextMessageWindowSize);
    if (windowSize !== null) {
        messages = messages.slice(-windowSize).map(({ contextUsage, ...message }) => message);
    }
    const { total } = measureContextTokens(messages, agentConfig.systemPrompt || '');
    if (total > limit) {
        throw new Error(`当前上下文估算 ${total} token，超过上限 ${limit}；请先压缩上下文、缩短内容或调整上限。`);
    }
}

/**
 * Estimate assembled text only; encoded media bytes are not text tokens.
 * The assembled request only contains what this client expands. Whatever the
 * server adds (expanded prompt variables, memory, tool definitions) is known
 * from the latest provider usage, so the larger of the two counts is used.
 */
export async function preflightContextSend({
    electronAPI, agentConfig, context, history, pendingMessage,
    extraContextHistory = [], createRequestTextOptions, afterCompaction = false,
}) {
    const limit = Number(agentConfig?.contextTokenLimit);
    if (!Number.isFinite(limit) || limit <= 0) return { shouldCompact: false };

    const assemble = (messages, conversationSnapshot) => assembleRequestMessages({
        ...createRequestTextOptions?.(agentConfig, messages, pendingMessage.id),
        electronAPI, agentConfig, context, history: messages, conversationSnapshot,
        currentUserMessageId: pendingMessage.id,
        buildMessageContent: args => buildDefaultMessageContent({ ...args, includeAttachmentFrames: false }),
    });
    const estimate = ({ messagesForVCP }) => estimateContextTokens(messagesForVCP.map(message => ({
        ...message,
        content: Array.isArray(message.content)
            ? message.content.filter(part => part?.type === 'text')
            : message.content,
    })));
    const full = await assemble([...extraContextHistory, ...history, pendingMessage]);
    // A message window sends only part of the history, so the usage-anchored count of the whole topic does not apply.
    const measured = normalizeAgentContextWindowSize(agentConfig.contextMessageWindowSize) === null
        ? measureContextTokens([...extraContextHistory, ...history, pendingMessage], agentConfig.systemPrompt || '')
        : { source: 'estimate', total: 0, fixed: 0 };
    const anchored = measured.source === 'provider_usage';
    const tokens = Math.max(estimate(full), anchored ? measured.total : 0);
    if (tokens < limit * 0.85) return { shouldCompact: false, tokens };

    const oldHistory = new Set(history);
    const canCompact = !afterCompaction && full.retainedHistory.some(message =>
        oldHistory.has(message) && !isContextCheckpoint(message));
    if (canCompact) {
        // Do not spend a compaction request if the new turn cannot fit even on its own.
        const minimum = Math.max(
            estimate(await assemble([pendingMessage], full.conversationSnapshot)),
            anchored ? measured.fixed + estimateMessageTokens(pendingMessage) : 0);
        if (minimum <= limit) return { shouldCompact: true, tokens };
        throw new Error(`本轮内容（含展开附件）与提示词估算 ${minimum} token，超过上限 ${limit}；请缩短内容、移除附件或调整上限。`);
    }
    if (tokens > limit) {
        const subject = afterCompaction ? '压缩后的请求' : '当前请求（含展开附件）';
        throw new Error(`${subject}估算 ${tokens} token，超过上限 ${limit}；请缩短内容、移除附件或调整上限。`);
    }
    return { shouldCompact: false, tokens };
}
export async function requestContextCompaction({ settings, state, signal, requestId, fetchImpl = globalThis.fetch, onResponse = () => {} }) {
    const config = compactionSettings(settings);
    let url;
    let messages;
    try {
        if (!config.model) throw new Error('请先配置上下文压缩模型');
        // Compression uses standard Chat Completions, never the tool-injection route.
        url = vcpChatUrl(settings.vcpServerUrl);
        messages = buildCompactionMessages(state, settings);
    } catch (error) {
        // Changing the model cannot fix a shared request configuration.
        throw Object.assign(error, { compactionNoFallback: true });
    }
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(settings.vcpApiKey ? { Authorization: `Bearer ${settings.vcpApiKey}` } : {}),
        },
        body: JSON.stringify({
            model: config.model,
            messages,
            stream: true,
            ...(requestId ? { requestId } : {}),
        }),
        signal,
    });
    if (!response.ok) {
        // Do not leave the failed attempt's response body running.
        void response.body?.cancel?.().catch(() => {});
        throw Object.assign(new Error(`上下文压缩请求失败（HTTP ${response.status}）`), {
            compactionNoFallback: response.status === 401 || response.status === 403,
        });
    }
    return readCompactionResponse(response, { signal, model: config.model, onResponse });
}

/** Topic-owned busy state; commit and UI projection remain explicit injected capabilities. */
export function createContextCompactionService({
    historyMutationAuthority,
    request = requestContextCompaction,
    onBusyChanged = () => {},
    timeoutMs = 600000,
    flowlock = null,
    interruptRequest = null,
} = {}) {
    const pending = new Map();
    let disposed = false;

    function isBusy(scope) {
        return Boolean(scope?.itemId && scope?.topicId && pending.has(scopeKey(scope)));
    }

    function interrupt(requestId) {
        if (!requestId) return;
        try {
            Promise.resolve(interruptRequest?.(requestId)).catch(error =>
                console.warn('[ContextCompaction] Upstream interrupt failed:', error));
        } catch (error) {
            console.warn('[ContextCompaction] Upstream interrupt failed:', error);
        }
    }

    function cancel(scope) {
        if (!scope?.itemId || !scope?.topicId) return false;
        const controller = pending.get(scopeKey(scope));
        if (!controller || controller.signal.aborted || controller.committing) return false;
        const requestId = controller.requestId;
        controller.abort();
        // Stop targets the active attempt and never blocks local cancellation.
        interrupt(requestId);
        return true;
    }

    async function attemptCheckpoint({ controller, state, settings, record }) {
        const attempt = new AbortController();
        const requestId = `compaction_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
        controller.requestId = requestId;
        let timer;
        let cancelAttempt;
        let active = true;
        const deadline = new Promise((_, reject) => {
            cancelAttempt = () => {
                reject(new Error('上下文压缩已取消'));
                attempt.abort();
            };
            controller.signal.addEventListener('abort', cancelAttempt, { once: true });
            timer = setTimeout(() => {
                reject(new Error('上下文压缩超时，请重试'));
                attempt.abort();
                interrupt(requestId);
            }, timeoutMs);
        });
        let response;
        try {
            response = await Promise.race([
                deadline,
                (async () => request({
                    settings, state, signal: attempt.signal, requestId,
                    onResponse: diagnostic => { if (active && !attempt.signal.aborted) record.diagnostic = diagnostic; },
                }))(),
            ]);
        } finally {
            active = false;
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', cancelAttempt);
            controller.requestId = null;
        }
        if (controller.signal.aborted) throw new Error('上下文压缩已取消');
        record.content = response;
        return createCheckpointMessage(state, response, settings);
    }

    async function compact({ scope, history, settings, throughMessageId = null, onCommitted = () => {} }) {
        if (disposed) throw new Error('压缩服务已关闭');
        if (scope?.itemType !== 'agent') throw new Error('上下文压缩仅支持单聊');
        if (!historyMutationAuthority?.mutate) throw new Error('上下文压缩缺少历史写入权限');
        const { enabled, model, fallbackModel } = compactionSettings(settings);
        if (!enabled) throw new Error('请先开启上下文智能压缩');
        const models = fallbackModel && model && fallbackModel !== model ? [model, fallbackModel] : [model];
        if (isBusy(scope)) throw new Error('当前话题正在压缩上下文');
        if (history.some(message => message?.isThinking)) throw new Error('请等待当前回复结束后再压缩');
        const snapshot = structuredClone(history);
        // Resolve the boundary before selecting the previous checkpoint: a later
        // checkpoint must never leak future knowledge into an earlier floor.
        const prefixThrough = entries => {
            if (throughMessageId === null) return entries;
            const index = entries.findIndex(message => message?.id === throughMessageId);
            if (index < 0) throw new Error('压缩截止楼层不存在或已变化，请重新选择');
            if (entries[index].isThinking) throw new Error('请等待当前回复结束后再压缩');
            return entries.slice(0, index + 1);
        };
        const state = prepareCompactionState(prefixThrough(snapshot));
        if (!state.sourceCount) throw new Error('当前没有可压缩的上下文');
        const original = serializeCompactionState(state);
        const controller = new AbortController();

        const key = scopeKey(scope);
        pending.set(key, controller);
        const notifyBusy = busy => {
            try { onBusyChanged(scope, busy); }
            catch (error) { console.error('[ContextCompaction] Busy projection failed:', error); }
        };
        const attempts = [];
        try {
            const flowlockLease = flowlock?.suspendForContextCompaction?.(scope.itemId, scope.topicId) || null;
            notifyBusy(true);
            let message;
            for (const attemptedModel of models) {
                if (controller.signal.aborted) throw new Error('上下文压缩已取消');
                const record = { model: attemptedModel };
                attempts.push(record);
                try {
                    message = await attemptCheckpoint({
                        controller, state, record,
                        settings: { ...settings, contextCompactionModel: attemptedModel },
                    });
                    break;
                } catch (error) {
                    record.error = error;
                    if (controller.signal.aborted) throw new Error('上下文压缩已取消');
                    if (error.compactionNoFallback || attempts.length === models.length) {
                        if (attempts.length === 1) throw error;
                        throw new AggregateError(attempts.map(entry => entry.error),
                            `主备模型压缩均失败：${attempts.map(entry => `${entry.model}：${entry.error.message}`).join('；')}`);
                    }
                }
            }
            if (controller.signal.aborted) throw new Error('上下文压缩已取消');

            const outcome = await historyMutationAuthority.mutate({
                ...scope, category: 'context-compaction',
            }, current => {
                if (disposed || controller.signal.aborted) throw new Error('上下文压缩已取消');
                const prefix = prefixThrough(current);
                if (current.some(message => message?.isThinking)
                    || serializeCompactionState(prepareCompactionState(prefix)) !== original) {
                    throw new Error('压缩期间历史已变化，请重新压缩');
                }
                // Once the mutation has handed off to durable storage it cannot
                // safely be rolled back by aborting the network request.
                controller.committing = true;
                // Keep durable source messages and every later checkpoint intact.
                // Effective context is owned by the last checkpoint in floor order.
                return [...prefix, message, ...current.slice(prefix.length)];
            });
            // Durable success, not UI rendering, determines whether the heartbeat can resume.
            flowlock?.resumeAfterContextCompaction?.(flowlockLease);
            try { await onCommitted(outcome.history, message); }
            catch (error) { console.error('[ContextCompaction] Committed checkpoint projection failed:', error); }
            return { message, history: outcome.history, warnings: state.warnings };
        } catch (error) {
            if (attempts.length > 1 || attempts.some(record => record.diagnostic || record.content !== undefined)) {
                const details = attempts.map(record => {
                    const diagnostic = record.diagnostic;
                    const content = diagnostic?.content ?? record.content;
                    const raw = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
                    const responseModel = diagnostic?.model && diagnostic.model !== record.model
                        ? `（响应模型：${diagnostic.model}）` : '';
                    return [
                        `模型：${record.model || '未配置'}${responseModel}`,
                        `服务端结束原因：${diagnostic?.finishReason ?? '未提供'}`,
                        `尝试结果：${record.error?.message ?? (record.content === undefined ? '未返回正文' : '已返回正文')}`,
                        '模型返回正文（非请求历史）：',
                        raw ?? '（无正文）',
                    ].join('\n');
                });
                error.compactionDiagnostic = [
                    '上下文压缩失败诊断',
                    `失败原因：${error.message}`,
                    ...details,
                ].join('\n\n');
            }
            throw error;
        } finally {
            pending.delete(key);
            notifyBusy(false);
        }
    }

    return Object.freeze({
        isBusy,
        cancel,
        compact,
        dispose() {
            disposed = true;
            for (const controller of pending.values()) controller.abort();
        },
    });
}