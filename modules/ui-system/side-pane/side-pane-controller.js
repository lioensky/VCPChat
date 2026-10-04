/* Host controller for Workspace Side Pane, managing tabs, views, and provider lifecycles. */
'use strict';

import * as SidePaneState from './side-pane-state.js';
import { createSidePaneResizerOwner } from './side-pane-resizer-owner.js';
import { createSidePaneVisibility } from './side-pane-visibility.js';
import { createSidePaneTabStrip } from './side-pane-tab-strip.js';
import { createSidePaneTabOverview } from './side-pane-tab-overview.js';
import { createSidePaneTabMenu } from './side-pane-tab-menu.js';
import { createSidePaneLauncher } from './side-pane-launcher.js';

// 对话区窄于这个宽度时自动收起面板（ZCode WorkspaceShellLayout.tsx:481-525）
const CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX = 480;
const CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS = 300;
const RECENTLY_CLOSED_LIMIT = 10;

export function createSidePaneController({
    root,
    resizerHandle,
    tabListElement,
    contentContainer,
    toggleNotificationsBtn = null,
    toggleChatBtn = null,
    closeSidePaneBtn = null,
    addChatTabBtn = null,
    overviewBtn = null,
    overviewPopover = null,
    settingsRef = null,
    electronAPI = null,
    scope = null,
    providers = {},
    openTabEntries = [],
    onOpenSideChat = null,
    onTabClosed = null,
    onRestoreSessions = null,
    onLauncherAddress = null
}) {
    if (!root) {
        throw new TypeError('SidePaneController requires a root element');
    }

    const doc = root.ownerDocument || globalThis.document;
    const win = doc?.defaultView || globalThis.window;
    const resolvedAddChatTabBtn = addChatTabBtn || doc.getElementById?.('addSidePaneChatBtn');
    const resolvedOverviewBtn = overviewBtn || doc.getElementById?.('sidePaneTabOverviewBtn');
    const resolvedOverviewPopover = overviewPopover || doc.getElementById?.('sidePaneTabOverviewPopover');
    const resolvedTabContextMenu = doc.getElementById?.('sidePaneTabContextMenu');

    const initialWidth = Number(settingsRef?.get?.()?.notificationsSidebarWidth) || SidePaneState.DEFAULT_WIDTH;

    let state = SidePaneState.createInitialSidePaneState({
        preferredWidth: initialWidth,
        visible: root.classList.contains('active') || root.getAttribute('aria-hidden') === 'false'
    });

    const mountedTabMap = new Map(); // tabId -> { tab | descriptor, viewElement, handle }
    const pendingTabMounts = new Map(); // tabId -> Promise<entry | null>
    const pendingChatOpens = new Map(); // childKey -> Promise<handle>
    const cleanupListeners = [];
    const recentlyClosedTabs = [];
    const tabTypes = new Map();
    const getTabType = kind => tabTypes.get(kind) || null;
    const collapsedByParent = new Map(); // parentKey -> boolean
    const activeTabByParent = new Map(); // parentKey -> tabId
    let isDisposed = false;
    let controller = null;

    const isNotificationsTab = (tabId) => tabId === SidePaneState.NOTIFICATIONS_TAB_ID;
    const isClosableTab = (tab) => !isNotificationsTab(tab.id) && tab.closable !== false;
    const parentKeyOf = () => (state.parent ? SidePaneState.getParentKey(state.parent) : '');

    // ---- 开合与宽度 ----
    function syncHeaderButtons(isVisible) {
        const isNotifActive = isVisible && isNotificationsTab(state.activeTabId);
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
        doc.getElementById('notificationsSidebar')?.classList.toggle('active', isNotifActive);

        // 展开按钮只在面板收起时出现；面板里有自己的收起按钮
        if (toggleChatBtn) {
            toggleChatBtn.hidden = isVisible;
            toggleChatBtn.setAttribute('aria-expanded', String(isVisible));
        }
    }

    // 旧键 notificationsSidebarRatio 曾按整个窗口宽度算（父元素 display: contents 时测出 0），存下的值偏小，直接弃用
    const visibility = createSidePaneVisibility({
        root,
        resizerHandle,
        initialRatio: Number(settingsRef?.get?.()?.sidePaneWidthRatio),
        onSync: syncHeaderButtons
    });
    const syncDomVisibility = (options = {}) => visibility.sync(state.visible, options);

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
        addButton: resolvedAddChatTabBtn,
        onLauncherAddress,
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

    // VCPLog 连接状态不单独占一行：通知标签和新标签页的通知分类上各一个小圆点，悬停/读屏给出全文
    const connectionStatusEl = doc.getElementById('vcpLogConnectionStatus');
    const readConnectionStatus = () => (connectionStatusEl ? {
        status: connectionStatusEl.dataset.status || 'unknown',
        text: connectionStatusEl.querySelector('.notifications-status-text')?.textContent.trim() || ''
    } : null);

    if (tabListElement) {
        strip = createSidePaneTabStrip({
            tabListElement,
            addButton: resolvedAddChatTabBtn,
            getTabs: getStripTabs,
            getTabType,
            getActiveTabId: () => state.activeTabId,
            isClosable: isClosableTab,
            statusTabId: SidePaneState.NOTIFICATIONS_TAB_ID,
            getStatus: readConnectionStatus,
            onActivate: (tabId) => controller.activateTab(tabId),
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
            getRecentlyClosed: () => recentlyClosedTabs,
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
            focusTab: (tabId) => strip?.focusTab(tabId),
            onAction: async (action, tabId) => {
                if (action === 'close-tab' && tabId) await controller.closeTab(tabId);
                else if (action === 'close-others' && tabId) await controller.closeOtherTabs(tabId);
                else if (action === 'close-all') await controller.closeAllTabs();
            }
        });
        cleanupListeners.push(() => tabMenu.dispose());
    }

    function syncConnectionStatus() {
        launcher.syncStatus(readConnectionStatus());
        strip?.syncStatus();
    }

    if (connectionStatusEl && typeof win.MutationObserver === 'function') {
        const statusObserver = new win.MutationObserver(syncConnectionStatus);
        statusObserver.observe(connectionStatusEl, { attributes: true, attributeFilter: ['data-status'], childList: true, characterData: true, subtree: true });
        cleanupListeners.push(() => statusObserver.disconnect());
    }

    function renderTabList() {
        strip?.render();
        launcher.syncStatus(readConnectionStatus());
    }

    function syncViewPanels() {
        if (!contentContainer) return;
        const visibleTabIds = new Set(SidePaneState.getVisibleTabs(state, state.parent).map(t => t.id));
        visibleTabIds.add(SidePaneState.LAUNCHER_TAB_ID);
        const activeViewId = launcher.hostsNotifications && isNotificationsTab(state.activeTabId)
            ? SidePaneState.LAUNCHER_TAB_ID
            : state.activeTabId;
        contentContainer.querySelectorAll('.side-pane-view').forEach(view => {
            const viewTabId = view.getAttribute('data-tab-id') || (
                view.id === 'sidePaneViewNotifications' ? SidePaneState.NOTIFICATIONS_TAB_ID : null
            );
            const isActive = visibleTabIds.has(viewTabId) && viewTabId === activeViewId;
            view.classList.toggle('active', isActive);
            view.hidden = !isActive;
        });
        if (launcher.hostsNotifications) launcher.syncSections();
    }

    // ---- 标签视图挂载 ----
    // 同一个 tabId 只挂一次：并发打开时后来的调用等同一次挂载；挂载期间标签被关掉或控制器被销毁时，把刚挂上的拆掉
    function ensureTabMounted(tabId, { provider, payload, fields, ariaLabel = null, onMounted = null }) {
        const mounted = mountedTabMap.get(tabId);
        if (mounted) return Promise.resolve(mounted);
        if (pendingTabMounts.has(tabId)) return pendingTabMounts.get(tabId);

        const mounting = (async () => {
            let view = contentContainer?.querySelector(`[data-tab-id="${tabId}"]`);
            if (!view && contentContainer) {
                view = doc.createElement('section');
                view.className = 'side-pane-view';
                view.setAttribute('data-tab-id', tabId);
                view.setAttribute('role', 'tabpanel');
                if (ariaLabel) view.setAttribute('aria-label', ariaLabel);
                contentContainer.appendChild(view);
            }
            if (!view) return null;

            const handle = provider?.mountTab ? await provider.mountTab(payload, view) : null;
            if (isDisposed || !state.tabs.some(t => t.id === tabId)) {
                await handle?.dispose?.();
                view.remove?.();
                return null;
            }
            const entry = { ...fields, viewElement: view, handle };
            mountedTabMap.set(tabId, entry);
            if (handle) onMounted?.(handle);
            return entry;
        })();

        pendingTabMounts.set(tabId, mounting);
        mounting.then(
            () => pendingTabMounts.delete(tabId),
            () => pendingTabMounts.delete(tabId)
        );
        return mounting;
    }

    // 打开的标签属于当前对话时，记下它是这个对话的激活标签，且面板展开
    function rememberOpened(parentRef, tabId) {
        if (!state.parent || !SidePaneState.matchesConversation(parentRef, state.parent)) return;
        const parentKey = parentKeyOf();
        collapsedByParent.set(parentKey, false);
        activeTabByParent.set(parentKey, tabId);
    }

    function finishOpen(entry) {
        if (isDisposed) return null;
        syncViewPanels();
        syncDomVisibility();
        entry?.handle?.focus?.();
        return entry?.handle || null;
    }

    // ZCode parity (useAppPanels.ts:1334): 临时的辅助对话不进“最近关闭”，其他标签都能重新打开
    function rememberClosed(tabObj, tabDesc) {
        const isEphemeralChat = tabObj.kind === 'chat' || tabObj.type === 'selection-side-chat' || tabDesc?.ephemeral;
        if (isEphemeralChat || tabObj.reopenable === false) return;
        const { openedAt, ...reopenable } = tabObj;
        const previous = recentlyClosedTabs.findIndex(entry => entry.id === tabObj.id);
        if (previous !== -1) recentlyClosedTabs.splice(previous, 1);
        recentlyClosedTabs.unshift({ id: tabObj.id, title: tabObj.title || '标签页', tab: reopenable, closedAt: Date.now() });
        if (recentlyClosedTabs.length > RECENTLY_CLOSED_LIMIT) recentlyClosedTabs.pop();
    }

    controller = Object.freeze({
        getSnapshot() {
            return state;
        },

        setVisible(visible, options = {}) {
            if (isDisposed) return;
            state = SidePaneState.setVisible(state, visible);
            if (state.parent) collapsedByParent.set(parentKeyOf(), !state.visible);
            syncDomVisibility(options);
            if (!visible) {
                const trigger = toggleChatBtn || toggleNotificationsBtn || doc.getElementById('toggleSidePaneChatBtn') || doc.getElementById('closeSidePaneBtn');
                trigger?.focus?.();
            }
        },

        toggleVisible() {
            if (isDisposed) return;
            this.setVisible(!state.visible);
        },

        showNotifications() {
            if (isDisposed) return;
            state = SidePaneState.showNotifications(state);
            if (launcher.hostsNotifications) launcher.renderProfile();
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
        },

        showLauncher() {
            if (isDisposed) return;
            state = SidePaneState.showLauncher(state);
            launcher.renderProfile();
            launcher.renderSegment();
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
        },

        activateTab(tabId) {
            if (isDisposed || !tabId) return;
            state = SidePaneState.activateTab(state, tabId);
            if (state.parent && !isNotificationsTab(tabId) && tabId !== SidePaneState.LAUNCHER_TAB_ID) {
                const parentKey = parentKeyOf();
                activeTabByParent.set(parentKey, tabId);
                if (state.visible) collapsedByParent.set(parentKey, false);
            }
            renderTabList();
            strip?.scrollActiveIntoView();
            syncViewPanels();
            syncDomVisibility();
            mountedTabMap.get(tabId)?.handle?.focus?.();
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
            for (const tab of closing) {
                await this.closeTab(tab.id, { collapseWhenEmpty: false });
            }
            this.activateTab(tabId);
        },

        /** 关掉当前对话里所有可关的标签，最后一个关掉时面板收起 */
        async closeAllTabs() {
            if (isDisposed) return;
            for (const tab of SidePaneState.getClosableVisibleTabs(state)) {
                await this.closeTab(tab.id);
            }
        },

        async openTab(rawTab) {
            if (isDisposed || !rawTab) return null;
            if (rawTab.kind === 'chat' && rawTab.descriptor) {
                return await this.openChat(rawTab.descriptor);
            }

            const definition = getTabType(rawTab.kind);
            state = SidePaneState.openTab(state, definition ? {
                icon: definition.icon, typeLabel: definition.label, searchHint: definition.searchHint,
                ...rawTab
            } : rawTab);
            const targetTabId = state.activeTabId;
            rememberOpened(SidePaneState.getTabParent(rawTab), targetTabId);
            renderTabList();

            const entry = await ensureTabMounted(targetTabId, {
                provider: providers[rawTab.kind],
                payload: rawTab,
                fields: { tab: rawTab },
                ariaLabel: rawTab.title || '副屏视图'
            });
            return finishOpen(entry);
        },

        async openChat(descriptor) {
            if (isDisposed || !descriptor) return null;
            // 同一个子话题正在打开时直接等它，不重复建标签
            const childKey = `${descriptor.child?.itemId || ''}:${descriptor.child?.topicId || descriptor.id}`;
            if (pendingChatOpens.has(childKey)) {
                return await pendingChatOpens.get(childKey);
            }

            const opening = (async () => {
                state = SidePaneState.openChatTab(state, descriptor);
                const targetTabId = state.activeTabId;
                rememberOpened(descriptor.parent, targetTabId);
                renderTabList();

                const entry = await ensureTabMounted(targetTabId, {
                    provider: providers.chat,
                    payload: descriptor,
                    fields: { descriptor }
                });
                return finishOpen(entry);
            })();

            pendingChatOpens.set(childKey, opening);
            try {
                return await opening;
            } finally {
                pendingChatOpens.delete(childKey);
            }
        },

        /** 改已打开标签的标题或 payload（关掉后重新打开时用新的 payload），不切换标签 */
        updateTab(tabId, patch = {}) {
            if (isDisposed || !tabId) return;
            const next = SidePaneState.updateTab(state, tabId, patch);
            if (next === state) return;
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

        setLauncherAddressHandler(handler) {
            launcher.setAddressHandler(handler);
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

        /** One declaration owns a tab kind's provider, launcher entry and presentation. */
        registerTabType(definition) {
            if (isDisposed) return () => {};
            if (!definition || typeof definition.kind !== 'string' || !definition.kind
                || typeof definition.label !== 'string' || !definition.label) {
                throw new TypeError('registerTabType requires { kind, label, provider?, entry? }');
            }
            const stored = Object.freeze({ ...definition });
            const unregisterEntry = stored.entry ? launcher.registerEntry({
                id: stored.kind, label: stored.label, icon: stored.icon, ...stored.entry
            }) : () => {};
            tabTypes.set(stored.kind, stored);
            if (stored.provider) providers[stored.kind] = stored.provider;
            renderTabList();
            overview?.refresh();
            return () => {
                unregisterEntry();
                if (tabTypes.get(stored.kind) !== stored) return;
                tabTypes.delete(stored.kind);
                if (providers[stored.kind] === stored.provider) delete providers[stored.kind];
                if (!isDisposed) { renderTabList(); overview?.refresh(); }
            };
        },

        getTabType,

        async closeTab(tabId, options = {}) {
            if (isDisposed || !tabId || isNotificationsTab(tabId)) return;
            const entry = mountedTabMap.get(tabId);
            const tabDesc = entry?.descriptor || state.tabs.find(t => t.id === tabId)?.descriptor || null;
            let updatedTabDesc = tabDesc ? { ...tabDesc } : null;
            if (entry) {
                const closeResult = await entry.handle?.requestClose?.();
                if (closeResult && closeResult.closed === false) {
                    return; // 用户或进行中的操作拦下了关闭
                }
                // provider 拆不干净也要让标签关掉，不能卡在标签条上
                try {
                    await entry.handle?.dispose?.();
                } catch (error) {
                    console.error(`[SidePaneController] Failed to dispose tab "${tabId}":`, error);
                }
                entry.viewElement?.remove?.();
                mountedTabMap.delete(tabId);
            }
            if (updatedTabDesc && typeof onTabClosed === 'function') {
                try { await onTabClosed(updatedTabDesc); } catch {}
            }

            const tabObj = state.tabs.find(t => t.id === tabId);
            if (tabObj) rememberClosed(tabObj, updatedTabDesc);

            const wasVisible = state.visible;
            state = SidePaneState.closeTab(state, tabId, options);
            if (state.parent) {
                const parentKey = parentKeyOf();
                if (wasVisible && !state.visible) {
                    collapsedByParent.set(parentKey, true);
                    activeTabByParent.delete(parentKey);
                } else if (activeTabByParent.get(parentKey) === tabId) {
                    activeTabByParent.set(parentKey, state.activeTabId);
                }
            }

            renderTabList();
            syncViewPanels();
            syncDomVisibility();
            strip?.focusTab(state.activeTabId);
        },

        setParent(parentRef) {
            if (isDisposed) return;
            // 切走前记下当前对话的激活标签和展开状态
            if (state.parent) {
                const prevKey = parentKeyOf();
                if (state.activeTabId && !isNotificationsTab(state.activeTabId) && state.activeTabId !== SidePaneState.LAUNCHER_TAB_ID) {
                    activeTabByParent.set(prevKey, state.activeTabId);
                }
                collapsedByParent.set(prevKey, !state.visible);
            }

            const nextKey = parentRef ? SidePaneState.getParentKey(parentRef) : '';
            state = SidePaneState.setParent(state, parentRef, {
                preferredTabId: activeTabByParent.get(nextKey),
                collapsedPreference: collapsedByParent.get(nextKey)
            });
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
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

        async openSideChat(opts = {}) {
            if (isDisposed) return null;
            if (typeof onOpenSideChat === 'function') {
                return await onOpenSideChat(opts);
            }
            return null;
        },

        async restoreSessions(agentId, parentTopicId) {
            if (isDisposed || !agentId) return [];
            if (typeof onRestoreSessions === 'function') {
                return await onRestoreSessions(agentId, parentTopicId);
            }
            return [];
        },

        async dispose() {
            if (isDisposed) return;
            isDisposed = true;
            visibility.dispose();
            cleanupListeners.forEach(cleanup => cleanup());
            cleanupListeners.length = 0;
            resizerOwner?.dispose?.();

            const disposePromises = [];
            mountedTabMap.forEach((entry) => {
                if (entry.handle?.dispose) {
                    disposePromises.push(Promise.resolve().then(() => entry.handle.dispose()));
                }
                entry.viewElement?.remove?.();
            });
            mountedTabMap.clear();
            tabTypes.clear();
            await Promise.allSettled(disposePromises);
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

    if (toggleChatBtn) {
        const onExpandClick = () => {
            if (state.visible) {
                controller.setVisible(false);
                return;
            }
            // 有待审批时直接打开通知，免得审批被标签页挡住
            if (Number(toggleChatBtn.dataset.pendingCount) > 0) {
                controller.showNotifications();
                return;
            }
            const closable = SidePaneState.getClosableVisibleTabs(state);
            if (closable.length === 0) {
                launcher.expandFromEmpty();
                return;
            }
            const preferred = state.parent ? activeTabByParent.get(parentKeyOf()) : null;
            const target = closable.find(t => t.id === preferred) || closable[closable.length - 1];
            controller.activateTab(target.id);
            controller.setVisible(true);
        };
        toggleChatBtn.addEventListener('click', onExpandClick);
        cleanupListeners.push(() => toggleChatBtn.removeEventListener('click', onExpandClick));
    }

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
    cleanupListeners.push(() => {
        if (windowResizeTimer) clearTimeout(windowResizeTimer);
        win?.removeEventListener?.('resize', onWindowResize);
    });

    openTabEntries.forEach(entry => controller.registerOpenTabEntry(entry));

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
