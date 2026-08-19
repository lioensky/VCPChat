(() => {
    const TAB_SESSION_KEY = 'vcpchat.nextUi.openTabs.v1';
    let appTabHost = null;
    let assistantSearchController = null;
    let launchpadController = null;
    let initialized = false;
    let mounted = false;
    let mountGeneration = 0;
    let mountAbortController = null;
    let mountScope = null;
    let accountMenuController = null;
    let notificationMenuController = null;
    let escapeDispatcher = null;
    let settingsEscapeDisposer = null;
    let sidebarResizeObserver = null;
    let creationController = null;
    let embeddedAppController = null;
    let restoringTabs = false;
    let pendingTabRestore = null;
    let teardownPromise = null;
    let overlayCoordinator = null;
    let releaseWindowState = null;
    let tabOperationId = 0;
    let tabOperationRevision = 0;
    const pendingTabOperations = new Map();
    const tabOperationListeners = new Set();
    const suppressedTabClicks = new Set();

    function getTabSettlementSnapshot() {
        return Object.freeze({
            revision: tabOperationRevision,
            operationId: tabOperationId,
            generation: mountGeneration,
            pending: Object.freeze([...pendingTabOperations.entries()].map(([id, label]) => Object.freeze({ id, label }))),
            restoring: restoringTabs,
            tearingDown: Boolean(teardownPromise),
            hostRevision: appTabHost?.revision || 0,
        });
    }

    function publishTabSettlement() {
        tabOperationRevision += 1;
        const snapshot = getTabSettlementSnapshot();
        tabOperationListeners.forEach(listener => {
            try { listener(snapshot, snapshot); } catch (error) { console.error('[NextUI] AppTab settlement subscriber failed:', error); }
        });
        return snapshot;
    }

    function beginTabOperation(label) {
        const id = ++tabOperationId;
        pendingTabOperations.set(id, label);
        publishTabSettlement();
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            pendingTabOperations.delete(id);
            publishTabSettlement();
        };
    }

    function trackTabPromise(label, promise) {
        const finish = beginTabOperation(label);
        return Promise.resolve(promise).finally(finish);
    }

    function subscribeTabSettlement(listener, options = {}) {
        tabOperationListeners.add(listener);
        if (options.immediate !== false) listener(getTabSettlementSnapshot(), getTabSettlementSnapshot());
        return () => tabOperationListeners.delete(listener);
    }

    function whenTabsSettled(options = {}) {
        const wait = window.VCPSettlement?.waitForSettlement;
        if (!wait) return Promise.reject(new Error('VCPSettlement is unavailable.'));
        const operationId = Number.isFinite(options.operationId) ? Number(options.operationId) : tabOperationId;
        const generation = Number.isFinite(options.generation) ? Number(options.generation) : mountGeneration;
        return wait({
            ...options,
            label: 'AppTab controller',
            getSnapshot: getTabSettlementSnapshot,
            subscribe: subscribeTabSettlement,
            predicate: snapshot => snapshot.operationId >= operationId
                && snapshot.generation >= generation
                && snapshot.pending.length === 0
                && !snapshot.restoring
                && !snapshot.tearingDown,
        });
    }

    function listen(target, type, handler, options = {}) {
        if (!target || (!mountScope && !mountAbortController)) return;
        if (mountScope) return mountScope.listen(target, type, handler, options, `tab-host:${type}`);
        target.addEventListener(type, handler, { ...options, signal: mountAbortController.signal });
    }

    function readTabSession() {
        return appTabHost?.readSession() || null;
    }

    function persistTabSession() {
        appTabHost?.persist();
    }

    function getDesktopApi() {
        return window.chatAPI || window.electronAPI;
    }

    function getDensity() {
        return localStorage.getItem('vcpchat.uiDensity') === 'compact' ? 'compact' : 'comfortable';
    }

    function syncDensity(density = getDensity()) {
        document.querySelectorAll('.next-ui-topbar.vcp-ui-scope, .next-ui-launchpad.vcp-ui-scope, #nextUiInternalAppHost.vcp-ui-scope').forEach(scope => {
            scope.dataset.density = density;
        });
    }

    function syncWindowControl(state) {
        const button = document.getElementById('nextUiMaximizeBtn');
        if (!button || !state?.ready) return;
        const icon = button.querySelector('.vcp-ui-icon');
        const label = state.maximized ? '还原窗口' : '最大化窗口';
        if (icon) {
            if (window.VCPIcons?.set) window.VCPIcons.set(icon, state.maximized ? 'filter_none' : 'crop_square');
            else icon.textContent = state.maximized ? 'filter_none' : 'crop_square';
        }
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', String(state.maximized));
    }

    function observeSidebarWidth() {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar || typeof ResizeObserver === 'undefined') return;
        const syncWidth = () => document.documentElement.style.setProperty('--next-sidebar-width', `${Math.max(0, sidebar.getBoundingClientRect().width)}px`);
        syncWidth();
        sidebarResizeObserver = new ResizeObserver(syncWidth);
        if (mountScope) mountScope.observe(sidebarResizeObserver, sidebar, undefined, 'sidebar-resize');
        else sidebarResizeObserver.observe(sidebar);
    }

    function createTab({ id, title, icon, iconSvg, closeLabel, scope = mountScope }) {
        return appTabHost.createTab({ id, title, icon, iconSvg, closeLabel, scope });
    }

    function getEmbeddedBounds(container) {
        const rect = container.getBoundingClientRect();
        return {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height))
        };
    }

    function syncEmbeddedBounds(view) {
        if (view?.kind !== 'embedded' || !view.container.isConnected) return;
        embeddedAppController?.setBounds(view.action, getEmbeddedBounds(view.container))?.catch(error => {
            console.warn(`[NextUI] Failed to resize embedded app ${view.action}:`, error);
        });
    }

    function syncEmbeddedActivation() {
        const activeView = appTabHost.views.get(appTabHost.activeViewId);
        const action = mounted && !restoringTabs && !overlayCoordinator?.active && activeView?.kind === 'embedded'
            ? activeView.action
            : null;
        const activation = embeddedAppController?.activate(action);
        if (!activation) return;
        trackTabPromise(`activate:${action || 'home'}`, activation).then(result => {
            if (result?.success && activeView?.kind === 'embedded') syncEmbeddedBounds(activeView);
        }).catch(error => console.warn('[NextUI] Failed to activate embedded app:', error));
    }

    function ensureInternalHost() {
        let host = document.getElementById('nextUiInternalAppHost');
        if (host) return host;
        host = document.createElement('main');
        host.id = 'nextUiInternalAppHost';
        host.className = 'next-ui-internal-app-host vcp-ui-scope';
        host.setAttribute('aria-hidden', 'true');
        host.dataset.density = getDensity();
        host.hidden = true;
        document.querySelector('.container')?.before(host);
        return host;
    }

    function updateVisibility() { appTabHost?.updateVisibility(); }

    function setView(viewId) {
        appTabHost?.setView(viewId);
    }

    function openLaunchpad() {
        if (!mounted) return;
        launchpadController?.render();
        setView('launchpad');
    }

    function closeLaunchpad() {
        if (appTabHost?.activeViewId === 'launchpad') setView('home');
    }

    function openInternalApp(appId) {
        if (!mounted) return;
        const app = window.nextUiApps?.get(appId);
        if (!app) return;
        const viewId = `app:${app.id}`;
        if (appTabHost.views.has(viewId)) {
            setView(viewId);
            return;
        }
        const host = ensureInternalHost();
        const container = document.createElement('section');
        container.className = 'next-ui-internal-app-view';
        container.dataset.appId = app.id;
        container.hidden = true;
        host.append(container);
        const viewScope = mountScope?.child(`next:internal-app:${app.id}`) || null;
        const tab = createTab({ id: viewId, title: app.title, icon: app.icon, iconSvg: app.iconSvg, scope: viewScope });
        const context = Object.freeze({
            close: () => closeView(viewId),
            activate: () => setView(viewId),
            feedback: window.VCPUI?.feedback,
            scope: viewScope
        });
        let disposer = null;
        try {
            disposer = app.mount(container, context) || null;
        } catch (error) {
            console.error(`[NextUiApps] Failed to mount ${app.id}:`, error);
            container.textContent = `应用加载失败：${error.message}`;
        }
        if (viewScope) {
            viewScope.own(() => app.unmount?.(), `app-unmount:${app.id}`, 'ui-registration');
            if (typeof disposer === 'function' || typeof disposer?.dispose === 'function') {
                viewScope.own(disposer, `app-disposer:${app.id}`, 'ui-registration');
            }
        }
        appTabHost.register(viewId, { kind: 'internal', app, tab, container, disposer, scope: viewScope });
        setView(viewId);
    }

    function shouldDetachTab(event, startPoint) {
        const moved = Math.hypot(event.clientX - startPoint.clientX, event.clientY - startPoint.clientY);
        if (moved < 18) return false;
        const outsideWindow = event.screenX < window.screenX - 4
            || event.screenX > window.screenX + window.outerWidth + 4
            || event.screenY < window.screenY - 4
            || event.screenY > window.screenY + window.outerHeight + 4;
        const strip = document.querySelector('.next-ui-tab-strip')?.getBoundingClientRect();
        const pulledAwayFromStrip = strip
            ? event.clientY < strip.top - 32 || event.clientY > strip.bottom + 48
            : false;
        return outsideWindow || pulledAwayFromStrip;
    }

    function installDetachDrag(tab, viewId, scope = mountScope) {
        tab.title = '拖出标签可在独立窗口中打开';
        const bind = (target, type, handler, options) => scope
            ? scope.listen(target, type, handler, options, `detach:${viewId}:${type}`)
            : target.addEventListener(type, handler, options);
        bind(tab, 'pointerdown', event => {
            if (event.button !== 0 || event.target.closest('.next-ui-tab-close')) return;
            const startPoint = {
                clientX: event.clientX,
                clientY: event.clientY,
                screenX: event.screenX,
                screenY: event.screenY
            };
            let dragging = false;
            let releaseMove;
            let releaseUp;
            let releaseCancel;
            tab.setPointerCapture?.(event.pointerId);

            const finish = async (finishEvent, cancelled = false) => {
                if (scope) {
                    void releaseMove?.();
                    void releaseUp?.();
                    void releaseCancel?.();
                } else {
                    tab.removeEventListener('pointermove', move);
                    tab.removeEventListener('pointerup', up);
                    tab.removeEventListener('pointercancel', cancel);
                }
                tab.classList.remove('is-dragging');
                document.body.classList.remove('next-ui-tab-dragging');
                if (!dragging || cancelled || !shouldDetachTab(finishEvent, startPoint)) return;
                suppressedTabClicks.add(viewId);
                await detachView(viewId, { x: finishEvent.screenX, y: finishEvent.screenY });
            };
            const move = moveEvent => {
                if (!dragging && Math.hypot(moveEvent.clientX - startPoint.clientX, moveEvent.clientY - startPoint.clientY) >= 6) {
                    dragging = true;
                    tab.classList.add('is-dragging');
                    document.body.classList.add('next-ui-tab-dragging');
                }
            };
            const up = upEvent => finish(upEvent);
            const cancel = cancelEvent => finish(cancelEvent, true);
            releaseMove = bind(tab, 'pointermove', move);
            releaseUp = bind(tab, 'pointerup', up, { once: true });
            releaseCancel = bind(tab, 'pointercancel', cancel, { once: true });
        });
    }

    async function openEmbeddedAppInternal(app) {
        if (!mounted) return;
        const generation = mountGeneration;
        if (!embeddedAppController?.supported) {
            await window.trayManager?.launchApp(app);
            return;
        }
        const viewId = `app:${app.id}`;
        if (appTabHost.views.has(viewId)) {
            setView(viewId);
            return;
        }
        const host = ensureInternalHost();
        const container = document.createElement('section');
        container.className = 'next-ui-internal-app-view next-ui-embedded-app-view';
        container.dataset.appId = app.id;
        container.dataset.state = 'loading';
        container.hidden = true;
        container.innerHTML = '<div class="next-ui-embedded-app-status"><span class="vcp-ui-icon" aria-hidden="true">progress_activity</span><span>正在打开应用…</span></div>';
        host.append(container);
        const viewScope = mountScope?.child(`next:embedded-app:${app.id}`) || null;
        const tab = createTab({
            id: viewId,
            title: app.name,
            iconSvg: window.trayManager?.getIcon(app.icon),
            closeLabel: `关闭${app.name}标签`,
            scope: viewScope
        });
        const resizeObserver = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(() => {
                const view = appTabHost.views.get(viewId);
                if (view && appTabHost.activeViewId === viewId) syncEmbeddedBounds(view);
            });
        const view = { kind: 'embedded', app, action: app.action, tab, container, resizeObserver, scope: viewScope };
        appTabHost.register(viewId, view);
        if (resizeObserver && viewScope) viewScope.observe(resizeObserver, container, undefined, `embedded-resize:${app.id}`);
        else resizeObserver?.observe(container);
        installDetachDrag(tab, viewId, viewScope);
        setView(viewId);

        try {
            const result = await embeddedAppController.create(app.action, viewScope);
            if (!mounted || generation !== mountGeneration || !appTabHost.views.has(viewId)) {
                if (result?.success) await embeddedAppController.close(app.action);
                return;
            }
            if (!result?.success) throw new Error(result?.error || '应用无法内嵌打开。');
            container.dataset.state = 'ready';
            if (appTabHost.activeViewId === viewId && !restoringTabs) {
                syncEmbeddedBounds(view);
                await embeddedAppController.activate(app.action);
            }
        } catch (error) {
            console.error(`[NextUI] Failed to open embedded app ${app.id}:`, error);
            container.dataset.state = 'error';
            container.innerHTML = `<div class="next-ui-embedded-app-status is-error"><span class="vcp-ui-icon" aria-hidden="true">error</span><span>${error.message || '应用加载失败'}</span></div>`;
        }
    }

    function openEmbeddedApp(app) {
        return trackTabPromise(`open:${app?.action || app?.id || 'unknown'}`, openEmbeddedAppInternal(app));
    }

    async function detachView(viewId, point) {
        const view = appTabHost.views.get(viewId);
        if (!view || view.kind !== 'embedded') return;
        view.tab.classList.add('is-detaching');
        try {
            const result = await embeddedAppController?.detach(view.action, point, view.scope || mountScope);
            if (!result?.success) throw new Error(result?.error || '无法打开独立窗口。');
            closeView(viewId, { skipEmbeddedClose: true });
        } catch (error) {
            view.tab.classList.remove('is-detaching');
            window.VCPUI?.feedback?.toast?.(error.message || '标签拖出失败', { variant: 'error' });
        }
    }

    function closeView(viewId, options = {}) {
        if (viewId === 'launchpad') {
            closeLaunchpad();
            return;
        }
        const view = appTabHost.views.get(viewId);
        if (!view) return;
        try {
            if (view.kind === 'embedded') {
                // Disconnect before detaching the observed container. Waiting
                // for asynchronous Scope unwinding lets ResizeObserver queue a
                // final record that retains the removed view subtree.
                view.resizeObserver?.disconnect();
                if (!options.skipEmbeddedClose) {
                    trackTabPromise(`close:${view.action}`, embeddedAppController?.close(view.action) || Promise.resolve()).catch(error => {
                        console.warn(`[NextUI] Failed to close embedded app ${view.action}:`, error);
                    });
                }
                view.container.replaceChildren();
            } else {
                if (!view.scope) {
                    if (typeof view.disposer === 'function') view.disposer();
                    view.app.unmount?.();
                }
            }
        } catch (error) {
            console.error(`[NextUiApps] Failed to unmount ${view.app?.id || view.action}:`, error);
        }
        if (view.scope) {
            trackTabPromise(`dispose:${viewId}`, view.scope.dispose(`view-closed:${viewId}`)).catch(error => {
                console.error(`[NextUiApps] Failed to dispose ${viewId}:`, error);
            });
        }
        appTabHost.unregister(viewId);
    }

    async function restoreTabSessionInternal() {
        if (!mounted || restoringTabs) return;
        const generation = mountGeneration;
        restoringTabs = true;
        try {
            const apps = window.trayManager?.getApps?.() || [];
            let authoritative = { sessions: [], activeAction: null };
            try {
                authoritative = await embeddedAppController?.list() || authoritative;
            } catch (error) {
                console.warn('[NextUI] Failed to reconcile embedded app sessions:', error);
            }
            if (!mounted || generation !== mountGeneration) return;

            // Reconciliation can be retriggered by a late catalog event after
            // the persisted restore has already completed. Use the live tab
            // snapshot as the fallback; resetting to a synthetic Home state
            // would hide the just-restored native application.
            const restoreState = pendingTabRestore || appTabHost.snapshot();
            const descriptors = [...restoreState.tabs];
            for (const session of authoritative.sessions || []) {
                const app = apps.find(candidate => candidate.action === session.action && candidate.embed);
                if (!app || descriptors.some(descriptor => descriptor.kind === 'embedded' && descriptor.id === app.id)) continue;
                descriptors.push({ kind: 'embedded', id: app.id });
            }
            if (!descriptors.length) {
                pendingTabRestore = null;
                return;
            }
            const authoritativeActiveApp = apps.find(candidate => (
                candidate.action === authoritative.activeAction && candidate.embed
            ));
            const requestedActive = authoritativeActiveApp
                ? `app:${authoritativeActiveApp.id}`
                : restoreState.activeViewId;
            const unresolved = [];
            for (const descriptor of descriptors) {
                if (!mounted || generation !== mountGeneration) return;
                if (descriptor.kind === 'internal') {
                    if (!window.nextUiApps?.get(descriptor.id)) {
                        unresolved.push(descriptor);
                        continue;
                    }
                    openInternalApp(descriptor.id);
                    continue;
                }
                const app = window.trayManager?.getApps?.().find(candidate => candidate.id === descriptor.id && candidate.embed);
                if (!app) {
                    unresolved.push(descriptor);
                    continue;
                }
                await openEmbeddedApp(app);
                if (!mounted || generation !== mountGeneration) return;
            }
            pendingTabRestore = unresolved.length ? { ...restoreState, tabs: unresolved } : null;
            if (requestedActive === 'home' || requestedActive === 'launchpad' || appTabHost.views.has(requestedActive)) {
                appTabHost.setView(requestedActive, { persist: false });
            }
        } finally {
            restoringTabs = false;
            persistTabSession();
            if (mounted && generation === mountGeneration) syncEmbeddedActivation();
        }
    }

    function restoreTabSession() {
        return trackTabPromise('restore-session', restoreTabSessionInternal());
    }

    async function closeAllInternalApps(options = {}) {
        const preservedSession = options.preserveSession ? appTabHost.snapshot() : null;
        const embeddedActions = [...appTabHost.views.values()]
            .filter(view => view.kind === 'embedded')
            .map(view => view.action);
        // Native WebContentsViews paint above the renderer DOM. Hide them in
        // Main before the page is allowed to cross back to Classic, then
        // destroy the sessions. The local host can be removed immediately.
        const hidePromise = embeddedAppController?.hide?.() || Promise.resolve({ success: true });
        if (preservedSession) restoringTabs = true;
        [...appTabHost.views.keys()].forEach(viewId => closeView(viewId, { skipEmbeddedClose: true }));
        closeLaunchpad();
        window.VCPUI?.feedback.cancelAll();
        document.getElementById('nextUiInternalAppHost')?.remove();
        setView('home');
        if (preservedSession) {
            restoringTabs = false;
            sessionStorage.setItem(TAB_SESSION_KEY, JSON.stringify(preservedSession));
        }
        try {
            await hidePromise;
        } catch (error) {
            console.warn('[NextUI] Failed to hide embedded apps before teardown:', error);
        }
        try {
            await embeddedAppController?.closeAll(embeddedActions);
        } catch (error) {
            console.warn('[NextUI] Failed to close all embedded apps:', error);
        }
    }

    function closeCreateDialog() { creationController?.close(); }

    function openCreateDialog() { return creationController?.open(); }

    function setupEmbeddedAppState() {
        embeddedAppController?.mount(mountScope, payload => {
            const view = [...appTabHost.views.values()].find(candidate => candidate.kind === 'embedded' && candidate.action === payload?.action);
            if (!view) return;
            if (payload?.state === 'closed') {
                const generation = mountGeneration;
                const viewId = `app:${view.app.id}`;
                // A close notification can cross a renderer reload after Main
                // has already created/reused a newer session for the same
                // action. Reconcile with Main before removing the replacement
                // renderer's tab; the event itself has no session generation.
                Promise.resolve(embeddedAppController.list()).then(state => {
                    if (!mounted || generation !== mountGeneration || appTabHost.views.get(viewId) !== view) return;
                    const stillOpen = state?.sessions?.some(session => session.action === view.action);
                    if (stillOpen) {
                        syncEmbeddedActivation();
                        return;
                    }
                    closeView(viewId, { skipEmbeddedClose: true });
                }).catch(error => {
                    console.warn(`[NextUI] Failed to reconcile closed embedded app ${view.action}:`, error);
                    if (mounted && generation === mountGeneration && appTabHost.views.get(viewId) === view) {
                        closeView(viewId, { skipEmbeddedClose: true });
                    }
                });
                return;
            }
            if (payload?.state !== 'error') return;
            view.container.dataset.state = 'error';
            view.container.innerHTML = `<div class="next-ui-embedded-app-status is-error"><span class="vcp-ui-icon" aria-hidden="true">error</span><span>${payload.error || '应用运行异常'}</span></div>`;
        });
    }

    function mount() {
        if (mounted) return;
        if (teardownPromise) return teardownPromise.then(() => mount());
        const finishMountTiming = window.VCPPerformance?.begin?.('next.mount');
        const OverlayCoordinator = window.VCPNextShell?.OverlayCoordinator;
        const EscapeDispatcher = window.VCPNextShell?.EscapeDispatcher;
        const EmbeddedAppController = window.VCPNextShell?.EmbeddedAppController;
        const AppTabHost = window.VCPNextShell?.AppTabHost;
        const AssistantSearchController = window.VCPNextShell?.AssistantSearchController;
        const AccountMenuController = window.VCPNextShell?.AccountMenuController;
        const NotificationMenuController = window.VCPNextShell?.NotificationMenuController;
        const LaunchpadController = window.VCPNextShell?.LaunchpadController;
        const CreationController = window.VCPNextShell?.CreationController;
        if (!OverlayCoordinator) throw new Error('OverlayCoordinator is unavailable.');
        if (!EscapeDispatcher) throw new Error('EscapeDispatcher is unavailable.');
        if (!EmbeddedAppController) throw new Error('EmbeddedAppController is unavailable.');
        if (!AppTabHost) throw new Error('AppTabHost is unavailable.');
        if (!AssistantSearchController) throw new Error('AssistantSearchController is unavailable.');
        if (!AccountMenuController) throw new Error('AccountMenuController is unavailable.');
        if (!NotificationMenuController) throw new Error('NotificationMenuController is unavailable.');
        if (!LaunchpadController) throw new Error('LaunchpadController is unavailable.');
        if (!CreationController) throw new Error('CreationController is unavailable.');
        mounted = true;
        mountGeneration += 1;
        const LifecycleScope = window.VCPLifecycle?.LifecycleScope;
        mountScope = LifecycleScope ? new LifecycleScope('next:tab-host') : null;
        mountAbortController = mountScope ? null : new AbortController();
        escapeDispatcher = new EscapeDispatcher({ document });
        escapeDispatcher.mount(mountScope);
        settingsEscapeDisposer = escapeDispatcher.register({
            priority: 20,
            isActive: () => {
                const modal = document.getElementById('globalSettingsModal');
                if (modal?.classList.contains('active') !== true) return false;
                return !document.querySelector('.vcp-ui-modal-overlay, wa-dialog[open], .confirm-dialog-overlay.visible');
            },
            close: () => {
                if (typeof window.uiHelperFunctions?.closeModal !== 'function') return false;
                window.uiHelperFunctions.closeModal('globalSettingsModal');
                return true;
            },
        });
        if (mountScope) mountScope.own(settingsEscapeDisposer, 'next:settings-escape-owner', 'controller');
        releaseWindowState = window.MainChatCommands?.subscribeWindowState?.(syncWindowControl) || null;
        if (mountScope && releaseWindowState) mountScope.own(releaseWindowState, 'next:window-state', 'subscription');
        appTabHost = new AppTabHost({
            document,
            storage: sessionStorage,
            sessionKey: TAB_SESSION_KEY,
            canPersist: () => !restoringTabs,
            onActivate: syncEmbeddedActivation,
            onCloseRequested: closeView,
            suppressedClicks: suppressedTabClicks,
        });
        appTabHost.mount(mountScope);
        assistantSearchController = new AssistantSearchController({
            document,
            filter: value => window.uiHelperFunctions?.filterAgentList?.(value),
            escapeDispatcher,
        });
        assistantSearchController.mount(mountScope);
        accountMenuController = new AccountMenuController({
            window,
            document,
            getSettings: () => window.globalSettings || {},
            openSettings: () => window.uiHelperFunctions?.openModal?.('globalSettingsModal'),
            openAppearance: trigger => window.VCPAppearanceStudio?.open?.({ trigger }),
            openThemes: () => (window.chatAPI || window.electronAPI)?.openThemesWindow?.(),
            setThemeMode: mode => window.VCPAppearanceStudio?.setThemeMode?.(mode, { source: 'account-menu' }),
            toggleTheme: () => window.MainChatCommands?.toggleTheme?.(),
            syncAppearance: () => window.VCPAppearanceStudio?.syncAccountMenuValue?.(),
            setIcon: (element, icon) => window.VCPIcons?.set?.(element, icon),
            subscribeTheme: (listener, options) => window.uiManager?.subscribeTheme?.(listener, options),
            escapeDispatcher,
        });
        accountMenuController.mount(mountScope);
        notificationMenuController = new NotificationMenuController({
            window,
            document,
            commands: () => window.MainChatCommands,
            filterManager: window.filterManager,
            showToast: (message, variant) => window.uiHelperFunctions?.showToastNotification?.(message, variant),
            escapeDispatcher,
        });
        notificationMenuController.mount(mountScope);
        launchpadController = new LaunchpadController({
            document,
            getExternalApps: () => window.trayManager?.getApps?.() || [],
            getInternalApps: () => window.nextUiApps?.list?.() || [],
            getIcon: icon => window.trayManager?.getIcon?.(icon) || '',
            openExternal: app => window.trayManager?.launchApp?.(app),
            openEmbedded: openEmbeddedApp,
            openInternal: openInternalApp,
        });
        launchpadController.mount(mountScope);
        embeddedAppController = new EmbeddedAppController({ getApi: getDesktopApi });
        overlayCoordinator = new OverlayCoordinator({
            document,
            hideEmbeddedView: () => embeddedAppController?.hide(),
            reconcileEmbeddedView: syncEmbeddedActivation,
        });
        overlayCoordinator.mount(mountScope);
        const creationOverlayCoordinator = overlayCoordinator;
        creationController = new CreationController({
            window,
            document,
            getUi: () => window.VCPUI,
            getApi: getDesktopApi,
            commands: () => window.MainChatCommands,
            getDensity,
            acquireOverlay: owner => creationOverlayCoordinator.acquire(owner),
            releaseOverlay: owner => creationOverlayCoordinator.release(owner),
            showUnavailable: message => window.uiHelperFunctions?.showToastNotification?.(
                message || '创建功能尚未准备好，请稍后重试。',
                'error'
            ),
        });
        creationController.mount(mountScope);
        syncDensity();
        observeSidebarWidth();
        setupEmbeddedAppState();
        pendingTabRestore = readTabSession();
        listen(document.getElementById('nextUiCreateItemBtn'), 'click', openCreateDialog);
        listen(document.getElementById('nextUiHomeTab'), 'click', () => setView('home'));
        listen(document.getElementById('nextUiAddTabBtn'), 'click', openLaunchpad);
        listen(document.getElementById('nextUiThemeStoreBtn'), 'click', () => window.MainChatCommands?.openThemes?.());
        listen(document.getElementById('nextUiThemeBtn'), 'click', () => window.MainChatCommands?.toggleTheme?.());
        listen(document.getElementById('nextUiSettingsBtn'), 'click', () => window.MainChatCommands?.openSettings?.());
        listen(document.getElementById('nextUiMinimizeToTrayBtn'), 'click', () => window.MainChatCommands?.minimizeToTray?.());
        listen(document.getElementById('nextUiMinimizeBtn'), 'click', () => window.MainChatCommands?.minimize?.());
        listen(document.getElementById('nextUiMaximizeBtn'), 'click', () => window.MainChatCommands?.toggleMaximize?.());
        listen(document.getElementById('nextUiCloseBtn'), 'click', () => window.MainChatCommands?.close?.());
        listen(window, 'next-ui-apps-changed', event => {
            if (event.detail?.action === 'unregistered') closeView(`app:${event.detail.id}`);
            launchpadController?.render();
            void restoreTabSession();
        });
        listen(window, 'vcp-ui-density-changed', event => {
            const density = event.detail?.density;
            if (!density) return;
            localStorage.setItem('vcpchat.uiDensity', density);
            syncDensity(density);
        });
        queueMicrotask(() => { void restoreTabSession(); });
        finishMountTiming?.({ status: 'mounted' });
    }

    function unmount() {
        if (!mounted) return teardownPromise || Promise.resolve();
        mounted = false;
        mountGeneration += 1;
        if (!mountScope) mountAbortController?.abort();
        if (!mountScope) {
            notificationMenuController?.dispose();
            escapeDispatcher?.dispose();
        }
        if (!mountScope) releaseWindowState?.();
        releaseWindowState = null;
        mountAbortController = null;
        sidebarResizeObserver?.disconnect();
        sidebarResizeObserver = null;
        if (!mountScope) {
            embeddedAppController?.dispose();
            appTabHost?.dispose();
            assistantSearchController?.dispose();
            accountMenuController?.dispose();
            notificationMenuController?.dispose();
            launchpadController?.dispose();
            creationController?.dispose();
        }
        pendingTabRestore = null;
        restoringTabs = false;
        closeCreateDialog();
        const coordinatorToDispose = overlayCoordinator;
        overlayCoordinator = null;
        coordinatorToDispose?.dispose();
        const scopeToDispose = mountScope;
        mountScope = null;
        const pending = Promise.allSettled([
            closeAllInternalApps({ preserveSession: true }),
            scopeToDispose?.dispose('leave-next') || Promise.resolve(),
        ]).then(results => {
            results.forEach(result => {
                if (result.status === 'rejected') {
                    console.error('[NextUI] Teardown resource failed; mode transition will continue:', result.reason);
                }
            });
        });
        const wrapped = pending.finally(() => {
            if (teardownPromise === wrapped) teardownPromise = null;
        });
        teardownPromise = wrapped;
        publishTabSettlement();
        wrapped.finally(publishTabSettlement).catch(() => {});
        document.body.classList.remove('next-ui-tab-dragging');
        return wrapped;
    }

    async function acquireOverlay(owner = Symbol('next-ui-overlay')) {
        if (!overlayCoordinator) throw new Error('Next UI overlay coordinator is not mounted.');
        return overlayCoordinator.acquire(owner);
    }

    function releaseOverlay(owner) {
        overlayCoordinator?.release(owner);
    }

    function init() {
        if (initialized) return;
        initialized = true;
        mount();
    }

    // Internal applications may need to enter the shared VCPChat Agent/Group
    // creation flow.  Expose the action itself rather than asking them to
    // synthesize a click on #nextUiCreateItemBtn: that element is part of a
    // renderable sidebar and may be replaced while the Next UI changes mode.
    // The action owns no Agent Runtime state; it only opens the existing
    // VCPChat configuration modal.
    window.VCPNextShellController = Object.freeze({
        init,
        mount,
        unmount,
        isMounted: () => mounted,
        openAccountMenu: () => accountMenuController?.open(),
        openLaunchpad,
        openCreateDialog,
        openInternalApp,
        openEmbeddedApp,
        closeView,
        setView,
        acquireOverlay,
        releaseOverlay,
        getDiagnostics: () => Object.freeze({
            mounted,
            generation: mountGeneration,
            activeViewId: appTabHost?.activeViewId || 'home',
            openViews: Object.freeze([...(appTabHost?.views?.keys?.() || [])]),
            overlay: overlayCoordinator?.snapshot?.() || null,
            embedded: embeddedAppController?.getState?.() || null,
            appTabs: getTabSettlementSnapshot(),
        }),
        getAppTabSnapshot: getTabSettlementSnapshot,
        whenAppTabsSettled: whenTabsSettled,
    });
})();
