/** Pure stream-session protocol; readers, DOM, Electron and persistence stay outside. */
import { normalizeChatTerminal, STREAM_TERMINAL_KINDS } from './chatEventContract.js';

const TERMINALS = new Set(STREAM_TERMINAL_KINDS);
const freeze = value => Object.freeze(value);
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

export function normalizeStreamTerminal(input, fallback = {}) {
    try {
        return normalizeChatTerminal(input, { ...fallback, ...(fallback.kind ? {} : { kind: undefined }) });
    } catch (error) {
        if (fallback.kind) return freeze({ ...fallback, ...(input && typeof input === 'object' ? input : { kind: input }) });
        throw error;
    }
}

export function createStreamSession(request = {}) {
    const sessionId = String(request.sessionId || request.messageId || '').trim();
    const conversationKey = String(request.conversationKey || '').trim();
    if (!sessionId || !conversationKey) throw new TypeError('stream session requires id and conversation key');
    const generation = Number.isInteger(request.generation) ? request.generation : 0;
    let state = freeze({ status: 'started', sessionId, conversationKey, generation, chunkCount: 0, text: '', terminal: null });
    let disposed = false;
    const completion = deferred();
    const listeners = new Set();
    const emit = event => [...listeners].forEach(listener => {
        try { listener(freeze({ ...event, sessionId, conversationKey, generation }), state); }
        catch (error) { console.error('[StreamSession] consumer failed:', error); }
    });
    const update = (next, event) => {
        if (disposed) return false;
        state = freeze({ ...state, ...next });
        emit(event);
        return true;
    };
    const api = {
        get snapshot() { return state; },
        get done() { return completion.promise; },
        subscribe(listener) {
            if (disposed) return () => {};
            if (typeof listener !== 'function') throw new TypeError('stream listener is required');
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        pushChunk(chunk, candidateGeneration = generation) {
            if (disposed || state.terminal || candidateGeneration !== generation) return false;
            const text = typeof chunk === 'string' ? chunk : String(chunk?.text || '');
            if (!text) return false;
            return update({ status: 'streaming', chunkCount: state.chunkCount + 1, text: state.text + text }, { type: 'chunk', text });
        },
        terminal(kind, payload = {}, candidateGeneration = generation) {
            if (!TERMINALS.has(kind)) throw new Error(`unsupported stream terminal: ${kind}`);
            if (disposed || state.terminal || candidateGeneration !== generation) return false;
            const terminal = normalizeStreamTerminal({ kind, ...payload });
            const accepted = update({ status: kind, terminal }, { type: kind, terminal });
            if (accepted) completion.resolve(terminal);
            return accepted;
        },
        discard(reason = 'disposed') { return api.terminal('discarded', { reason }); },
        async dispose(reason = 'disposed') {
            if (!disposed) {
                if (!state.terminal) api.discard(reason);
                disposed = true;
                listeners.clear();
            }
            return completion.promise;
        },
    };
    return api;
}

export function createStreamStateReducer() {
    return (state, event) => {
        if (!state || state.sessionId !== event?.sessionId || state.terminal) return state;
        if (event.type === 'chunk') return freeze({ ...state, status: 'streaming', text: state.text + event.text, chunkCount: (state.chunkCount || 0) + 1 });
        if (TERMINALS.has(event.type)) return freeze({ ...state, status: event.type, terminal: event.terminal || freeze({ kind: event.type }) });
        return state;
    };
}

export const STREAM_TERMINALS = Object.freeze([...TERMINALS]);
