/** A replacement owns a whole declaration; retired declarations cannot detach its resources. */
export function createSidePaneTabRegistry({ providers, registerEntry, onChanged, isDisposed }) {
    const registrations = new Map();
    const getTabType = kind => registrations.get(kind)?.definition || null;

    function releaseProvider(definition) {
        if (definition.provider && providers[definition.kind] === definition.provider) {
            delete providers[definition.kind];
        }
    }

    function registerTabType(definition) {
        if (isDisposed()) return () => {};
        if (!definition || typeof definition.kind !== 'string' || !definition.kind
            || typeof definition.label !== 'string' || !definition.label) {
            throw new TypeError('registerTabType requires { kind, label, provider?, entry? }');
        }
        const stored = Object.freeze({ ...definition });
        // Entry validation runs before retiring the old declaration. Entry
        // cleanup compares identity, including when the entry id stays the same.
        const unregisterEntry = stored.entry ? registerEntry({
            id: stored.kind, label: stored.label, icon: stored.icon, ...stored.entry
        }) : () => {};
        const previous = registrations.get(stored.kind);
        if (previous) {
            previous.unregisterEntry();
            releaseProvider(previous.definition);
        }
        const registration = { definition: stored, unregisterEntry };
        registrations.set(stored.kind, registration);
        if (stored.provider) providers[stored.kind] = stored.provider;
        onChanged();
        return () => {
            unregisterEntry();
            if (registrations.get(stored.kind) !== registration) return;
            registrations.delete(stored.kind);
            releaseProvider(stored);
            if (!isDisposed()) onChanged();
        };
    }

    function dispose() {
        for (const registration of registrations.values()) {
            registration.unregisterEntry();
            releaseProvider(registration.definition);
        }
        registrations.clear();
    }

    return { getTabType, registerTabType, dispose };
}
