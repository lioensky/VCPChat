const CAPABILITIES = new Set(['theme', 'surface-slot', 'presentation-state']);
const SLOTS = new Set(['header', 'message-tail']);

export function validateChatPluginManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') throw new TypeError('chat plugin manifest is required');
    if (!manifest.id || !/^[a-z0-9-]+$/.test(manifest.id)) throw new Error('chat plugin id must be lowercase kebab-case');
    if (manifest.apiVersion !== 1) throw new Error('unsupported chat plugin API version');
    const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
    for (const capability of capabilities) if (!CAPABILITIES.has(capability)) throw new Error(`unsupported chat plugin capability: ${capability}`);
    for (const slot of manifest.slots || []) if (!SLOTS.has(slot)) throw new Error(`unsupported chat plugin slot: ${slot}`);
    if (manifest.ipc || manifest.selectors || manifest.cssText) throw new Error('chat plugins cannot request IPC, selectors, or CSS text');
    return Object.freeze({ id: manifest.id, apiVersion: 1, capabilities: Object.freeze([...capabilities]), slots: Object.freeze([...(manifest.slots || [])]) });
}

export function createChatPluginLoader({ state, slots, theme, skins = new Map() }) {
    const installed = new Map();
    let disposed = false;
    return {
        install(rawManifest, provider) {
            if (disposed) throw new Error('chat plugin loader is disposed');
            const manifest = validateChatPluginManifest(rawManifest);
            if (installed.has(manifest.id)) throw new Error(`chat plugin already installed: ${manifest.id}`);
            if (typeof provider !== 'function') throw new TypeError('chat plugin provider is required');
            const owned = [];
            const releaseOwned = () => {
                [...owned].reverse().forEach(fn => { try { fn(); } catch (error) { console.error('[ChatPluginLoader] owner teardown failed:', error); } });
                owned.length = 0;
            };
            const subscribeState = (listener) => {
                if (!manifest.capabilities.includes('presentation-state')) throw new Error('presentation-state capability not declared');
                if (typeof listener !== 'function' || typeof state?.subscribe !== 'function') throw new TypeError('presentation state subscription is required');
                const unsubscribe = state.subscribe(snapshot => listener(Object.freeze({ ...snapshot })));
                if (typeof unsubscribe === 'function') owned.push(unsubscribe);
                return unsubscribe;
            };
            let dispose;
            try {
                dispose = provider(Object.freeze({
                    manifest,
                    state: state?.getSnapshot?.() || Object.freeze({}),
                    subscribeState,
                    registerSlot: (slot, id, mount) => {
                        if (!manifest.slots.includes(slot)) throw new Error(`slot not declared by plugin: ${slot}`);
                        const disposeSlot = slots?.register(slot, `${manifest.id}:${id}`, mount);
                        if (typeof disposeSlot === 'function') owned.push(disposeSlot);
                        return disposeSlot;
                    },
                    applyTheme: (root, plugin) => {
                        if (!manifest.capabilities.includes('theme')) throw new Error('theme capability not declared');
                        const apply = plugin?.apply || theme?.apply;
                        if (typeof apply !== 'function') throw new TypeError('theme plugin is required');
                        const teardown = apply(root);
                        if (typeof teardown === 'function') owned.push(teardown);
                        return teardown;
                    },
                    mountSkin: (root, skin) => {
                        if (!manifest.capabilities.includes('presentation-state')) throw new Error('presentation-state capability not declared');
                        const mount = skin?.mount || skins.get(manifest.id)?.mount;
                        if (typeof mount !== 'function') throw new TypeError('presentation skin is required');
                        const mounted = mount(root, state?.getSnapshot?.() || Object.freeze({}));
                        const teardown = typeof mounted === 'function' ? mounted : mounted?.teardown;
                        const update = typeof mounted === 'function' ? mounted.update : mounted?.update;
                        if (typeof teardown === 'function') owned.push(teardown);
                        if (update && typeof state?.subscribe === 'function') {
                            const unsubscribe = state.subscribe(snapshot => update(snapshot));
                            if (typeof unsubscribe === 'function') owned.push(unsubscribe);
                        }
                        return teardown;
                    }
                }));
            } catch (error) {
                releaseOwned();
                throw error;
            }
            const teardown = typeof dispose === 'function' ? dispose : () => {};
            installed.set(manifest.id, () => { releaseOwned(); teardown(); });
            return () => { if (!installed.has(manifest.id)) return; installed.delete(manifest.id); releaseOwned(); teardown(); };
        },
        dispose() { disposed = true; [...installed.values()].reverse().forEach(teardown => teardown()); installed.clear(); }
    };
}
