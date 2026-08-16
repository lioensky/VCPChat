/*
 * OverlayCoordinator
 *
 * Owns the relationship between renderer overlays and native embedded views.
 * A renderer overlay acquires a lease before it becomes visible. The first
 * lease hides the native view; releasing the last lease reconciles the view
 * selected by AppTabHost. Modal visibility events are translated into the
 * same lease protocol so there is only one overlay authority.
 */
(function installOverlayCoordinator(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) {
        const namespace = globalObject.VCPNextShell || {};
        globalObject.VCPNextShell = Object.freeze({ ...namespace, ...api });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createOverlayCoordinatorApi() {
    'use strict';

    class OverlayCoordinator {
        constructor(options = {}) {
            this.document = options.document || globalThis.document;
            this.hideEmbeddedView = options.hideEmbeddedView || (() => Promise.resolve());
            this.reconcileEmbeddedView = options.reconcileEmbeddedView || (() => {});
            this.warn = options.warn || ((...args) => console.warn(...args));
            this.owners = new Set();
            this.modalOwners = new Map();
            this.scope = null;
            this.abortController = null;
            this.mounted = false;
        }

        get active() {
            return this.owners.size > 0;
        }

        mount(scope = null) {
            if (this.mounted) return;
            this.mounted = true;
            this.scope = scope;
            const handler = event => this.handleModalVisibilityChanged(event);
            if (scope) {
                scope.listen(this.document, 'modal-visibility-changed', handler, undefined, 'overlay:modal-visibility');
                scope.own(() => this.dispose(), 'overlay-coordinator', 'controller');
            } else {
                const AbortControllerConstructor = this.document.defaultView?.AbortController || AbortController;
                this.abortController = new AbortControllerConstructor();
                this.document.addEventListener('modal-visibility-changed', handler, { signal: this.abortController.signal });
            }
            this.reconcileVisibleModals();
        }

        dispatchState(active) {
            const CustomEventConstructor = this.document.defaultView?.CustomEvent || CustomEvent;
            this.document.dispatchEvent(new CustomEventConstructor('next-ui-overlay-changed', { detail: { active } }));
        }

        async acquire(owner = Symbol('next-ui-overlay')) {
            if (!this.mounted) throw new Error('OverlayCoordinator must be mounted before acquiring a lease.');
            const wasEmpty = this.owners.size === 0;
            this.owners.add(owner);
            if (wasEmpty) this.dispatchState(true);
            try {
                await this.hideEmbeddedView();
            } catch (error) {
                const removed = this.owners.delete(owner);
                if (removed && this.owners.size === 0) this.dispatchState(false);
                this.warn('[NextUI] Failed to hide embedded app for overlay:', error);
                throw error;
            } finally {
                // A lease can be released while hide IPC is still pending. A
                // late hide result must never become the final native state.
                if (!this.owners.has(owner)) this.reconcileEmbeddedView();
            }
            return owner;
        }

        release(owner) {
            if (!this.owners.delete(owner)) return false;
            if (this.owners.size === 0) this.dispatchState(false);
            this.reconcileEmbeddedView();
            return true;
        }

        handleModalVisibilityChanged(event) {
            const modalId = event.detail?.modalId;
            if (typeof modalId !== 'string' || !modalId) return;
            if (event.detail?.active === true) {
                if (this.modalOwners.has(modalId)) return;
                const owner = Symbol(`modal-overlay:${modalId}`);
                this.modalOwners.set(modalId, owner);
                void this.acquire(owner).catch(error => {
                    if (this.modalOwners.get(modalId) === owner) this.modalOwners.delete(modalId);
                    this.warn(`[NextUI] Failed to acquire overlay for modal ${modalId}:`, error);
                });
                return;
            }
            const owner = this.modalOwners.get(modalId);
            if (!owner) return;
            this.modalOwners.delete(modalId);
            this.release(owner);
        }

        reconcileVisibleModals() {
            this.document.querySelectorAll('.modal.active[id]').forEach(modal => {
                this.handleModalVisibilityChanged({ detail: { modalId: modal.id, active: true } });
            });
        }

        snapshot() {
            return Object.freeze({
                mounted: this.mounted,
                active: this.active,
                owners: Object.freeze([...this.owners].map(owner => typeof owner === 'symbol' ? owner.description || 'symbol' : String(owner))),
                modalIds: Object.freeze([...this.modalOwners.keys()]),
            });
        }

        dispose() {
            if (!this.mounted) return;
            this.mounted = false;
            this.abortController?.abort();
            this.abortController = null;
            this.scope = null;
            this.modalOwners.clear();
            if (this.owners.size > 0) this.dispatchState(false);
            this.owners.clear();
        }
    }

    return { OverlayCoordinator };
});
