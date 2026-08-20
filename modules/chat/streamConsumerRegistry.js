/** Owner-scoped routing metadata; this is not a global event bus or stream state store. */
export function createStreamConsumerRegistry() {
    const routes = new Map();
    let disposed = false;
    return Object.freeze({
        register(messageId, route) {
            if (disposed) throw new Error('stream consumer registry is disposed');
            if (!messageId || !route) throw new TypeError('stream consumer route requires message identity and route');
            if (routes.has(messageId)) {
                throw new Error(`stream consumer route already registered: ${messageId}`);
            }
            const token = Object.freeze({});
            routes.set(messageId, { token, route });
            const release = () => {
                if (routes.get(messageId)?.token === token) routes.delete(messageId);
            };
            release.retract = () => {
                if (routes.get(messageId)?.token !== token) return;
                const tombstone = Object.freeze({
                    suppressed: true,
                    start() {},
                    append() {},
                    release: () => {
                        if (routes.get(messageId)?.token === token) routes.delete(messageId);
                    },
                });
                routes.set(messageId, { token, route: tombstone });
            };
            return release;
        },
        claim(messageId) {
            return routes.get(messageId)?.route || null;
        },
        dispose() {
            disposed = true;
            routes.clear();
        },
    });
}
