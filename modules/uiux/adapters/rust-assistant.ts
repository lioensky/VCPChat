import type { UiCommand, UiDisposer, UiReadable, UiServiceDefinition, UiSnapshot } from '../contracts.js';

export type RustAssistantState = Readonly<Record<string, unknown>>;
export type RustAssistantPatch = Readonly<Record<string, unknown>>;

export interface RustAssistantResult {
    readonly success: boolean;
    readonly error?: string;
    readonly [key: string]: unknown;
}

export interface RustAssistantUiService {
    readonly state: UiReadable<RustAssistantState>;
    readonly refresh: UiCommand<void, RustAssistantResult>;
    readonly save: UiCommand<RustAssistantPatch, RustAssistantResult>;
    readonly dispose: UiDisposer;
}

export interface RustAssistantUiAdapterInput {
    readonly get: () => Promise<RustAssistantState> | RustAssistantState;
    readonly save: (patch: RustAssistantPatch) => Promise<RustAssistantResult> | RustAssistantResult;
}

function freeze(value: RustAssistantState): RustAssistantState {
    return Object.freeze({ ...(value || {}) });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function createRustAssistantUiService(input: RustAssistantUiAdapterInput): RustAssistantUiService {
    if (!input || typeof input.get !== 'function' || typeof input.save !== 'function') {
        throw new TypeError('RustAssistantUiAdapter requires get() and save().');
    }
    let state = freeze({});
    let revision = 0;
    let source = 'initial';
    let disposed = false;
    let generation = 0;
    const listeners = new Set<(value: RustAssistantState, snapshot: UiSnapshot<RustAssistantState>) => void>();
    const snapshot = (): UiSnapshot<RustAssistantState> => Object.freeze({ value: state, revision, source });
    const publish = (next: RustAssistantState, nextSource: string) => {
        if (disposed) return snapshot();
        state = freeze(next);
        revision += 1;
        source = nextSource;
        const nextSnapshot = snapshot();
        [...listeners].forEach(listener => {
            try { listener(state, nextSnapshot); } catch (error) {
                console.error('[RustAssistantUiService] subscriber failed:', error);
            }
        });
        return nextSnapshot;
    };
    const service: RustAssistantUiService = {
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
        refresh: {
            async execute() {
                if (disposed) return Object.freeze({ success: false, error: 'Rust Assistant UI service disposed' });
                const token = ++generation;
                try {
                    const next = await input.get();
                    if (disposed || token !== generation) return Object.freeze({ success: true });
                    publish(next, 'rust-config-refresh');
                    return Object.freeze({ success: true });
                } catch (error) {
                    return Object.freeze({ success: false, error: errorMessage(error) });
                }
            },
        },
        save: {
            async execute(patch) {
                if (disposed) return Object.freeze({ success: false, error: 'Rust Assistant UI service disposed' });
                const token = ++generation;
                try {
                    const result = await input.save(Object.freeze({ ...patch }));
                    if (!result?.success) return Object.freeze({ success: false, error: result?.error || 'Rust Assistant config save failed' });
                    if (!disposed && token === generation) publish({ ...state, ...patch }, 'rust-config-save');
                    return Object.freeze({ ...result, success: true });
                } catch (error) {
                    return Object.freeze({ success: false, error: errorMessage(error) });
                }
            },
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            generation += 1;
            listeners.clear();
        },
    };
    return Object.freeze(service);
}

export const rustAssistantUiDefinition: UiServiceDefinition<RustAssistantUiService> = {
    id: 'rust-assistant-ui',
    provide: context => {
        const service = context.services.rustAssistantAdapter;
        if (!service || typeof (service as RustAssistantUiService).save?.execute !== 'function') {
            throw new TypeError('RustAssistantUiDefinition requires a RustAssistantUiService.');
        }
        return service as RustAssistantUiService;
    },
};
