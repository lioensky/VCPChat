/* Dynamic tab and view authority for the Next presentation. */
(function installAppTabHost(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) {
        const namespace = globalObject.VCPNextShell || {};
        globalObject.VCPNextShell = Object.freeze({ ...namespace, ...api });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAppTabHostApi() {
    'use strict';

    class AppTabHost {
        constructor(options = {}) {
            this.document = options.document || globalThis.document;
            this.storage = options.storage || globalThis.sessionStorage;
            this.sessionKey = options.sessionKey || 'vcpchat.nextUi.openTabs.v1';
            this.canPersist = options.canPersist || (() => true);
            this.onActivate = options.onActivate || (() => {});
            this.onCloseRequested = options.onCloseRequested || (() => {});
            this.suppressedClicks = options.suppressedClicks || new Set();
            this.views = new Map();
            this.activeViewId = 'home';
            this.mounted = false;
            this.revision = 0;
            this.listeners = new Set();
        }

        mount(scope) {
            if (this.mounted) return;
            this.mounted = true;
            if (scope) scope.own(() => this.dispose(), 'app-tab-host', 'controller');
        }

        readSession() {
            try {
                const parsed = JSON.parse(this.storage.getItem(this.sessionKey) || 'null');
                if (!parsed || !Array.isArray(parsed.tabs)) return null;
                return {
                    activeViewId: typeof parsed.activeViewId === 'string' ? parsed.activeViewId : 'home',
                    tabs: parsed.tabs.filter(tab => tab && typeof tab.id === 'string' && (tab.kind === 'internal' || tab.kind === 'embedded')),
                };
            } catch {
                return null;
            }
        }

        snapshot() {
            return {
                activeViewId: this.activeViewId,
                tabs: [...this.views.values()].map(view => ({ kind: view.kind, id: view.app.id })),
            };
        }

        getSnapshot() {
            return Object.freeze({ revision: this.revision, ...this.snapshot() });
        }

        publish() {
            this.revision += 1;
            const snapshot = this.getSnapshot();
            this.listeners.forEach(listener => {
                try { listener(snapshot, snapshot); } catch (error) { console.error('[NextUI] AppTab subscriber failed:', error); }
            });
            return snapshot;
        }

        subscribe(listener, options = {}) {
            this.listeners.add(listener);
            if (options.immediate !== false) listener(this.getSnapshot(), this.getSnapshot());
            return () => this.listeners.delete(listener);
        }

        whenSettled(options = {}) {
            const wait = globalThis.VCPSettlement?.waitForSettlement;
            if (!wait) return Promise.reject(new Error('VCPSettlement is unavailable.'));
            return wait({
                ...options,
                label: 'AppTab host',
                getSnapshot: () => this.getSnapshot(),
                subscribe: (listener, subscribeOptions) => this.subscribe(listener, subscribeOptions),
            });
        }

        persist(force = false) {
            if (!force && !this.canPersist()) return;
            try {
                this.storage.setItem(this.sessionKey, JSON.stringify(this.snapshot()));
            } catch {
                // Session restoration is a convenience and cannot block UI.
            }
        }

        createTab({ id, title, icon, iconSvg, closeLabel, scope }) {
            const tab = this.document.createElement('div');
            tab.className = 'next-ui-tab';
            tab.dataset.viewId = id;
            // The wrapper owns the visual tab slot and drag affordance. Keep
            // the actionable tab and close control as siblings: a `role=tab`
            // must not contain an interactive descendant (AT treats tab
            // descendants as presentational).
            tab.setAttribute('role', 'presentation');
            const tabButton = this.document.createElement('button');
            tabButton.type = 'button';
            tabButton.className = 'next-ui-tab-label next-ui-tab-label-button';
            tabButton.id = `nextUiTab-${String(id).replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
            tabButton.setAttribute('role', 'tab');
            tabButton.setAttribute('aria-selected', 'false');
            tabButton.tabIndex = -1;
            const label = this.document.createElement('span');
            label.className = 'vcp-ui-scope';
            if (icon || iconSvg) {
                const symbol = this.document.createElement('span');
                symbol.className = icon ? 'vcp-ui-icon next-ui-tab-symbol' : 'next-ui-tab-symbol next-ui-tab-svg';
                symbol.setAttribute('aria-hidden', 'true');
                if (icon) symbol.textContent = icon;
                else symbol.innerHTML = iconSvg;
                label.append(symbol);
            }
            const text = this.document.createElement('span');
            text.textContent = title;
            label.append(text);
            tabButton.append(label);
            const close = this.document.createElement('button');
            close.type = 'button';
            close.className = 'next-ui-tab-close';
            close.setAttribute('aria-label', closeLabel || `关闭${title}标签`);
            close.title = '关闭标签';
            close.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">close</span>';
            tab.append(tabButton, close);
            const listen = (type, handler) => scope
                ? scope.listen(tab, type, handler, undefined, `tab:${id}:${type}`)
                : tab.addEventListener(type, handler);
            listen('click', event => {
                if (this.suppressedClicks.delete(id)) return void event.preventDefault();
                if (event.target.closest('.next-ui-tab-close')) {
                    event.stopPropagation();
                    this.onCloseRequested(id);
                } else this.setView(id);
            });
            listen('keydown', event => {
                if (event.target.closest('.next-ui-tab-close') || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                this.setView(id);
            });
            listen('keydown', event => {
                if (event.target.closest('.next-ui-tab-close')) return;
                const tabs = [...this.document.querySelectorAll('#nextUiDynamicTabs .next-ui-tab-label-button')];
                const current = tabs.indexOf(tabButton);
                if (current < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 0
                    : event.key === 'End' ? tabs.length - 1
                        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                tabs[next]?.focus();
            });
            this.document.getElementById('nextUiDynamicTabs')?.append(tab);
            return tab;
        }

        register(viewId, view) {
            const tabButton = view.tabButton || view.tab?.querySelector?.('.next-ui-tab-label-button') || view.tab;
            view.tabButton = tabButton;
            const panelId = view.container.id || `nextUiPanel-${String(viewId).replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
            view.container.id = panelId;
            tabButton.setAttribute('aria-controls', panelId);
            view.container.setAttribute('role', 'tabpanel');
            if (tabButton.id) view.container.setAttribute('aria-labelledby', tabButton.id);
            this.views.set(viewId, view);
            this.publish();
        }

        updateVisibility() {
            const previousViewId = this._lastActiveViewId || 'home';
            const isHome = this.activeViewId === 'home';
            const isLaunchpad = this.activeViewId === 'launchpad';
            const isInternal = this.activeViewId.startsWith('app:');
            this.document.body.classList.toggle('next-ui-launchpad-open', isLaunchpad);
            this.document.body.classList.toggle('next-ui-internal-app-open', isInternal);
            const homeTab = this.document.getElementById('nextUiHomeTab');
            const addTabButton = this.document.getElementById('nextUiAddTabBtn');
            const launchpad = this.document.getElementById('nextUiLaunchpad');
            const host = this.document.getElementById('nextUiInternalAppHost');
            const activeView = isInternal ? this.views.get(this.activeViewId) : null;
            homeTab?.classList.toggle('active', isHome);
            homeTab?.setAttribute('aria-selected', String(isHome));
            launchpad?.setAttribute('aria-hidden', String(!isLaunchpad));
            // App buttons are created dynamically, so static interaction gates
            // cannot see their focusability while the surface is closed.
            // Keep the hidden launchpad out of keyboard/AT navigation.
            if (launchpad) launchpad.inert = !isLaunchpad;
            host?.setAttribute('aria-hidden', String(!isInternal));
            if (host) {
                host.hidden = !isInternal;
                host.dataset.activeAppId = activeView?.app?.id || '';
            }
            addTabButton?.classList.toggle('active', isLaunchpad);
            addTabButton?.setAttribute('aria-selected', String(isLaunchpad));
            addTabButton?.setAttribute('aria-expanded', String(isLaunchpad));
            this.views.forEach((view, id) => {
                const active = id === this.activeViewId;
                view.tab.classList.toggle('active', active);
                const tabButton = view.tabButton || view.tab;
                tabButton.setAttribute('aria-selected', String(active));
                tabButton.tabIndex = active ? 0 : -1;
                view.container.hidden = !active;
                view.container.setAttribute('role', 'tabpanel');
                if (tabButton.id) view.container.setAttribute('aria-labelledby', tabButton.id);
            });
            this.onActivate(this.activeViewId, activeView);
            this._lastActiveViewId = this.activeViewId;
            if (previousViewId !== 'launchpad' && isLaunchpad) {
                const focusFirst = () => {
                    if (this.activeViewId === 'launchpad') this.document.querySelector('#nextUiAppGrid .next-ui-app-item')?.focus();
                };
                this.document.defaultView?.requestAnimationFrame ? this.document.defaultView.requestAnimationFrame(focusFirst) : queueMicrotask(focusFirst);
            } else if (previousViewId === 'launchpad' && !isLaunchpad
                && this.document.activeElement?.closest?.('#nextUiLaunchpad')) {
                this.document.getElementById('nextUiAddTabBtn')?.focus();
            }
        }

        setView(viewId, options = {}) {
            if (viewId !== 'home' && viewId !== 'launchpad' && !this.views.has(viewId)) viewId = 'home';
            this.activeViewId = viewId;
            this.updateVisibility();
            if (options.persist !== false) this.persist();
            this.publish();
        }

        unregister(viewId) {
            const view = this.views.get(viewId);
            if (!view) return null;
            const restoreFocus = view.tab.contains(this.document.activeElement);
            const tabs = [...this.document.querySelectorAll('#nextUiDynamicTabs > .next-ui-tab')];
            const tabIndex = tabs.indexOf(view.tab);
            view.tab.remove();
            view.container.remove();
            this.views.delete(viewId);
            if (this.activeViewId === viewId) {
                const remaining = [...this.document.querySelectorAll('#nextUiDynamicTabs > .next-ui-tab')];
                const left = tabIndex > 0 ? remaining[tabIndex - 1] : null;
                this.setView(left?.dataset.viewId || 'home');
                if (restoreFocus) (left || this.document.getElementById('nextUiHomeTab'))?.focus();
            }
            this.persist();
            this.publish();
            return view;
        }

        dispose() {
            if (!this.mounted) return;
            this.mounted = false;
            this.views.clear();
            this.activeViewId = 'home';
            this.publish();
            this.listeners.clear();
        }
    }

    return { AppTabHost };
});
