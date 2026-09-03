const errorMessage = (error) => error instanceof Error ? error.message : String(error);
export function createAssistantRuntimeUiService(input) {
    if (!input || typeof input.get !== 'function')
        throw new TypeError('AssistantRuntimeUiAdapter requires get().');
    let state = Object.freeze({});
    let revision = 0;
    let source = 'initial';
    let disposed = false;
    let generation = 0;
    const listeners = new Set();
    const snapshot = () => Object.freeze({ value: state, revision, source });
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
        refresh: { async execute() {
                if (disposed)
                    return Object.freeze({ success: false, error: 'Assistant runtime UI service disposed' });
                const token = ++generation;
                try {
                    const next = await input.get();
                    if (disposed || token !== generation)
                        return Object.freeze({ success: true });
                    state = Object.freeze({ ...(next || {}) });
                    revision += 1;
                    source = 'assistant-runtime-refresh';
                    const nextSnapshot = snapshot();
                    [...listeners].forEach(listener => {
                        try {
                            listener(state, nextSnapshot);
                        }
                        catch (error) {
                            console.error('[AssistantRuntimeUiService] subscriber failed:', error);
                        }
                    });
                    return Object.freeze({ success: true });
                }
                catch (error) {
                    return Object.freeze({ success: false, error: errorMessage(error) });
                }
            } },
        dispose() { if (!disposed) {
            disposed = true;
            generation += 1;
            listeners.clear();
        } },
    };
    return Object.freeze(service);
}
export const assistantRuntimeUiDefinition = {
    id: 'assistant-runtime-ui',
    provide: context => {
        const service = context.services.assistantRuntimeAdapter;
        if (!service || typeof service.refresh?.execute !== 'function') {
            throw new TypeError('AssistantRuntimeUiDefinition requires an AssistantRuntimeUiService.');
        }
        return service;
    },
};
