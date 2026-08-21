/* Cancellable renderer task primitive for requestId-based IPC operations. */
(function installTaskHandle(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) globalObject.VCPTasks = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTaskHandleApi() {
    'use strict';
    const activeTasks = new Map();

    function createCancellationToken() {
        let aborted = false;
        let reason;
        const token = Object.freeze({
            get aborted() { return aborted; },
            get reason() { return reason; },
            throwIfCancelled() {
                if (!aborted) return;
                const error = new Error(String(reason || 'Task cancelled.'));
                error.name = 'TaskCancelledError';
                throw error;
            },
        });
        return {
            token,
            cancel(nextReason) {
                if (aborted) return false;
                aborted = true;
                reason = nextReason;
                return true;
            },
        };
    }

    class TaskHandle {
        constructor(options = {}) {
            if (!options.id) throw new TypeError('TaskHandle requires a stable id.');
            if (typeof options.start !== 'function') throw new TypeError('TaskHandle requires start().');
            this.id = String(options.id);
            if (activeTasks.has(this.id)) throw new Error(`TaskHandle id already active: ${this.id}`);
            this.cancelOperation = typeof options.cancel === 'function' ? options.cancel : null;
            this.cancellation = createCancellationToken();
            this.state = 'pending';
            this.cancelPromise = null;
            this.startedAt = Date.now();
            this.ownerLabel = null;
            activeTasks.set(this.id, this);
            this.promise = Promise.resolve().then(() => options.start(this.id, this.cancellation.token)).then(
                value => {
                    if (this.state === 'pending') this.state = 'fulfilled';
                    return value;
                },
                error => {
                    if (this.state === 'pending') this.state = 'rejected';
                    throw error;
                }
            );
            void this.promise.then(() => activeTasks.delete(this.id), () => activeTasks.delete(this.id));
        }

        get settled() { return this.state === 'fulfilled' || this.state === 'rejected'; }
        get cancelled() { return this.state === 'cancelling' || this.state === 'cancelled'; }

        cancel(reason = 'cancelled') {
            if (this.settled || this.state === 'cancelled') return this.cancelPromise || Promise.resolve(false);
            if (this.cancelPromise) return this.cancelPromise;
            this.state = 'cancelling';
            this.cancellation.cancel(reason);
            this.cancelPromise = Promise.resolve(this.cancelOperation?.(this.id, reason)).then(
                () => { this.state = 'cancelled'; return true; },
                error => { this.state = 'cancelled'; throw error; }
            );
            return this.cancelPromise;
        }

        own(scope, label = `task:${this.id}`) {
            if (!scope) return this.promise;
            this.ownerLabel = scope.label || null;
            const tracked = scope.track(this.promise, label);
            const releaseCancellation = scope.own(
                () => this.cancel('scope-disposed').catch(() => {}),
                `${label}:cancel`,
                'task-cancel'
            );
            void tracked.then(releaseCancellation.forget, releaseCancellation.forget);
            return tracked;
        }
    }

    let nextTaskSequence = 1;
    function createTaskId(operation = 'task') {
        const prefix = String(operation || 'task').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 48) || 'task';
        const uuid = globalThis.crypto?.randomUUID?.();
        return `${prefix}:${uuid || `${Date.now().toString(36)}-${nextTaskSequence++}`}`;
    }

    const createTask = options => new TaskHandle(options);
    const diagnostics = Object.freeze({
        snapshot: () => [...activeTasks.values()].map(task => Object.freeze({
            id: task.id,
            state: task.state,
            owner: task.ownerLabel,
            ageMs: Math.max(0, Date.now() - task.startedAt),
            cancelled: task.cancelled,
        })),
    });
    return { TaskHandle, createTask, createTaskId, diagnostics };
});
