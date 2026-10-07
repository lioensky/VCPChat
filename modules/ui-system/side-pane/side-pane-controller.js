/* Host controller for Workspace Side Pane, managing tabs, views, and provider lifecycles. */
'use strict';

import * as SidePaneState from './side-pane-state.js';
import { createSidePaneResizerOwner } from './side-pane-resizer-owner.js';
import { createSidePaneVisibility } from './side-pane-visibility.js';
import { createSidePaneTabStrip } from './side-pane-tab-strip.js';
import { createSidePaneTabOverview } from './side-pane-tab-overview.js';
import { createSidePaneTabMenu } from './side-pane-tab-menu.js';
import { createSidePaneLauncher } from './side-pane-launcher.js';
import { createSidePaneFocus } from './side-pane-focus.js';
import { createSidePaneTabCloseOwner } from './side-pane-tab-close-owner.js';
import { createSidePaneTabRegistry } from './side-pane-tab-registry.js';
import { createSidePaneShortcuts } from './side-pane-shortcuts.js';
import { createSidePaneLayoutStore, parseLayout, rememberBounded, serializeLayout } from './side-pane-persistence.js';
import { createSidePaneRootScope, createTabOccurrence } from './side-pane-occurrence.js';
import { selectDormantViews } from './side-pane-dormancy.js';
import { findByTabId } from './side-pane-tab-utils.js';

/** @typedef {import('./side-pane-types.js').SidePaneTab} SidePaneTab */
/** @typedef {import('./side-pane-types.js').SidePaneTabType} SidePaneTabType */
/** @typedef {import('./side-pane-types.js').SidePaneTabHandle} SidePaneTabHandle */

// 对话区窄于这个宽度时自动收起面板
const CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX = 480;
const CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS = 300;
const RECENTLY_CLOSED_LIMIT = 10;

