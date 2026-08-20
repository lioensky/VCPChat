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
            const lease = { active: true };
            const ownedRoute = Object.freeze({
                get suppressed() { return !lease.active || route.suppressed === true; },
                start(...args) { if (lease.active) return route.start?.(...args); },
                append(...args) { if (lease.active) return route.append?.(...args); },
                release(...args) {
                    if (!lease.active) {
                        if (routes.get(messageId)?.token === token) routes.delete(messageId);
                        return;
                    }
                    lease.active = false;
                    try { return route.release?.(...args); }
                    finally { if (routes.get(messageId)?.token === token) routes.delete(messageId); }
                },
            });
            routes.set(messageId, { token, route: ownedRoute, lease });
            const release = () => {
                if (routes.get(messageId)?.token !== token) return;
                lease.active = false;
                routes.delete(messageId);
            };
            release.retract = () => {
                if (routes.get(messageId)?.token !== token) return;
                lease.active = false;
            };
            return release;
        },
        claim(messageId) {
            return routes.get(messageId)?.route || null;
        },
        dispose() {
            disposed = true;
            routes.forEach(entry => { entry.lease.active = false; });
            routes.clear();
        },
    });
}
