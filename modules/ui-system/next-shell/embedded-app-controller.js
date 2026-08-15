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
            this.getTasks = options.getTasks || (() => globalThis.VCPTasks);
            this.warn = options.warn || ((...args) => console.warn(...args));
            this.stateDisposer = null;
            this.mounted = false;
            this.scope = null;
        }

        get supported() {
            return typeof this.getApi()?.desktopCreateEmbeddedVchatApp === 'function';
        }

        mount(scope, onState) {
            if (this.mounted) return;
            this.mounted = true;
            this.scope = scope || null;
            this.stateDisposer = this.getApi()?.onEmbeddedVchatAppState?.(onState) || null;
            if (scope) scope.own(() => this.dispose(), 'embedded-app-controller', 'controller');
        }

        runTask(operation, ownerScope, start) {
            const api = this.getApi();
            const tasks = this.getTasks();
            if (!tasks?.createTask) return start('', api);
            const requestId = tasks.createTaskId?.(`embedded-${operation}`) || `embedded-${operation}:${Date.now()}`;
            const task = tasks.createTask({
                id: requestId,
                start: id => start(id, api),
                cancel: id => api?.desktopCancelEmbeddedVchatAppTask?.(id),
            });
            return ownerScope ? task.own(ownerScope, `embedded:${operation}`) : task.promise;
        }

        create(action, ownerScope = this.scope) {
            return this.runTask('create', ownerScope, (requestId, api) => (
                api?.desktopCreateEmbeddedVchatApp?.(action, requestId)
            ));
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

        detach(action, point, ownerScope = this.scope) {
            return this.runTask('detach', ownerScope, (requestId, api) => (
                api?.desktopDetachEmbeddedVchatApp?.(action, point, requestId)
            ));
        }

        close(action, ownerScope = this.scope) {
            return this.runTask('close', ownerScope, (requestId, api) => (
                api?.desktopCloseEmbeddedVchatApp?.(action, requestId)
            ));
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
            this.scope = null;
        }
    }

    return { EmbeddedAppController };
});
