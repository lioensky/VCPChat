function freeze(value) {
    return Object.freeze({ ...(value || {}) });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function createRustAssistantUiService(input) {
    if (!input || typeof input.get !== 'function' || typeof input.save !== 'function') {
        throw new TypeError('RustAssistantUiAdapter requires get() and save().');
    }
    let state = freeze({});
    let revision = 0;
    let source = 'initial';
    let disposed = false;
    let generation = 0;
    const listeners = new Set();
    const snapshot = () => Object.freeze({ value: state, revision, source });
    const publish = (next, nextSource) => {
        if (disposed)
            return snapshot();
        state = freeze(next);
        revision += 1;
        source = nextSource;
        const nextSnapshot = snapshot();
        [...listeners].forEach(listener => {
            try {
                listener(state, nextSnapshot);
            }
            catch (error) {
                console.error('[RustAssistantUiService] subscriber failed:', error);
            }
        });
        return nextSnapshot;
    };
    const service = {
        state: {
            get: () => state,
            getSnapshot: snapshot,
            subscribe(listener, options = {}) {
                if (disposed)
                    return () => { };
                listeners.add(listener);
                if (options.immediate !== false)
                    listener(state, snapshot());
                let active = true;
                return () => { if (active) {
                    active = false;
                    listeners.delete(listener);
                } };
            },
        },
        refresh: {
            async execute() {
                if (disposed)
                    return Object.freeze({ success: false, error: 'Rust Assistant UI service disposed' });
                const token = ++generation;
                try {
                    const next = await input.get();
                    if (disposed || token !== generation)
                        return Object.freeze({ success: true });
                    publish(next, 'rust-config-refresh');
                    return Object.freeze({ success: true });
                }
                catch (error) {
                    return Object.freeze({ success: false, error: errorMessage(error) });
                }
            },
        },
        save: {
            async execute(patch) {
                if (disposed)
                    return Object.freeze({ success: false, error: 'Rust Assistant UI service disposed' });
                const token = ++generation;
                try {
                    const result = await input.save(Object.freeze({ ...patch }));
                    if (!result?.success)
                        return Object.freeze({ success: false, error: result?.error || 'Rust Assistant config save failed' });
                    if (!disposed && token === generation)
                        publish({ ...state, ...patch }, 'rust-config-save');
                    return Object.freeze({ ...result, success: true });
                }
                catch (error) {
                    return Object.freeze({ success: false, error: errorMessage(error) });
                }
            },
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            generation += 1;
            listeners.clear();
        },
    };
    return Object.freeze(service);
}
export const rustAssistantUiDefinition = {
    id: 'rust-assistant-ui',
    provide: context => {
        const service = context.services.rustAssistantAdapter;
        if (!service || typeof service.save?.execute !== 'function') {
            throw new TypeError('RustAssistantUiDefinition requires a RustAssistantUiService.');
        }
        return service;
    },
};
