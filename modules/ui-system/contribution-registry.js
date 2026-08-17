/* Disposable, data-first contribution registries for Next-owned surfaces. */
(function installContributionRegistry(globalObject, factory) {
    const api = factory(globalObject);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) {
        globalObject.VCPContributions = Object.freeze(api);
        globalObject.dispatchEvent?.(new globalObject.CustomEvent('vcp-contributions-ready'));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createContributionApi(globalObject) {
    'use strict';

    const ID_PATTERN = /^[a-z][a-z0-9.-]{1,95}$/;
    const FORBIDDEN_FIELDS = ['html', 'innerHTML', 'template', 'url', 'channel'];

    function validateCommon(type, definition) {
        if (!definition || typeof definition !== 'object') throw new TypeError(`${type} contribution is required.`);
        if (!ID_PATTERN.test(String(definition.id || ''))) throw new TypeError(`${type} contribution has an invalid id.`);
        const forbidden = FORBIDDEN_FIELDS.find(field => Object.hasOwn(definition, field));
        if (forbidden) throw new TypeError(`${type} contribution cannot provide ${forbidden}.`);
    }

    function validate(type, definition) {
        validateCommon(type, definition);
        if (type === 'command' && typeof definition.handler !== 'function') {
            throw new TypeError(`Command "${definition.id}" requires handler().`);
        }
        if (type === 'app') {
            if (!definition.title) throw new TypeError(`App "${definition.id}" requires a title.`);
            if (definition.kind !== 'internal') throw new TypeError(`App "${definition.id}" must use kind "internal".`);
            if (typeof definition.mount !== 'function') throw new TypeError(`App "${definition.id}" requires mount().`);
        }
    }

    class ContributionRegistry {
        constructor(type) {
            this.type = type;
            this.entries = new Map();
            this.listeners = new Set();
        }

        register(definition, options = {}) {
            validate(this.type, definition);
            if (this.entries.has(definition.id)) throw new Error(`Duplicate ${this.type} contribution: ${definition.id}`);
            const owner = options.owner || null;
            if (owner?.active === false) throw new Error(`Cannot register ${definition.id} on an inactive owner.`);
            const value = Object.freeze({
                ...definition,
                ownerId: options.ownerId || owner?.label || 'application',
            });
            let disposed = false;
            const dispose = () => {
                if (disposed || this.entries.get(value.id)?.value !== value) return false;
                disposed = true;
                this.entries.delete(value.id);
                this._emit('unregistered', value);
                return true;
            };
            dispose.contribution = value;
            this.entries.set(value.id, { value, dispose });
            try {
                owner?.own?.(dispose, `contribution:${this.type}:${value.id}`, 'contribution');
            } catch (error) {
                this.entries.delete(value.id);
                throw error;
            }
            this._emit('registered', value);
            return dispose;
        }

        unregister(id, expected = null) {
            const record = this.entries.get(id);
            if (!record || (expected && record.value !== expected)) return false;
            return record.dispose();
        }

        get(id) { return this.entries.get(id)?.value || null; }
        list(predicate = null) {
            const values = [...this.entries.values()].map(record => record.value);
            return predicate ? values.filter(predicate) : values;
        }

        subscribe(listener) {
            if (typeof listener !== 'function') throw new TypeError('Contribution subscriber must be a function.');
            this.listeners.add(listener);
            let active = true;
            return () => {
                if (!active) return false;
                active = false;
                return this.listeners.delete(listener);
            };
        }

        _emit(action, contribution) {
            const change = Object.freeze({ type: this.type, action, id: contribution.id, contribution });
            this.listeners.forEach(listener => {
                try { listener(change); } catch (error) { console.error('[VCPContributions] Subscriber failed:', error); }
            });
            globalObject?.dispatchEvent?.(new globalObject.CustomEvent('vcp-contributions-changed', { detail: change }));
        }
    }

    class CommandRegistry extends ContributionRegistry {
        constructor() { super('command'); }
        execute(id, ...args) {
            const command = this.get(id);
            if (!command) throw new Error(`Unknown command: ${id}`);
            return command.handler(...args);
        }
    }

    const commands = new CommandRegistry();
    const apps = new ContributionRegistry('app');

    const diagnostics = Object.freeze({
        snapshot: () => Object.freeze(Object.fromEntries(
            Object.entries({ commands, apps }).map(([name, registry]) => [
                name,
                Object.freeze(registry.list().map(entry => Object.freeze({ id: entry.id, ownerId: entry.ownerId }))),
            ])
        )),
    });

    return Object.freeze({ ContributionRegistry, CommandRegistry, commands, apps, diagnostics });
});
