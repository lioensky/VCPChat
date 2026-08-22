/**
 * Typed vocabulary shared by stream producers and Surface consumers.
 * This module is deliberately DOM/Electron-free so source-plane tests can
 * validate terminal ownership without booting a renderer.
 */
export const STREAM_EVENT_MODE = 'emit';
export const STREAM_TERMINAL_KINDS = Object.freeze(['completed', 'failed', 'cancelled', 'discarded']);
const TERMINAL_SET = new Set(STREAM_TERMINAL_KINDS);

export const CHAT_EVENT_CONTRACTS = Object.freeze({
    'chat.stream.started': Object.freeze({ durable: false, mode: STREAM_EVENT_MODE, terminal: false }),
    'chat.stream.chunk': Object.freeze({ durable: false, mode: STREAM_EVENT_MODE, terminal: false }),
    'chat.stream.final': Object.freeze({ durable: false, mode: STREAM_EVENT_MODE, terminal: false }),
    'chat.stream.completed': Object.freeze({ durable: true, mode: STREAM_EVENT_MODE, terminal: true }),
    'chat.stream.failed': Object.freeze({ durable: false, mode: STREAM_EVENT_MODE, terminal: true }),
    'chat.stream.cancelled': Object.freeze({ durable: false, mode: STREAM_EVENT_MODE, terminal: true }),
    'chat.stream.discarded': Object.freeze({ durable: false, mode: STREAM_EVENT_MODE, terminal: true }),
});

export function normalizeChatTerminal(input, fallback = {}) {
    const source = typeof input === 'string' ? { kind: input } : (input && typeof input === 'object' ? input : {});
    const raw = String(source.kind || source.type || source.finishReason || '').toLowerCase();
    const kind = ['end', 'done', 'success', 'stop', 'completed'].includes(raw)
        ? 'completed'
        : ['abort', 'aborted', 'cancel', 'cancelled'].includes(raw)
            ? 'cancelled'
            : ['discard', 'discarded', 'stale'].includes(raw)
                ? 'discarded'
                : ['error', 'failed', 'disconnect', 'disconnected', 'reader-error'].includes(raw)
                    ? 'failed'
                    : fallback.kind;
    if (!TERMINAL_SET.has(kind)) throw new TypeError(`unknown chat stream terminal: ${raw || '<empty>'}`);
    return Object.freeze({ ...fallback, ...source, kind });
}

export function assertChatEventContract({ name, terminal = false, durable = false } = {}) {
    const contract = CHAT_EVENT_CONTRACTS[name];
    if (!contract) throw new Error(`unregistered chat event: ${name}`);
    if (Boolean(terminal) !== contract.terminal) throw new Error(`terminal declaration mismatch for ${name}`);
    if (Boolean(durable) !== contract.durable) throw new Error(`durability declaration mismatch for ${name}`);
    return contract;
}
