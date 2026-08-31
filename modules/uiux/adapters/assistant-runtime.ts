import type { UiCommand, UiDisposer, UiReadable, UiServiceDefinition, UiSnapshot } from '../contracts.js';

export type AssistantRuntimeState = Readonly<Record<string, unknown>>;
export interface AssistantRuntimeUiService {
    readonly state: UiReadable<AssistantRuntimeState>;
    readonly refresh: UiCommand<void, { readonly success: boolean; readonly error?: string }>;
    readonly dispose: UiDisposer;
}
export interface AssistantRuntimeUiAdapterInput { readonly get: () => Promise<AssistantRuntimeState> | AssistantRuntimeState; }

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export function createAssistantRuntimeUiService(input: AssistantRuntimeUiAdapterInput): AssistantRuntimeUiService {
    if (!input || typeof input.get !== 'function') throw new TypeError('AssistantRuntimeUiAdapter requires get().');
    let state: AssistantRuntimeState = Object.freeze({});
    let revision = 0;
    let source = 'initial';
    let disposed = false;
    let generation = 0;
    const listeners = new Set<(value: AssistantRuntimeState, snapshot: UiSnapshot<AssistantRuntimeState>) => void>();
    const snapshot = () => Object.freeze({ value: state, revision, source });
    const service: AssistantRuntimeUiService = {
        state: {
            get: () => state,
            getSnapshot: snapshot,
            subscribe(listener, options = {}) {
                if (disposed) return () => {};
                listeners.add(listener);
                if (options.immediate !== false) listener(state, snapshot());
                let active = true;
                return () => { if (active) { active = false; listeners.delete(listener); } };
            },
        },
        refresh: { async execute() {
            if (disposed) return Object.freeze({ success: false, error: 'Assistant runtime UI service disposed' });
            const token = ++generation;
            try {
                const next = await input.get();
                if (disposed || token !== generation) return Object.freeze({ success: true });
                state = Object.freeze({ ...(next || {}) });
                revision += 1;
                source = 'assistant-runtime-refresh';
                const nextSnapshot = snapshot();
                [...listeners].forEach(listener => { try { listener(state, nextSnapshot); } catch (error) {
                    console.error('[AssistantRuntimeUiService] subscriber failed:', error);
                } });
                return Object.freeze({ success: true });
            } catch (error) { return Object.freeze({ success: false, error: errorMessage(error) }); }
        } },
        dispose() { if (!disposed) { disposed = true; generation += 1; listeners.clear(); } },
    };
    return Object.freeze(service);
}

export const assistantRuntimeUiDefinition: UiServiceDefinition<AssistantRuntimeUiService> = {
    id: 'assistant-runtime-ui',
    provide: context => {
        const service = context.services.assistantRuntimeAdapter;
        if (!service || typeof (service as AssistantRuntimeUiService).refresh?.execute !== 'function') {
            throw new TypeError('AssistantRuntimeUiDefinition requires an AssistantRuntimeUiService.');
        }
        return service as AssistantRuntimeUiService;
    },
};
