/**
 * Surface-owned mutable projection runtime. This module contains no DOM,
 * Electron or history policy; the projection factory owns one instance.
 */
export function createStreamProjectionRuntime() {
    const messageRuntimeKeys = new Map();
    const runtimeStateKey = messageId => messageRuntimeKeys.get(String(messageId)) || String(messageId);
    const createMap = () => {
        const store = new Map();
        return {
            get: key => store.get(runtimeStateKey(key)),
            has: key => store.has(runtimeStateKey(key)),
            set(key, value) { store.set(runtimeStateKey(key), value); return this; },
            delete: key => store.delete(runtimeStateKey(key)),
            clear: () => store.clear(),
            get size() { return store.size; },
            keys: () => [...store.keys()].map(key => String(key).split('::').pop())[Symbol.iterator](),
            values: () => store.values(),
            entries: () => [...store.entries()].map(([key, value]) => [String(key).split('::').pop(), value])[Symbol.iterator](),
            forEach: callback => store.forEach((value, key) => callback(value, String(key).split('::').pop(), store)),
            [Symbol.iterator]() { return this.entries(); },
            displayKeys: () => [...store.keys()].map(key => String(key).split('::').pop()),
        };
    };
    const createSet = () => {
        const store = new Set();
        return {
            add(key) { store.add(runtimeStateKey(key)); return this; },
            has: key => store.has(runtimeStateKey(key)),
            delete: key => store.delete(runtimeStateKey(key)),
            clear: () => store.clear(),
            get size() { return store.size; },
        };
    };
    return {
        messageRuntimeKeys,
        streamingChunkQueues: createMap(),
        streamingTimers: createMap(),
        accumulatedStreamText: createMap(),
        streamSegmentStates: createMap(),
        activeStreamingMessages: createMap(),
        messageDomCache: createMap(),
        scrollThrottleTimers: createMap(),
        viewContextCache: createMap(),
        pendingDirectRenderMessages: createSet(),
        preBufferedChunks: createMap(),
        messageInitializationStatus: createMap(),
        messageInitializationWaiters: createMap(),
        messageContextMap: createMap(),
        elementContentLengthCache: new WeakMap(),
    };
}
