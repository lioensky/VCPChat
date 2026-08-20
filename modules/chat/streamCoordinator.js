import { createStreamSession, normalizeStreamTerminal } from './streamSession.js';

const freeze = value => Object.freeze(value);
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const errorDto = error => freeze({
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'Unknown stream error'),
});
const immutableDto = value => {
    if (Array.isArray(value)) return freeze(value.map(immutableDto));
    if (value && typeof value === 'object') {
        if (value instanceof Error) return errorDto(value);
        const copy = {};
        for (const [key, nested] of Object.entries(value)) copy[key] = immutableDto(nested);
        return freeze(copy);
    }
    return value;
};

/**
 * Coordinates one-shot stream operations without owning DOM, Electron or UI state.
 * `run` is the transport provider; `persist` is the sole durable-result provider.
 */
export function createStreamCoordinator({ run, persist, reportError = console.error } = {}) {
    if (typeof run !== 'function') throw new TypeError('stream coordinator requires a run provider');
    if (persist !== undefined && typeof persist !== 'function') throw new TypeError('persist must be a function');

    const records = new Map();
    const replacements = new Map();
    const generations = new Map();
    const saveQueues = new Map();
    let coordinatorDisposed = false;

    const safeReport = (label, error) => {
        try { reportError(label, error); } catch { /* diagnostics cannot own lifecycle */ }
    };
    const owns = record => records.get(record.sessionId) === record && record.accepting;
    const publish = (record, event) => {
        if (!record.surfaceAttached || typeof record.onEvent !== 'function') return;
        try { record.onEvent(immutableDto({
            ...event,
            sessionId: record.sessionId,
            conversationKey: record.conversationKey,
            generation: record.generation,
            surfaceGeneration: record.surfaceGeneration,
        })); } catch (error) { safeReport('[StreamCoordinator] consumer failed', error); }
    };
    const enqueuePersistence = (record, task) => {
        const previous = saveQueues.get(record.conversationKey) || Promise.resolve();
        const queued = previous.then(task);
        const tail = queued.catch(() => {}).finally(() => {
            if (saveQueues.get(record.conversationKey) === tail) saveQueues.delete(record.conversationKey);
        });
        saveQueues.set(record.conversationKey, tail);
        return queued;
    };
    const releaseOwnedResources = async record => {
        const cleanups = record.cleanups.splice(0).reverse();
        for (const cleanup of cleanups) {
            try { await cleanup(); } catch (error) { safeReport('[StreamCoordinator] cleanup failed', error); }
        }
    };

    const start = (request = {}, options = {}) => {
        if (coordinatorDisposed) throw new Error('stream coordinator is disposed');
        const sessionId = String(request.sessionId || request.messageId || '').trim();
        const conversationKey = String(request.conversationKey || '').trim();
        const replacementKey = String(request.replacementKey || request.messageId || sessionId).trim();
        if (!sessionId || !conversationKey || !replacementKey) {
            throw new TypeError('stream start requires session, conversation and replacement identity');
        }
        if (options.onEvent !== undefined && typeof options.onEvent !== 'function') {
            throw new TypeError('onEvent must be a function');
        }

        const authorityKey = `${conversationKey}\u0000${replacementKey}`;
        const previous = replacements.get(authorityKey);
        if (previous) previous.replace();
        const generation = (generations.get(authorityKey) || 0) + 1;
        generations.set(authorityKey, generation);

        const abortController = new AbortController();
        const completion = deferred();
        const record = {
            sessionId,
            conversationKey,
            replacementKey,
            authorityKey,
            generation,
            request: immutableDto({ ...request, sessionId, conversationKey }),
            surfaceGeneration: options.surfaceGeneration,
            onEvent: options.onEvent,
            surfaceAttached: true,
            accepting: true,
            disposeReason: null,
            abortController,
            cleanups: [],
            completion,
            disposePromise: null,
            externalAbortCleanup: null,
            session: createStreamSession({ sessionId, conversationKey, generation }),
        };
        records.set(sessionId, record);
        replacements.set(authorityKey, record);

        const stop = (kind, reason, detachSurface) => {
            if (detachSurface) {
                record.surfaceAttached = false;
                record.onEvent = null;
            }
            if (!record.accepting) return;
            record.disposeReason = reason;
            record.accepting = false;
            record.session.terminal(kind, { reason });
            abortController.abort(reason);
        };
        record.replace = () => stop('discarded', 'replaced', true);

        const controls = freeze({
            signal: abortController.signal,
            pushChunk(chunk) {
                if (!owns(record) || !record.session.pushChunk(chunk, generation)) return false;
                publish(record, { type: 'chunk', text: typeof chunk === 'string' ? chunk : String(chunk?.text || '') });
                return true;
            },
            final(payload = {}) {
                if (!owns(record) || record.session.snapshot.terminal) return false;
                publish(record, { type: 'final', payload: immutableDto(payload) });
                return true;
            },
            terminal(input, payload = {}) {
                if (!owns(record)) return false;
                const terminal = normalizeStreamTerminal(typeof input === 'string' ? { kind: input, ...payload } : input);
                return record.session.terminal(terminal.kind, terminal, generation);
            },
            own(cleanup) {
                if (!owns(record) || typeof cleanup !== 'function') return false;
                record.cleanups.push(cleanup);
                return true;
            },
        });

        publish(record, { type: 'started' });

        const work = (async () => {
            let runResult;
            try {
                runResult = await run(record.request, controls);
                if (!record.session.snapshot.terminal) {
                    const terminal = normalizeStreamTerminal(runResult || 'completed');
                    record.session.terminal(terminal.kind, terminal, generation);
                }
            } catch (error) {
                if (!record.session.snapshot.terminal) {
                    const kind = abortController.signal.aborted ? (record.disposeReason === 'replaced' || record.disposeReason === 'disposed' ? 'discarded' : 'cancelled') : 'failed';
                    record.session.terminal(kind, { error: errorDto(error), reason: record.disposeReason || undefined }, generation);
                }
            }

            const transport = await record.session.done;
            let persistence = freeze({ status: 'skipped' });
            let outcomeKind = transport.kind;
            let phase;
            if (persist && transport.kind !== 'discarded' && records.get(sessionId) === record) {
                try {
                    await enqueuePersistence(record, async () => {
                        if (records.get(sessionId) !== record) return;
                        await persist(freeze({
                            request: record.request,
                            terminal: immutableDto(transport),
                            snapshot: immutableDto(record.session.snapshot),
                        }));
                    });
                    persistence = freeze({ status: records.get(sessionId) === record ? 'saved' : 'skipped' });
                } catch (error) {
                    persistence = freeze({ status: 'failed', error: errorDto(error) });
                    outcomeKind = 'failed';
                    phase = 'persistence';
                    safeReport('[StreamCoordinator] persistence failed', error);
                }
            }

            const outcome = immutableDto({
                kind: outcomeKind,
                phase,
                transport,
                persistence,
                sessionId,
                conversationKey,
                generation,
                text: record.session.snapshot.text,
                chunkCount: record.session.snapshot.chunkCount,
            });
            publish(record, { type: outcome.kind, outcome });
            await releaseOwnedResources(record);
            record.externalAbortCleanup?.();
            if (records.get(sessionId) === record) records.delete(sessionId);
            if (replacements.get(authorityKey) === record) replacements.delete(authorityKey);
            completion.resolve(outcome);
            return outcome;
        })().catch(error => {
            safeReport('[StreamCoordinator] internal failure', error);
            const outcome = immutableDto({ kind: 'failed', phase: 'coordinator', error: errorDto(error), sessionId, conversationKey, generation });
            completion.resolve(outcome);
            return outcome;
        });
        record.work = work;

        if (options.signal) {
            const externalAbort = () => stop('cancelled', 'external-abort', false);
            if (options.signal.aborted) externalAbort();
            else {
                options.signal.addEventListener('abort', externalAbort, { once: true });
                record.externalAbortCleanup = () => options.signal.removeEventListener('abort', externalAbort);
            }
        }

        const handle = freeze({
            sessionId,
            conversationKey,
            generation,
            get done() { return completion.promise; },
            cancel(reason = 'cancelled') {
                stop('cancelled', reason, false);
                return completion.promise;
            },
            dispose(reason = 'disposed') {
                if (!record.disposePromise) {
                    stop('discarded', reason, true);
                    record.disposePromise = work.then(() => completion.promise);
                }
                return record.disposePromise;
            },
        });
        return handle;
    };

    return freeze({
        start,
        async dispose() {
            if (coordinatorDisposed) return;
            coordinatorDisposed = true;
            const active = [...records.values()];
            await Promise.all(active.map(record => {
                record.surfaceAttached = false;
                record.onEvent = null;
                if (record.accepting) {
                    record.disposeReason = 'coordinator-disposed';
                    record.accepting = false;
                    record.session.terminal('discarded', { reason: record.disposeReason });
                    record.abortController.abort(record.disposeReason);
                }
                return record.work;
            }));
        },
    });
}
