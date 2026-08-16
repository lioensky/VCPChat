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
            this.getPerformance = options.getPerformance || (() => globalThis.VCPPerformance);
            this.warn = options.warn || ((...args) => console.warn(...args));
            this.stateDisposer = null;
            this.mounted = false;
            this.scope = null;
            const channels = globalThis.VCPStateChannels;
            this.stateChannel = channels?.get('embedded-sessions') || channels?.create('embedded-sessions', Object.freeze({
                sessions: Object.freeze([]), activeAction: null, lastEvent: null
            })) || null;
            this.currentState = this.stateChannel?.get() || Object.freeze({ sessions: Object.freeze([]), activeAction: null, lastEvent: null });
            this.listeners = new Set();
        }

        get supported() {
            return typeof this.getApi()?.desktopCreateEmbeddedVchatApp === 'function';
        }

        mount(scope, onState) {
            if (this.mounted) return;
            this.mounted = true;
            this.scope = scope || null;
            this.stateDisposer = this.getApi()?.onEmbeddedVchatAppState?.(payload => {
                this.applyEvent(payload);
            }) || null;
            if (typeof onState === 'function') {
                const unsubscribe = this.subscribe((_state, snapshot) => {
                    if (snapshot.source === 'embedded-event') onState(snapshot.value.lastEvent);
                }, { immediate: false });
                scope?.own?.(unsubscribe, 'embedded-state-consumer', 'subscription');
            }
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

        measure(name, operation, metadata) {
            const recorder = this.getPerformance();
            return recorder?.measure ? recorder.measure(name, operation, metadata) : operation();
        }

        publishState(value, source) {
            const state = Object.freeze({
                sessions: Object.freeze([...(value.sessions || [])].map(session => Object.freeze({ action: session.action }))),
                activeAction: value.activeAction || null,
                lastEvent: value.lastEvent || null,
            });
            this.currentState = state;
            this.stateChannel?.publish(state, { source });
            return state;
        }

        applyEvent(payload) {
            const current = this.getState();
            const sessions = [...(current.sessions || [])];
            if (payload?.action && payload.state === 'ready' && !sessions.some(item => item.action === payload.action)) {
                sessions.push({ action: payload.action });
            }
            if (payload?.action && payload.state === 'closed') {
                const index = sessions.findIndex(item => item.action === payload.action);
                if (index >= 0) sessions.splice(index, 1);
            }
            this.publishState({
                sessions,
                activeAction: payload?.state === 'closed' && current.activeAction === payload.action ? null : current.activeAction,
                lastEvent: payload || null,
            }, 'embedded-event');
            const state = this.getState();
            const snapshot = Object.freeze({ source: 'embedded-event', value: state });
            this.listeners.forEach(listener => listener(state, snapshot));
        }

        getState() {
            return this.stateChannel?.get() || this.currentState;
        }

        subscribe(listener, options) {
            if (typeof listener !== 'function') throw new TypeError('Embedded state subscriber must be a function.');
            this.listeners.add(listener);
            if (options?.immediate !== false) listener(this.getState(), Object.freeze({ source: 'initial', value: this.getState() }));
            let active = true;
            return () => {
                if (!active) return false;
                active = false;
                return this.listeners.delete(listener);
            };
        }

        create(action, ownerScope = this.scope) {
            return this.measure('embedded.create', () => (
                Promise.resolve(this.runTask('create', ownerScope, (requestId, api) => (
                    api?.desktopCreateEmbeddedVchatApp?.(action, requestId)
                ))).then(result => {
                    if (result?.success && result.reused) this.applyEvent({ action, state: 'ready', reused: true });
                    return result;
                })
            ), { action });
        }

        activate(action) {
            return this.measure('embedded.activate', () => (
                Promise.resolve(this.getApi()?.desktopActivateEmbeddedVchatApp?.(action)).then(result => {
                    if (result?.success) this.publishState({ ...this.getState(), activeAction: action || null }, 'embedded-activate');
                    return result;
                })
            ), { action: action || 'none' });
        }

        hide() {
            return this.activate(null);
        }

        setBounds(action, bounds) {
            return this.getApi()?.desktopSetEmbeddedVchatAppBounds?.(action, bounds);
        }

        list() {
            return Promise.resolve(this.getApi()?.desktopListEmbeddedVchatApps?.()).then(result => {
                if (result) this.publishState({ ...result, lastEvent: this.getState().lastEvent }, 'embedded-reconcile');
                return result;
            });
        }

        detach(action, point, ownerScope = this.scope) {
            return Promise.resolve(this.runTask('detach', ownerScope, (requestId, api) => (
                api?.desktopDetachEmbeddedVchatApp?.(action, point, requestId)
            )));
        }

        close(action, ownerScope = this.scope) {
            return Promise.resolve(this.runTask('close', ownerScope, (requestId, api) => (
                api?.desktopCloseEmbeddedVchatApp?.(action, requestId)
            )));
        }

        async closeAll(actions = []) {
            const api = this.getApi();
            if (api?.desktopCloseAllEmbeddedVchatApps) {
                const result = await api.desktopCloseAllEmbeddedVchatApps();
                if (result?.success !== false) this.publishState({ sessions: [], activeAction: null, lastEvent: { state: 'closed-all' } }, 'embedded-close-all');
                return result;
            }
            if (api?.desktopCloseEmbeddedVchatApp) {
                const result = await Promise.all(actions.map(action => api.desktopCloseEmbeddedVchatApp(action)));
                this.publishState({ sessions: [], activeAction: null, lastEvent: { state: 'closed-all' } }, 'embedded-close-all');
                return result;
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
            this.listeners.clear();
        }
    }

    return { EmbeddedAppController };
});
