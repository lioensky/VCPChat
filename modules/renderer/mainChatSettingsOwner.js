/** Owns main-window settings state and exposes a compatibility-safe reference for legacy consumers. */
export function createMainChatSettingsOwner({ initial = {}, publish = () => {} } = {}) {
    const clone = value => {
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(clone);
        return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, clone(nested)]));
    };
    const freeze = value => {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze);
        return Object.freeze(value);
    };
    const settings = clone(initial);
    let disposed = false;
    const get = () => clone(settings);
    const snapshot = () => freeze(clone(settings));
    const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
    const replace = next => {
        if (disposed) return snapshot();
        Object.assign(settings, clone(next || {}));
        publish(snapshot());
        return snapshot();
    };
    const merge = patch => {
        if (disposed || !isPlainObject(patch)) return snapshot();
        for (const [key, value] of Object.entries(patch)) {
            if (isPlainObject(value) && isPlainObject(settings[key])) {
                settings[key] = { ...clone(settings[key]), ...clone(value) };
            } else {
                settings[key] = clone(value);
            }
        }
        publish(snapshot());
        return snapshot();
    };
    const update = (key, value) => replace({ [key]: value });
    const dispose = () => { disposed = true; };
    return Object.freeze({
        get,
        snapshot,
        replace,
        merge,
        update,
        dispose,
        ref: Object.freeze({ get, set: value => replace(value) }),
    });
}
