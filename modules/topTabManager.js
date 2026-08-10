(() => {
    const APP_TONES = ['purple', 'green', 'pink', 'cyan', 'amber', 'charcoal', 'red', 'orange'];
    const TAB_SESSION_KEY = 'vcpchat.nextUi.openTabs.v1';
    const views = new Map();
    let initialized = false;
    let mounted = false;
    let mountGeneration = 0;
    let mountAbortController = null;
    let accountMenuObserver = null;
    let accountMenuController = null;
    let activeViewId = 'home';
    let sidebarResizeObserver = null;
    let activeCreateModal = null;
    let embeddedStateDisposer = null;
    let restoringTabs = false;
    let pendingTabRestore = null;
    let teardownPromise = null;
    let modeRequestGeneration = 0;
    const suppressedTabClicks = new Set();

    function listen(target, type, handler, options = {}) {
        if (!target || !mountAbortController) return;
        target.addEventListener(type, handler, { ...options, signal: mountAbortController.signal });
    }

    function readTabSession() {
        try {
            const parsed = JSON.parse(sessionStorage.getItem(TAB_SESSION_KEY) || 'null');
            if (!parsed || !Array.isArray(parsed.tabs)) return null;
            return {
                activeViewId: typeof parsed.activeViewId === 'string' ? parsed.activeViewId : 'home',
                tabs: parsed.tabs.filter(tab => tab && typeof tab.id === 'string' && (tab.kind === 'internal' || tab.kind === 'embedded')),
            };
        } catch {
            return null;
        }
    }

    function persistTabSession() {
        if (restoringTabs) return;
        try {
            sessionStorage.setItem(TAB_SESSION_KEY, JSON.stringify({
                activeViewId,
                tabs: [...views.values()].map(view => ({
                    kind: view.kind,
                    id: view.kind === 'internal' ? view.app.id : view.app.id,
                })),
            }));
        } catch {
            // Tab restoration is a convenience; storage failure must not block navigation.
        }
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
        sidebarResizeObserver.observe(sidebar);
    }

    function createTab({ id, title, icon, iconSvg, closeLabel }) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'next-ui-tab';
        tab.dataset.viewId = id;
        tab.setAttribute('aria-selected', 'false');
        const label = document.createElement('span');
        label.className = 'next-ui-tab-label vcp-ui-scope';
        if (icon) {
            const symbol = document.createElement('span');
            symbol.className = 'vcp-ui-icon next-ui-tab-symbol';
            symbol.setAttribute('aria-hidden', 'true');
            symbol.textContent = icon;
            label.append(symbol);
        } else if (iconSvg) {
            const symbol = document.createElement('span');
            symbol.className = 'next-ui-tab-symbol next-ui-tab-svg';
            symbol.setAttribute('aria-hidden', 'true');
            symbol.innerHTML = iconSvg;
            label.append(symbol);
        }
        const text = document.createElement('span');
        text.textContent = title;
        label.append(text);
        const close = document.createElement('span');
        close.className = 'next-ui-tab-close';
        close.setAttribute('role', 'button');
        close.setAttribute('aria-label', closeLabel || `关闭${title}标签`);
        close.title = '关闭标签';
        close.innerHTML = '<span class="vcp-ui-icon" aria-hidden="true">close</span>';
        tab.append(label, close);
        tab.addEventListener('click', event => {
            if (suppressedTabClicks.delete(id)) {
                event.preventDefault();
                return;
            }
            if (event.target.closest('.next-ui-tab-close')) {
                event.stopPropagation();
                closeView(id);
            } else setView(id);
        });
        document.getElementById('nextUiDynamicTabs')?.append(tab);
        return tab;
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
        getDesktopApi()?.desktopSetEmbeddedVchatAppBounds?.(view.action, getEmbeddedBounds(view.container)).catch(error => {
            console.warn(`[NextUI] Failed to resize embedded app ${view.action}:`, error);
        });
    }

    function syncEmbeddedActivation() {
        const activeView = views.get(activeViewId);
        const action = activeView?.kind === 'embedded' ? activeView.action : null;
        getDesktopApi()?.desktopActivateEmbeddedVchatApp?.(action).then(result => {
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

    function updateVisibility() {
        const isHome = activeViewId === 'home';
        const isLaunchpad = activeViewId === 'launchpad';
        const isInternal = activeViewId.startsWith('app:');
        document.body.classList.toggle('next-ui-launchpad-open', isLaunchpad);
        document.body.classList.toggle('next-ui-internal-app-open', isInternal);
        const homeTab = document.getElementById('nextUiHomeTab');
        const addTabButton = document.getElementById('nextUiAddTabBtn');
        const launchpad = document.getElementById('nextUiLaunchpad');
        const host = document.getElementById('nextUiInternalAppHost');
        const activeInternalView = isInternal ? views.get(activeViewId) : null;
        homeTab?.classList.toggle('active', isHome);
        homeTab?.setAttribute('aria-selected', String(isHome));
        launchpad?.setAttribute('aria-hidden', String(!isLaunchpad));
        host?.setAttribute('aria-hidden', String(!isInternal));
        if (host) {
            host.hidden = !isInternal;
            host.dataset.activeAppId = activeInternalView?.app?.id || '';
        }
        addTabButton?.classList.toggle('active', isLaunchpad);
        addTabButton?.setAttribute('aria-selected', String(isLaunchpad));
        addTabButton?.setAttribute('aria-expanded', String(isLaunchpad));
        views.forEach((view, id) => {
            const active = id === activeViewId;
            view.tab.classList.toggle('active', active);
            view.tab.setAttribute('aria-selected', String(active));
            view.container.hidden = !active;
        });
        syncEmbeddedActivation();
    }

    function setView(viewId) {
        if (viewId !== 'home' && viewId !== 'launchpad' && !views.has(viewId)) viewId = 'home';
        activeViewId = viewId;
        updateVisibility();
        persistTabSession();
    }

    function openLaunchpad() {
        if (!mounted) return;
        renderApps();
        setView('launchpad');
    }

    function closeLaunchpad() {
        if (activeViewId === 'launchpad') setView('home');
    }

    function openInternalApp(appId) {
        if (!mounted) return;
        const app = window.nextUiApps?.get(appId);
        if (!app) return;
        const viewId = `app:${app.id}`;
        if (views.has(viewId)) {
            setView(viewId);
            return;
        }
        const host = ensureInternalHost();
        const container = document.createElement('section');
        container.className = 'next-ui-internal-app-view';
        container.dataset.appId = app.id;
        container.hidden = true;
        host.append(container);
        const tab = createTab({ id: viewId, title: app.title, icon: app.icon, iconSvg: app.iconSvg });
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
        views.set(viewId, { kind: 'internal', app, tab, container, disposer });
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

    function installDetachDrag(tab, viewId) {
        tab.title = '拖出标签可在独立窗口中打开';
        tab.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.target.closest('.next-ui-tab-close')) return;
            const startPoint = {
                clientX: event.clientX,
                clientY: event.clientY,
                screenX: event.screenX,
                screenY: event.screenY
            };
            let dragging = false;
            tab.setPointerCapture?.(event.pointerId);

            const finish = async (finishEvent, cancelled = false) => {
                tab.removeEventListener('pointermove', move);
                tab.removeEventListener('pointerup', up);
                tab.removeEventListener('pointercancel', cancel);
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
            tab.addEventListener('pointermove', move);
            tab.addEventListener('pointerup', up, { once: true });
            tab.addEventListener('pointercancel', cancel, { once: true });
        });
    }

    async function openEmbeddedApp(app) {
        if (!mounted) return;
        const generation = mountGeneration;
        const api = getDesktopApi();
        if (!api?.desktopCreateEmbeddedVchatApp) {
            await window.trayManager?.launchApp(app);
            return;
        }
        const viewId = `app:${app.id}`;
        if (views.has(viewId)) {
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
        const tab = createTab({
            id: viewId,
            title: app.name,
            iconSvg: window.trayManager?.getIcon(app.icon),
            closeLabel: `关闭${app.name}标签`
        });
        const resizeObserver = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(() => {
                const view = views.get(viewId);
                if (view && activeViewId === viewId) syncEmbeddedBounds(view);
            });
        const view = { kind: 'embedded', app, action: app.action, tab, container, resizeObserver };
        views.set(viewId, view);
        resizeObserver?.observe(container);
        installDetachDrag(tab, viewId);
        setView(viewId);

        try {
            const result = await api.desktopCreateEmbeddedVchatApp(app.action);
            if (!mounted || generation !== mountGeneration || !views.has(viewId)) {
                if (result?.success) await api.desktopCloseEmbeddedVchatApp?.(app.action);
                return;
            }
            if (!result?.success) throw new Error(result?.error || '应用无法内嵌打开。');
            container.dataset.state = 'ready';
            if (activeViewId === viewId) {
                syncEmbeddedBounds(view);
                await api.desktopActivateEmbeddedVchatApp?.(app.action);
            }
        } catch (error) {
            console.error(`[NextUI] Failed to open embedded app ${app.id}:`, error);
            container.dataset.state = 'error';
            container.innerHTML = `<div class="next-ui-embedded-app-status is-error"><span class="vcp-ui-icon" aria-hidden="true">error</span><span>${error.message || '应用加载失败'}</span></div>`;
        }
    }

    async function detachView(viewId, point) {
        const view = views.get(viewId);
        if (!view || view.kind !== 'embedded') return;
        view.tab.classList.add('is-detaching');
        try {
            const result = await getDesktopApi()?.desktopDetachEmbeddedVchatApp?.(view.action, point);
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
        const view = views.get(viewId);
        if (!view) return;
        const tabs = [...document.querySelectorAll('#nextUiDynamicTabs > .next-ui-tab')];
        const tabIndex = tabs.indexOf(view.tab);
        try {
            if (view.kind === 'embedded') {
                view.resizeObserver?.disconnect();
                if (!options.skipEmbeddedClose) {
                    getDesktopApi()?.desktopCloseEmbeddedVchatApp?.(view.action).catch(error => {
                        console.warn(`[NextUI] Failed to close embedded app ${view.action}:`, error);
                    });
                }
            } else {
                if (typeof view.disposer === 'function') view.disposer();
                view.app.unmount?.();
            }
        } catch (error) {
            console.error(`[NextUiApps] Failed to unmount ${view.app?.id || view.action}:`, error);
        }
        view.tab.remove();
        view.container.remove();
        views.delete(viewId);
        if (activeViewId === viewId) {
            const remaining = [...document.querySelectorAll('#nextUiDynamicTabs > .next-ui-tab')];
            const left = tabIndex > 0 ? remaining[tabIndex - 1] : null;
            setView(left?.dataset.viewId || 'home');
        }
        persistTabSession();
    }

    async function restoreTabSession() {
        if (!mounted || !pendingTabRestore || restoringTabs) return;
        const generation = mountGeneration;
        restoringTabs = true;
        try {
            const unresolved = [];
            for (const descriptor of pendingTabRestore.tabs) {
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
            const requestedActive = pendingTabRestore.activeViewId;
            pendingTabRestore = unresolved.length ? { ...pendingTabRestore, tabs: unresolved } : null;
            if (requestedActive === 'home' || requestedActive === 'launchpad' || views.has(requestedActive)) {
                activeViewId = requestedActive;
                updateVisibility();
            }
        } finally {
            restoringTabs = false;
            persistTabSession();
        }
    }

    async function closeAllInternalApps(options = {}) {
        const preservedSession = options.preserveSession ? {
            activeViewId,
            tabs: [...views.values()].map(view => ({ kind: view.kind, id: view.app.id })),
        } : null;
        const desktopApi = getDesktopApi();
        const embeddedActions = [...views.values()]
            .filter(view => view.kind === 'embedded')
            .map(view => view.action);
        // Native WebContentsViews paint above the renderer DOM. Hide them in
        // Main before the page is allowed to cross back to Classic, then
        // destroy the sessions. The local host can be removed immediately.
        const hidePromise = desktopApi?.desktopActivateEmbeddedVchatApp
            ? desktopApi.desktopActivateEmbeddedVchatApp(null)
            : Promise.resolve({ success: true });
        if (preservedSession) restoringTabs = true;
        [...views.keys()].forEach(viewId => closeView(viewId, { skipEmbeddedClose: true }));
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
            if (desktopApi?.desktopCloseAllEmbeddedVchatApps) {
                await desktopApi.desktopCloseAllEmbeddedVchatApps();
            } else if (desktopApi?.desktopCloseEmbeddedVchatApp) {
                await Promise.all(embeddedActions.map(action => desktopApi.desktopCloseEmbeddedVchatApp(action)));
            }
        } catch (error) {
            console.warn('[NextUI] Failed to close all embedded apps:', error);
        }
    }

    function renderApps() {
        const grid = document.getElementById('nextUiAppGrid');
        const trayManager = window.trayManager;
        if (!grid || !trayManager?.getApps) return;
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
            button.addEventListener('click', () => app.embed ? openEmbeddedApp(app) : trayManager.launchApp(app));
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
            button.addEventListener('click', () => openInternalApp(app.id));
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
        if (!dock || !menu || !trigger || !avatar || !userName) return;

        const sync = () => {
            const settings = window.globalSettings || {};
            userName.textContent = settings.userName?.trim() || '用户';
            const nextAvatar = settings.userAvatarUrl || 'assets/default_user_avatar.png';
            if (avatar.getAttribute('src') !== nextAvatar) avatar.src = nextAvatar;
            window.VCPAppearanceStudio?.syncAccountMenuValue?.();
            const isDark = document.body.classList.contains('dark-theme');
            const nextThemeLabel = isDark ? '切换为浅色模式' : '切换为深色模式';
            if (themeIcon) window.VCPIcons?.set(themeIcon, isDark ? 'light_mode' : 'dark_mode');
            if (themeLabel) themeLabel.textContent = nextThemeLabel;
            themeToggleButton?.setAttribute('aria-label', nextThemeLabel);
            themeToggleButton?.setAttribute('aria-pressed', String(isDark));
        };

        const setOpen = (open) => {
            menu.hidden = !open;
            trigger.setAttribute('aria-expanded', String(open));
            if (open) sync();
        };
        accountMenuController = Object.freeze({ open: () => setOpen(true), close: () => setOpen(false) });

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
        accountMenuObserver = new MutationObserver(sync);
        accountMenuObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
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
        let kind = 'agent';
        let submitting = false;
        let cleaned = false;
        let modal;

        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            if (activeCreateModal === modal) activeCreateModal = null;
            ownedControllers.forEach(controller => controller.destroy());
            host.remove();
        };

        modal = ui.create('Modal', {
            title: '创建助手或群组',
            size: 'sm',
            content: form,
            actions: [cancelButton, createButton],
            onClose: cleanup
        });
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
                const result = kind === 'group'
                    ? await window.MainChatCommands.createGroup({ name, model })
                    : await window.MainChatCommands.createAgent({ name, model });
                if (!result?.success) throw new Error(result?.error || '创建失败，请稍后重试。');
                window.VCPUI?.feedback?.toast(`${kind === 'group' ? '群组' : '助手'}“${name}”已创建`, { variant: 'success' });
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

        typeControl.element.addEventListener('change', syncType);
        nameInput.addEventListener('input', () => {
            if (nameField.element.dataset.state === 'error') nameField.update({ error: '' });
        });
        cancelButton.element.addEventListener('click', () => modal.close(null));
        createButton.element.addEventListener('click', submit);
        form.addEventListener('submit', event => {
            event.preventDefault();
            submit();
        });
        requestAnimationFrame(() => nameInput.focus());

        try {
            const options = normalizeModelOptions(await api.getCachedModels?.());
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
            if (active) requestAnimationFrame(() => input.focus());
            else if (document.activeElement === input) trigger.focus();
        };

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
        if (embeddedStateDisposer) return;
        embeddedStateDisposer = getDesktopApi()?.onEmbeddedVchatAppState?.(payload => {
            const view = [...views.values()].find(candidate => candidate.kind === 'embedded' && candidate.action === payload?.action);
            if (!view || payload?.state !== 'error') return;
            view.container.dataset.state = 'error';
            view.container.innerHTML = `<div class="next-ui-embedded-app-status is-error"><span class="vcp-ui-icon" aria-hidden="true">error</span><span>${payload.error || '应用运行异常'}</span></div>`;
        }) || null;
    }

    function mount() {
        if (mounted || document.documentElement.dataset.uiMode !== 'next') return;
        if (teardownPromise) return;
        mounted = true;
        mountGeneration += 1;
        mountAbortController = new AbortController();
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
        listen(window, 'next-ui-apps-changed', () => {
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
        mountGeneration += 1;
        mountAbortController?.abort();
        mountAbortController = null;
        accountMenuObserver?.disconnect();
        accountMenuObserver = null;
        accountMenuController = null;
        sidebarResizeObserver?.disconnect();
        sidebarResizeObserver = null;
        embeddedStateDisposer?.();
        embeddedStateDisposer = null;
        pendingTabRestore = null;
        restoringTabs = false;
        closeCreateDialog();
        const pending = closeAllInternalApps({ preserveSession: true });
        const wrapped = pending.finally(() => {
            if (teardownPromise === wrapped) teardownPromise = null;
        });
        teardownPromise = wrapped;
        document.body.classList.remove('next-ui-tab-dragging');
        return wrapped;
    }

    async function prepareForMode(mode) {
        if (mode !== 'next') {
            await unmount();
            return;
        }
        if (teardownPromise) await teardownPromise;
    }

    async function syncMode(mode) {
        const normalizedMode = mode === 'next' ? 'next' : 'classic';
        const generation = ++modeRequestGeneration;
        if (normalizedMode !== 'next') {
            await unmount();
            return;
        }
        if (teardownPromise) await teardownPromise;
        if (generation !== modeRequestGeneration) return;
        if (document.documentElement.dataset.uiMode === 'next') mount();
    }

    function init() {
        if (initialized) return;
        initialized = true;
        window.addEventListener('ui-mode-changed', event => {
            void syncMode(event.detail?.mode);
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
        setView
    });
})();
