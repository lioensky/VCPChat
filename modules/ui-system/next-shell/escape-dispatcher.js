/* Priority-based Escape ownership for Next-owned transient surfaces. */
(function installEscapeDispatcher(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) {
        const namespace = globalObject.VCPNextShell || {};
        globalObject.VCPNextShell = Object.freeze({ ...namespace, ...api });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createEscapeDispatcherApi() {
    'use strict';

    class EscapeDispatcher {
        constructor(options = {}) {
            this.document = options.document || globalThis.document;
            this.warn = options.warn || ((...args) => console.warn(...args));
            this.entries = new Set();
            this.sequence = 0;
            this.scope = null;
            this.abortController = null;
            this.mounted = false;
        }

        mount(scope = null) {
            if (this.mounted) return;
            this.mounted = true;
            this.scope = scope;
            const handler = event => this.dispatch(event);
            if (scope) {
                scope.listen(this.document, 'keydown', handler, true, 'escape-dispatcher');
                scope.own(() => this.dispose(), 'escape-dispatcher', 'controller');
            } else {
                const AbortControllerConstructor = this.document.defaultView?.AbortController || AbortController;
                this.abortController = new AbortControllerConstructor();
                this.document.addEventListener('keydown', handler, { capture: true, signal: this.abortController.signal });
            }
        }

        register(options = {}) {
            const entry = {
                priority: Number.isFinite(options.priority) ? options.priority : 0,
                sequence: this.sequence++,
                isActive: typeof options.isActive === 'function' ? options.isActive : () => true,
                close: typeof options.close === 'function' ? options.close : () => false,
                disposed: false,
            };
            this.entries.add(entry);
            return () => {
                if (entry.disposed) return;
                entry.disposed = true;
                this.entries.delete(entry);
            };
        }

        dispatch(event) {
            if (!this.mounted || event?.key !== 'Escape' || event.defaultPrevented) return false;
            const candidates = [...this.entries]
                .filter(entry => !entry.disposed)
                .sort((a, b) => b.priority - a.priority || b.sequence - a.sequence);
            for (const entry of candidates) {
                let active = false;
                try { active = Boolean(entry.isActive()); } catch (error) { this.warn('[NextUI] Escape owner activity check failed:', error); }
                if (!active) continue;
                try {
                    if (entry.close() === false) continue;
                } catch (error) {
                    this.warn('[NextUI] Escape owner close failed:', error);
                    continue;
                }
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                return true;
            }
            return false;
        }

        dispose() {
            if (!this.mounted) return;
            this.mounted = false;
            this.abortController?.abort();
            this.abortController = null;
            this.entries.clear();
            this.scope = null;
        }
    }

    return { EscapeDispatcher };
});
