/* Explicit read/subscribe channels backed by existing authoritative managers. */
(function installStateChannels(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) globalObject.VCPStateChannels = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createStateChannelApi() {
    'use strict';

    const channels = new Map();

    class StateChannel {
        constructor(name, initialValue) {
            if (!/^[a-z][a-z0-9.-]{1,63}$/.test(String(name || ''))) throw new TypeError('State channel name is invalid.');
            this.name = name;
            this.value = initialValue;
            this.revision = 0;
            this.source = 'initial';
            this.listeners = new Set();
            this.disposed = false;
        }

        get() { return this.value; }
        getSnapshot() {
            return Object.freeze({ name: this.name, value: this.value, revision: this.revision, source: this.source });
        }

        publish(value, options = {}) {
            if (this.disposed) throw new Error(`State channel "${this.name}" is disposed.`);
            if (options.equals?.(this.value, value) || (!options.force && Object.is(this.value, value))) return this.getSnapshot();
            this.value = value;
            this.revision += 1;
            this.source = options.source || 'manager';
            const snapshot = this.getSnapshot();
            this.listeners.forEach(listener => {
                try { listener(value, snapshot); } catch (error) { console.error(`[VCPState] ${this.name} subscriber failed:`, error); }
            });
            return snapshot;
        }

        subscribe(listener, options = {}) {
            if (this.disposed) throw new Error(`State channel "${this.name}" is disposed.`);
            if (typeof listener !== 'function') throw new TypeError('State subscriber must be a function.');
            this.listeners.add(listener);
            try {
                if (options.immediate !== false) listener(this.value, this.getSnapshot());
            } catch (error) {
                // Subscription is transactional: a caller that never receives an
                // unsubscribe handle must never leave a hidden listener behind.
                this.listeners.delete(listener);
                throw error;
            }
            let active = true;
            return () => {
                if (!active) return false;
                active = false;
                return this.listeners.delete(listener);
            };
        }

        dispose() {
            if (this.disposed) return;
            this.disposed = true;
            this.listeners.clear();
            if (channels.get(this.name) === this) channels.delete(this.name);
        }
    }

    function create(name, initialValue) {
        if (channels.has(name)) throw new Error(`State channel already exists: ${name}`);
        const channel = new StateChannel(name, initialValue);
        channels.set(name, channel);
        return channel;
    }

    function get(name) { return channels.get(name) || null; }
    function diagnostics() {
        return [...channels.values()].map(channel => Object.freeze({
            name: channel.name,
            revision: channel.revision,
            source: channel.source,
            subscribers: channel.listeners.size,
        }));
    }

    return Object.freeze({ StateChannel, create, get, diagnostics });
});
