import { effectiveContextHistory, prepareCompactionState } from './contextCompactionState.js';
import { compactionSettings, buildCompactionMessages, createCheckpointMessage } from './contextCompactionPrompts.js';

const scopeKey = scope => `${scope.itemType || 'agent'}:${scope.itemId}:${scope.topicId}`;

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
    if (!config.model) throw new Error('请先配置上下文压缩模型');
    const url = new URL(settings.vcpServerUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('压缩服务器地址必须使用 HTTP 或 HTTPS');
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
            messages: buildCompactionMessages(state, settings),
            stream: false,
            ...(requestId ? { requestId } : {}),
        }),
        signal,
    });
    if (!response.ok) throw new Error(`上下文压缩请求失败（HTTP ${response.status}）`);
    const data = await response.json();
    if (data?.error) throw new Error('压缩服务器返回错误，未生成快照，请检查模型配置或服务端日志');
    const choice = data?.choices?.[0];
    onResponse({
        model: typeof data?.model === 'string' ? data.model : config.model,
        finishReason: choice?.finish_reason ?? '未提供',
        content: choice?.message?.content ?? '',
    });
    // Success is a returned report, not a model-authored protocol or finish reason.
    // Tool metadata is never executed; reasoning is never substituted for the answer.
    return choice?.message?.content || choice?.message?.refusal;
}

/** Topic-owned busy state; commit and UI projection remain explicit injected capabilities. */
export function createContextCompactionService({
    historyMutationAuthority,
    request = requestContextCompaction,
    onBusyChanged = () => {},
    timeoutMs = 180000,
    flowlock = null,
    interruptRequest = null,
} = {}) {
    const pending = new Map();
    let disposed = false;

    function isBusy(scope) {
        return Boolean(scope?.itemId && scope?.topicId && pending.has(scopeKey(scope)));
    }

    function cancel(scope) {
        if (!scope?.itemId || !scope?.topicId) return false;
        const controller = pending.get(scopeKey(scope));
        if (!controller || controller.signal.aborted || controller.committing) return false;
        // Same upstream Stop reply gateway; never wait for an unresponsive server
        // before revoking the local request and rejecting late model results.
        try {
            Promise.resolve(interruptRequest?.(controller.requestId)).catch(error =>
                console.warn('[ContextCompaction] Upstream interrupt failed:', error));
        } catch (error) {
            console.warn('[ContextCompaction] Upstream interrupt failed:', error);
        }
        controller.abort();
        return true;
    }

    async function compact({ scope, history, settings, onCommitted = () => {} }) {
        if (disposed) throw new Error('压缩服务已关闭');
        if (scope?.itemType !== 'agent') throw new Error('上下文压缩仅支持单聊');
        if (!historyMutationAuthority?.mutate) throw new Error('上下文压缩缺少历史写入权限');
        if (!compactionSettings(settings).enabled) throw new Error('请先开启上下文智能压缩');
        if (isBusy(scope)) throw new Error('当前话题正在压缩上下文');
        if (history.some(message => message?.isThinking)) throw new Error('请等待当前回复结束后再压缩');
        const snapshot = structuredClone(history);
        const state = prepareCompactionState(snapshot);
        if (!state.sourceCount) throw new Error('当前没有可压缩的上下文');
        const controller = new AbortController();
        controller.requestId = `compaction_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
        const key = scopeKey(scope);
        pending.set(key, controller);
        const notifyBusy = busy => {
            try { onBusyChanged(scope, busy); }
            catch (error) { console.error('[ContextCompaction] Busy projection failed:', error); }
        };
        let timer;
        let flowlockLease = null;
        let responseDiagnostic = null;
        let returnedContent;
        try {
            flowlockLease = flowlock?.suspendForContextCompaction?.(scope.itemId, scope.topicId) || null;
            notifyBusy(true);
            const deadline = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new Error('上下文压缩超时，请重试'));
                }, timeoutMs);
                controller.signal.addEventListener('abort', () => reject(new Error('上下文压缩已取消')), { once: true });
            });
            const response = await Promise.race([
                request({
                    settings, state, signal: controller.signal, requestId: controller.requestId,
                    onResponse: diagnostic => { responseDiagnostic = diagnostic; },
                }),
                deadline,
            ]);
            if (disposed || controller.signal.aborted) throw new Error('上下文压缩已取消');
            returnedContent = response;
            const message = createCheckpointMessage(state, response, settings);
            const original = JSON.stringify(snapshot);
            const outcome = await historyMutationAuthority.mutate({
                ...scope, category: 'context-compaction',
            }, current => {
                if (disposed || controller.signal.aborted) throw new Error('上下文压缩已取消');
                if (JSON.stringify(current) !== original) throw new Error('压缩期间历史已变化，请重新压缩');
                // Once the mutation has handed off to durable storage it cannot
                // safely be rolled back by aborting the network request.
                controller.committing = true;
                return [...current, message];
            });
            // Durable success, not UI rendering, determines whether the heartbeat can resume.
            flowlock?.resumeAfterContextCompaction?.(flowlockLease);
            try { await onCommitted(outcome.history, message); }
            catch (error) { console.error('[ContextCompaction] Committed checkpoint projection failed:', error); }
            return { message, history: outcome.history, warnings: state.warnings };
        } catch (error) {
            if (responseDiagnostic || returnedContent !== undefined) {
                const content = responseDiagnostic?.content ?? returnedContent;
                const raw = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
                error.compactionDiagnostic = [
                    '上下文压缩失败诊断（原历史未修改）',
                    `模型：${responseDiagnostic?.model || compactionSettings(settings).model}`,
                    `服务端结束原因：${responseDiagnostic?.finishReason ?? '未提供'}`,
                    `失败原因：${error.message}`,
                    '',
                    '以下为模型返回正文原文，不是待压缩历史；不包含请求密钥：',
                    raw ?? '（无正文）',
                ].join('\n');
            }
            throw error;
        } finally {
            clearTimeout(timer);
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