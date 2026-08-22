/**
 * Narrow named-slot contract for presentation extensions. A slot receives a
 * read-only snapshot and an owned root; it cannot access business IPC or
 * arbitrary selectors. Registration returns a disposer and late owners fail.
 */
export function createChatSurfaceSlots() {
    const definitions = new Map();
    let disposed = false;
    const allowed = new Set(['header', 'message-tail']);
    return {
        register(slot, id, mount) {
            if (disposed) throw new Error('ChatSurfaceSlots is disposed');
            if (!allowed.has(slot)) throw new Error(`Unsupported chat surface slot: ${slot}`);
            if (!id || typeof mount !== 'function') throw new TypeError('slot id and mount function are required');
            const key = `${slot}:${id}`;
            if (definitions.has(key)) throw new Error(`Duplicate chat surface contribution: ${key}`);
            definitions.set(key, { slot, id, mount });
            let active = true;
            return () => { if (!active) return; active = false; definitions.delete(key); };
        },
        mount(slot, root, snapshot) {
            if (disposed) return [];
            const owned = [];
            for (const definition of definitions.values()) {
                if (definition.slot !== slot) continue;
                const child = root.ownerDocument.createElement('span');
                child.dataset.chatSlotOwner = definition.id;
                root.appendChild(child);
                try {
                    const unmount = definition.mount(child, Object.freeze({ ...snapshot }));
                    owned.push(() => { if (typeof unmount === 'function') unmount(); child.remove(); });
                } catch (error) {
                    child.remove();
                    owned.splice(0).reverse().forEach(dispose => dispose());
                    throw error;
                }
            }
            return owned;
        },
        dispose() { disposed = true; definitions.clear(); }
    };
}
