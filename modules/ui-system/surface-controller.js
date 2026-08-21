/* Deterministic lifecycle for Next-owned VCPUI surfaces. */
(function installSurfaceController(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) globalObject.VCPUISurface = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSurfaceApi() {
    'use strict';

    class SurfaceController {
        constructor(options = {}) {
            this.window = options.window || globalThis.window;
            this.document = options.document || this.window.document;
            this.label = options.label || 'next:surface';
            this.ownerScope = options.ownerScope || null;
            this.getUi = options.getUi || (() => this.window.VCPUI);
            this.state = 'idle';
            this.kernel = null;
            this.scope = null;
            this.host = null;
            this.focusOrigin = null;
            this.fallback = false;
            this.kernelPreference = options.kernelPreference || null;
            this.disposers = [];
            this.disposePromise = null;
            this.ownerRelease = null;
        }

        chooseKernel() {
            if (this.kernelPreference === 'native' || this.kernelPreference === 'web-awesome') return this.kernelPreference;
            const runtime = this.window.VCPWebAwesome?.getRuntimeState?.();
            return this.document.documentElement.dataset.uiMode === 'next' && runtime?.state === 'ready'
                ? 'web-awesome'
                : 'native';
        }

        _createScope(label = this.label) {
            const LifecycleScope = this.window.VCPLifecycle?.LifecycleScope;
            return this.ownerScope?.child?.(label) || (LifecycleScope ? new LifecycleScope(label) : null);
        }

        async mount(host, render, options = {}) {
            if (this.state === 'mounted') return this;
            if (this.state !== 'idle') throw new Error(`Surface "${this.label}" cannot mount from ${this.state}.`);
            if (!host || typeof render !== 'function') throw new TypeError('Surface mount requires a host and render callback.');
            this.state = 'mounting';
            this.host = host;
            this.focusOrigin = options.focusOrigin || this.document.activeElement;
            this.kernel = this.chooseKernel();
            this.scope = this._createScope();
            if (this.ownerScope?.own) {
                this.ownerRelease = this.ownerScope.own(() => this.dispose('owner-disposed'), `surface:${this.label}`, 'controller');
            }
            if (this.kernel === 'web-awesome') {
                const releaseKernelScope = this.window.VCPWebAwesome?.mountScope?.(host);
                if (releaseKernelScope) this.own(releaseKernelScope, 'webawesome-surface-scope', 'ui-registration');
            }
            const context = Object.freeze({
                kernel: this.kernel,
                ui: this.getUi(),
                scope: this.scope,
                own: (value, label, type) => this.own(value, label, type),
                create: (name, componentOptions = {}) => {
                    if (this.state !== 'mounting') throw new Error(`Surface "${this.label}" only creates controls during mount.`);
                    const control = this.getUi()?.create(name, componentOptions);
                    if (!control) throw new Error(`VCPUI could not create ${name}.`);
                    this.own(control, `control:${name}`, 'ui-registration');
                    return control;
                },
            });
            try {
                render(context);
                this.own(() => host.remove(), 'surface-host', 'dom');
                this.state = 'mounted';
            } catch (error) {
                this.fallback = true;
                await this._disposeOwned('mount-failed');
                this.scope = this._createScope(`${this.label}:fallback`);
                host.replaceChildren();
                options.renderFallback?.(host, error);
                this.own(() => host.remove(), 'surface-host', 'dom');
                this.state = 'mounted';
            }
            return this;
        }

        own(value, label = 'surface-resource', type = 'custom') {
            const disposer = typeof value === 'function' ? value : () => value?.destroy?.() ?? value?.dispose?.();
            if (this.scope) return this.scope.own(disposer, label, type);
            let active = true;
            const release = async () => {
                if (!active) return;
                active = false;
                await disposer();
            };
            this.disposers.push(release);
            return release;
        }

        focus(target = null) {
            const candidate = target || this.host?.querySelector('[autofocus], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
            candidate?.focus?.();
        }

        async _disposeOwned(reason) {
            if (this.scope) {
                const scope = this.scope;
                this.scope = null;
                await scope.dispose(reason);
                return;
            }
            for (const dispose of [...this.disposers].reverse()) await dispose();
            this.disposers.length = 0;
        }

        dispose(reason = 'surface-disposed') {
            if (this.disposePromise) return this.disposePromise;
            this.state = 'disposing';
            this.disposePromise = (async () => {
                await this._disposeOwned(reason);
                this.state = 'disposed';
                const focus = this.focusOrigin?.isConnected ? this.focusOrigin : null;
                this.host = null;
                this.focusOrigin = null;
                await this.ownerRelease?.forget?.();
                this.ownerRelease = null;
                focus?.focus?.();
            })();
            return this.disposePromise;
        }
    }

    return Object.freeze({ SurfaceController });
});
