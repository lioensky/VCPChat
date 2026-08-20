/** Owner-scoped routing metadata; this is not a global event bus or stream state store. */
export function createStreamConsumerRegistry() {
    const routes = new Map();
    let disposed = false;
    return Object.freeze({
        register(messageId, route) {
            if (disposed) throw new Error('stream consumer registry is disposed');
            if (!messageId || !route) throw new TypeError('stream consumer route requires message identity and route');
            const token = Object.freeze({});
            routes.set(messageId, { token, route });
            return () => {
                if (routes.get(messageId)?.token === token) routes.delete(messageId);
            };
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
