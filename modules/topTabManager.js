(() => {
    const APP_TONES = ['purple', 'green', 'pink', 'cyan', 'amber', 'charcoal', 'red', 'orange'];
    const TAB_SESSION_KEY = 'vcpchat.nextUi.openTabs.v1';
    let appTabHost = null;
    let initialized = false;
    let mounted = false;
    let mountGeneration = 0;
    let mountAbortController = null;
    let mountScope = null;
    let appGridScope = null;
    let accountMenuObserver = null;
    let accountMenuController = null;
    let sidebarResizeObserver = null;
    let activeCreateModal = null;
    let embeddedAppController = null;
    let restoringTabs = false;
    let pendingTabRestore = null;
    let teardownPromise = null;
    let modeRequestGeneration = 0;
    let previewSuspended = false;
    let overlayCoordinator = null;
    const suppressedTabClicks = new Set();

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
        const action = mounted && !previewSuspended && !restoringTabs && !overlayCoordinator?.active && activeView?.kind === 'embedded'
            ? activeView.action
            : null;
        embeddedAppController?.activate(action)?.then(result => {
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
        renderApps();
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
            feedback: window.VCPUI?.feedback
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

    async function openEmbeddedApp(app) {
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
            const result = await embeddedAppController.create(app.action);
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

    async function detachView(viewId, point) {
        const view = appTabHost.views.get(viewId);
        if (!view || view.kind !== 'embedded') return;
        view.tab.classList.add('is-detaching');
        try {
            const result = await embeddedAppController?.detach(view.action, point);
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
                if (!view.scope) view.resizeObserver?.disconnect();
                if (!options.skipEmbeddedClose) {
                    embeddedAppController?.close(view.action)?.catch(error => {
                        console.warn(`[NextUI] Failed to close embedded app ${view.action}:`, error);
                    });
                }
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
            void view.scope.dispose(`view-closed:${viewId}`).catch(error => {
                console.error(`[NextUiApps] Failed to dispose ${viewId}:`, error);
            });
        }
        appTabHost.unregister(viewId);
    }

    async function restoreTabSession() {
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

            const restoreState = pendingTabRestore || { activeViewId: 'home', tabs: [] };
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

    function renderApps() {
        const grid = document.getElementById('nextUiAppGrid');
        const trayManager = window.trayManager;
        if (!grid || !trayManager?.getApps) return;
        if (appGridScope) {
            const previousScope = appGridScope;
            appGridScope = null;
            void previousScope.dispose('app-grid-rerender').catch(error => {
                console.error('[NextUI] Failed to dispose app-grid listeners:', error);
            });
        }
        appGridScope = mountScope?.child('next:app-grid') || null;
        const listenApp = (target, handler) => appGridScope
            ? appGridScope.listen(target, 'click', handler, undefined, 'app-grid:click')
            : target.addEventListener('click', handler);
        grid.replaceChildren();
        const externalApps = trayManager.getApps().filter(app => app.id !== 'vchat-app-main');
        externalApps.forEach((app, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'next-ui-app-item';
            button.title = app.name;
            button.innerHTML = `<span class="next-ui-app-icon" data-tone="${APP_TONES[index % APP_TONES.length]}">${trayManager.getIcon(app.icon)}</span><span>${app.name}</span>`;
            button.dataset.openMode = app.embed ? 'embedded' : 'window';
            button.title = app.embed ? `${app.name}（在标签页中打开）` : `${app.name}（在独立窗口中打开）`;
            listenApp(button, () => app.embed ? openEmbeddedApp(app) : trayManager.launchApp(app));
            grid.append(button);
        });
        window.nextUiApps?.list().forEach(app => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'next-ui-app-item next-ui-internal-app-item';
            button.title = app.title;
            const appIcon = document.createElement('span');
            appIcon.className = 'next-ui-app-icon vcp-ui-internal-app-icon vcp-ui-scope';
            if (app.icon) {
                appIcon.append(Object.assign(document.createElement('span'), { className: 'vcp-ui-icon', textContent: app.icon }));
            } else if (app.iconSvg) {
                appIcon.innerHTML = app.iconSvg;
            }
            const label = document.createElement('span');
            label.textContent = app.title;
            button.append(appIcon, label);
            listenApp(button, () => openInternalApp(app.id));
            grid.append(button);
        });
    }

    function setupAccountMenu() {
        const dock = document.querySelector('.next-ui-account-dock');
        const menu = document.getElementById('nextUiAccountMenu');
        const trigger = document.getElementById('nextUiAccountMenuTrigger');
        const avatar = document.getElementById('nextUiAccountAvatar');
        const userName = document.getElementById('nextUiAccountName');
        const settingsButton = document.getElementById('nextUiAccountSettingsBtn');
        const appearanceStudioButton = document.getElementById('nextUiAccountAppearanceStudioBtn');
        const themeStoreButton = document.getElementById('nextUiAccountThemeStoreBtn');
        const themeToggleButton = document.getElementById('nextUiAccountThemeToggleBtn');
        const themeIcon = document.getElementById('nextUiAccountThemeIcon');
        const themeLabel = document.getElementById('nextUiAccountThemeLabel');
        const topbarThemeButton = document.getElementById('nextUiThemeBtn');
        const topbarThemeIcon = topbarThemeButton?.querySelector('.vcp-ui-icon');
        if (!dock || !menu || !trigger || !avatar || !userName) return;

        const sync = () => {
            const settings = window.globalSettings || {};
            userName.textContent = settings.userName?.trim() || '用户';
            const nextAvatar = settings.userAvatarUrl || 'assets/default_user_avatar.png';
            if (avatar.getAttribute('src') !== nextAvatar) avatar.src = nextAvatar;
            window.VCPAppearanceStudio?.syncAccountMenuValue?.();
            const isDark = document.body.classList.contains('dark-theme');
            const nextThemeLabel = isDark ? '切换为浅色模式' : '切换为深色模式';
            const currentThemeIcon = isDark ? 'dark_mode' : 'light_mode';
            if (themeIcon) window.VCPIcons?.set(themeIcon, currentThemeIcon);
            if (themeLabel) themeLabel.textContent = nextThemeLabel;
            themeToggleButton?.setAttribute('aria-label', nextThemeLabel);
            themeToggleButton?.setAttribute('aria-pressed', String(isDark));
            if (topbarThemeIcon) {
                if (window.VCPIcons?.set) window.VCPIcons.set(topbarThemeIcon, currentThemeIcon);
                else topbarThemeIcon.textContent = currentThemeIcon;
            }
            topbarThemeButton?.setAttribute('aria-label', nextThemeLabel);
            topbarThemeButton?.setAttribute('title', nextThemeLabel);
        };

        const setOpen = (open) => {
            menu.hidden = !open;
            trigger.setAttribute('aria-expanded', String(open));
            if (open) sync();
        };
        accountMenuController = Object.freeze({ open: () => setOpen(true), close: () => setOpen(false) });
        mountScope?.own(() => setOpen(false), 'account-menu-state', 'dom-state');

        listen(avatar, 'error', () => {
            if (!avatar.src.endsWith('/assets/default_user_avatar.png')) {
                avatar.src = 'assets/default_user_avatar.png';
            }
        });
        listen(trigger, 'click', event => {
            event.stopPropagation();
            setOpen(menu.hidden);
        });
        listen(settingsButton, 'click', () => {
            setOpen(false);
            window.uiHelperFunctions?.openModal?.('globalSettingsModal');
        });
        listen(appearanceStudioButton, 'click', () => {
            setOpen(false);
            window.VCPAppearanceStudio?.open?.({ trigger: appearanceStudioButton });
        });
        listen(themeStoreButton, 'click', () => {
            setOpen(false);
            (window.chatAPI || window.electronAPI)?.openThemesWindow?.();
        });
        listen(themeToggleButton, 'click', () => {
            const nextTheme = document.body.classList.contains('dark-theme') ? 'light' : 'dark';
            setOpen(false);
            if (!window.VCPAppearanceStudio?.setThemeMode?.(nextTheme, { source: 'account-menu' })) {
                window.MainChatCommands?.toggleTheme?.();
            }
        });
        listen(document, 'pointerdown', event => {
            if (!menu.hidden && !dock.contains(event.target)) setOpen(false);
        });
        listen(document, 'keydown', event => {
            if (event.key !== 'Escape' || menu.hidden) return;
            event.preventDefault();
            setOpen(false);
            trigger.focus();
        });
        listen(document, 'next-ui-overlay-changed', event => {
            if (event.detail?.active === true) setOpen(false);
        });
        accountMenuObserver = new MutationObserver(sync);
        if (mountScope) mountScope.observe(accountMenuObserver, document.body, { attributes: true, attributeFilter: ['class'] }, 'account-theme-observer');
        else accountMenuObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        listen(window, 'global-settings-updated', sync);
        sync();
    }

    function normalizeModelOptions(payload) {
        let models = payload;
        if (!Array.isArray(models)) models = payload?.data || payload?.models || (payload?.id ? [payload] : []);
        if (!Array.isArray(models)) return [];
        const seen = new Set();
        return models.reduce((options, item) => {
            const id = typeof item === 'string' ? item : item?.id;
            if (!id || seen.has(id)) return options;
            seen.add(id);
            options.push({
                value: id,
                label: typeof item === 'string' ? item : item.name || item.displayName || id
            });
            return options;
        }, []);
    }

    function closeCreateDialog() {
        activeCreateModal?.close(null);
    }

    async function openCreateDialog() {
        if (activeCreateModal?.element?.isConnected) {
            activeCreateModal.focus();
            return;
        }
        const ui = window.VCPUI;
        const api = window.chatAPI || window.electronAPI;
        const generation = mountGeneration;
        if (!ui || !window.MainChatCommands?.createAgent || !window.MainChatCommands?.createGroup) {
            window.uiHelperFunctions?.showToastNotification?.('创建功能尚未准备好，请稍后重试。', 'error');
            return;
        }

        const host = document.createElement('div');
        host.className = 'next-ui-create-dialog-host vcp-ui-scope';
        host.dataset.density = getDensity();
        const form = document.createElement('form');
        form.className = 'next-ui-create-dialog-form';

        const typeControl = ui.create('SegmentedControl', {
            label: '创建类型',
            value: 'agent',
            items: [
                { value: 'agent', label: '助手', icon: 'person' },
                { value: 'group', label: '群组', icon: 'group' }
            ]
        });
        const typeField = ui.create('Field', {
            label: '类型',
            required: true,
            helper: '创建一个可以独立对话的助手。',
            control: typeControl
        });
        typeField.element.classList.add('next-ui-create-dialog-type');

        const nameControl = ui.create('Input', {
            placeholder: '例如：旅行助手',
            leadingIcon: 'edit',
            required: true
        });
        const nameField = ui.create('Field', {
            label: '名称',
            required: true,
            helper: '创建后仍可在设置中修改名称和详细配置。',
            control: nameControl
        });
        const nameInput = nameControl.control;

        const modelControl = ui.create('Select', {
            value: '',
            disabled: true,
            options: [{ value: '', label: '使用默认模型' }]
        });
        const modelField = ui.create('Field', {
            label: '模型',
            helper: '正在读取可用模型…',
            control: modelControl
        });

        const error = document.createElement('div');
        error.className = 'next-ui-create-dialog-error';
        error.setAttribute('role', 'alert');
        error.setAttribute('aria-live', 'polite');
        form.append(typeField.element, nameField.element, modelField.element, error);

        const cancelButton = ui.create('Button', { label: '取消', variant: 'ghost' });
        const createButton = ui.create('Button', { label: '创建', variant: 'primary', type: 'submit' });
        const ownedControllers = [typeControl, typeField, nameControl, nameField, modelControl, modelField, cancelButton, createButton];
        const dialogScope = mountScope?.child('next:create-item-modal') || null;
        dialogScope?.own(() => host.remove(), 'create-modal-host', 'dom');
        ownedControllers.forEach((controller, index) => {
            dialogScope?.own(() => controller.destroy(), `create-control:${index}`, 'ui-registration');
        });
        let kind = 'agent';
        let submitting = false;
        let cleaned = false;
        let modal;
        const overlayOwner = Symbol('create-item-modal-overlay');
        try {
            await acquireOverlay(overlayOwner);
        } catch (overlayError) {
            if (dialogScope) await dialogScope.dispose('create-overlay-failed');
            else ownedControllers.forEach(controller => controller.destroy());
            throw overlayError;
        }
        // Switching to Classic can dispose the parent while the native view
        // hide request is still in flight.  A lease acquired for a dead dialog
        // must be returned directly instead of being registered on that Scope.
        if (dialogScope && !dialogScope.active) {
            releaseOverlay(overlayOwner);
            return;
        }
        dialogScope?.own(() => releaseOverlay(overlayOwner), 'create-overlay-lease', 'overlay');
        if (!mounted || generation !== mountGeneration || document.documentElement.dataset.uiMode !== 'next') {
            if (dialogScope) await dialogScope.dispose('create-open-cancelled');
            else {
                releaseOverlay(overlayOwner);
                ownedControllers.forEach(controller => controller.destroy());
            }
            return;
        }

        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            if (activeCreateModal === modal) activeCreateModal = null;
            if (dialogScope) {
                void dialogScope.dispose('create-modal-closed').catch(error => {
                    console.error('[NextUI] Failed to dispose create dialog:', error);
                });
            } else {
                releaseOverlay(overlayOwner);
                ownedControllers.forEach(controller => controller.destroy());
                host.remove();
            }
        };

        try {
            modal = ui.create('Modal', {
                title: '创建助手或群组',
                size: 'sm',
                content: form,
                actions: [cancelButton, createButton],
                onClose: cleanup
            });
        } catch (error) {
            if (dialogScope) await dialogScope.dispose('create-modal-failed');
            else {
                releaseOverlay(overlayOwner);
                ownedControllers.forEach(controller => controller.destroy());
            }
            throw error;
        }
        activeCreateModal = modal;
        host.append(modal.element);
        document.body.append(host);

        const syncType = () => {
            const checked = typeControl.element.querySelector('[role="radio"][aria-checked="true"]');
            kind = checked?.dataset.value === 'group' ? 'group' : 'agent';
            typeField.update({
                helper: kind === 'group'
                    ? '创建一个由多个助手参与的群组会话。'
                    : '创建一个可以独立对话的助手。'
            });
            nameInput.placeholder = kind === 'group' ? '例如：项目讨论组' : '例如：旅行助手';
            modelField.update({
                helper: kind === 'group'
                    ? '选中的模型将作为群组统一模型；也可以沿用默认设置。'
                    : '选择助手的初始模型；也可以使用系统默认模型。'
            });
        };

        const submit = async () => {
            if (submitting) return;
            const name = nameInput.value.trim();
            if (!name) {
                nameField.update({ error: '请输入名称。' });
                nameInput.focus();
                return;
            }

            submitting = true;
            error.textContent = '';
            nameField.update({ error: '' });
            createButton.update({ label: '创建中', loading: true });
            cancelButton.update({ disabled: true });
            const model = modelControl.getValue();

            try {
                const request = kind === 'group'
                    ? window.MainChatCommands.createGroup({ name, model })
                    : window.MainChatCommands.createAgent({ name, model });
                const result = dialogScope ? await dialogScope.track(request, `create-${kind}`) : await request;
                if (!result?.success) throw new Error(result?.error || '创建失败，请稍后重试。');
                window.VCPUI?.feedback?.toast(
                    result.navigationSuccess === false
                        ? `${kind === 'group' ? '群组' : '助手'}“${name}”已创建，请刷新列表查看`
                        : `${kind === 'group' ? '群组' : '助手'}“${name}”已创建`,
                    { variant: result.navigationSuccess === false ? 'warning' : 'success' }
                );
                if (modal.element.isConnected) modal.close(true);
            } catch (creationError) {
                console.error('[NextUI] Failed to create item:', creationError);
                if (modal.element.isConnected) {
                    error.textContent = creationError.message || '创建失败，请稍后重试。';
                    createButton.update({ label: '创建', loading: false });
                    cancelButton.update({ disabled: false });
                    submitting = false;
                } else {
                    window.VCPUI?.feedback?.toast(creationError.message || '创建失败，请稍后重试。', { variant: 'error' });
                }
            }
        };

        const listenDialog = (target, type, handler, options) => dialogScope
            ? dialogScope.listen(target, type, handler, options, `create-modal:${type}`)
            : target.addEventListener(type, handler, options);
        listenDialog(typeControl.element, 'change', syncType);
        listenDialog(nameInput, 'input', () => {
            if (nameField.element.dataset.state === 'error') nameField.update({ error: '' });
        });
        listenDialog(cancelButton.element, 'click', () => modal.close(null));
        listenDialog(createButton.element, 'click', submit);
        listenDialog(form, 'submit', event => {
            event.preventDefault();
            submit();
        });
        if (dialogScope) dialogScope.animationFrame(() => nameInput.focus(), 'focus-create-name');
        else requestAnimationFrame(() => nameInput.focus());

        try {
            const modelRequest = api.getCachedModels?.();
            const modelPayload = dialogScope && modelRequest
                ? await dialogScope.track(modelRequest, 'load-create-models')
                : await modelRequest;
            const options = normalizeModelOptions(modelPayload);
            if (activeCreateModal !== modal || !modal.element.isConnected) return;
            modelControl.update({
                disabled: false,
                options: [{ value: '', label: '使用默认模型' }, ...options]
            });
            syncType();
        } catch (modelError) {
            console.warn('[NextUI] Failed to load cached models:', modelError);
            if (activeCreateModal !== modal || !modal.element.isConnected) return;
            modelControl.update({ disabled: false, options: [{ value: '', label: '使用默认模型' }] });
            modelField.update({ helper: '模型列表暂不可用，将使用系统默认模型。' });
        }
    }

    function setupAgentSearch() {
        const header = document.querySelector('#tabContentAgents .agents-header');
        const trigger = document.getElementById('nextUiAgentSearchTrigger');
        const close = document.getElementById('nextUiAgentSearchClose');
        const input = document.getElementById('agentSearchInput');
        if (!header || !trigger || !close || !input) return;

        const setSearchMode = (active, clear = !active) => {
            header.classList.toggle('is-searching', active);
            trigger.setAttribute('aria-expanded', String(active));
            if (clear) {
                input.value = '';
                window.uiHelperFunctions?.filterAgentList?.('');
            }
            if (active) {
                if (mountScope) mountScope.animationFrame(() => input.focus(), 'focus-agent-search');
                else requestAnimationFrame(() => input.focus());
            }
            else if (document.activeElement === input) trigger.focus();
        };

        mountScope?.own(() => {
            header.classList.remove('is-searching');
            trigger.setAttribute('aria-expanded', 'false');
            input.value = '';
            window.uiHelperFunctions?.filterAgentList?.('');
        }, 'agent-search-state', 'dom-state');

        listen(trigger, 'click', () => setSearchMode(true, false));
        listen(close, 'click', () => setSearchMode(false));
        listen(input, 'keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setSearchMode(false);
        });
        document.querySelectorAll('.sidebar-tab-button').forEach(button => {
            listen(button, 'click', () => {
                if (button.dataset.tab !== 'agents') setSearchMode(false);
            });
        });
    }

    function setupEmbeddedAppState() {
        embeddedAppController?.mount(mountScope, payload => {
            const view = [...appTabHost.views.values()].find(candidate => candidate.kind === 'embedded' && candidate.action === payload?.action);
            if (!view) return;
            if (payload?.state === 'closed') {
                closeView(`app:${view.app.id}`, { skipEmbeddedClose: true });
                return;
            }
            if (payload?.state !== 'error') return;
            view.container.dataset.state = 'error';
            view.container.innerHTML = `<div class="next-ui-embedded-app-status is-error"><span class="vcp-ui-icon" aria-hidden="true">error</span><span>${payload.error || '应用运行异常'}</span></div>`;
        });
    }

    function mount() {
        if (mounted || document.documentElement.dataset.uiMode !== 'next') return;
        if (teardownPromise) return;
        const OverlayCoordinator = window.VCPNextShell?.OverlayCoordinator;
        const EmbeddedAppController = window.VCPNextShell?.EmbeddedAppController;
        const AppTabHost = window.VCPNextShell?.AppTabHost;
        if (!OverlayCoordinator) throw new Error('OverlayCoordinator is unavailable.');
        if (!EmbeddedAppController) throw new Error('EmbeddedAppController is unavailable.');
        if (!AppTabHost) throw new Error('AppTabHost is unavailable.');
        mounted = true;
        mountGeneration += 1;
        const LifecycleScope = window.VCPLifecycle?.LifecycleScope;
        mountScope = LifecycleScope ? new LifecycleScope('next:tab-host') : null;
        mountAbortController = mountScope ? null : new AbortController();
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
        embeddedAppController = new EmbeddedAppController({ getApi: getDesktopApi });
        overlayCoordinator = new OverlayCoordinator({
            document,
            hideEmbeddedView: () => embeddedAppController?.hide(),
            reconcileEmbeddedView: syncEmbeddedActivation,
        });
        overlayCoordinator.mount(mountScope);
        renderApps();
        syncDensity();
        observeSidebarWidth();
        setupAgentSearch();
        setupAccountMenu();
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
            renderApps();
            void restoreTabSession();
        });
        listen(window, 'vcp-ui-density-changed', event => {
            const density = event.detail?.density;
            if (!density) return;
            localStorage.setItem('vcpchat.uiDensity', density);
            syncDensity(density);
        });
        queueMicrotask(() => { void restoreTabSession(); });
    }

    function unmount() {
        if (!mounted) return teardownPromise || Promise.resolve();
        mounted = false;
        previewSuspended = false;
        mountGeneration += 1;
        if (!mountScope) mountAbortController?.abort();
        mountAbortController = null;
        accountMenuObserver?.disconnect();
        accountMenuObserver = null;
        accountMenuController = null;
        sidebarResizeObserver?.disconnect();
        sidebarResizeObserver = null;
        if (!mountScope) {
            embeddedAppController?.dispose();
            appTabHost?.dispose();
        }
        pendingTabRestore = null;
        restoringTabs = false;
        closeCreateDialog();
        const coordinatorToDispose = overlayCoordinator;
        overlayCoordinator = null;
        coordinatorToDispose?.dispose();
        const scopeToDispose = mountScope;
        mountScope = null;
        appGridScope = null;
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
        document.body.classList.remove('next-ui-tab-dragging');
        return wrapped;
    }

    async function suspendForPreview() {
        if (!mounted || previewSuspended) return;
        previewSuspended = true;
        const host = document.getElementById('nextUiInternalAppHost');
        if (host) host.hidden = true;
        try {
            await embeddedAppController?.hide();
        } catch (error) {
            console.warn('[NextUI] Failed to suspend embedded app preview:', error);
        }
    }

    function resumeFromPreview() {
        if (!previewSuspended) return;
        previewSuspended = false;
        updateVisibility();
    }

    async function acquireOverlay(owner = Symbol('next-ui-overlay')) {
        if (!overlayCoordinator) throw new Error('Next UI overlay coordinator is not mounted.');
        return overlayCoordinator.acquire(owner);
    }

    function releaseOverlay(owner) {
        overlayCoordinator?.release(owner);
    }

    async function prepareForMode(mode, options = {}) {
        if (mode !== 'next' && options.preview === true) {
            await suspendForPreview();
            return;
        }
        if (mode !== 'next') {
            await unmount();
            return;
        }
        if (teardownPromise) await teardownPromise;
    }

    async function syncMode(mode, options = {}) {
        const normalizedMode = mode === 'next' ? 'next' : 'classic';
        const generation = ++modeRequestGeneration;
        if (normalizedMode !== 'next') {
            if (options.preview === true) {
                await suspendForPreview();
                return;
            }
            await unmount();
            return;
        }
        if (teardownPromise) await teardownPromise;
        if (generation !== modeRequestGeneration) return;
        if (document.documentElement.dataset.uiMode === 'next') {
            if (previewSuspended) resumeFromPreview();
            else mount();
        }
    }

    function init() {
        if (initialized) return;
        initialized = true;
        window.addEventListener('ui-mode-changed', event => {
            if (event.detail?.coordinated === true) return;
            void syncMode(event.detail?.mode, { preview: event.detail?.preview === true });
        });
        void syncMode(document.documentElement.dataset.uiMode);
    }

    // Internal applications may need to enter the shared VCPChat Agent/Group
    // creation flow.  Expose the action itself rather than asking them to
    // synthesize a click on #nextUiCreateItemBtn: that element is part of a
    // renderable sidebar and may be replaced while the Next UI changes mode.
    // The action owns no Agent Runtime state; it only opens the existing
    // VCPChat configuration modal.
    window.topTabManager = Object.freeze({
        init,
        mount: () => syncMode('next'),
        unmount: () => syncMode('classic'),
        prepareForMode,
        syncMode,
        isMounted: () => mounted,
        openAccountMenu: () => accountMenuController?.open(),
        openLaunchpad,
        openCreateDialog,
        openInternalApp,
        openEmbeddedApp,
        closeView,
        setView,
        acquireOverlay,
        releaseOverlay
    });
})();
