/* Cancellable renderer task primitive for requestId-based IPC operations. */
(function installTaskHandle(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) globalObject.VCPTasks = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTaskHandleApi() {
    'use strict';

    class TaskHandle {
        constructor(options = {}) {
            if (!options.id) throw new TypeError('TaskHandle requires a stable id.');
            if (typeof options.start !== 'function') throw new TypeError('TaskHandle requires start().');
            this.id = String(options.id);
            this.cancelOperation = typeof options.cancel === 'function' ? options.cancel : null;
            this.state = 'pending';
            this.cancelPromise = null;
            this.promise = Promise.resolve().then(() => options.start(this.id)).then(
                value => {
                    if (this.state === 'pending') this.state = 'fulfilled';
                    return value;
                },
                error => {
                    if (this.state === 'pending') this.state = 'rejected';
                    throw error;
                }
            );
        }

        get settled() { return this.state === 'fulfilled' || this.state === 'rejected'; }
        get cancelled() { return this.state === 'cancelling' || this.state === 'cancelled'; }

        cancel(reason = 'cancelled') {
            if (this.settled || this.state === 'cancelled') return this.cancelPromise || Promise.resolve(false);
            if (this.cancelPromise) return this.cancelPromise;
            this.state = 'cancelling';
            this.cancelPromise = Promise.resolve(this.cancelOperation?.(this.id, reason)).then(
                () => { this.state = 'cancelled'; return true; },
                error => { this.state = 'cancelled'; throw error; }
            );
            return this.cancelPromise;
        }

        own(scope, label = `task:${this.id}`) {
            if (!scope) return this.promise;
            const tracked = scope.track(this.promise, label);
            scope.own(() => this.cancel('scope-disposed').catch(() => {}), `${label}:cancel`, 'task-cancel');
            return tracked;
        }
    }

    const createTask = options => new TaskHandle(options);
    return { TaskHandle, createTask };
});