export function createSidePaneController({
    root,
    resizerHandle,
    tabListElement,
    contentContainer,
    toggleNotificationsBtn = null,
    // 通知面板本体：通知页签展开时加 active
    notificationsPanel = null,
    // notification-center 状态 { counts, connection }；不传就用页面里登记的那一份
    notificationState = null,
    // 通知页签从看不见变成看得见时调用（收走悬浮通知）
    onNotificationsShown = null,
    expandButton = null,
    closeSidePaneBtn = null,
    addTabButton = null,
    homeButton = null,
    overviewBtn = null,
    overviewPopover = null,
    settingsRef = null,
    electronAPI = null,
    scope = null,
    providers = {},
    tabTypes: initialTabTypes = [],
    openTabEntries = [],
    // { storage, key? }：传了才持久化布局；控制器调用 restoreLayout() 之前不会写入，免得空布局盖掉存档
    persistence = null,
    // 休眠策略的阈值（见 side-pane-dormancy.js），测试可以连 now 一起换掉
    dormancy = null
}) {
    if (!root) {
        throw new TypeError('SidePaneController requires a root element');
    }

    const doc = root.ownerDocument || globalThis.document;
    const win = doc?.defaultView || globalThis.window;
    const resolvedAddTabButton = addTabButton || doc.getElementById?.('addSidePaneChatBtn');
    const resolvedHomeButton = homeButton || doc.getElementById?.('sidePaneHomeBtn') || null;
    const resolvedOverviewBtn = overviewBtn || doc.getElementById?.('sidePaneTabOverviewBtn');
    const resolvedOverviewPopover = overviewPopover || doc.getElementById?.('sidePaneTabOverviewPopover');
    const resolvedTabContextMenu = doc.getElementById?.('sidePaneTabContextMenu');

    const initialWidth = Number(settingsRef?.get?.()?.notificationsSidebarWidth) || SidePaneState.DEFAULT_WIDTH;

    let state = SidePaneState.createInitialSidePaneState({
        preferredWidth: initialWidth,
        visible: root.classList.contains('active') || root.getAttribute('aria-hidden') === 'false'
    });

    const mountedTabMap = new Map(); // tabId -> { payload, viewElement, handle, occurrence }
    const pendingTabMounts = new Map(); // tabId -> mount occurrence; reopening the same id starts a new lifetime
    // 标签打开期间的 scope：第一次挂载时建，关标签才释放；视图休眠只释放它下面的 view scope
    const rootScope = createSidePaneRootScope(scope);
    const occurrences = new Map(); // tabId -> createTabOccurrence()
    // 休眠：视图释放了、标签还在的记在 dormantTabs，再显示时重新挂载并拿回 captureState 存下的内容
    const viewTimes = new Map(); // tabId -> { hiddenSince, lastShownAt }，只记挂着视图的标签
    const dormantTabs = new Map(); // tabId -> { reason, since, state }
    const now = typeof dormancy?.now === 'function' ? dormancy.now : () => Date.now();
    let cancelDormancyCheck = null;
    const cleanupListeners = [];
    const recentlyClosedTabs = [];
    const collapsedByParent = new Map(); // parentKey -> boolean，最近 50 个对话
    const activeTabByParent = new Map(); // parentKey -> tabId，最近 50 个对话
    let isDisposed = false;
    let navigationRevision = 0;
    // 最近一次按对话定下面板时的 navigationRevision；之后没人动过面板，补回来的标签还可以重新定一次
    let parentResolvedRevision = -1;
    let controller = null;
    const tabRegistry = createSidePaneTabRegistry({
        providers,
        registerEntry: entry => launcher.registerEntry(entry),
        onChanged: () => { renderTabList(); overview?.refresh(); },
        isDisposed: () => isDisposed
    });
    const { getTabType } = tabRegistry;
    const focus = createSidePaneFocus({
        doc,
        root,
        getFallback: () => [expandButton, toggleNotificationsBtn].find(button => button && !button.hidden) || null
    });

    const isNotificationsTab = (tabId) => tabId === SidePaneState.NOTIFICATIONS_TAB_ID;
    const isClosableTab = (tab) => !isNotificationsTab(tab.id) && tab.closable !== false;
    const parentKeyOf = () => (state.parent ? SidePaneState.getParentKey(state.parent) : '');

    // ---- 开合与宽度 ----
    let notificationsShown = false;
    function syncHeaderButtons(isVisible) {
        const isNotifActive = isVisible && isNotificationsTab(state.activeTabId);
        if (isNotifActive && !notificationsShown) onNotificationsShown?.();
        notificationsShown = isNotifActive;
        if (toggleNotificationsBtn) {
            toggleNotificationsBtn.classList.toggle('notification-panel-active', isNotifActive);
            toggleNotificationsBtn.setAttribute('aria-expanded', String(isNotifActive));
            toggleNotificationsBtn.setAttribute('aria-label', isNotifActive ? '关闭通知面板' : '打开通知面板');
            toggleNotificationsBtn.title = `${isNotifActive ? '左键关闭通知面板' : '左键打开通知面板'}/右键监控面板`;
            // 通知按钮仅在通知页签展开时挪进面板标题，其余情况（含切到其他页签/关闭）必须回到聊天标题
            const targetHost = doc.getElementById(isNotifActive ? 'nextUiPanelNotificationHost' : 'nextUiChatNotificationHost');
            if (targetHost && toggleNotificationsBtn.parentElement !== targetHost) {
                targetHost.append(toggleNotificationsBtn);
            }
        }
        notificationsPanel?.classList.toggle('active', isNotifActive);

        // 展开按钮只在面板收起时出现；面板里有自己的收起按钮
        if (expandButton) {
            expandButton.hidden = isVisible;
            expandButton.setAttribute('aria-expanded', String(isVisible));
        }
    }

    // 旧键 notificationsSidebarRatio 曾按整个窗口宽度算（父元素 display: contents 时测出 0），存下的值偏小，直接弃用
    const visibility = createSidePaneVisibility({
        root,
        resizerHandle,
        initialRatio: Number(settingsRef?.get?.()?.sidePaneWidthRatio),
        onSync: syncHeaderButtons
    });
    const syncDomVisibility = (options = {}) => {
        if (!state.visible) resizerOwner?.cancel?.();
        visibility.sync(state.visible, options);
        mountActiveIfNeeded();
        syncOccurrenceVisibility();
    };

    // ---- 布局持久化 ----
    const canPersistKind = kind => {
        const definition = getTabType(kind);
        return !!definition && definition.persist !== false && !!providers[kind];
    };
    const layoutStore = persistence?.storage ? createSidePaneLayoutStore({
        storage: persistence.storage,
        key: persistence.key,
        win,
        getLayout: () => serializeLayout({
            tabs: state.tabs,
            activeTabId: state.activeTabId,
            visible: state.visible,
            activeByParent: activeTabByParent,
            collapsedByParent
        }, canPersistKind)
    }) : null;
    let layoutRestored = false;
    const persistSoon = () => {
        if (layoutRestored && !isDisposed) layoutStore?.scheduleSave();
    };

    let resizerOwner = null;
    if (resizerHandle && typeof window !== 'undefined' && window.VCPSidebarResizer?.create) {
        resizerOwner = createSidePaneResizerOwner({
            handle: resizerHandle,
            paneElement: root,
            onWidthChange: (width) => {
                state = SidePaneState.setPreferredWidth(state, width);
            },
            onWidthCommit: async (width) => {
                state = SidePaneState.setPreferredWidth(state, width);
                if (visibility.setRatioFromWidth(width)) visibility.writeWidth();
                const ratio = visibility.getRatio();
                if (settingsRef?.set) {
                    settingsRef.set({ ...(settingsRef.get() || {}), notificationsSidebarWidth: width, sidePaneWidthRatio: ratio });
                }
                if (electronAPI?.saveSettings) {
                    try {
                        await electronAPI.saveSettings({
                            __vcpSettingsOps: [
                                { op: 'set', path: ['notificationsSidebarWidth'], value: width },
                                { op: 'set', path: ['sidePaneWidthRatio'], value: ratio }
                            ]
                        });
                    } catch (err) {
                        console.error('[SidePaneController] Failed to persist width:', err);
                    }
                }
            },
            scope
        });
    }

    // ---- 新标签页、标签条、概览、右键菜单 ----
    let strip = null;
    let overview = null;
    let tabMenu = null;

    const launcher = createSidePaneLauncher({
        contentContainer,
        addButton: resolvedAddTabButton,
        homeButton: resolvedHomeButton,
        isNotificationsActive: () => isNotificationsTab(state.activeTabId),
        showNotifications: () => controller.showNotifications(),
        showLauncher: () => controller.showLauncher(),
        hideMenus: () => {
            overview?.hide();
            tabMenu?.hide();
        },
        onEntriesChanged: () => strip?.scheduleLayout()
    });
    cleanupListeners.push(() => launcher.dispose());

    // 通知在新标签页里有自己的分类时，不再占标签条上的位置
    const getStripTabs = () => {
        const tabs = SidePaneState.getVisibleTabs(state, state.parent);
        return launcher.hostsNotifications ? tabs.filter(tab => !isNotificationsTab(tab.id)) : tabs;
    };

    // VCPLog 连接状态不单独占一行：通知标签和新标签页的通知分类上各一个小圆点，悬停/读屏给出全文。
    // 新标签页的通知卡片还要带上待审批/错误数。两样都从通知中心发布的状态里读。
    const notificationChannel = notificationState || win?.VCPStateChannels?.get?.('notification-center') || null;
    const readConnectionStatus = () => {
        const connection = notificationChannel?.get?.()?.connection;
        return connection ? { status: connection.status || 'unknown', text: String(connection.text || '').trim() } : null;
    };
    const readLauncherStatus = () => {
        const current = readConnectionStatus();
        const counts = notificationChannel?.get?.()?.counts || {};
        return current ? { ...current, pending: Number(counts.pending) || 0, errors: Number(counts.error) || 0 } : null;
    };

    if (tabListElement) {
        strip = createSidePaneTabStrip({
            tabListElement,
            addButton: resolvedAddTabButton,
            getTabs: getStripTabs,
            getTabType,
            getActiveTabId: () => state.activeTabId,
            isClosable: isClosableTab,
            statusTabId: SidePaneState.NOTIFICATIONS_TAB_ID,
            getStatus: readConnectionStatus,
            onActivate: (tabId, options) => controller.activateTab(tabId, options),
            onClose: (tabId) => controller.closeTab(tabId),
            onReorder: (activeId, overId) => controller.reorderTab(activeId, overId),
            onContextMenu: (tabId, x, y) => tabMenu?.show(tabId, x, y),
            onRendered: () => overview?.refresh()
        });
        cleanupListeners.push(() => strip.dispose());
    }

    if (resolvedOverviewPopover) {
        overview = createSidePaneTabOverview({
            button: resolvedOverviewBtn,
            popover: resolvedOverviewPopover,
            getTabs: getStripTabs,
            getTabType,
            getActiveTabId: () => state.activeTabId,
            // 只列当前对话能看到的：别的话题的标签重开后登记在那个话题下，这里看起来像点了没反应
            getRecentlyClosed: () => recentlyClosedTabs.filter(entry => SidePaneState.isTabVisibleForParent(entry.tab, state.parent)),
            isClosable: isClosableTab,
            onActivate: (tabId) => {
                controller.activateTab(tabId);
                controller.setVisible(true);
            },
            onClose: (tabId) => controller.closeTab(tabId),
            onReopen: (closedId) => controller.reopenClosedTab(closedId),
            onShow: () => tabMenu?.hide()
        });
        cleanupListeners.push(() => overview.dispose());
    }

    if (resolvedTabContextMenu) {
        tabMenu = createSidePaneTabMenu({
            menu: resolvedTabContextMenu,
            getClosableTabs: () => SidePaneState.getClosableVisibleTabs(state),
            onShow: () => overview?.hide(),
            focusTab: (tabId) => strip?.focusTab(state.tabs.some(t => t.id === tabId) ? tabId : state.activeTabId),
            onAction: async (action, tabId) => {
                if (action === 'close-tab' && tabId) await controller.closeTab(tabId);
                else if (action === 'close-others' && tabId) await controller.closeOtherTabs(tabId);
                else if (action === 'close-all') await controller.closeAllTabs();
            }
        });
        cleanupListeners.push(() => tabMenu.dispose());
    }

    function syncConnectionStatus() {
        launcher.syncStatus(readLauncherStatus());
        strip?.syncStatus();
    }

    if (typeof notificationChannel?.subscribe === 'function') {
        const offNotificationState = notificationChannel.subscribe(syncConnectionStatus, { immediate: false });
        cleanupListeners.push(() => offNotificationState());
    }

    function renderTabList() {
        persistSoon();
        strip?.render();
        launcher.syncStatus(readLauncherStatus());
    }

    function getActiveView() {
        const visibleTabIds = new Set(SidePaneState.getVisibleTabs(state, state.parent).map(t => t.id));
        visibleTabIds.add(SidePaneState.LAUNCHER_TAB_ID);
        const activeViewId = launcher.hostsNotifications && isNotificationsTab(state.activeTabId)
            ? SidePaneState.LAUNCHER_TAB_ID
            : state.activeTabId;
        return { visibleTabIds, activeViewId };
    }

    // 面板展开、是当前标签、窗口没有最小化或被切走，三者都满足才算可见
    function isTabShown(tabId, { visibleTabIds, activeViewId } = getActiveView()) {
        return !isDisposed && state.visible && doc.visibilityState !== 'hidden' && tabId === activeViewId && visibleTabIds.has(tabId);
    }

    // 可见性由容器下发：provider 不用自己探测 DOM；隐藏时 suspend，重新可见时 resume
    function syncOccurrenceVisibility() {
        if (isDisposed) return;
        const active = getActiveView();
        occurrences.forEach((tabOccurrence, tabId) => {
            const shown = isTabShown(tabId, active);
            if (!tabOccurrence.setVisible(shown)) return;
            const handle = mountedTabMap.get(tabId)?.handle;
            try {
                if (shown) handle?.resume?.();
                else handle?.suspend?.();
            } catch (error) {
                console.error(`[SidePaneController] Failed to ${shown ? 'resume' : 'suspend'} tab "${tabId}":`, error);
            }
        });
        noteViewPresence(active);
        evaluateDormancy();
    }

    // ---- 休眠 ----
    // 计时看的是"在当前对话里是不是当前标签"，不看窗口有没有最小化，也不看面板是否收起：
    // 用户重新展开时看到的还是它，不该被换掉（对照 ZCode shouldMountSidePaneContent、DSH TabLayout 收起时保留选中标签）
    function isTabPresented(tabId, { visibleTabIds, activeViewId } = getActiveView()) {
        return !isDisposed && tabId === activeViewId && visibleTabIds.has(tabId);
    }

    function noteViewPresence(active = getActiveView()) {
        const at = now();
        mountedTabMap.forEach((_entry, tabId) => {
            const presented = isTabPresented(tabId, active);
            const times = viewTimes.get(tabId) || { hiddenSince: at, lastShownAt: 0 };
            if (presented) {
                times.hiddenSince = null;
                times.lastShownAt = at;
            } else if (times.hiddenSince === null) {
                times.hiddenSince = at;
            }
            viewTimes.set(tabId, times);
        });
    }

    function isOtherTopicTab(tab) {
        const parent = SidePaneState.getTabParent(tab);
        return Boolean(parent && state.parent && !SidePaneState.matchesConversation(parent, state.parent));
    }

    function evaluateDormancy() {
        if (isDisposed) return;
        cancelDormancyCheck?.();
        cancelDormancyCheck = null;
        const active = getActiveView();
        const candidates = [];
        mountedTabMap.forEach((entry, tabId) => {
            const tab = state.tabs.find(t => t.id === tabId);
            if (!tab) return;
            let busy = false;
            try {
                busy = entry.handle?.isBusy?.() === true;
            } catch (error) {
                console.error(`[SidePaneController] Failed to ask tab "${tabId}" whether it is busy:`, error);
                busy = true;
            }
            const times = viewTimes.get(tabId) || { hiddenSince: null, lastShownAt: 0 };
            candidates.push({
                tabId,
                shown: isTabPresented(tabId, active),
                dormancy: getTabType(tab.kind)?.dormancy || 'none',
                busy,
                otherTopic: isOtherTopicTab(tab),
                hiddenSince: times.hiddenSince,
                lastShownAt: times.lastShownAt,
                openedAt: Number(tab.openedAt) || 0
            });
        });
        const at = now();
        const { release, nextCheckAt } = selectDormantViews(candidates, { ...dormancy, now: at });
        release.forEach(({ tabId, reason }) => putViewToSleep(tabId, reason));
        if (nextCheckAt !== null) {
            cancelDormancyCheck = rootScope.timeout(evaluateDormancy, Math.max(0, nextCheckAt - at), 'dormancy-check');
        }
    }

    /**
     * 只释放视图：provider 的 dispose 和 view scope 照常收掉，标签、occurrence（以及挂在它上面的会话）留着。
     * 再显示时由 mountActiveIfNeeded 重新挂载，captureState 存下的内容作为 restoredState 交回去。
     */
    function putViewToSleep(tabId, reason) {
        const entry = mountedTabMap.get(tabId);
        if (!entry || isDisposed) return;
        let saved;
        try {
            saved = entry.handle?.captureState?.();
        } catch (error) {
            console.error(`[SidePaneController] Failed to save tab "${tabId}" before it sleeps:`, error);
        }
        // 先同步摘掉：马上又显示的话，重新挂载拿到的是一个新的视图容器
        mountedTabMap.delete(tabId);
        viewTimes.delete(tabId);
        dormantTabs.set(tabId, { reason, since: now(), state: saved });
        entry.viewElement?.remove?.();
        const sleepingView = entry.occurrence?.view || null;
        void Promise.resolve()
            .then(() => entry.handle?.dispose?.())
            .catch(error => console.error(`[SidePaneController] Failed to release the view of tab "${tabId}":`, error))
            .then(() => sleepingView && entry.occurrence?.closeView?.(`dormant:${reason}`, sleepingView))
            .catch(error => console.error(`[SidePaneController] Failed to release the view scope of tab "${tabId}":`, error));
    }

    function obtainOccurrence(tabId, kind) {
        const existing = occurrences.get(tabId);
        if (existing?.active) return existing;
        const created = createTabOccurrence(rootScope, { tabId, kind });
        occurrences.set(tabId, created);
        return created;
    }

    function releaseOccurrence(tabOccurrence, reason) {
        if (!tabOccurrence) return Promise.resolve();
        for (const [tabId, current] of occurrences) {
            if (current === tabOccurrence) occurrences.delete(tabId);
        }
        return tabOccurrence.dispose(reason).catch(error => {
            console.error(`[SidePaneController] Failed to release tab "${tabOccurrence.occurrence.id}":`, error);
        });
    }

    function syncViewPanels() {
        if (!contentContainer) return;
        const { visibleTabIds, activeViewId } = getActiveView();
        contentContainer.querySelectorAll('.side-pane-view').forEach(view => {
            const viewTabId = view.getAttribute('data-tab-id') || (
                view.id === 'sidePaneViewNotifications' ? SidePaneState.NOTIFICATIONS_TAB_ID : null
            );
            const isActive = visibleTabIds.has(viewTabId) && viewTabId === activeViewId;
            view.classList.toggle('active', isActive);
            view.hidden = !isActive;
        });
        if (launcher.hostsNotifications) launcher.syncSections();
        launcher.syncHome(activeViewId === SidePaneState.LAUNCHER_TAB_ID);
        syncOccurrenceVisibility();
    }

    // ---- 标签视图挂载 ----
    // 同一个 tabId 只挂一次：并发打开时后来的调用等同一次挂载；挂载期间标签被关掉或控制器被销毁时，把刚挂上的拆掉
    function cancelPendingMount(tabId) {
        const pending = pendingTabMounts.get(tabId);
        if (!pending) return;
        pending.canceled = true;
        pending.viewElement?.remove();
        pendingTabMounts.delete(tabId);
    }

    // 挂载失败的标签：tabId -> 显示出错提示的视图
    const failedMounts = new Map();

    function clearMountFailure(tabId) {
        failedMounts.get(tabId)?.remove?.();
        failedMounts.delete(tabId);
    }

    function showMountFailure(tabId, view, error, mountOptions) {
        view.replaceChildren();
        const box = doc.createElement('div');
        box.className = 'side-pane-mount-error';
        box.setAttribute('role', 'alert');
        const title = doc.createElement('div');
        title.className = 'side-pane-mount-error-title';
        title.textContent = '这个标签没能打开';
        const detail = doc.createElement('div');
        detail.className = 'side-pane-mount-error-detail';
        detail.textContent = error?.message || String(error || '未知错误');
        const retry = doc.createElement('button');
        retry.type = 'button';
        retry.className = 'side-pane-mount-error-retry';
        retry.textContent = '重试';
        retry.addEventListener('click', () => {
            if (isDisposed || failedMounts.get(tabId) !== view) return;
            const refocus = view.contains(doc.activeElement);
            ensureTabMounted(tabId, mountOptions)
                .then(entry => {
                    if (!entry || isDisposed) return;
                    syncViewPanels();
                    if (refocus && state.activeTabId === tabId) entry.handle?.focus?.();
                })
                .catch(retryError => {
                    console.error(`[SidePaneController] Retrying the mount of tab "${tabId}" failed:`, retryError);
                    if (!isDisposed) syncViewPanels();
                    if (refocus) failedMounts.get(tabId)?.querySelector?.('.side-pane-mount-error-retry')?.focus?.();
                });
        });
        box.append(title, detail, retry);
        view.append(box);
        failedMounts.set(tabId, view);
        syncViewPanels();
    }

    function ensureTabMounted(tabId, { provider, payload, kind = payload?.kind, ariaLabel = null, onClosed = null }) {
        const mounted = mountedTabMap.get(tabId);
        if (mounted) return Promise.resolve(mounted);
        if (pendingTabMounts.has(tabId)) return pendingTabMounts.get(tabId).promise;

        const pending = { promise: null, viewElement: null, canceled: false, onClosed };
        const mounting = (async () => {
            // 上次挂载失败留下的提示页不复用，换一个干净的视图重新挂
            clearMountFailure(tabId);
            let view = findByTabId(contentContainer, '[data-tab-id]', tabId);
            if (!view && contentContainer) {
                view = doc.createElement('section');
                view.className = 'side-pane-view';
                view.setAttribute('data-tab-id', tabId);
                view.setAttribute('role', 'tabpanel');
                if (ariaLabel) view.setAttribute('aria-label', ariaLabel);
                contentContainer.appendChild(view);
            }
            if (!view) return null;
            pending.viewElement = view;
            const tabOccurrence = obtainOccurrence(tabId, kind);
            const viewScope = tabOccurrence.openView();
            // 挂载前先给出可见性，provider 一开始就知道要不要起轮询
            tabOccurrence.setVisible(isTabShown(tabId));

            const dormant = dormantTabs.get(tabId);
            let handle = null;
            try {
                handle = provider?.mountTab
                    ? await provider.mountTab(payload, view, {
                        scope: viewScope,
                        occurrence: tabOccurrence.occurrence,
                        restoredState: dormant?.state
                    })
                    : null;
            } catch (error) {
                await tabOccurrence.closeView('mount-failed').catch(() => {});
                // 标签还在、侧栏没拆：留一页出错提示和重试按钮，不让用户对着空白页
                if (!isDisposed && !pending.canceled && state.tabs.some(t => t.id === tabId)) {
                    showMountFailure(tabId, view, error, { provider, payload, kind, ariaLabel, onClosed });
                } else {
                    view.remove?.();
                }
                throw error;
            }
            if (isDisposed || pending.canceled || !state.tabs.some(t => t.id === tabId)) {
                try {
                    await handle?.dispose?.();
                } catch (error) {
                    console.error(`[SidePaneController] Failed to dispose canceled mount "${tabId}":`, error);
                } finally {
                    await tabOccurrence.closeView('mount-canceled').catch(() => {});
                    view.remove?.();
                }
                return null;
            }
            const entry = { payload, viewElement: view, handle, onClosed, occurrence: tabOccurrence };
            mountedTabMap.set(tabId, entry);
            if (dormantTabs.get(tabId) === dormant) dormantTabs.delete(tabId);
            return entry;
        })();

        pending.promise = mounting;
        pendingTabMounts.set(tabId, pending);
        const forget = () => {
            if (pendingTabMounts.get(tabId) === pending) pendingTabMounts.delete(tabId);
        };
        mounting.then(
            forget,
            forget
        );
        return mounting;
    }

    // 恢复出来的标签不在启动时挂载，第一次显示时才挂；焦点留在原处
    // 批量关闭期间兜底激活的标签多半紧接着也要关，等整批关完再挂当时停着的那个
    let batchClosing = 0;
    async function closeBatch(tabs, options, onFocusMoved) {
        batchClosing++;
        try {
            await tabCloseOwner.closeTabs(tabs, options, onFocusMoved);
        } finally {
            batchClosing--;
            mountActiveIfNeeded();
        }
    }

    function mountActiveIfNeeded() {
        if (isDisposed || !state.visible || batchClosing > 0) return;
        const tabId = state.activeTabId;
        if (!tabId || mountedTabMap.has(tabId) || pendingTabMounts.has(tabId)) return;
        const tab = state.tabs.find(t => t.id === tabId);
        const provider = tab && providers[tab.kind];
        if (!provider?.mountTab) return;
        ensureTabMounted(tabId, { provider, payload: tab, ariaLabel: tab.title || '副屏视图', onClosed: getTabType(tab.kind)?.onClosed })
            .then(entry => { if (entry && !isDisposed) syncViewPanels(); })
            .catch(error => console.error(`[SidePaneController] Failed to mount restored tab "${tabId}":`, error));
    }

    // 打开的标签属于当前对话时，记下它是这个对话的激活标签，且面板展开
    function rememberOpened(parentRef, tabId) {
        if (!state.parent || !SidePaneState.matchesConversation(parentRef, state.parent)) return;
        const parentKey = parentKeyOf();
        rememberBounded(collapsedByParent, parentKey, false);
        rememberBounded(activeTabByParent, parentKey, tabId);
    }

    function finishOpen(tabId, entry, origin) {
        if (isDisposed) return null;
        syncViewPanels();
        syncDomVisibility();
        // A background mount can finish after another tab, conversation or input has taken focus.
        const focusUnchanged = doc.activeElement === origin
            || (doc.activeElement === doc.body && origin && !origin.isConnected);
        if (state.visible && state.activeTabId === tabId && mountedTabMap.get(tabId) === entry
            && SidePaneState.getVisibleTabs(state, state.parent).some(tab => tab.id === tabId) && focusUnchanged) {
            entry?.handle?.focus?.();
        }
        return entry?.handle || null;
    }

    // 临时标签（如辅助对话）不进“最近关闭”，其他标签都能重新打开
    function rememberClosed(tabObj) {
        if (tabObj.ephemeral || tabObj.reopenable === false || getTabType(tabObj.kind)?.reopenable === false) return;
        const { openedAt, ...reopenable } = tabObj;
        const previous = recentlyClosedTabs.findIndex(entry => entry.id === tabObj.id);
        if (previous !== -1) recentlyClosedTabs.splice(previous, 1);
        recentlyClosedTabs.unshift({ id: tabObj.id, title: tabObj.title || '标签页', tab: reopenable, closedAt: Date.now() });
        if (recentlyClosedTabs.length > RECENTLY_CLOSED_LIMIT) recentlyClosedTabs.pop();
    }

    const tabCloseOwner = createSidePaneTabCloseOwner({
        isDisposed: () => isDisposed,
        getTab: tabId => state.tabs.find(tab => tab.id === tabId),
        getEntry: tabId => mountedTabMap.get(tabId),
        getOnClosed: tab => {
            const occurrence = mountedTabMap.get(tab.id) || pendingTabMounts.get(tab.id);
            return occurrence ? occurrence.onClosed : getTabType(tab.kind)?.onClosed;
        },
        cancelPendingMount,
        getRequestClose: tab => getTabType(tab.kind)?.requestClose || null,
        retireTab(tab, entry, options, onFocusMoved) {
            // Read current focus after authorization; the user may have moved elsewhere while it waited.
            const ownedFocus = focus.ownsFocus();
            const origin = doc.activeElement;
            const closingFocusedTab = state.activeTabId === tab.id
                || entry?.viewElement?.contains(origin)
                || origin?.closest?.('[data-tab-id]')?.getAttribute('data-tab-id') === tab.id;
            entry?.viewElement?.remove();
            clearMountFailure(tab.id);
            if (mountedTabMap.get(tab.id) === entry) mountedTabMap.delete(tab.id);
            viewTimes.delete(tab.id);
            dormantTabs.delete(tab.id);
            // 挂着的标签由 disposeEntry 先调 handle.dispose 再释放 scope；没挂上（或挂到一半）的这里直接释放
            const tabOccurrence = entry?.occurrence || occurrences.get(tab.id);
            if (entry) occurrences.delete(tab.id);
            else void releaseOccurrence(tabOccurrence, 'tab-closed');
            if (!options.discard) rememberClosed(tab);
            const wasVisible = state.visible;
            state = SidePaneState.closeTab(state, tab.id, options);
            tabCloseOwner.forgetLifetime(tab.id);
            if (state.parent) {
                const parentKey = parentKeyOf();
                if (wasVisible && !state.visible) {
                    rememberBounded(collapsedByParent, parentKey, true);
                    activeTabByParent.delete(parentKey);
                } else if (activeTabByParent.get(parentKey) === tab.id) {
                    rememberBounded(activeTabByParent, parentKey, state.activeTabId);
                }
            }
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
            if (!state.visible) focus.restoreAfterHide(ownedFocus);
            else if (ownedFocus && closingFocusedTab) strip?.focusTab(state.activeTabId);
            onFocusMoved?.(origin, doc.activeElement);
        }
    });

    controller = Object.freeze({
        getSnapshot() {
            return state;
        },

        setVisible(visible, options = {}) {
            if (isDisposed) return;
            if (Boolean(visible) !== state.visible) navigationRevision++;
            const ownedFocus = focus.ownsFocus();
            if (visible) focus.rememberOrigin();
            state = SidePaneState.setVisible(state, visible);
            if (state.parent) rememberBounded(collapsedByParent, parentKeyOf(), !state.visible);
            persistSoon();
            syncDomVisibility(options);
            if (!visible) focus.restoreAfterHide(ownedFocus);
        },

        toggleVisible() {
            if (isDisposed) return;
            this.setVisible(!state.visible);
        },

        /**
         * 展开按钮和 Ctrl/Cmd+Alt+B 共用：已展开就收起；收起时有待审批先看通知，
         * 当前对话没有标签时走新标签页的空状态，否则回到这个对话上次的标签。
         */
        toggleFromUser() {
            if (isDisposed) return;
            if (state.visible) {
                this.setVisible(false);
                return;
            }
            if (Number(expandButton?.dataset.pendingCount) > 0) {
                this.showNotifications();
                return;
            }
            const closable = SidePaneState.getClosableVisibleTabs(state);
            if (closable.length === 0) {
                focus.rememberOrigin();
                launcher.expandFromEmpty();
                return;
            }
            const preferred = state.parent ? activeTabByParent.get(parentKeyOf()) : null;
            const target = closable.find(t => t.id === preferred) || closable[closable.length - 1];
            this.setVisible(true);
            this.activateTab(target.id);
        },

        /** 按标签条上的顺序切到前一个（-1）或后一个（1）标签，首尾相接 */
        cycleTab(delta) {
            if (isDisposed || !state.visible) return;
            const tabs = getStripTabs();
            if (tabs.length < 2) return;
            const index = tabs.findIndex(tab => tab.id === state.activeTabId);
            const next = tabs[(index + (delta < 0 ? -1 : 1) + tabs.length) % tabs.length];
            this.activateTab(next.id);
            strip?.focusTab(next.id);
        },

        showNotifications() {
            if (isDisposed) return;
            navigationRevision++;
            focus.rememberOrigin();
            state = SidePaneState.showNotifications(state);
            if (launcher.hostsNotifications) launcher.renderProfile();
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
        },

        showLauncher() {
            if (isDisposed) return;
            navigationRevision++;
            focus.rememberOrigin();
            state = SidePaneState.showLauncher(state);
            launcher.renderProfile();
            launcher.renderSegment();
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
        },

        /** options.focus 为 false 时只切换，不把焦点挪进标签（后台恢复时用） */
        activateTab(tabId, { focus: moveFocus = true } = {}) {
            if (isDisposed || !tabId) return;
            if (tabId !== SidePaneState.LAUNCHER_TAB_ID
                && !SidePaneState.getVisibleTabs(state, state.parent).some(tab => tab.id === tabId)) return;
            navigationRevision++;
            state = SidePaneState.activateTab(state, tabId);
            if (state.parent && !isNotificationsTab(tabId) && tabId !== SidePaneState.LAUNCHER_TAB_ID) {
                const parentKey = parentKeyOf();
                rememberBounded(activeTabByParent, parentKey, tabId);
                if (state.visible) rememberBounded(collapsedByParent, parentKey, false);
            }
            renderTabList();
            strip?.scrollActiveIntoView();
            syncViewPanels();
            syncDomVisibility();
            if (moveFocus) mountedTabMap.get(tabId)?.handle?.focus?.();
        },

        reorderTab(activeId, overId) {
            if (isDisposed) return;
            const next = SidePaneState.reorderTabs(state, activeId, overId);
            if (next === state) return;
            state = next;
            renderTabList();
        },

        getRecentlyClosedTabs() {
            return recentlyClosedTabs.map(entry => ({ ...entry }));
        },

        async reopenClosedTab(closedId) {
            if (isDisposed || !closedId) return null;
            const index = recentlyClosedTabs.findIndex(entry => entry.id === closedId);
            if (index === -1) return null;
            const [closed] = recentlyClosedTabs.splice(index, 1);
            const handle = await this.openTab({ ...closed.tab, openedAt: Date.now() });
            this.setVisible(true);
            overview?.refresh();
            return handle;
        },

        /** 关掉当前对话里除 tabId 外的标签；别的对话的标签不动 */
        async closeOtherTabs(tabId) {
            if (isDisposed || !tabId) return;
            if (!SidePaneState.getVisibleTabs(state, state.parent).some(t => t.id === tabId)) return;
            const closing = SidePaneState.getClosableVisibleTabs(state).filter(t => t.id !== tabId);
            const revision = ++navigationRevision;
            const keptLifetime = tabCloseOwner.getLifetime(tabId);
            let expectedFocus = doc.activeElement;
            await closeBatch(closing, { collapseWhenEmpty: false }, (before, after) => {
                // Follow our synchronous close handoffs, not an unrelated focus change.
                if (before === expectedFocus) expectedFocus = after;
            });
            if (!isDisposed && navigationRevision === revision && tabCloseOwner.getLifetime(tabId) === keptLifetime) {
                this.activateTab(tabId, { focus: doc.activeElement === expectedFocus });
            }
        },

        /** 关掉当前对话里所有可关的标签，最后一个关掉时面板收起 */
        async closeAllTabs() {
            if (isDisposed) return;
            navigationRevision++;
            await closeBatch(SidePaneState.getClosableVisibleTabs(state));
        },

        /**
         * 话题删掉后，属于它的标签（辅助对话、话题级代码查看等）直接丢弃：不询问、不进最近关闭、不调 onClosed
         * （子话题目录已随父话题一起删了）。不丢的话辅助对话是 keep，会一直挂着渲染器和监听直到重启。
         * 对齐 ZCode useAppPanels.ts 订阅父任务生命周期统一关掉框选副屏标签。
         */
        async discardTabsOfDeletedTopics({ itemId, topicIds } = {}) {
            if (isDisposed || !itemId || !topicIds?.length) return;
            const deleted = new Set(topicIds);
            const orphaned = state.tabs.filter(tab => tab.parent?.itemId === itemId && deleted.has(tab.parent?.topicId));
            if (!orphaned.length) return;
            navigationRevision++;
            await closeBatch(orphaned, { discard: true });
        },

        /**
         * 打开（或激活已打开的）标签。登记了 toTab 的类型可以只传 payload，比如
         * openTab({ kind: 'chat', descriptor })，由类型自己映射成标签并决定落到哪个已有标签上。
         * @param {SidePaneTab | { kind: string }} rawTab
         * @returns {Promise<SidePaneTabHandle | null>}
         */
        async openTab(rawTab) {
            if (isDisposed || !rawTab) return null;
            focus.rememberOrigin();
            const origin = doc.activeElement;
            const definition = getTabType(rawTab.kind);
            const resolved = definition?.toTab ? definition.toTab(rawTab, state.tabs) : rawTab;
            state = SidePaneState.openTab(state, definition ? {
                icon: definition.icon, typeLabel: definition.label, searchHint: definition.searchHint,
                ...resolved
            } : resolved);
            navigationRevision++;
            const targetTabId = String(resolved.id);
            const openedTab = state.tabs.find(t => t.id === targetTabId);
            rememberOpened(SidePaneState.getTabParent(openedTab), targetTabId);
            renderTabList();

            const mounting = ensureTabMounted(targetTabId, {
                provider: providers[rawTab.kind],
                payload: rawTab,
                onClosed: definition?.onClosed,
                ariaLabel: resolved.title || '副屏视图'
            });
            // 标签条已经切过去了，面板和内容区同一刻跟上，不等挂载完（慢的挂载期间不会是新标签配旧内容、或标签亮着面板却收着）
            syncViewPanels();
            syncDomVisibility();
            const entry = await mounting;
            return finishOpen(targetTabId, entry, origin);
        },

        /**
         * 在后台补回标签（比如切到话题后才读回来的辅助对话）：不抢激活、不挂载，也不改这个对话记下的收起状态。
         * 切到这个对话时它还一个标签都没有，面板按「没有标签」自动收起了；补回之后照切换时本该有的样子重新定一次：
         * 回到上次停的标签、按记下的收起状态展开或收起。期间用户自己动过面板就不再改。
         * @param {Array<SidePaneTab | { kind: string }>} rawTabs
         * @returns {Promise<string[]>} 补进来的标签 id；其中有标签因此显示出来时，等它挂好
         */
        async restoreTabs(rawTabs = []) {
            if (isDisposed) return [];
            const ownTabsBefore = state.parent
                ? state.tabs.filter(tab => SidePaneState.matchesConversation(SidePaneState.getTabParent(tab), state.parent))
                : [];
            const untouchedFallback = state.parent && ownTabsBefore.length === 0 && !state.visible
                && isNotificationsTab(state.activeTabId);
            // 启动时布局先恢复、辅助对话后补回：这时面板落在全局工具或随布局恢复的本话题标签（比如计划）上，
            // 但只要补回的是这个对话上次停的标签、期间没人动过面板，也照样回到它
            const untouchedSinceParent = state.parent && navigationRevision === parentResolvedRevision;
            const added = [];
            for (const rawTab of rawTabs) {
                if (!rawTab) continue;
                const definition = getTabType(rawTab.kind);
                let resolved;
                try {
                    resolved = definition?.toTab ? definition.toTab(rawTab, state.tabs) : rawTab;
                } catch (error) {
                    console.error('[SidePaneController] Failed to restore tab:', error);
                    continue;
                }
                const next = SidePaneState.restoreTabs(state, [definition ? {
                    icon: definition.icon, typeLabel: definition.label, searchHint: definition.searchHint,
                    ...resolved
                } : resolved]);
                if (next === state) continue;
                state = next;
                added.push(String(resolved.id));
            }
            if (added.length === 0) return added;
            navigationRevision++;
            const key = state.parent ? parentKeyOf() : '';
            if (untouchedFallback || (untouchedSinceParent && added.includes(activeTabByParent.get(key)))) {
                state = SidePaneState.setParent(state, state.parent, {
                    force: true,
                    preferredTabId: activeTabByParent.get(key),
                    collapsedPreference: collapsedByParent.get(key)
                });
            }
            // 后台补标签不算用户操作
            if (untouchedSinceParent) parentResolvedRevision = navigationRevision;
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
            const mounting = pendingTabMounts.get(state.activeTabId);
            if (mounting && added.includes(state.activeTabId)) await mounting.promise.catch(() => null);
            return added;
        },

        /** 改已打开标签的标题或 payload（关掉后重新打开时用新的 payload），不切换标签 */
        updateTab(tabId, patch = {}) {
            if (isDisposed || !tabId) return;
            const next = SidePaneState.updateTab(state, tabId, patch);
            if (next === state) return;
            persistSoon();
            const titleChanged = next.tabs.find(t => t.id === tabId)?.title !== state.tabs.find(t => t.id === tabId)?.title;
            state = next;
            if (!titleChanged) return;
            const title = state.tabs.find(t => t.id === tabId).title;
            mountedTabMap.get(tabId)?.viewElement?.setAttribute?.('aria-label', title);
            renderTabList();
        },

        getTabHandle(tabId) {
            if (isDisposed || !tabId) return null;
            return mountedTabMap.get(tabId)?.handle || null;
        },

        /** 诊断用：哪些标签挂着视图，哪些在休眠（为什么、从什么时候） */
        getViewResidency() {
            return {
                live: [...mountedTabMap.keys()],
                dormant: [...dormantTabs].map(([tabId, { reason, since }]) => ({ tabId, reason, since }))
            };
        },

        /**
         * 给 VCPLifecycleInspector：每个标签的视图在不在、是否可见、隐藏了多久，
         * 以及它的 view scope（含 provider 挂在下面的子 scope）还挂着多少监听、定时器、Observer；不含标题和内容
         */
        getDiagnostics() {
            const at = now();
            return {
                visible: state.visible,
                tabs: state.tabs.map(tab => {
                    const dormant = dormantTabs.get(tab.id);
                    const times = viewTimes.get(tab.id);
                    return {
                        id: tab.id,
                        kind: tab.kind,
                        view: mountedTabMap.has(tab.id) ? 'live' : (dormant ? 'dormant' : (pendingTabMounts.has(tab.id) ? 'mounting' : 'unmounted')),
                        visible: occurrences.get(tab.id)?.occurrence.isVisible() === true,
                        hiddenMs: times?.hiddenSince != null ? at - times.hiddenSince : null,
                        dormantReason: dormant?.reason || null,
                        // 视图没挂着（休眠或未挂载）时为 null；挂着时按资源类型计数
                        resources: occurrences.get(tab.id)?.view?.resourceSummary?.() || null
                    };
                })
            };
        },

        /**
         * 登记一个"打开标签页"入口，新增菜单和引导页都会列出它。返回注销函数。
         * entry: { id, label, icon?, order?, open(), isAvailable?() }
         */
        registerOpenTabEntry(entry) {
            if (isDisposed) return () => {};
            return launcher.registerEntry(entry);
        },

        /** 入口的可用状态变了（比如当前窗口不支持某能力）时调用，重新渲染菜单和引导页 */
        refreshOpenTabEntries() {
            if (!isDisposed) launcher.renderEntries();
        },

        /** provider() 返回 { name, avatarUrl, onEditAvatar?, onRename?(name) } 或 null（不显示） */
        setLauncherProfileProvider(provider) {
            launcher.setProfileProvider(provider);
        },

        /** provider() 返回 [{ id, label, title?, open(), mountIcon?(button, iconHost) }]；不设置时只有工具页 */
        setLauncherAppsProvider(provider) {
            launcher.setAppsProvider(provider);
        },

        /** 工具页下方「推荐」：provider() 同应用页的条目；onSettings 时标题旁出现设置按钮 */
        setLauncherRecommendedProvider(provider, options) {
            launcher.setRecommendedProvider(provider, options);
        },

        refreshLauncherRecommended() {
            launcher.refreshRecommended();
        },

        registerProvider(name, provider) {
            if (isDisposed) return;
            providers[name] = provider;
        },

        /**
         * One declaration owns a tab kind's provider, launcher entry and presentation.
         * @param {SidePaneTabType} definition
         * @returns {() => void} unregister
         */
        registerTabType: tabRegistry.registerTabType,

        getTabType,

        /**
         * 读回上次的布局：已登记、允许持久化的标签补回标签条（第一次显示时才挂载），
         * 上次停在这些标签上就回到那里（展开状态也照旧），每个对话的激活标签和收起状态补进记忆。
         * 要在登记完标签类型之后调用。
         */
        restoreLayout() {
            if (isDisposed || layoutRestored || !layoutStore) return false;
            layoutRestored = true;
            const layout = parseLayout(layoutStore.load(), canPersistKind);
            if (!layout) return false;
            state = SidePaneState.restoreTabs(state, layout.tabs);
            if (layout.activeTabId) {
                state = SidePaneState.activateTab(state, layout.activeTabId);
                if (layout.visible) state = SidePaneState.setVisible(state, true);
            }
            layout.collapsedByParent.forEach((collapsed, key) => {
                if (!collapsedByParent.has(key)) rememberBounded(collapsedByParent, key, collapsed);
            });
            // 不按已恢复的标签过滤：辅助对话不进布局存档，要等读回话题后才补回来，到时还要回到它
            layout.activeByParent.forEach((tabId, key) => {
                if (!activeTabByParent.has(key)) rememberBounded(activeTabByParent, key, tabId);
            });
            if (state.parent) {
                const key = parentKeyOf();
                state = SidePaneState.setParent(state, state.parent, {
                    force: true,
                    preferredTabId: activeTabByParent.get(key),
                    collapsedPreference: collapsedByParent.get(key)
                });
            }
            parentResolvedRevision = navigationRevision;
            renderTabList();
            syncViewPanels();
            // 启动时直接落到存档的开合状态，不播动画
            syncDomVisibility({ animate: false });
            return true;
        },

        closeTab(tabId, options = {}) {
            if (state.tabs.some(tab => tab.id === tabId && tab.closable !== false)) navigationRevision++;
            return tabCloseOwner.closeTab(tabId, options);
        },

        setParent(parentRef) {
            if (isDisposed) return;
            const previousParent = state.parent;
            // 切走前记下当前对话的激活标签和展开状态
            if (state.parent) {
                const prevKey = parentKeyOf();
                if (state.activeTabId && !isNotificationsTab(state.activeTabId) && state.activeTabId !== SidePaneState.LAUNCHER_TAB_ID) {
                    rememberBounded(activeTabByParent, prevKey, state.activeTabId);
                }
                rememberBounded(collapsedByParent, prevKey, !state.visible);
            }

            const nextKey = parentRef ? SidePaneState.getParentKey(parentRef) : '';
            const ownedFocus = focus.ownsFocus();
            const wasVisible = state.visible;
            state = SidePaneState.setParent(state, parentRef, {
                preferredTabId: activeTabByParent.get(nextKey),
                collapsedPreference: collapsedByParent.get(nextKey)
            });
            if (state.parent !== previousParent) {
                navigationRevision++;
                // 入口是否可用可能取决于当前对话（群聊里不能开辅助对话），换对话时重新列一遍
                launcher.renderEntries();
            }
            parentResolvedRevision = navigationRevision;
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
            if (wasVisible && !state.visible) focus.restoreAfterHide(ownedFocus);
        },

        // 不大于 1 的数是比例，否则是像素
        setPreferredWidth(width) {
            if (isDisposed) return;
            if (typeof width === 'number') {
                if (width > 0 && width <= 1) visibility.setRatio(width);
                else if (width > 1) visibility.setRatioFromWidth(width);
            }
            state = SidePaneState.setPreferredWidth(state, width);
            if (state.visible && !visibility.isAnimating()) visibility.writeWidth();
        },

        async dispose() {
            if (isDisposed) return;
            isDisposed = true;
            cancelDormancyCheck?.();
            viewTimes.clear();
            dormantTabs.clear();
            visibility.dispose();
            cleanupListeners.forEach(cleanup => cleanup());
            cleanupListeners.length = 0;
            resizerOwner?.dispose?.();
            focus.dispose();
            layoutStore?.dispose();

            const disposePromises = [];
            mountedTabMap.forEach((entry, tabId) => {
                disposePromises.push(tabCloseOwner.disposeEntry(tabId, entry));
                entry.viewElement?.remove?.();
            });
            mountedTabMap.clear();
            for (const tabId of [...failedMounts.keys()]) clearMountFailure(tabId);
            for (const tabId of pendingTabMounts.keys()) cancelPendingMount(tabId);
            tabRegistry.dispose();
            await Promise.allSettled([...disposePromises, tabCloseOwner.dispose()]);
            occurrences.clear();
            await rootScope.dispose('side-pane-disposed').catch(error => {
                console.error('[SidePaneController] Failed to release side pane scope:', error);
            });
        }
    });

    // ---- 标题栏与面板里的按钮 ----
    if (toggleNotificationsBtn && !electronAPI?.sendToggleNotificationsSidebar) {
        const onNotifClick = () => {
            if (state.visible && isNotificationsTab(state.activeTabId)) controller.setVisible(false);
            else controller.showNotifications();
        };
        toggleNotificationsBtn.addEventListener('click', onNotifClick);
        cleanupListeners.push(() => toggleNotificationsBtn.removeEventListener('click', onNotifClick));
    }

    if (expandButton) {
        const onExpandClick = () => controller.toggleFromUser();
        expandButton.addEventListener('click', onExpandClick);
        cleanupListeners.push(() => expandButton.removeEventListener('click', onExpandClick));
    }

    const shortcuts = createSidePaneShortcuts({
        win,
        root,
        onToggle: () => controller.toggleFromUser(),
        onCycleTab: delta => controller.cycleTab(delta)
    });
    cleanupListeners.push(() => shortcuts.dispose());

    if (closeSidePaneBtn) {
        const onCloseClick = () => controller.setVisible(false);
        closeSidePaneBtn.addEventListener('click', onCloseClick);
        cleanupListeners.push(() => closeSidePaneBtn.removeEventListener('click', onCloseClick));
    }

    // 窗口缩放停下后：对话区太窄就收起面板，否则把宽度换回百分比
    let windowResizeTimer = null;
    const onWindowResize = () => {
        if (isDisposed) return;
        if (windowResizeTimer) clearTimeout(windowResizeTimer);
        windowResizeTimer = setTimeout(() => {
            windowResizeTimer = null;
            if (isDisposed || !state.visible) return;
            const mainWidthPx = doc.querySelector('.main-content')?.getBoundingClientRect?.()?.width ?? null;
            if (mainWidthPx !== null && mainWidthPx < CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX) {
                controller.setVisible(false);
            } else {
                visibility.ensurePercentWidth();
            }
        }, CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS);
    };
    win?.addEventListener?.('resize', onWindowResize, { passive: true });
    // 窗口最小化或切到别处时，当前标签也算不可见，跟着它的轮询一起停
    if (doc?.addEventListener) rootScope.listen(doc, 'visibilitychange', syncOccurrenceVisibility, undefined, 'document-visibility');
    cleanupListeners.push(() => {
        if (windowResizeTimer) clearTimeout(windowResizeTimer);
        win?.removeEventListener?.('resize', onWindowResize);
    });

    openTabEntries.forEach(entry => controller.registerOpenTabEntry(entry));
    initialTabTypes.forEach(definition => controller.registerTabType(definition));

    // Initial render
    launcher.renderEntries();
    renderTabList();
    overview?.render();
    syncViewPanels();
    syncDomVisibility({ animate: false });

    if (scope && typeof scope.own === 'function') {
        scope.own(controller, 'side-pane-controller');
    }

    return controller;
}

const api = Object.freeze({ createSidePaneController });

if (typeof globalThis !== 'undefined') {
    globalThis.VCPSidePaneController = api;
}

export default api;
