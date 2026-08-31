const message = (error) => error instanceof Error ? error.message : String(error);
const freeze = (value) => Object.freeze({ ...(value || {}) });
const withTimeout = (value, timeoutMs) => {
    const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
    let timer;
    return Promise.race([
        Promise.resolve(value),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Forum config operation timed out (${duration}ms)`)), duration); }),
    ]).finally(() => { if (timer)
        clearTimeout(timer); });
};
export function createForumConfigUiService(input) {
    if (!input || typeof input.get !== 'function' || typeof input.save !== 'function') {
        throw new TypeError('ForumConfigUiAdapter requires get() and save().');
    }
    let state = freeze({});
    let revision = 0;
    let source = 'initial';
    let disposed = false;
    let generation = 0;
    const timeoutMs = input.timeoutMs ?? 15000;
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
                console.error('[ForumConfigUiService] subscriber failed:', error);
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
        refresh: { async execute() {
                if (disposed)
                    return Object.freeze({ success: false, error: 'Forum config UI service disposed' });
                const token = ++generation;
                try {
                    const next = await withTimeout(input.get(), timeoutMs);
                    if (disposed || token !== generation)
                        return Object.freeze({ success: true });
                    publish(next, 'forum-config-refresh');
                    return Object.freeze({ success: true });
                }
                catch (error) {
                    return Object.freeze({ success: false, error: message(error) });
                }
            } },
        save: { async execute(patch) {
                if (disposed)
                    return Object.freeze({ success: false, error: 'Forum config UI service disposed' });
                const token = ++generation;
                try {
                    const result = await withTimeout(input.save(Object.freeze({ ...patch })), timeoutMs);
                    if (!result?.success)
                        return Object.freeze({ success: false, error: result?.error || 'Forum config save failed' });
                    if (!disposed && token === generation)
                        publish({ ...state, ...patch }, 'forum-config-save');
                    return Object.freeze({ ...result, success: true });
                }
                catch (error) {
                    return Object.freeze({ success: false, error: message(error) });
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
export const forumConfigUiDefinition = {
    id: 'forum-config-ui',
    provide: context => {
        const service = context.services.forumConfigAdapter;
        if (!service || typeof service.save?.execute !== 'function') {
            throw new TypeError('ForumConfigUiDefinition requires a ForumConfigUiService.');
        }
        return service;
    },
};
