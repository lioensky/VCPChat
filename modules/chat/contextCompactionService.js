import { effectiveContextHistory, prepareCompactionState } from './contextCompactionState.js';
import { readCompactionResponse } from './contextCompactionStream.js';
import { compactionSettings, buildCompactionMessages, createCheckpointMessage } from './contextCompactionPrompts.js';

const scopeKey = scope => `${scope.itemType || 'agent'}:${scope.itemId}:${scope.topicId}`;

/** Compare consumed state, not renderer/runtime metadata or JSON object key order. */
function serializeCompactionState(state) {
    return JSON.stringify(state, (_key, value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    });
}

/** Conservative local estimate, not a tokenizer count. Includes attachment text and metadata. */
export function estimateContextTokens(history, systemPrompt = '') {
    const text = systemPrompt + JSON.stringify(effectiveContextHistory(history));
    let cost = 0;
    for (const character of text) cost += character.codePointAt(0) > 127 ? 1 : 0.3;
    return Math.ceil(cost);
}

export function shouldCompactContext(history, agentConfig, pendingText = '') {
    const limit = Number(agentConfig?.contextTokenLimit);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    const effective = effectiveContextHistory(history);
    if (!effective.length) return false;
    // A checkpoint alone cannot be compressed endlessly when diary retention exceeds the budget.
    if (effective.length === 1 && effective[0].contextCompaction) return false;
    return estimateContextTokens([...effective, { role: 'user', content: pendingText }], agentConfig.systemPrompt || '') >= limit * 0.85;
}

export async function requestContextCompaction({ settings, state, signal, requestId, fetchImpl = globalThis.fetch, onResponse = () => {} }) {
    const config = compactionSettings(settings);
    let url;
    let messages;
    try {
        if (!config.model) throw new Error('请先配置上下文压缩模型');
        url = new URL(settings.vcpServerUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('压缩服务器地址必须使用 HTTP 或 HTTPS');
        messages = buildCompactionMessages(state, settings);
    } catch (error) {
        // Changing the model cannot fix a shared request configuration.
        throw Object.assign(error, { compactionNoFallback: true });
    }
    // Never use chatvcp endpoint: compression must not execute historical tool requests.
    url.pathname = url.pathname.replace(/\/chatvcp\/completions\/?$/, '/chat/completions');
    const response = await fetchImpl(url.href, {
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