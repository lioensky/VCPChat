/* Native embedded application session gateway for the Next presentation. */
(function installEmbeddedAppController(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) {
        const namespace = globalObject.VCPNextShell || {};
        globalObject.VCPNextShell = Object.freeze({ ...namespace, ...api });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createEmbeddedAppControllerApi() {
    'use strict';

    class EmbeddedAppController {
        constructor(options = {}) {
            this.getApi = options.getApi || (() => null);
            this.warn = options.warn || ((...args) => console.warn(...args));
            this.stateDisposer = null;
            this.mounted = false;
        }

        get supported() {
            return typeof this.getApi()?.desktopCreateEmbeddedVchatApp === 'function';
        }

        mount(scope, onState) {
            if (this.mounted) return;
            this.mounted = true;
            this.stateDisposer = this.getApi()?.onEmbeddedVchatAppState?.(onState) || null;
            if (scope) scope.own(() => this.dispose(), 'embedded-app-controller', 'controller');
        }

        create(action) {
            return this.getApi()?.desktopCreateEmbeddedVchatApp?.(action);
        }

        activate(action) {
            return this.getApi()?.desktopActivateEmbeddedVchatApp?.(action);
        }

        hide() {
            return this.activate(null);
        }

        setBounds(action, bounds) {
            return this.getApi()?.desktopSetEmbeddedVchatAppBounds?.(action, bounds);
        }

        list() {
            return this.getApi()?.desktopListEmbeddedVchatApps?.();
        }

        detach(action, point) {
            return this.getApi()?.desktopDetachEmbeddedVchatApp?.(action, point);
        }

        close(action) {
            return this.getApi()?.desktopCloseEmbeddedVchatApp?.(action);
        }

        async closeAll(actions = []) {
            const api = this.getApi();
            if (api?.desktopCloseAllEmbeddedVchatApps) return api.desktopCloseAllEmbeddedVchatApps();
            if (api?.desktopCloseEmbeddedVchatApp) {
                return Promise.all(actions.map(action => api.desktopCloseEmbeddedVchatApp(action)));
            }
            return undefined;
        }

        dispose() {
            if (!this.mounted) return;
            this.mounted = false;
            try {
                this.stateDisposer?.();
            } catch (error) {
                this.warn('[NextUI] Failed to dispose embedded app state subscription:', error);
            }
            this.stateDisposer = null;
        }
    }

    return { EmbeddedAppController };
});
