function freezeState(value) {
    return Object.freeze({ ...(value || {}) });
}
function sameState(left, right) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every(key => left[key] === right[key]);
}
export function createSettingsUiService(input) {
    if (!input || typeof input.get !== 'function' || typeof input.save !== 'function') {
        throw new TypeError('SettingsUiAdapter requires get() and save().');
    }
    let state = freezeState(input.get());
    let revision = 0;
    let source = 'initial';
    let disposed = false;
    let saveGeneration = 0;
    const listeners = new Set();
    const snapshot = () => Object.freeze({
        value: state,
        revision,
        source,
    });
    const publish = (next, nextSource) => {
        if (disposed)
            return snapshot();
        const nextState = freezeState(next);
        if (sameState(state, nextState))
            return snapshot();
        state = nextState;
        revision += 1;
        source = nextSource;
        const nextSnapshot = snapshot();
        [...listeners].forEach(listener => {
            try {
                listener(state, nextSnapshot);
            }
            catch (error) {
                // One presentation consumer must not prevent the remaining
                // consumers from receiving the committed snapshot.
                console.error('[SettingsUiService] subscriber failed:', error);
            }
        });
        return nextSnapshot;
    };
    // External notifications are allowed to be partial patches (for example,
    // a presentation owner may publish only the field it changed). Merge them
    // into the authoritative snapshot instead of erasing unrelated settings.
    const externalRelease = input.subscribe?.(next => publish({ ...state, ...(next || {}) }, 'settings-external')) || null;
    const service = {
        state: {
            get: () => state,
            getSnapshot: snapshot,
            subscribe(listener, options = {}) {
                if (disposed)
                    return () => { };
                listeners.add(listener);
                if (options.immediate !== false) {
                    try {
                        listener(state, snapshot());
                    }
                    catch (error) {
                        listeners.delete(listener);
                        throw error;
                    }
                }
                let active = true;
                return () => {
                    if (!active)
                        return;
                    active = false;
                    listeners.delete(listener);
                };
            },
        },
        save: {
            async execute(patch) {
                if (disposed)
                    return Object.freeze({ success: false, error: '设置服务已销毁' });
                const generation = ++saveGeneration;
                const result = await input.save(Object.freeze({ ...patch }));
                if (!result?.success)
                    return Object.freeze({ success: false, error: result?.error || '设置保存失败' });
                // A newer save owns publication rights. The older IPC result
                // may still settle, but must not roll the UI snapshot back.
                if (disposed || generation !== saveGeneration)
                    return Object.freeze({ success: true });
                publish({ ...state, ...patch }, 'settings-save');
                return Object.freeze({ success: true });
            },
        },
    };
    Object.defineProperty(service, 'cancelPendingSaves', {
        value: () => {
            saveGeneration += 1;
            input.cancelPendingSaves?.();
        },
        enumerable: false,
    });
    // The adapter is itself a UI-owned resource when external settings updates
    // exist; callers should register this disposer with their UiScope.
    Object.defineProperty(service, 'dispose', {
        value: () => {
            if (disposed)
                return;
            disposed = true;
            saveGeneration += 1;
            listeners.clear();
            return externalRelease?.();
        },
        enumerable: false,
    });
    return Object.freeze(service);
}
export const settingsUiDefinition = {
    id: 'settings-ui',
    provide: context => {
        const service = context.services.settings;
        if (!service || typeof service.save?.execute !== 'function') {
            throw new TypeError('SettingsUiDefinition requires a SettingsUiService.');
        }
        return service;
    },
};
