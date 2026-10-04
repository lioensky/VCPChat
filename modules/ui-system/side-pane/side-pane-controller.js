/* Host controller for Workspace Side Pane, managing tabs, views, and provider lifecycles. */
'use strict';

import * as SidePaneState from './side-pane-state.js';
import { createSidePaneResizerOwner } from './side-pane-resizer-owner.js';
import { createTabSortable } from './side-pane-tab-dnd.js';
import {
    buildSearchFields,
    filterAndRankSearchItems,
    formatRelativeTime,
    getTabIconName,
    getTabSearchHint,
    getTabTypeLabel,
    normalizeSearchQuery,
    resolveTabsOverflow
} from './side-pane-tab-utils.js';

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

    // ZCode parity: Proportional width ratio (sidePaneLayout.ts: SIDE_PANE_DEFAULT_EXPANDED_RATIO = 0.45)
    const ZCODE_DEFAULT_EXPANDED_RATIO = 0.45;
    const MIN_RATIO = 0.20;
    const MAX_RATIO = 0.65;

    const savedRatio = Number(settingsRef?.get?.()?.notificationsSidebarRatio);
    let currentRatio = (Number.isFinite(savedRatio) && savedRatio >= MIN_RATIO && savedRatio <= MAX_RATIO)
        ? savedRatio
        : ZCODE_DEFAULT_EXPANDED_RATIO;

    const initialWidth = Number(settingsRef?.get?.()?.notificationsSidebarWidth)
        || SidePaneState.DEFAULT_WIDTH;

    function getFormattedPercent() {
        return `${(currentRatio * 100).toFixed(1)}%`;
    }

    let state = SidePaneState.createInitialSidePaneState({
        preferredWidth: initialWidth,
        visible: root.classList.contains('active') || root.getAttribute('aria-hidden') === 'false'
    });

    const mountedTabMap = new Map(); // tabId -> { provider, viewElement, tabElement, handle }
    const pendingMountMap = new Map(); // childKey -> Promise<handle>
    const childDraftsMap = new Map(); // childKey -> { draft: string, references: Array }
    const cleanupListeners = [];
    const recentlyClosedTabs = [];
    const collapsedByParent = new Map(); // parentKey -> boolean
    const activeTabByParent = new Map(); // parentKey -> tabId
    let isDisposed = false;
    const openTabEntryMap = new Map(); // entryId -> { id, label, icon, order, seq, open, isAvailable }
    let openTabEntrySeq = 0;

    function getAvailableOpenTabEntries() {
        return Array.from(openTabEntryMap.values())
            .filter(entry => {
                try { return entry.isAvailable?.() !== false; } catch { return false; }
            })
            .sort((a, b) => a.order - b.order || a.seq - b.seq);
    }
    let contextTargetTabId = null;
    let tabSortable = null;

    // Resizer Owner
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
                const parent = root.parentElement || doc.querySelector('#nextUiMainPanel, .container') || doc.body;
                const parentWidth = parent?.getBoundingClientRect?.()?.width || win?.innerWidth || 1200;
                if (parentWidth > 0) {
                    currentRatio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, width / parentWidth));
                    root.style.width = getFormattedPercent();
                }
                if (settingsRef?.set) {
                    const current = settingsRef.get() || {};
                    settingsRef.set({
                        ...current,
                        notificationsSidebarWidth: width,
                        notificationsSidebarRatio: currentRatio
                    });
                }
                if (electronAPI?.saveSettings) {
                    try {
                        const ops = [
                            { op: 'set', path: ['notificationsSidebarWidth'], value: width },
                            { op: 'set', path: ['notificationsSidebarRatio'], value: currentRatio }
                        ];
                        await electronAPI.saveSettings({ __vcpSettingsOps: ops });
                    } catch (err) {
                        console.error('[SidePaneController] Failed to persist width:', err);
                    }
                }
            },
            scope
        });
    }

    // ---- 标签条：悬停提示 / 溢出布局 / 拖拽排序（对齐 ZCode SidePaneTabTitleTooltip、AnimatedSidePanePanel、SortableSidePaneTabTrigger） ----
    const TAB_TOOLTIP_DELAY_MS = 1500;
    let tabTooltipEl = null;
    let tabTooltipTimer = null;
    let tabDragging = false;

    function hideTabTooltip() {
        if (tabTooltipTimer) {
            win.clearTimeout(tabTooltipTimer);
            tabTooltipTimer = null;
        }
        if (tabTooltipEl) {
            tabTooltipEl.remove();
            tabTooltipEl = null;
        }
    }

    function scheduleTabTooltip(anchor, text) {
        hideTabTooltip();
        if (!anchor || !text) return;
        tabTooltipTimer = win.setTimeout(() => {
            tabTooltipTimer = null;
            if (tabDragging || !anchor.isConnected) return;
            const rect = anchor.getBoundingClientRect();
            const tip = doc.createElement('div');
            tip.className = 'side-pane-tab-tooltip';
            tip.setAttribute('role', 'tooltip');
            tip.textContent = text;
            doc.body.appendChild(tip);
            const tipRect = tip.getBoundingClientRect();
            const viewportWidth = win.innerWidth || 1200;
            const left = Math.max(8, Math.min(viewportWidth - tipRect.width - 8, rect.left + rect.width / 2 - tipRect.width / 2));
            tip.style.left = `${Math.round(left)}px`;
            tip.style.top = `${Math.round(rect.bottom + 6)}px`;
            tabTooltipEl = tip;
        }, TAB_TOOLTIP_DELAY_MS);
    }

    // VCPLog 连接状态不再单独占一行：通知标签上一个小圆点，悬停/读屏给出全文
    const connectionStatusEl = doc.getElementById('vcpLogConnectionStatus');
    const connectionStatusText = () => connectionStatusEl?.querySelector('.notifications-status-text')?.textContent.trim() || '';
    // 通知放进新标签页的“通知”分类时，状态里的通知页仍是首页/兜底，只是不再占标签条上的位置
    const notificationsSegmentBtn = contentContainer?.querySelector?.('#sidePaneViewLauncher [data-launcher-tab="notifications"]') || null;
    const notificationsInLauncher = Boolean(contentContainer?.querySelector?.('#sidePaneViewLauncher [data-launcher-section="notifications"]'));
    const getStripTabs = () => {
        const tabs = SidePaneState.getVisibleTabs(state, state.parent);
        return notificationsInLauncher ? tabs.filter(tab => tab.id !== SidePaneState.NOTIFICATIONS_TAB_ID) : tabs;
    };

    function tabTooltipText(tab) {
        const status = tab.id === SidePaneState.NOTIFICATIONS_TAB_ID ? connectionStatusText() : '';
        return status ? `${tab.title} · ${status}` : tab.title;
    }

    function syncNotificationTabStatus() {
        if (!connectionStatusEl) return;
        if (notificationsSegmentBtn) {
            const segmentDot = notificationsSegmentBtn.querySelector('.side-pane-launcher-tab-status');
            if (segmentDot) segmentDot.dataset.status = connectionStatusEl.dataset.status || 'unknown';
            const label = connectionStatusText().replace(/:\s*/, ' ');
            notificationsSegmentBtn.title = label;
            if (label) notificationsSegmentBtn.setAttribute('aria-label', `通知，${label}`);
            else notificationsSegmentBtn.removeAttribute('aria-label');
        }
        if (!tabListElement) return;
        const btn = tabListElement.querySelector(`.side-pane-tab[data-tab-id="${SidePaneState.NOTIFICATIONS_TAB_ID}"]`);
        const dot = btn?.querySelector('.side-pane-tab-status');
        if (!dot) return;
        dot.dataset.status = connectionStatusEl.dataset.status || 'unknown';
        const text = connectionStatusText();
        // 标签上直接写连接状态（“VCPLog 已连接”），“通知”只留在标签名和概览里
        const title = btn.querySelector('.tab-title');
        if (title) title.textContent = text ? text.replace(/:\s*/, ' ') : '通知';
        if (text) btn.setAttribute('aria-label', `通知，${text}`);
        else btn.removeAttribute('aria-label');
    }

    if (connectionStatusEl && typeof win.MutationObserver === 'function') {
        const statusObserver = new win.MutationObserver(syncNotificationTabStatus);
        statusObserver.observe(connectionStatusEl, { attributes: true, attributeFilter: ['data-status'], childList: true, characterData: true, subtree: true });
        cleanupListeners.push(() => statusObserver.disconnect());
    }

    const addButtonHome = resolvedAddChatTabBtn?.parentElement || null;
    const addButtonHomeNext = resolvedAddChatTabBtn?.nextSibling || null;
    let tabLayoutRaf = 0;
    let lastRenderedActiveTabId = null;

    function layoutTabStrip() {
        if (!tabListElement) return;
        const items = tabListElement.querySelectorAll('.side-pane-tab-item');
        const addBtn = resolvedAddChatTabBtn;
        let overflowing = true;
        if (addBtn && addButtonHome) {
            const addInside = addBtn.parentElement === tabListElement;
            const measured = addBtn.getBoundingClientRect?.().width || 0;
            const overflow = resolveTabsOverflow({
                addButtonInside: addInside,
                addButtonWidth: measured || 28,
                tabCount: items.length,
                viewportWidth: tabListElement.clientWidth || 0
            });
            // 视口宽度未知（隐藏或无布局）时保持在右侧操作区，避免来回搬动
            overflowing = tabListElement.clientWidth ? overflow : true;
            if (!overflowing && !addInside) {
                tabListElement.appendChild(addBtn);
            } else if (overflowing && addInside) {
                addButtonHome.insertBefore(addBtn, addButtonHomeNext && addButtonHomeNext.parentElement === addButtonHome ? addButtonHomeNext : addButtonHome.firstChild);
            }
        }
        // 溢出时只在还能继续滚动的一侧渐隐
        const maxScrollLeft = Math.max(0, tabListElement.scrollWidth - tabListElement.clientWidth);
        tabListElement.classList.toggle('mask-left', overflowing && tabListElement.scrollLeft > 1);
        tabListElement.classList.toggle('mask-right', overflowing && tabListElement.scrollLeft < maxScrollLeft - 1);
    }

    function scheduleTabLayout() {
        if (tabLayoutRaf) return;
        const raf = win.requestAnimationFrame || ((cb) => win.setTimeout(cb, 16));
        tabLayoutRaf = raf(() => {
            tabLayoutRaf = 0;
            if (!isDisposed) layoutTabStrip();
        });
    }

    function scrollActiveTabIntoView() {
        const activeItem = tabListElement?.querySelector?.('.side-pane-tab-item.active');
        if (!activeItem) return;
        const items = tabListElement.querySelectorAll('.side-pane-tab-item');
        // 首尾标签直接滚到边缘，否则标签条的内边距会留下一侧渐隐压在激活标签上
        if (items.length > 1 && activeItem === items[items.length - 1]) {
            tabListElement.scrollLeft = tabListElement.scrollWidth;
        } else if (activeItem === items[0]) {
            tabListElement.scrollLeft = 0;
        } else {
            activeItem.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        }
    }

    function renderTabList() {
        if (!tabListElement) return;
        hideTabTooltip();
        // 只清标签项：新增按钮在不溢出时会住在标签条里
        tabListElement.querySelectorAll('.side-pane-tab-item').forEach((el) => el.remove());
        tabListElement.setAttribute('role', 'tablist');
        tabListElement.setAttribute('aria-label', '工作区侧栏标签页');

        const visibleTabs = getStripTabs();
        const insertAnchor = resolvedAddChatTabBtn?.parentElement === tabListElement ? resolvedAddChatTabBtn : null;

        visibleTabs.forEach(tab => {
            const isActive = tab.id === state.activeTabId;

            const tabItem = doc.createElement('div');
            tabItem.className = `side-pane-tab-item${isActive ? ' active' : ''}`;
            tabItem.setAttribute('data-tab-id', tab.id);

            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = `side-pane-tab${isActive ? ' active' : ''}`;
            btn.setAttribute('role', 'tab');
            btn.setAttribute('aria-selected', String(isActive));
            btn.setAttribute('tabindex', isActive ? '0' : '-1');
            btn.setAttribute('data-tab-id', tab.id);

            const iconSpan = doc.createElement('span');
            iconSpan.className = 'tab-icon vcp-ui-icon';
            iconSpan.setAttribute('aria-hidden', 'true');
            iconSpan.textContent = getTabIconName(tab);

            const titleSpan = doc.createElement('span');
            titleSpan.className = 'tab-title';
            titleSpan.textContent = tab.title;

            btn.append(iconSpan, titleSpan);
            if (tab.id === SidePaneState.NOTIFICATIONS_TAB_ID) {
                const statusDot = doc.createElement('span');
                statusDot.className = 'side-pane-tab-status';
                statusDot.setAttribute('aria-hidden', 'true');
                btn.classList.add('has-status');
                btn.appendChild(statusDot);
            }

            btn.addEventListener('click', () => {
                controller.activateTab(tab.id);
            });

            tabItem.appendChild(btn);

            // Close button for closable tabs - sibling to tab button
            const closable = tab.id !== SidePaneState.NOTIFICATIONS_TAB_ID && tab.closable !== false;
            if (closable) {
                const closeBtn = doc.createElement('button');
                closeBtn.type = 'button';
                closeBtn.className = 'side-pane-tab-close';
                closeBtn.setAttribute('aria-label', `关闭 ${tab.title}`);
                closeBtn.setAttribute('tabindex', '-1');
                closeBtn.innerHTML = '<span class="vcp-ui-icon vcp-side-pane-icon-caption">close</span>';
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    controller.closeTab(tab.id);
                });
                tabItem.appendChild(closeBtn);
            }

            // 中键关闭（ZCode SidePaneTabTrigger：mousedown 拦截浏览器自动滚动，auxclick 关闭且不激活）
            tabItem.addEventListener('mousedown', (e) => {
                if (e.button === 1) e.preventDefault();
            });
            tabItem.addEventListener('auxclick', (e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                e.stopPropagation();
                if (closable) controller.closeTab(tab.id);
            });

            // 标题悬停提示：1.5s 后出现，离开/按下/拖拽即消失
            tabItem.addEventListener('mouseenter', () => scheduleTabTooltip(tabItem, tabTooltipText(tab)));
            tabItem.addEventListener('mouseleave', hideTabTooltip);
            tabItem.addEventListener('pointerdown', hideTabTooltip);

            tabItem.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                hideTabTooltip();
                showTabContextMenu(tab.id, e.clientX, e.clientY);
            });

            tabListElement.insertBefore(tabItem, insertAnchor);
        });
        syncNotificationTabStatus();
        renderTabOverviewPopover?.(searchInput?.value || '');
        layoutTabStrip();
        // 新开或切换到的标签在溢出区时滚进可见范围；激活项不变时不打扰用户手动滚动
        if (state.activeTabId !== lastRenderedActiveTabId) {
            lastRenderedActiveTabId = state.activeTabId;
            scrollActiveTabIntoView();
        }
    }

    if (tabListElement) {
        tabSortable = createTabSortable({
            container: tabListElement,
            isDraggable: (item) => item.getAttribute('data-tab-id') !== SidePaneState.NOTIFICATIONS_TAB_ID,
            onReorder: (activeId, overId) => controller.reorderTab(activeId, overId),
            onDragStateChange: (dragging) => {
                tabDragging = dragging;
                if (dragging) hideTabTooltip();
            }
        });
        tabListElement.addEventListener('scroll', scheduleTabLayout, { passive: true });
        cleanupListeners.push(() => tabListElement.removeEventListener('scroll', scheduleTabLayout));
        cleanupListeners.push(() => tabSortable?.dispose());
        cleanupListeners.push(hideTabTooltip);
        if (typeof win.ResizeObserver === 'function') {
            const resizeObserver = new win.ResizeObserver(scheduleTabLayout);
            resizeObserver.observe(tabListElement);
            cleanupListeners.push(() => resizeObserver.disconnect());
        }
    }

    if (tabListElement) {
        tabListElement.addEventListener('keydown', (e) => {
            const tabButtons = Array.from(tabListElement.querySelectorAll('[role="tab"]'));
            if (tabButtons.length === 0) return;
            const currentIndex = tabButtons.findIndex(b => b.getAttribute('data-tab-id') === state.activeTabId);
            let targetIndex = currentIndex;

            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                targetIndex = (currentIndex + 1) % tabButtons.length;
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                targetIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
            } else if (e.key === 'Home') {
                e.preventDefault();
                targetIndex = 0;
            } else if (e.key === 'End') {
                e.preventDefault();
                targetIndex = tabButtons.length - 1;
            }

            if (targetIndex !== currentIndex && targetIndex >= 0 && targetIndex < tabButtons.length) {
                const targetId = tabButtons[targetIndex].getAttribute('data-tab-id');
                controller.activateTab(targetId);
                tabButtons[targetIndex].focus();
            }
        });
    }

    function syncViewPanels() {
        if (!contentContainer) return;
        const visibleTabIds = new Set(SidePaneState.getVisibleTabs(state, state.parent).map(t => t.id));
        visibleTabIds.add(SidePaneState.LAUNCHER_TAB_ID);
        const activeViewId = notificationsInLauncher && state.activeTabId === SidePaneState.NOTIFICATIONS_TAB_ID
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
        if (notificationsInLauncher) syncLauncherSections();
    }

    const isJSDOM = (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.includes('jsdom'))
        || (typeof win !== 'undefined' && win.name === 'nodejs');

    let isAnimating = false;
    let animationTimer = null;
    let animationRafId = null;

    function clearPendingAnimation() {
        if (animationTimer) {
            clearTimeout(animationTimer);
            animationTimer = null;
        }
        if (animationRafId) {
            win?.cancelAnimationFrame?.(animationRafId);
            animationRafId = null;
        }
    }

    // 开合动画期间把内容宽度锁在展开宽度，避免正文随面板宽度逐帧重排（同 ZCode lockedContentWidthPx）
    function lockContentWidth(widthPx) {
        const style = win?.getComputedStyle?.(root);
        const borderPx = (parseFloat(style?.borderLeftWidth) || 0) + (parseFloat(style?.borderRightWidth) || 0);
        if (Number.isFinite(widthPx) && widthPx > borderPx) {
            root.style.setProperty('--side-pane-locked-width', `${Math.floor(widthPx - borderPx)}px`);
        }
    }

    function unlockContentWidth() {
        root.style.removeProperty('--side-pane-locked-width');
    }

    // 展开后的宽度：百分比相对父元素内容区，再按 min 240px / max 65% 夹住
    function readExpandedWidthPx() {
        const host = root.parentElement;
        if (!host) return 0;
        const style = win?.getComputedStyle?.(host);
        const hostWidth = host.clientWidth - (parseFloat(style?.paddingLeft) || 0) - (parseFloat(style?.paddingRight) || 0);
        if (!(hostWidth > 0)) return 0;
        return Math.min(hostWidth * 0.65, Math.max(240, hostWidth * currentRatio));
    }

    function syncHeaderButtons(isVisible) {
        if (toggleNotificationsBtn) {
            const isNotifActive = isVisible && state.activeTabId === SidePaneState.NOTIFICATIONS_TAB_ID;
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

        const notifSidebar = doc.getElementById('notificationsSidebar');
        if (notifSidebar) {
            const isNotifActive = isVisible && state.activeTabId === SidePaneState.NOTIFICATIONS_TAB_ID;
            notifSidebar.classList.toggle('active', isNotifActive);
        }

        // 展开按钮只在面板收起时出现；面板里有自己的收起按钮
        if (toggleChatBtn) {
            toggleChatBtn.hidden = isVisible;
            toggleChatBtn.setAttribute('aria-expanded', String(isVisible));
        }
    }

    function applySynchronousVisibility(isVisible) {
        clearPendingAnimation();
        isAnimating = false;
        root.classList.remove('is-animating');
        root.classList.toggle('active', isVisible);
        root.classList.toggle('collapsed', !isVisible);
        root.setAttribute('aria-hidden', String(!isVisible));

        resizerHandle?.classList.remove('is-animating', 'is-animating-closing');
        unlockContentWidth();

        if (isVisible) {
            root.style.width = getFormattedPercent();
            root.style.opacity = '';
        } else {
            root.style.width = '';
            root.style.opacity = '';
        }

        syncHeaderButtons(isVisible);
    }

    function animateOpen() {
        clearPendingAnimation();
        isAnimating = true;

        const targetPercent = getFormattedPercent();
        lockContentWidth(readExpandedWidthPx());

        // Prep starting frame: unhide and lock at 0 width (ZCode next-frame pattern)
        root.classList.remove('collapsed');
        root.removeAttribute('aria-hidden');
        root.classList.add('is-animating', 'active');
        root.style.width = '0%';
        root.style.opacity = '0';

        resizerHandle?.classList.add('is-animating', 'is-animating-closing');

        syncHeaderButtons(true);

        const finish = () => {
            clearPendingAnimation();
            isAnimating = false;
            root.classList.remove('is-animating');
            root.style.width = targetPercent;
            root.style.opacity = '';
            unlockContentWidth();
            resizerHandle?.classList.remove('is-animating', 'is-animating-closing');
            root.removeEventListener('transitionend', onTransitionEnd);
        };

        const onTransitionEnd = (e) => {
            if (e.target === root && e.propertyName === 'width') {
                finish();
            }
        };

        root.addEventListener('transitionend', onTransitionEnd);
        animationTimer = setTimeout(finish, 240);

        animationRafId = win.requestAnimationFrame(() => {
            animationRafId = null;
            root.style.width = targetPercent;
            root.style.opacity = '1';
            if (resizerHandle) {
                resizerHandle.classList.remove('is-animating-closing');
            }
        });
    }

    function animateClose() {
        clearPendingAnimation();
        isAnimating = true;

        const startPercent = root.style.width || getFormattedPercent();
        lockContentWidth(root.getBoundingClientRect().width);
        root.classList.add('is-animating');
        root.style.width = startPercent;
        root.style.opacity = '1';

        resizerHandle?.classList.add('is-animating', 'is-animating-closing');

        syncHeaderButtons(false);

        const finish = () => {
            clearPendingAnimation();
            isAnimating = false;
            root.classList.remove('is-animating', 'active');
            root.classList.add('collapsed');
            root.setAttribute('aria-hidden', 'true');
            root.style.width = '';
            root.style.opacity = '';
            unlockContentWidth();

            resizerHandle?.classList.remove('is-animating', 'is-animating-closing');
            root.removeEventListener('transitionend', onTransitionEnd);
        };

        const onTransitionEnd = (e) => {
            if (e.target === root && e.propertyName === 'width') {
                finish();
            }
        };

        root.addEventListener('transitionend', onTransitionEnd);
        animationTimer = setTimeout(finish, 240);

        animationRafId = win.requestAnimationFrame(() => {
            animationRafId = null;
            root.style.width = '0%';
            root.style.opacity = '0';
        });
    }

    function syncDomVisibility(options = {}) {
        const isVisible = state.visible;
        const shouldAnimate = options.animate !== false
            && !isJSDOM
            && typeof win?.requestAnimationFrame === 'function'
            && !win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

        if (!shouldAnimate) {
            applySynchronousVisibility(isVisible);
            return;
        }

        const currentlyVisible = root.classList.contains('active') && !root.classList.contains('collapsed');
        if (isVisible === currentlyVisible && !isAnimating) {
            if (isVisible) {
                root.style.width = getFormattedPercent();
            }
            syncHeaderButtons(isVisible);
            return;
        }

        if (isVisible) {
            animateOpen();
        } else {
            animateClose();
        }
    }

    const controller = Object.freeze({
        getSnapshot() {
            return state;
        },

        setVisible(visible, options = {}) {
            if (isDisposed) return;
            state = SidePaneState.setVisible(state, visible);
            if (state.parent) {
                const parentKey = SidePaneState.getParentKey(state.parent);
                collapsedByParent.set(parentKey, !state.visible);
            }
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
            if (notificationsInLauncher) renderLauncherProfile();
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
        },

        showLauncher() {
            if (isDisposed) return;
            state = SidePaneState.showLauncher(state);
            renderLauncherProfile();
            if (launcherTab === 'apps') renderLauncherApps();
            else renderLauncherRecommended();
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
        },

        activateTab(tabId) {
            if (isDisposed || !tabId) return;
            state = SidePaneState.activateTab(state, tabId);
            if (state.parent && tabId !== SidePaneState.NOTIFICATIONS_TAB_ID && tabId !== SidePaneState.LAUNCHER_TAB_ID) {
                const parentKey = SidePaneState.getParentKey(state.parent);
                activeTabByParent.set(parentKey, tabId);
                if (state.visible) {
                    collapsedByParent.set(parentKey, false);
                }
            }
            renderTabList();
            scrollActiveTabIntoView();
            syncViewPanels();
            syncDomVisibility();

            const entry = mountedTabMap.get(tabId);
            entry?.handle?.focus?.();
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
            renderTabOverviewPopover(searchInput?.value || '');
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

            state = SidePaneState.openTab(state, rawTab);
            const targetTabId = state.activeTabId;
            if (state.parent && SidePaneState.matchesConversation(SidePaneState.getTabParent(rawTab), state.parent)) {
                const parentKey = SidePaneState.getParentKey(state.parent);
                collapsedByParent.set(parentKey, false);
                activeTabByParent.set(parentKey, targetTabId);
            }
            renderTabList();

            let entry = mountedTabMap.get(targetTabId);
            if (!entry) {
                let view = contentContainer?.querySelector(`[data-tab-id="${targetTabId}"]`);
                if (!view && contentContainer) {
                    view = doc.createElement('section');
                    view.className = 'side-pane-view';
                    view.setAttribute('data-tab-id', targetTabId);
                    view.setAttribute('role', 'tabpanel');
                    view.setAttribute('aria-label', rawTab.title || '副屏视图');
                    contentContainer.appendChild(view);
                }

                const provider = providers[rawTab.kind];
                if (provider?.mountTab && view) {
                    const handle = await provider.mountTab(rawTab, view);
                    if (isDisposed || !state.tabs.some(t => t.id === targetTabId)) {
                        await handle?.dispose?.();
                        view?.remove?.();
                        return null;
                    }
                    entry = { tab: rawTab, viewElement: view, handle };
                    mountedTabMap.set(targetTabId, entry);
                } else if (view) {
                    entry = { tab: rawTab, viewElement: view, handle: null };
                    mountedTabMap.set(targetTabId, entry);
                }
            }

            syncViewPanels();
            syncDomVisibility();
            entry?.handle?.focus?.();
            return entry?.handle || null;
        },

        async openChat(descriptor) {
            if (isDisposed || !descriptor) return null;
            const childKey = `${descriptor.child?.itemId || ''}:${descriptor.child?.topicId || descriptor.id}`;
            if (pendingMountMap.has(childKey)) {
                return await pendingMountMap.get(childKey);
            }

            const mountPromise = (async () => {
                state = SidePaneState.openChatTab(state, descriptor);
                const targetTabId = state.activeTabId;
                if (state.parent && SidePaneState.matchesConversation(descriptor.parent, state.parent)) {
                    const parentKey = SidePaneState.getParentKey(state.parent);
                    collapsedByParent.set(parentKey, false);
                    activeTabByParent.set(parentKey, targetTabId);
                }
                renderTabList();

                // Check if view container already mounted for this tab
                let entry = mountedTabMap.get(targetTabId);
                if (!entry) {
                    let view = contentContainer?.querySelector(`[data-tab-id="${targetTabId}"]`);
                    if (!view && contentContainer) {
                        view = doc.createElement('section');
                        view.className = 'side-pane-view';
                        view.setAttribute('data-tab-id', targetTabId);
                        view.setAttribute('role', 'tabpanel');
                        contentContainer.appendChild(view);
                    }

                    if (providers.chat?.mountTab && view) {
                        const handle = await providers.chat.mountTab(descriptor, view);
                        if (isDisposed || !state.tabs.some(t => t.id === targetTabId)) {
                            await handle?.dispose?.();
                            view?.remove?.();
                            return null;
                        }
                        entry = { descriptor, viewElement: view, handle };
                        mountedTabMap.set(targetTabId, entry);

                        // Restore cached draft & uncommitted references if available
                        if (childDraftsMap.has(childKey)) {
                            const cached = childDraftsMap.get(childKey);
                            childDraftsMap.delete(childKey);
                            if (cached.draft && typeof handle?.setDraft === 'function') {
                                handle.setDraft(cached.draft);
                            }
                            if (Array.isArray(cached.references) && typeof handle?.addReference === 'function') {
                                cached.references.forEach(r => handle.addReference(r));
                            }
                        } else if (descriptor?.draft || (Array.isArray(descriptor?.references) && descriptor.references.length > 0)) {
                            if (descriptor.draft && typeof handle?.setDraft === 'function') {
                                handle.setDraft(descriptor.draft);
                            }
                            if (Array.isArray(descriptor.references) && typeof handle?.addReference === 'function') {
                                descriptor.references.forEach(r => handle.addReference(r));
                            }
                        }
                        if (descriptor?.model && typeof handle?.setModel === 'function' && handle.getModel?.() !== descriptor.model) {
                            handle.setModel(descriptor.model);
                        }
                    } else if (view) {
                        if (isDisposed || !state.tabs.some(t => t.id === targetTabId)) {
                            view?.remove?.();
                            return null;
                        }
                        entry = { descriptor, viewElement: view, handle: null };
                        mountedTabMap.set(targetTabId, entry);
                    }
                }

                syncViewPanels();
                syncDomVisibility();
                entry?.handle?.focus?.();
                return entry?.handle || null;
            })();

            pendingMountMap.set(childKey, mountPromise);
            try {
                return await mountPromise;
            } finally {
                pendingMountMap.delete(childKey);
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
            if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.label !== 'string' || typeof entry.open !== 'function') {
                throw new TypeError('registerOpenTabEntry requires { id, label, open }');
            }
            const stored = Object.freeze({
                id: entry.id,
                label: entry.label,
                icon: entry.icon ? String(entry.icon) : 'tab',
                order: Number.isFinite(entry.order) ? entry.order : 100,
                seq: openTabEntrySeq++,
                open: entry.open,
                isAvailable: typeof entry.isAvailable === 'function' ? entry.isAvailable : null
            });
            openTabEntryMap.set(stored.id, stored);
            renderOpenTabEntries();
            return () => {
                if (openTabEntryMap.get(stored.id) !== stored) return;
                openTabEntryMap.delete(stored.id);
                if (!isDisposed) renderOpenTabEntries();
            };
        },

        /** 入口的可用状态变了（比如当前窗口不支持某能力）时调用，重新渲染菜单和引导页 */
        refreshOpenTabEntries() {
            if (!isDisposed) renderOpenTabEntries();
        },

        setLauncherAddressHandler(handler) {
            launcherAddressHandler = typeof handler === 'function' ? handler : null;
            syncLauncherAddress();
        },

        /** provider() 返回 { name, avatarUrl, onEditAvatar?, onRename?(name) } 或 null（不显示） */
        setLauncherProfileProvider(provider) {
            launcherProfileProvider = typeof provider === 'function' ? provider : null;
            renderLauncherProfile();
        },

        /** provider() 返回 [{ id, label, title?, open(), mountIcon?(button, iconHost) }]；不设置时只有工具页 */
        setLauncherAppsProvider(provider) {
            launcherAppsProvider = typeof provider === 'function' ? provider : null;
            if (!launcherAppsProvider) launcherTab = 'tools';
            syncLauncherSections();
            if (launcherTab === 'apps') renderLauncherApps();
        },

        /** 工具页下方「推荐」：provider() 同应用页的条目；onSettings 时标题旁出现设置按钮 */
        setLauncherRecommendedProvider(provider, { onSettings = null } = {}) {
            launcherRecommendedProvider = typeof provider === 'function' ? provider : null;
            launcherRecommendedSettings = typeof onSettings === 'function' ? onSettings : null;
            renderLauncherRecommended();
        },

        refreshLauncherRecommended() {
            renderLauncherRecommended();
        },

        registerProvider(name, provider) {
            if (isDisposed) return;
            providers[name] = provider;
        },

        async closeTab(tabId, options = {}) {
            if (isDisposed || !tabId || tabId === SidePaneState.NOTIFICATIONS_TAB_ID) return;
            const entry = mountedTabMap.get(tabId);
            const tabDesc = entry?.descriptor || state.tabs.find(t => t.id === tabId)?.descriptor || null;
            let updatedTabDesc = tabDesc ? { ...tabDesc } : null;
            if (entry) {
                // Preserve model, draft & uncommitted references before closing
                const childKey = `${tabDesc?.child?.itemId || ''}:${tabDesc?.child?.topicId || tabDesc?.id || tabId}`;
                const draft = entry.handle?.getDraft?.() || '';
                const refs = entry.handle?.getReferences?.() || [];
                const latestModel = entry.handle?.getModel?.();
                if (latestModel && updatedTabDesc) {
                    updatedTabDesc.model = latestModel;
                }
                if (draft || refs.length > 0) {
                    childDraftsMap.set(childKey, { draft, references: refs });
                }
                if (updatedTabDesc) {
                    updatedTabDesc.draft = draft;
                    updatedTabDesc.references = refs;
                }

                const closeResult = await entry.handle?.requestClose?.();
                if (closeResult && closeResult.closed === false) {
                    return; // User or operation prevented close
                }
                await entry.handle?.dispose?.();
                entry.viewElement?.remove?.();
                mountedTabMap.delete(tabId);
            }
            if (updatedTabDesc && typeof onTabClosed === 'function') {
                try { await onTabClosed(updatedTabDesc); } catch {}
            }

            const tabObj = state.tabs.find(t => t.id === tabId);
            // ZCode parity (useAppPanels.ts:1334):
            // Ephemeral secondary sessions (selection-side-chat / kind === 'chat') are explicitly
            // excluded from recentlyClosedTabs; every other tab is remembered so it can be reopened.
            const isEphemeralChat = tabObj?.kind === 'chat' || tabObj?.type === 'selection-side-chat' || updatedTabDesc?.ephemeral;
            if (tabObj && !isEphemeralChat && tabObj.reopenable !== false) {
                const { openedAt, ...reopenable } = tabObj;
                const previous = recentlyClosedTabs.findIndex(entry => entry.id === tabId);
                if (previous !== -1) recentlyClosedTabs.splice(previous, 1);
                recentlyClosedTabs.unshift({
                    id: tabId,
                    title: tabObj.title || '标签页',
                    tab: reopenable,
                    closedAt: Date.now()
                });
                if (recentlyClosedTabs.length > 10) {
                    recentlyClosedTabs.pop();
                }
            }

            const wasVisible = state.visible;
            state = SidePaneState.closeTab(state, tabId, options);
            if (state.parent) {
                const parentKey = SidePaneState.getParentKey(state.parent);
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
            const activeTabBtn = tabListElement?.querySelector?.(`[role="tab"][data-tab-id="${state.activeTabId}"]`);
            activeTabBtn?.focus?.();
        },

        setParent(parentRef) {
            if (isDisposed) return;
            // Persist current parent's active tab and collapsed state before switching
            if (state.parent) {
                const prevKey = SidePaneState.getParentKey(state.parent);
                if (state.activeTabId && state.activeTabId !== SidePaneState.NOTIFICATIONS_TAB_ID && state.activeTabId !== SidePaneState.LAUNCHER_TAB_ID) {
                    activeTabByParent.set(prevKey, state.activeTabId);
                }
                collapsedByParent.set(prevKey, !state.visible);
            }

            const nextKey = parentRef ? SidePaneState.getParentKey(parentRef) : '';
            const preferredTabId = activeTabByParent.get(nextKey);
            const collapsedPreference = collapsedByParent.get(nextKey);

            state = SidePaneState.setParent(state, parentRef, { preferredTabId, collapsedPreference });
            renderTabList();
            syncViewPanels();
            syncDomVisibility();
        },

        setPreferredWidth(width) {
            if (isDisposed) return;
            if (typeof width === 'number') {
                if (width > 0 && width <= 1) {
                    currentRatio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, width));
                } else if (width > 1) {
                    const parent = root.parentElement || doc.querySelector('#nextUiMainPanel, .container') || doc.body;
                    const parentWidth = parent?.getBoundingClientRect?.()?.width || win?.innerWidth || 1200;
                    if (parentWidth > 0) {
                        currentRatio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, width / parentWidth));
                    }
                }
            }
            state = SidePaneState.setPreferredWidth(state, width);
            if (state.visible && !isAnimating) {
                root.style.width = getFormattedPercent();
            }
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
            clearPendingAnimation();
            if (windowResizeTimer) {
                clearTimeout(windowResizeTimer);
                windowResizeTimer = null;
            }
            cleanupListeners.forEach(cleanup => cleanup());
            cleanupListeners.length = 0;

            resizerOwner?.dispose?.();

            const disposePromises = [];
            mountedTabMap.forEach((entry) => {
                if (entry.handle?.dispose) {
                    disposePromises.push(entry.handle.dispose());
                }
                entry.viewElement?.remove?.();
            });
            mountedTabMap.clear();
            await Promise.allSettled(disposePromises);
        }
    });

    // Wire up buttons
    if (toggleNotificationsBtn && !electronAPI?.sendToggleNotificationsSidebar) {
        const onNotifClick = () => {
            if (state.visible && state.activeTabId === SidePaneState.NOTIFICATIONS_TAB_ID) {
                controller.setVisible(false);
            } else {
                controller.showNotifications();
            }
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
            const closable = SidePaneState.getClosableVisibleTabs(state);
            if (closable.length === 0) {
                expandFromEmpty();
                return;
            }
            const parentKey = state.parent ? SidePaneState.getParentKey(state.parent) : '';
            const preferred = parentKey ? activeTabByParent.get(parentKey) : null;
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

    // ZCode parity (WorkspaceShellLayout.tsx:481-525)
    // Auto-collapse side pane when conversation area is narrower than 480px.
    const CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX = 480;
    const CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS = 300;
    let windowResizeTimer = null;

    const onWindowResize = () => {
        if (isDisposed) return;
        if (windowResizeTimer) {
            clearTimeout(windowResizeTimer);
        }
        windowResizeTimer = setTimeout(() => {
            windowResizeTimer = null;
            if (isDisposed) return;

            const mainContent = doc.querySelector('.main-content');
            const mainWidthPx = mainContent?.getBoundingClientRect?.()?.width ?? null;

            if (state.visible && mainWidthPx !== null && mainWidthPx < CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX) {
                // conversation 过窄，自动收起右侧副屏 (ZCode WorkspaceShellLayout.tsx:495)
                controller.setVisible(false);
            } else if (state.visible && !isAnimating) {
                if (!root.style.width.endsWith('%')) {
                    root.style.width = getFormattedPercent();
                }
            }
        }, CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS);
    };

    win?.addEventListener?.('resize', onWindowResize, { passive: true });
    cleanupListeners.push(() => {
        if (windowResizeTimer) clearTimeout(windowResizeTimer);
        win?.removeEventListener?.('resize', onWindowResize);
    });

    function createOverviewIcon(name) {
        const icon = doc.createElement('span');
        icon.className = 'vcp-ui-icon';
        icon.classList.add('vcp-side-pane-icon-base');
        icon.textContent = name;
        return icon;
    }

    function renderTabOverviewPopover(filterQuery = '') {
        if (!resolvedOverviewPopover) return;
        const listEl = resolvedOverviewPopover.querySelector('#sidePaneOpenTabsList');
        if (!listEl) return;
        listEl.innerHTML = '';
        const queryParts = normalizeSearchQuery(filterQuery);
        const visibleTabs = getStripTabs();
        const now = Date.now();

        const openItems = filterAndRankSearchItems(visibleTabs.map(tab => ({
            tab,
            searchFields: buildSearchFields(tab.title, getTabSearchHint(tab), getTabTypeLabel(tab))
        })), queryParts);
        const closedItems = filterAndRankSearchItems(recentlyClosedTabs.map(closed => ({
            closed,
            searchFields: buildSearchFields(closed.title, getTabSearchHint(closed.tab), getTabTypeLabel(closed.tab))
        })), queryParts);

        if (openItems.length === 0 && closedItems.length === 0) {
            const emptyEl = doc.createElement('div');
            emptyEl.className = 'side-pane-overview-empty';
            emptyEl.textContent = '未找到匹配的标签页';
            listEl.appendChild(emptyEl);
            return;
        }

        if (openItems.length > 0) {
            const openTitle = doc.createElement('div');
            openTitle.className = 'side-pane-overview-section-title';
            openTitle.textContent = '打开的标签页';
            listEl.appendChild(openTitle);

            openItems.forEach(({ tab }) => {
                const item = doc.createElement('div');
                item.className = `side-pane-overview-item${tab.id === state.activeTabId ? ' active' : ''}`;
                item.setAttribute('data-tab-id', tab.id);
                const titleDiv = doc.createElement('div');
                titleDiv.className = 'side-pane-overview-item-title';
                const label = doc.createElement('span');
                label.textContent = tab.title;
                titleDiv.append(createOverviewIcon(getTabIconName(tab)), label);
                item.appendChild(titleDiv);

                if (tab.openedAt) {
                    const timeSpan = doc.createElement('span');
                    timeSpan.className = 'side-pane-overview-time';
                    timeSpan.textContent = formatRelativeTime(tab.openedAt, now);
                    item.appendChild(timeSpan);
                }

                if (tab.id !== SidePaneState.NOTIFICATIONS_TAB_ID && tab.closable !== false) {
                    const closeBtn = doc.createElement('button');
                    closeBtn.type = 'button';
                    closeBtn.className = 'side-pane-tab-close';
                    closeBtn.title = '关闭';
                    closeBtn.setAttribute('aria-label', `关闭 ${tab.title}`);
                    closeBtn.innerHTML = '<span class="vcp-ui-icon vcp-side-pane-icon-caption">close</span>';
                    closeBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await controller.closeTab(tab.id);
                        renderTabOverviewPopover(searchInput?.value || '');
                    });
                    item.appendChild(closeBtn);
                }

                item.addEventListener('click', () => {
                    controller.activateTab(tab.id);
                    controller.setVisible(true);
                    hideOverview();
                });

                listEl.appendChild(item);
            });
        }

        if (closedItems.length > 0) {
            const closedTitle = doc.createElement('div');
            closedTitle.className = 'side-pane-overview-section-title';
            closedTitle.textContent = '最近关闭的标签页';
            listEl.appendChild(closedTitle);

            closedItems.forEach(({ closed }) => {
                const item = doc.createElement('div');
                item.className = 'side-pane-overview-item recently-closed';
                item.setAttribute('data-closed-tab-id', closed.id);

                const titleDiv = doc.createElement('div');
                titleDiv.className = 'side-pane-overview-item-title';
                const label = doc.createElement('span');
                label.textContent = closed.title;
                titleDiv.append(createOverviewIcon(getTabIconName(closed.tab)), label);

                const timeSpan = doc.createElement('span');
                timeSpan.className = 'side-pane-overview-time';
                timeSpan.textContent = formatRelativeTime(closed.closedAt, now);

                item.append(titleDiv, timeSpan);

                item.addEventListener('click', async () => {
                    hideOverview();
                    await controller.reopenClosedTab(closed.id);
                });

                listEl.appendChild(item);
            });
        }
    }

    const searchInput = resolvedOverviewPopover?.querySelector?.('.side-pane-overview-input');
    if (searchInput) {
        const onSearchInput = () => {
            renderTabOverviewPopover(searchInput.value);
        };
        searchInput.addEventListener('input', onSearchInput);
        cleanupListeners.push(() => searchInput.removeEventListener('input', onSearchInput));

        // 键盘操作照 ZCode 的 Command：上下键移动高亮，回车打开，Esc 关闭并回到触发按钮。
        const onSearchKeydown = (event) => {
            const items = Array.from(resolvedOverviewPopover.querySelectorAll('.side-pane-overview-item'));
            const current = items.findIndex(item => item.classList.contains('kbd-active'));
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (!items.length) return;
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                const next = current < 0 ? (step > 0 ? 0 : items.length - 1) : (current + step + items.length) % items.length;
                items.forEach((item, index) => item.classList.toggle('kbd-active', index === next));
                items[next].scrollIntoView?.({ block: 'nearest' });
            } else if (event.key === 'Enter') {
                const target = items[current] || items[0];
                if (target) {
                    event.preventDefault();
                    target.click();
                }
            } else if (event.key === 'Escape') {
                event.preventDefault();
                hideOverview();
                resolvedOverviewBtn?.focus?.();
            }
        };
        searchInput.addEventListener('keydown', onSearchKeydown);
        cleanupListeners.push(() => searchInput.removeEventListener('keydown', onSearchKeydown));
    }

    // ---- 浮层菜单：概览 / 新增 / 标签右键。统一用 hidden 开关，点外面或按 Esc 关闭 ----
    function isOpen(el) {
        return Boolean(el) && !el.hidden;
    }

    function hideOverview() {
        if (resolvedOverviewPopover) resolvedOverviewPopover.hidden = true;
        resolvedOverviewBtn?.setAttribute('aria-expanded', 'false');
    }

    function hideTabContextMenu() {
        if (resolvedTabContextMenu) resolvedTabContextMenu.hidden = true;
        contextTargetTabId = null;
    }

    function hideAllMenus() {
        hideOverview();
        hideTabContextMenu();
    }

    if (resolvedOverviewBtn && resolvedOverviewPopover) {
        resolvedOverviewBtn.setAttribute('aria-haspopup', 'dialog');
        resolvedOverviewBtn.setAttribute('aria-expanded', 'false');
        const onOverviewClick = (e) => {
            e.stopPropagation();
            if (isOpen(resolvedOverviewPopover)) {
                hideOverview();
                return;
            }
            hideTabContextMenu();
            resolvedOverviewPopover.hidden = false;
            resolvedOverviewBtn.setAttribute('aria-expanded', 'true');
            if (searchInput) searchInput.value = '';
            renderTabOverviewPopover();
            searchInput?.focus?.();
        };
        resolvedOverviewBtn.addEventListener('click', onOverviewClick);
        cleanupListeners.push(() => resolvedOverviewBtn.removeEventListener('click', onOverviewClick));
    }

    const onDocPointerDown = (e) => {
        const target = e.target;
        if (isOpen(resolvedOverviewPopover) && !resolvedOverviewPopover.contains(target) && !resolvedOverviewBtn?.contains?.(target)) {
            hideOverview();
        }
        if (isOpen(resolvedTabContextMenu) && !resolvedTabContextMenu.contains(target)) {
            hideTabContextMenu();
        }
    };
    doc.addEventListener('pointerdown', onDocPointerDown, true);
    cleanupListeners.push(() => doc.removeEventListener('pointerdown', onDocPointerDown, true));

    const onDocKeydown = (e) => {
        if (e.key !== 'Escape') return;
        if (isOpen(resolvedTabContextMenu)) {
            e.preventDefault();
            const returnTo = tabListElement?.querySelector?.(`[role="tab"][data-tab-id="${contextTargetTabId}"]`);
            hideTabContextMenu();
            returnTo?.focus?.();
        } else if (isOpen(resolvedOverviewPopover)) {
            e.preventDefault();
            hideOverview();
            resolvedOverviewBtn?.focus?.();
        }
    };
    doc.addEventListener('keydown', onDocKeydown);
    cleanupListeners.push(() => doc.removeEventListener('keydown', onDocKeydown));

    // 菜单内上下键移动焦点
    function wireMenuKeyboard(menu) {
        if (!menu) return;
        const onKeydown = (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
            const items = Array.from(menu.querySelectorAll('[role="menuitem"]:not([disabled])'));
            if (!items.length) return;
            e.preventDefault();
            const current = items.indexOf(doc.activeElement);
            let next = 0;
            if (e.key === 'End') next = items.length - 1;
            else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
            else if (e.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
            items[next].focus();
        };
        menu.addEventListener('keydown', onKeydown);
        cleanupListeners.push(() => menu.removeEventListener('keydown', onKeydown));
    }

    function focusFirstMenuItem(menu) {
        menu?.querySelector?.('[role="menuitem"]:not([disabled])')?.focus?.();
    }

    // 菜单贴着指针出现，超出窗口时往回收
    function placeMenuAt(menu, x, y) {
        const margin = 8;
        const rect = menu.getBoundingClientRect();
        const viewportWidth = win.innerWidth || 1000;
        const viewportHeight = win.innerHeight || 800;
        const left = Math.max(margin, Math.min(x, viewportWidth - rect.width - margin));
        const top = Math.max(margin, Math.min(y, viewportHeight - rect.height - margin));
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
    }

    function showTabContextMenu(tabId, x, y) {
        if (!resolvedTabContextMenu) return;
        hideOverview();
        contextTargetTabId = tabId;
        const closableVisible = SidePaneState.getClosableVisibleTabs(state);
        const setDisabled = (action, disabled) => {
            const btn = resolvedTabContextMenu.querySelector(`[data-action="${action}"]`);
            if (btn) btn.disabled = disabled;
        };
        setDisabled('close-tab', !closableVisible.some(t => t.id === tabId));
        setDisabled('close-others', !closableVisible.some(t => t.id !== tabId));
        setDisabled('close-all', closableVisible.length === 0);
        resolvedTabContextMenu.hidden = false;
        placeMenuAt(resolvedTabContextMenu, x, y);
        focusFirstMenuItem(resolvedTabContextMenu);
    }

    if (resolvedTabContextMenu) {
        wireMenuKeyboard(resolvedTabContextMenu);
        const onContextMenuClick = async (e) => {
            const actionBtn = e.target.closest('[data-action]');
            if (!actionBtn || actionBtn.disabled) return;
            const action = actionBtn.getAttribute('data-action');
            const targetId = contextTargetTabId;
            hideTabContextMenu();

            if (action === 'close-tab' && targetId) {
                await controller.closeTab(targetId);
            } else if (action === 'close-others' && targetId) {
                await controller.closeOtherTabs(targetId);
            } else if (action === 'close-all') {
                await controller.closeAllTabs();
            }
        };
        resolvedTabContextMenu.addEventListener('click', onContextMenuClick);
        cleanupListeners.push(() => resolvedTabContextMenu.removeEventListener('click', onContextMenuClick));
    }

    // ---- 新标签页（引导页）：上面地址栏，下面工具入口。工具入口由各模块自己登记 ----
    const launcherView = contentContainer?.querySelector?.('#sidePaneViewLauncher') || null;
    const launcherList = launcherView?.querySelector?.('.side-pane-open-tab-list') || null;
    const launcherToolsSection = launcherView?.querySelector?.('[data-launcher-section="tools"]') || null;
    const launcherAddressForm = launcherView?.querySelector?.('.side-pane-launcher-address') || null;
    const launcherAddressInput = launcherAddressForm?.querySelector?.('input') || null;
    const launcherAddressError = launcherView?.querySelector?.('.side-pane-launcher-address-error') || null;
    let launcherAddressHandler = typeof onLauncherAddress === 'function' ? onLauncherAddress : null;
    const launcherProfile = launcherView?.querySelector?.('.side-pane-launcher-profile') || null;
    const launcherProfileAvatar = launcherProfile?.querySelector?.('.side-pane-launcher-avatar') || null;
    const launcherProfileImage = launcherProfileAvatar?.querySelector?.('img') || null;
    const launcherProfileName = launcherProfile?.querySelector?.('.side-pane-launcher-name') || null;
    const launcherTabs = launcherView?.querySelector?.('.side-pane-launcher-tabs') || null;
    const launcherAppsSection = launcherView?.querySelector?.('[data-launcher-section="apps"]') || null;
    const launcherAppGrid = launcherAppsSection?.querySelector?.('.side-pane-launcher-app-grid') || null;
    const launcherNotificationsSection = launcherView?.querySelector?.('[data-launcher-section="notifications"]') || null;
    const launcherToolsGroup = launcherToolsSection?.querySelector?.('[data-launcher-group="tools"]') || null;
    const launcherRecommendedGroup = launcherToolsSection?.querySelector?.('[data-launcher-group="recommended"]') || null;
    const launcherRecommendedRow = launcherRecommendedGroup?.querySelector?.('.side-pane-launcher-recommended-row') || null;
    const launcherRecommendedAction = launcherRecommendedGroup?.querySelector?.('.side-pane-launcher-group-action') || null;
    let launcherProfileProvider = null;
    let launcherProfileEdit = null;
    let launcherProfileRename = null;
    let launcherProfileNameValue = '';
    let launcherNameEdit = null;
    let launcherAppsProvider = null;
    let launcherApps = new Map();
    let launcherRecommendedProvider = null;
    let launcherRecommendedSettings = null;
    let launcherRecommended = new Map();
    let launcherTab = 'tools';

    // 当前助手的头像和名字；每次打开新标签页时现取，改了头像或名字也能跟上
    function renderLauncherProfile() {
        if (!launcherProfile) return;
        let profile = null;
        try {
            profile = launcherProfileProvider?.() || null;
        } catch (error) {
            console.warn('[SidePaneController] Failed to read launcher profile:', error);
        }
        launcherProfile.hidden = !profile;
        launcherProfileEdit = typeof profile?.onEditAvatar === 'function' ? profile.onEditAvatar : null;
        launcherProfileRename = typeof profile?.onRename === 'function' ? profile.onRename : null;
        if (!profile) return;
        launcherProfileNameValue = profile.name || '';
        if (launcherProfileName) {
            // 正在改名时不覆盖输入框
            if (!launcherNameEdit) launcherProfileName.value = launcherProfileNameValue;
            launcherProfileName.readOnly = !launcherProfileRename;
            launcherProfileName.title = launcherProfileRename ? '编辑名称' : '';
        }
        if (launcherProfileImage) {
            const src = profile.avatarUrl || 'assets/default_avatar.png';
            if (launcherProfileImage.getAttribute('src') !== src) launcherProfileImage.setAttribute('src', src);
        }
        if (launcherProfileAvatar) {
            launcherProfileAvatar.disabled = !launcherProfileEdit;
            launcherProfileAvatar.title = launcherProfileEdit ? '编辑头像' : '';
            launcherProfileAvatar.setAttribute('aria-label', launcherProfileEdit ? '编辑头像' : (profile.name || '头像'));
        }
    }

    if (launcherProfileAvatar) {
        const onAvatarClick = () => {
            if (launcherProfileEdit) launcherProfileEdit();
        };
        launcherProfileAvatar.addEventListener('click', onAvatarClick);
        cleanupListeners.push(() => launcherProfileAvatar.removeEventListener('click', onAvatarClick));
    }

    // 名字点一下就能改：回车或点别处保存，Esc 放弃；空名字不保存
    if (launcherProfileName) {
        const onNameFocus = () => {
            if (launcherProfileName.readOnly || !launcherProfileRename) return;
            launcherNameEdit = { rename: launcherProfileRename, original: launcherProfileNameValue };
        };
        const onNameKeydown = (e) => {
            if (!launcherNameEdit) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                launcherProfileName.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                launcherProfileName.value = launcherNameEdit.original;
                launcherProfileName.blur();
            }
        };
        const onNameBlur = async () => {
            const edit = launcherNameEdit;
            launcherNameEdit = null;
            if (!edit) return;
            const next = launcherProfileName.value.trim();
            if (!next || next === edit.original) {
                launcherProfileName.value = edit.original;
                return;
            }
            launcherProfileName.value = next;
            try {
                const result = await edit.rename(next);
                if (result === false || result?.error) throw new Error(result?.error || 'rename-failed');
                if (launcherProfileNameValue === edit.original) launcherProfileNameValue = next;
            } catch (error) {
                console.warn('[SidePaneController] Failed to rename:', error);
                if (!launcherNameEdit && launcherProfileName.value === next) launcherProfileName.value = edit.original;
            }
        };
        launcherProfileName.addEventListener('focus', onNameFocus);
        launcherProfileName.addEventListener('keydown', onNameKeydown);
        launcherProfileName.addEventListener('blur', onNameBlur);
        cleanupListeners.push(() => {
            launcherProfileName.removeEventListener('focus', onNameFocus);
            launcherProfileName.removeEventListener('keydown', onNameKeydown);
            launcherProfileName.removeEventListener('blur', onNameBlur);
        });
    }

    // 工具 / 应用 / 通知 三页。通知页就是状态里的通知标签（铃铛、关完标签后的兜底都落在这里），
    // 工具和应用记在 launcherTab 里；没有应用来源也没有通知页时不显示切换条
    function currentLauncherSegment() {
        return launcherNotificationsSection && state.activeTabId === SidePaneState.NOTIFICATIONS_TAB_ID
            ? 'notifications'
            : launcherTab;
    }

    function syncLauncherSections() {
        if (!launcherAppsProvider) launcherTab = 'tools';
        const segment = currentLauncherSegment();
        if (launcherTabs) {
            launcherTabs.hidden = !launcherAppsProvider && !launcherNotificationsSection;
            launcherTabs.querySelectorAll('[data-launcher-tab]').forEach(btn => {
                const key = btn.getAttribute('data-launcher-tab');
                btn.hidden = key === 'apps' && !launcherAppsProvider;
                const selected = key === segment;
                btn.setAttribute('aria-selected', String(selected));
                btn.tabIndex = selected ? 0 : -1;
            });
        }
        if (launcherView) launcherView.dataset.launcherSegment = segment;
        const hasEntries = getAvailableOpenTabEntries().length > 0;
        if (launcherToolsGroup) launcherToolsGroup.hidden = !hasEntries;
        if (launcherToolsSection) {
            launcherToolsSection.hidden = segment !== 'tools' || (!hasEntries && launcherRecommended.size === 0);
        }
        if (launcherAppsSection) launcherAppsSection.hidden = segment !== 'apps';
        if (launcherNotificationsSection) launcherNotificationsSection.hidden = segment !== 'notifications';
    }

    function selectLauncherTab(tab) {
        if (tab === 'notifications' && launcherNotificationsSection) {
            controller.showNotifications();
            return;
        }
        const next = tab === 'apps' && launcherAppsProvider ? 'apps' : 'tools';
        if (state.activeTabId === SidePaneState.NOTIFICATIONS_TAB_ID) {
            launcherTab = next;
            controller.showLauncher();
            return;
        }
        if (next === launcherTab) return;
        launcherTab = next;
        if (launcherTab === 'apps') renderLauncherApps();
        else renderLauncherRecommended();
        syncLauncherSections();
    }

    function readLauncherItems(provider, what) {
        try {
            return provider?.() || [];
        } catch (error) {
            console.warn(`[SidePaneController] Failed to read launcher ${what}:`, error);
            return [];
        }
    }

    // 应用页和推荐共用的大图标卡片；返回 id -> 条目，点击时按所在区域查表
    function renderLauncherCards(container, apps) {
        const registry = new Map();
        const mounts = [];
        container.replaceChildren(...apps.filter(app => app?.id && !registry.has(app.id)).map(app => {
            registry.set(app.id, app);
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'side-pane-launcher-app';
            btn.setAttribute('data-launcher-app', app.id);
            if (app.title) btn.title = app.title;
            const iconEl = doc.createElement('span');
            iconEl.className = 'side-pane-launcher-app-icon';
            iconEl.setAttribute('aria-hidden', 'true');
            const labelEl = doc.createElement('span');
            labelEl.className = 'side-pane-launcher-app-label';
            labelEl.textContent = app.label || app.id;
            btn.append(iconEl, labelEl);
            if (typeof app.mountIcon === 'function') mounts.push(() => app.mountIcon(btn, iconEl));
            return btn;
        }));
        mounts.forEach(mount => {
            try {
                mount();
            } catch (error) {
                console.warn('[SidePaneController] Failed to draw launcher app icon:', error);
            }
        });
        return registry;
    }

    function renderLauncherApps() {
        if (!launcherAppGrid) return;
        launcherApps = renderLauncherCards(launcherAppGrid, readLauncherItems(launcherAppsProvider, 'apps'));
    }

    function renderLauncherRecommended() {
        if (launcherRecommendedRow) {
            const items = launcherRecommendedProvider ? readLauncherItems(launcherRecommendedProvider, 'recommendations') : [];
            launcherRecommended = renderLauncherCards(launcherRecommendedRow, items);
        }
        if (launcherRecommendedGroup) launcherRecommendedGroup.hidden = launcherRecommended.size === 0;
        if (launcherRecommendedAction) launcherRecommendedAction.hidden = !launcherRecommendedSettings;
        syncLauncherSections();
    }

    async function runLauncherApp(appId, registry = launcherApps) {
        const app = registry.get(appId);
        if (!app || isDisposed) return;
        try {
            await app.open();
        } catch (error) {
            console.error(`[SidePaneController] Failed to open app "${appId}":`, error);
        }
    }

    if (launcherTabs) {
        const onTabsKeydown = (e) => {
            if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
            const tabs = [...launcherTabs.querySelectorAll('[data-launcher-tab]:not([hidden])')];
            const index = tabs.findIndex(btn => btn.getAttribute('data-launcher-tab') === currentLauncherSegment());
            const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            if (!next) return;
            e.preventDefault();
            selectLauncherTab(next.getAttribute('data-launcher-tab'));
            next.focus();
        };
        launcherTabs.addEventListener('keydown', onTabsKeydown);
        cleanupListeners.push(() => launcherTabs.removeEventListener('keydown', onTabsKeydown));
    }

    function createLauncherRow({ icon, label }) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'side-pane-open-tab-button';
        const iconEl = doc.createElement('span');
        iconEl.className = 'vcp-ui-icon';
        iconEl.setAttribute('aria-hidden', 'true');
        iconEl.textContent = icon || 'tab';
        const labelEl = doc.createElement('span');
        labelEl.className = 'side-pane-open-tab-button-label';
        labelEl.textContent = label;
        btn.append(iconEl, labelEl);
        return btn;
    }

    function syncLauncherAddress() {
        if (launcherAddressForm) launcherAddressForm.hidden = !launcherAddressHandler;
    }

    function showLauncherAddressError(message) {
        if (!launcherAddressError) return;
        launcherAddressError.textContent = message || '';
        launcherAddressError.hidden = !message;
    }

    function renderOpenTabEntries() {
        const entries = getAvailableOpenTabEntries();
        launcherList?.replaceChildren(...entries.map(entry => {
            const row = createLauncherRow({ icon: entry.icon, label: entry.label });
            row.setAttribute('data-open-tab-entry', entry.id);
            return row;
        }));
        syncLauncherSections();
        if (resolvedAddChatTabBtn) {
            resolvedAddChatTabBtn.hidden = entries.length === 0;
            const label = entries.length === 1 ? entries[0].label : '新标签页';
            resolvedAddChatTabBtn.title = label;
            resolvedAddChatTabBtn.setAttribute('aria-label', label);
        }
        scheduleTabLayout();
    }

    async function runOpenTabEntry(entryId) {
        const entry = openTabEntryMap.get(entryId);
        hideAllMenus();
        if (!entry || isDisposed) return;
        try {
            await entry.open();
        } catch (error) {
            console.error(`[SidePaneController] Failed to open "${entryId}":`, error);
        }
    }

    // 面板里没有可关的标签时展开：只有一个入口就直接打开它，否则显示新标签页
    async function expandFromEmpty() {
        const entries = getAvailableOpenTabEntries();
        if (entries.length === 1) {
            await runOpenTabEntry(entries[0].id);
        } else {
            controller.showLauncher();
        }
    }

    if (resolvedAddChatTabBtn) {
        // 和浏览器一样，「+」打开新标签页；只登记了一个入口时直接打开它
        const onAddClick = (e) => {
            e.stopPropagation();
            const entries = getAvailableOpenTabEntries();
            if (entries.length === 0) return;
            if (entries.length === 1) {
                runOpenTabEntry(entries[0].id);
                return;
            }
            hideAllMenus();
            controller.showLauncher();
            launcherAddressInput?.focus?.();
        };
        resolvedAddChatTabBtn.addEventListener('click', onAddClick);
        cleanupListeners.push(() => resolvedAddChatTabBtn.removeEventListener('click', onAddClick));
    }

    if (launcherView) {
        const onLauncherClick = (e) => {
            const entryBtn = e.target.closest('[data-open-tab-entry]');
            if (entryBtn) {
                runOpenTabEntry(entryBtn.getAttribute('data-open-tab-entry'));
                return;
            }
            const tabBtn = e.target.closest('[data-launcher-tab]');
            if (tabBtn) {
                selectLauncherTab(tabBtn.getAttribute('data-launcher-tab'));
                return;
            }
            const appBtn = e.target.closest('[data-launcher-app]');
            if (appBtn) {
                const registry = launcherRecommendedRow?.contains(appBtn) ? launcherRecommended : launcherApps;
                runLauncherApp(appBtn.getAttribute('data-launcher-app'), registry);
                return;
            }
            if (launcherRecommendedAction?.contains(e.target)) {
                try {
                    launcherRecommendedSettings?.();
                } catch (error) {
                    console.error('[SidePaneController] Failed to open recommendation settings:', error);
                }
            }
        };
        launcherView.addEventListener('click', onLauncherClick);
        cleanupListeners.push(() => launcherView.removeEventListener('click', onLauncherClick));
    }

    if (launcherAddressForm && launcherAddressInput) {
        const onAddressSubmit = async (e) => {
            e.preventDefault();
            const text = launcherAddressInput.value.trim();
            if (!text || !launcherAddressHandler) return;
            try {
                const result = await launcherAddressHandler(text);
                if (result?.error) {
                    showLauncherAddressError(result.error);
                    return;
                }
                launcherAddressInput.value = '';
                showLauncherAddressError('');
            } catch (error) {
                console.error('[SidePaneController] Failed to open address:', error);
                showLauncherAddressError('打开失败');
            }
        };
        const onAddressInput = () => showLauncherAddressError('');
        launcherAddressForm.addEventListener('submit', onAddressSubmit);
        launcherAddressInput.addEventListener('input', onAddressInput);
        cleanupListeners.push(() => {
            launcherAddressForm.removeEventListener('submit', onAddressSubmit);
            launcherAddressInput.removeEventListener('input', onAddressInput);
        });
    }
    syncLauncherAddress();

    openTabEntries.forEach(entry => controller.registerOpenTabEntry(entry));

    // Initial render
    renderOpenTabEntries();
    renderTabList();
    renderTabOverviewPopover();
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
