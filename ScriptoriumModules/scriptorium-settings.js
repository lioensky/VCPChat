'use strict';

(() => {
    const STORAGE_KEY = 'scriptorium:settings';
    const DEFAULTS = Object.freeze({
        trustNetworkFonts: false,
    });

    function createSettingsStore(options = {}) {
        const storage = options.storage || globalThis.localStorage;
        const listeners = new Map();
        let values = { ...DEFAULTS };
        let disposed = false;

        function assertActive() {
            if (disposed) {
                throw new Error('Settings store has been disposed.');
            }
        }

        function readStored() {
            try {
                const stored = JSON.parse(storage?.getItem?.(STORAGE_KEY) || '{}');
                if (stored && typeof stored === 'object') {
                    values = {
                        ...DEFAULTS,
                        trustNetworkFonts:
                            stored.trustNetworkFonts === true,
                    };
                }
            } catch (error) {
                console.warn(
                    '[ScriptoriumSettings] Stored settings could not be read:',
                    error
                );
                values = { ...DEFAULTS };
            }
            return snapshot();
        }

        function persist() {
            try {
                storage?.setItem?.(STORAGE_KEY, JSON.stringify(values));
                return true;
            } catch (error) {
                console.warn(
                    '[ScriptoriumSettings] Settings could not be persisted:',
                    error
                );
                return false;
            }
        }

        function snapshot() {
            return Object.freeze({ ...values });
        }

        function get(name) {
            assertActive();
            return values[name];
        }

        function set(name, value) {
            assertActive();
            if (!Object.hasOwn(DEFAULTS, name)) {
                throw new TypeError(`Unknown Scriptorium setting: ${name}`);
            }
            const normalized = value === true;
            if (values[name] === normalized) return normalized;
            values = {
                ...values,
                [name]: normalized,
            };
            persist();
            [...(listeners.get(name) || [])].forEach((listener) => {
                try {
                    listener(normalized, snapshot());
                } catch (error) {
                    console.error(
                        `[ScriptoriumSettings] ${name} listener failed:`,
                        error
                    );
                }
            });
            return normalized;
        }

        function subscribe(name, listener) {
            assertActive();
            if (typeof listener !== 'function') {
                throw new TypeError('Settings listener must be a function.');
            }
            const bucket = listeners.get(name) || new Set();
            bucket.add(listener);
            listeners.set(name, bucket);
            return () => {
                bucket.delete(listener);
                if (!bucket.size) listeners.delete(name);
            };
        }

        function dispose() {
            if (disposed) return;
            listeners.clear();
            disposed = true;
        }

        readStored();

        return Object.freeze({
            get,
            set,
            snapshot,
            subscribe,
            dispose,
        });
    }

    window.ScriptoriumSettings = Object.freeze({
        STORAGE_KEY,
        DEFAULTS,
        createSettingsStore,
    });
})();