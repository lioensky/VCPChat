'use strict';

const { randomUUID } = require('crypto');
const { conversationKey } = require('./historyMutationQueue');

function hasPendingHandoff(entries, scope) {
    const key = conversationKey(scope);
    const relevant = entries.filter(entry => conversationKey(entry.scope) === key);
    return !relevant.some(entry => ['recovered', 'failed', 'uncertain'].includes(entry.state))
        && relevant.some(entry => entry.state === 'queued' && !entry.kind
            && !entry.committed && !entry.cancellationRequested);
}

/**
 * One registration per real network request. sendControl must have a bounded
 * timeout and must never invoke the hard-interrupt/local-abort fallback.
 * Protocol support is explicit; unsupported requests send no control traffic.
 */
function createToolLoopHandoff({ sendControl, logger = console } = {}) {
    if (typeof sendControl !== 'function') throw new TypeError('sendControl required');
    const requests = new Map();
    let entries = [];

    function reconcile(state) {
        if (!state.active || state.sealed || !state.supported) return state.tail;
        const desired = state.compression || hasPendingHandoff(entries, state.scope);
        if (desired === state.desired) return state.tail;
        state.desired = desired;
        const revision = ++state.revision;
        // A generation ID fences cancellation from an earlier reservation.
        if (desired) state.handoffId = randomUUID();
        const payload = {
            requestId: state.requestId,
            action: desired ? 'prepare_handoff' : 'cancel_handoff',
            handoffId: state.handoffId,
            revision,
        };
        state.tail = state.tail.then(async () => {
            if (!state.active || state.sealed) return;
            // Do not skip a queued cancel: a prior prepare may have reached the
            // server even if its acknowledgement was lost.
            const receipt = await sendControl(payload, state.transport);
            if (receipt?.success !== true) {
                throw new Error(receipt?.error || receipt?.code || 'Handoff control not acknowledged');
            }
        }).catch(error => {
            logger.warn?.('[ToolLoopHandoff] control failed', {
                requestId: state.requestId, action: payload.action, revision,
                error: error.message || String(error),
            });
        });
        return state.tail;
    }

    return {
        updateEntries(next) {
            entries = structuredClone(next);
            for (const state of requests.values()) reconcile(state);
        },
        register({ requestId, scope, transport, supported = false }) {
            if (typeof requestId !== 'string' || !requestId) throw new TypeError('requestId required');
            if (requests.has(requestId)) throw new Error('Duplicate active handoff request');
            conversationKey(scope);
            const state = {
                requestId, scope: structuredClone(scope), transport,
                supported: supported === true, compression: false,
                desired: false, revision: 0, handoffId: null,
                active: true, sealed: false, tail: Promise.resolve(),
            };
            requests.set(requestId, state);
            reconcile(state);
            return Object.freeze({
                setSupported(value) {
                    if (value === true) state.supported = true;
                    return reconcile(state);
                },
                setCompression(value) {
                    state.compression = value === true;
                    return reconcile(state);
                },
                // Hard Stop / committed handoff owns termination from here.
                // Consuming the queue must not resume the old ToolLoop.
                seal() { state.sealed = true; },
                idle() { return state.tail; },
                finish() {
                    state.active = false;
                    if (requests.get(requestId) === state) requests.delete(requestId);
                },
            });
        },
        dispose() {
            for (const state of requests.values()) state.active = false;
            requests.clear();
            entries = [];
        },
    };
}

module.exports = { createToolLoopHandoff, hasPendingHandoff };