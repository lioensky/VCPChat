/**
 * Owns progressive-render generations per Surface root. A reload or dispose on
 * one root must never revoke delayed work owned by another root.
 */
export function createRenderSessionAuthority({ resolveDefaultRoot = () => null } = {}) {
    const generations = new WeakMap();
    let detachedGeneration = 0;

    const resolveRoot = root => root || resolveDefaultRoot() || null;

    return Object.freeze({
        invalidate(root = null) {
            const ownerRoot = resolveRoot(root);
            if (!ownerRoot) return Object.freeze({ root: null, generation: ++detachedGeneration });
            const generation = (generations.get(ownerRoot) || 0) + 1;
            generations.set(ownerRoot, generation);
            return Object.freeze({ root: ownerRoot, generation });
        },
        capture(root = null) {
            const ownerRoot = resolveRoot(root);
            if (!ownerRoot) return Object.freeze({ root: null, generation: detachedGeneration });
            return Object.freeze({ root: ownerRoot, generation: generations.get(ownerRoot) || 0 });
        },
        isActive(session) {
            if (!session) return false;
            if (!session.root) return session.generation === detachedGeneration;
            return session.generation === (generations.get(session.root) || 0);
        },
    });
}
