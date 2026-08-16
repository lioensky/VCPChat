/*
 * LifecycleScope
 *
 * A small, framework-free ownership primitive for dynamic Next UI surfaces.
 * It follows the same contract used by mature disposable systems: acquisition
 * and cleanup stay together, owned resources unwind in reverse order, and a
 * disposed owner cannot be revived by late asynchronous work.
 */
(function installLifecycleScope(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) {
        globalObject.VCPLifecycle = Object.freeze(api);
        globalObject.dispatchEvent?.(new globalObject.CustomEvent('vcp-lifecycle-ready'));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLifecycleApi() {
    'use strict';

    const activeScopes = new Map();
    let nextScopeId = 1;

    function normalizeDisposer(disposable) {
        if (typeof disposable === 'function') return disposable;
        if (disposable && typeof disposable.dispose === 'function') {
            return () => disposable.dispose();
        }
        throw new TypeError('LifecycleScope resources require a function or an object with dispose().');
    }

    class LifecycleScope {
        constructor(label = 'anonymous', options = {}) {
            this.id = nextScopeId++;
            this.label = String(label || 'anonymous');
            this.parent = options.parent || null;
            this.state = 'active';
            this.reason = null;
            this.createdAt = Date.now();
            this.disposingAt = null;
            this._generation = 0;
            this._records = [];
            this._releasingRecords = new Set();
            this._disposePromise = null;
            this._parentRecord = null;
            activeScopes.set(this.id, this);
        }

        get active() {
            return this.state === 'active';
        }

        get disposed() {
            return this.state === 'disposed';
        }

        assertActive() {
            if (!this.active) throw new Error(`LifecycleScope "${this.label}" is ${this.state}.`);
        }

        _removeRecord(record) {
            const index = this._records.indexOf(record);
            if (index >= 0) this._records.splice(index, 1);
        }

        _register(disposable, label = 'resource', type = 'custom') {
            this.assertActive();
            const record = {
                active: true,
                dispose: normalizeDisposer(disposable),
                label: String(label || type),
                type: String(type || 'custom'),
                createdAt: Date.now(),
            };
            this._records.push(record);
            return record;
        }

        async _release(record, run = true) {
            if (!record) return;
            // forget() only retracts ownership. It must not join an in-flight
            // disposer because parent/child teardown would otherwise await itself.
            if (!record.active) return run ? record.releasePromise : Promise.resolve();
            record.active = false;
            this._removeRecord(record);
            if (!run) {
                record.releasePromise = Promise.resolve();
                return record.releasePromise;
            }
            record.releasePromise = Promise.resolve().then(() => record.dispose());
            // Keep a rejected cleanup observable by dispose() without allowing an
            // ignored manual release to become an unhandled rejection first.
            record.releasePromise.catch(() => {});
            this._releasingRecords.add(record);
            try {
                await record.releasePromise;
            } finally {
                this._releasingRecords.delete(record);
            }
            return record.releasePromise;
        }

        own(disposable, label = 'resource', type = 'custom') {
            const record = this._register(disposable, label, type);
            let releasePromise = null;
            const release = () => {
                if (!releasePromise) releasePromise = this._release(record, true);
                return releasePromise;
            };
            release.forget = () => this._release(record, false);
            return release;
        }

        listen(target, type, handler, options = undefined, label = `event:${type}`) {
            if (!target?.addEventListener || !target?.removeEventListener) {
                throw new TypeError(`LifecycleScope.listen(${type}) requires an EventTarget.`);
            }
            this.assertActive();
            let record;
            const once = Boolean(options && typeof options === 'object' && options.once);
            const ownedHandler = once
                ? (...args) => {
                    void this._release(record, false);
                    return handler.apply(target, args);
                }
                : handler;
            target.addEventListener(type, ownedHandler, options);
            record = this._register(() => target.removeEventListener(type, ownedHandler, options), label, 'listener');
            let releasePromise = null;
            return () => {
                if (!releasePromise) releasePromise = this._release(record, true);
                return releasePromise;
            };
        }

        subscribe(register, label = 'subscription') {
            this.assertActive();
            const disposable = register();
            if (disposable == null) return () => Promise.resolve();
            return this.own(disposable, label, 'subscription');
        }

        observe(observer, target, options, label = 'observer') {
            if (!observer || typeof observer.observe !== 'function' || typeof observer.disconnect !== 'function') {
                throw new TypeError('LifecycleScope.observe() requires an observer with observe() and disconnect().');
            }
            this.assertActive();
            observer.observe(target, options);
            return this.own(() => observer.disconnect(), label, 'observer');
        }

        timeout(callback, delay, label = 'timeout') {
            this.assertActive();
            let record;
            const timer = setTimeout(() => {
                void this._release(record, false);
                if (this.active) callback();
            }, delay);
            record = this._register(() => clearTimeout(timer), label, 'timeout');
            return () => this._release(record, true);
        }

        interval(callback, delay, label = 'interval') {
            this.assertActive();
            const timer = setInterval(() => {
                if (this.active) callback();
            }, delay);
            return this.own(() => clearInterval(timer), label, 'interval');
        }

        animationFrame(callback, label = 'animation-frame') {
            this.assertActive();
            const request = globalThis.requestAnimationFrame || (fn => setTimeout(fn, 16));
            const cancel = globalThis.cancelAnimationFrame || clearTimeout;
            let record;
            const frame = request(timestamp => {
                void this._release(record, false);
                if (this.active) callback(timestamp);
            });
            record = this._register(() => cancel(frame), label, 'animation-frame');
            return () => this._release(record, true);
        }

        abortController(label = 'abort-controller') {
            this.assertActive();
            const controller = new AbortController();
            this.own(() => controller.abort(), label, 'abort-controller');
            return controller;
        }

        child(label) {
            this.assertActive();
            const child = new LifecycleScope(label, { parent: this });
            child._parentRecord = this._register(
                () => child.dispose('parent-disposed'),
                `child:${child.label}`,
                'child-scope'
            );
            return child;
        }

        bumpGeneration() {
            this.assertActive();
            this._generation += 1;
            return this._generation;
        }

        guard(callback, generation = this._generation) {
            return (...args) => {
                if (!this.active || generation !== this._generation) return undefined;
                return callback(...args);
            };
        }

        track(promise, label = 'async-task') {
            this.assertActive();
            let record;
            record = this._register(() => {}, label, 'async-task');
            return Promise.resolve(promise).finally(() => this._release(record, false));
        }

        snapshot() {
            const resources = this._records.filter(record => record.active).map(record => ({
                label: record.label,
                type: record.type,
                ageMs: Math.max(0, Date.now() - record.createdAt),
            }));
            return Object.freeze({
                id: this.id,
                label: this.label,
                parentId: this.parent?.id || null,
                state: this.state,
                generation: this._generation,
                reason: this.reason,
                ageMs: Math.max(0, Date.now() - this.createdAt),
                disposingMs: this.disposingAt ? Math.max(0, Date.now() - this.disposingAt) : 0,
                resourceCount: resources.length,
                resources,
            });
        }

        dispose(reason = 'disposed') {
            if (this._disposePromise) return this._disposePromise;
            this.state = 'disposing';
            this.reason = reason;
            this.disposingAt = Date.now();
            this._generation += 1;
            this._disposePromise = (async () => {
                const errors = [];
                for (const record of [...this._records].reverse()) {
                    try {
                        await this._release(record, true);
                    } catch (error) {
                        errors.push(error);
                    }
                }
                // A caller may have started release() immediately before dispose().
                // Such a record is no longer in _records, but the scope still owns
                // the completion of that cleanup and must not report disposed early.
                while (this._releasingRecords.size) {
                    const releasing = [...this._releasingRecords];
                    const results = await Promise.allSettled(releasing.map(record => record.releasePromise));
                    results.forEach(result => {
                        if (result.status === 'rejected' && !errors.includes(result.reason)) errors.push(result.reason);
                    });
                }
                this.state = 'disposed';
                activeScopes.delete(this.id);
                if (this.parent && this._parentRecord) {
                    await this.parent._release(this._parentRecord, false);
                    this._parentRecord = null;
                }
                if (errors.length) throw new AggregateError(errors, `LifecycleScope "${this.label}" cleanup failed.`);
            })();
            return this._disposePromise;
        }
    }

    const diagnostics = Object.freeze({
        snapshot() {
            return [...activeScopes.values()].map(scope => scope.snapshot());
        },
        summary() {
            const scopes = this.snapshot();
            const resourcesByType = {};
            for (const scope of scopes) {
                for (const resource of scope.resources) {
                    resourcesByType[resource.type] = (resourcesByType[resource.type] || 0) + 1;
                }
            }
            return Object.freeze({
                activeScopes: scopes.length,
                activeResources: scopes.reduce((sum, scope) => sum + scope.resourceCount, 0),
                resourcesByType: Object.freeze(resourcesByType),
            });
        },
        find(label) {
            return this.snapshot().filter(scope => scope.label === label);
        },
    });

    return Object.freeze({ LifecycleScope, diagnostics });
});
