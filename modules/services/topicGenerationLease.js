'use strict';

/**
 * operation receives explicit lifecycle marks; completion alone is not proof
 * of a durable terminal. Never hold the admission serial lock across operation.
 */
async function withTopicGenerationLease({
    admission, scope, token, operation, wait = false, signal, timeoutMs, handoffOwner,
}) {
    if (!admission?.acquire || !admission?.release || typeof operation !== 'function') {
        throw new TypeError('Generation lease dependencies missing');
    }
    const acquired = wait
        ? await admission.acquireWhenIdle(scope, token, {
            signal, timeoutMs, ...(handoffOwner === undefined ? {} : { handoffOwner }),
        })
        : await admission.acquire(scope, token);
    if (!acquired?.success) {
        throw Object.assign(new Error(acquired?.error || acquired?.code || 'Topic unavailable'), {
            code: acquired?.code || 'ADMISSION_UNAVAILABLE',
        });
    }
    let dispatched = false;
    let committed = false;
    let result;
    let failure;
    try {
        result = await operation({
            token,
            dispatched() { dispatched = true; },
            committed() { committed = true; },
        });
    } catch (error) {
        failure = error;
    }
    if (!dispatched || committed) {
        try {
            const released = await admission.release(scope, token, { saved: true });
            if (!released?.success) throw new Error(released?.error || released?.code || 'Lease release failed');
        } catch (error) {
            if (failure) throw new AggregateError([failure, error], 'Generation failed and lease release failed');
            throw error;
        }
    }
    if (failure && dispatched && !committed && typeof admission.reportUncertain === 'function') {
        try {
            const report = await admission.reportUncertain(scope, token, failure);
            if (!report?.success) throw new Error(report?.error || report?.code || 'Uncertain lease journal failed');
        } catch (error) {
            throw new AggregateError([failure, error], 'Generation failed and uncertainty journal failed');
        }
    }
    if (failure) throw failure;
    return result;
}

module.exports = { withTopicGenerationLease };