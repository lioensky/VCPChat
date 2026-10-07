/* Side pane tab strip: tab buttons, hover tooltip, overflow layout, keyboard and drag reorder. */
'use strict';

import { createTabSortable } from './side-pane-tab-dnd.js';
import { findByTabId, getTabIconName, resolveTabsOverflow } from './side-pane-tab-utils.js';

// 标签标题悬停提示、面板切换动画、可拖拽排序的标签
const TAB_TOOLTIP_DELAY_MS = 1500;

/**
 * 标签条只管画和交互，标签数据和动作都从外面来：
 *   getTabs() / getActiveTabId()   当前要显示的标签
 *   isClosable(tab)                是否画关闭按钮
 *   statusTabId / getStatus()      带状态圆点的标签（通知）和它的 { status, text }
 *   onActivate(tabId, { focus }) / onClose / onReorder / onContextMenu / onRendered
 *     键盘切换时传 { focus: false }：焦点留在标签上，不挪进面板
 */
export function createSidePaneTabStrip({
    tabListElement,
    addButton = null,
    getTabs,
    getTabType = () => null,
    getActiveTabId,
    isClosable,
    statusTabId = null,
    getStatus = () => null,
    onActivate,
    onClose,
    onReorder,
    onContextMenu,
    onRendered = () => {}
}) {
    const doc = tabListElement.ownerDocument;
    const win = doc.defaultView;
    const cleanups = [];
    let disposed = false;
    let tooltipEl = null;
    let tooltipTimer = null;
    let dragging = false;
    let renderPending = false;
    let layoutRaf = 0;
    let lastRenderedActiveTabId = null;
    let scrollActivePending = false;
    let tooltipAnchor = null;
    const itemEntries = new Map();

    // 新增按钮不溢出时住在标签条末尾，溢出时回到右侧操作区原来的位置
    const addButtonHome = addButton?.parentElement || null;
    const addButtonHomeNext = addButton?.nextSibling || null;

    function hideTooltip() {
        if (tooltipTimer) {
            win.clearTimeout(tooltipTimer);
            tooltipTimer = null;
        }
        if (tooltipEl) {
            tooltipEl.remove();
            tooltipEl = null;
        }
        tooltipAnchor = null;
    }

    function scheduleTooltip(anchor, text) {
        hideTooltip();
        if (!anchor || !text) return;
        tooltipAnchor = anchor;
        tooltipTimer = win.setTimeout(() => {
            tooltipTimer = null;
            if (dragging || !anchor.isConnected) return;
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
            tooltipEl = tip;
        }, TAB_TOOLTIP_DELAY_MS);
    }

    function tooltipText(tab) {
        const status = tab.id === statusTabId ? getStatus()?.text || '' : '';
        return status ? `${tab.title} · ${status}` : tab.title;
    }

    function layout() {
        const items = tabListElement.querySelectorAll('.side-pane-tab-item');
        let overflowing = true;
        if (addButton && addButtonHome) {
            const addInside = addButton.parentElement === tabListElement;
            const addButtonWidth = addButton.getBoundingClientRect?.().width || 28;
            const viewportWidth = tabListElement.clientWidth || 0;
            const overflow = resolveTabsOverflow({
                addButtonInside: addInside,
                addButtonWidth,
                tabCount: items.length,
                viewportWidth
            });
            // 视口放不下一个新增按钮（面板收起时只剩内边距那几像素，或没有布局）就当宽度未知，按钮留在右侧操作区。
            // 否则收起状态下两种摆法互相判成对方，按钮每帧搬来搬去，每次搬动都让整页样式重算。
            overflowing = viewportWidth > addButtonWidth ? overflow : true;
            if (!overflowing && !addInside) {
                tabListElement.appendChild(addButton);
            } else if (overflowing && addInside) {
                addButtonHome.insertBefore(addButton, addButtonHomeNext && addButtonHomeNext.parentElement === addButtonHome ? addButtonHomeNext : addButtonHome.firstChild);
            }
        }
        // 溢出时只在还能继续滚动的一侧渐隐
        const maxScrollLeft = Math.max(0, tabListElement.scrollWidth - tabListElement.clientWidth);
        tabListElement.classList.toggle('mask-left', overflowing && tabListElement.scrollLeft > 1);
        tabListElement.classList.toggle('mask-right', overflowing && tabListElement.scrollLeft < maxScrollLeft - 1);
    }

    function scheduleLayout() {
        if (layoutRaf) return;
        const raf = win.requestAnimationFrame || ((cb) => win.setTimeout(cb, 16));
        layoutRaf = raf(() => {
            layoutRaf = 0;
            if (disposed) return;
            layout();
            if (scrollActivePending) {
                scrollActivePending = false;
                scrollActiveIntoView();
            }
        });
    }

    function scrollActiveIntoView() {
        const activeItem = tabListElement.querySelector('.side-pane-tab-item.active');
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

    // 标签上直接写连接状态（“VCPLog 已连接”），“通知”只留在标签名和概览里
    function syncStatus() {
        const current = statusTabId ? getStatus() : null;
        if (!current) return;
        const btn = findByTabId(tabListElement, '.side-pane-tab[data-tab-id]', statusTabId);
        const dot = btn?.querySelector('.side-pane-tab-status');
        if (!dot) return;
        const { status = 'unknown', text = '' } = current;
        dot.dataset.status = status;
        const title = btn.querySelector('.tab-title');
        if (title) title.textContent = text ? text.replace(/:\s*/, ' ') : '通知';
        if (text) btn.setAttribute('aria-label', `通知，${text}`);
        else btn.removeAttribute('aria-label');
    }

    // 结构签名：这些变了才重建这一项；标题、激活态等原地更新（同 ZCode 按 key 复用标签节点）
    function itemSignature(tab) {
        return `${isClosable(tab) ? 1 : 0}|${getTabIconName(tab, getTabType)}|${tab.id === statusTabId ? 1 : 0}`;
    }

    function createTabItem(tab, isActive) {
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
        btn.setAttribute('aria-keyshortcuts', isClosable(tab) ? 'Delete Shift+F10' : 'Shift+F10');

        const iconSpan = doc.createElement('span');
        iconSpan.className = 'tab-icon vcp-ui-icon';
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.textContent = getTabIconName(tab, getTabType);

        const titleSpan = doc.createElement('span');
        titleSpan.className = 'tab-title';
        titleSpan.textContent = tab.title;

        btn.append(iconSpan, titleSpan);
        if (tab.id === statusTabId) {
            const statusDot = doc.createElement('span');
            statusDot.className = 'side-pane-tab-status';
            statusDot.setAttribute('aria-hidden', 'true');
            btn.classList.add('has-status');
            btn.appendChild(statusDot);
        }
        btn.addEventListener('click', () => onActivate(tab.id));
        tabItem.appendChild(btn);
        // 复用时标题会变：监听里读 entry.tab，不读创建时的 tab
        const entry = { tab, el: tabItem, btn, titleSpan, closeBtn: null, sig: itemSignature(tab) };

        // 关闭按钮和标签按钮并列
        const closable = isClosable(tab);
        if (closable) {
            const closeBtn = doc.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'side-pane-tab-close';
            closeBtn.setAttribute('aria-label', `关闭 ${tab.title}`);
            closeBtn.setAttribute('tabindex', '-1');
            closeBtn.innerHTML = '<span class="vcp-ui-icon vcp-side-pane-icon-caption" aria-hidden="true">close</span>';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onClose(tab.id);
            });
            tabItem.appendChild(closeBtn);
            entry.closeBtn = closeBtn;
        }

        // 中键关闭（mousedown 拦截浏览器自动滚动，auxclick 关闭且不激活）
        tabItem.addEventListener('mousedown', (e) => {
            if (e.button === 1) e.preventDefault();
        });
        tabItem.addEventListener('auxclick', (e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            e.stopPropagation();
            if (closable) onClose(tab.id);
        });

        // 标题悬停提示：1.5s 后出现，离开/按下/拖拽即消失
        tabItem.addEventListener('mouseenter', () => scheduleTooltip(tabItem, tooltipText(entry.tab)));
        tabItem.addEventListener('mouseleave', hideTooltip);
        tabItem.addEventListener('pointerdown', hideTooltip);

        tabItem.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            hideTooltip();
            // 键盘（Shift+F10 / 菜单键）打开时没有指针坐标，贴着标签下沿出菜单
            let { clientX: x, clientY: y } = e;
            if (!x && !y) {
                const rect = tabItem.getBoundingClientRect();
                x = rect.left + 8;
                y = rect.bottom + 4;
            }
            onContextMenu(tab.id, x, y);
        });
        return entry;
    }

    function updateTabItem(entry, tab, isActive) {
        entry.tab = tab;
        entry.el.classList.toggle('active', isActive);
        entry.btn.classList.toggle('active', isActive);
        entry.btn.setAttribute('aria-selected', String(isActive));
        entry.btn.setAttribute('tabindex', isActive ? '0' : '-1');
        // 通知标签的标题由 syncStatus 写
        if (tab.id !== statusTabId && entry.titleSpan.textContent !== tab.title) entry.titleSpan.textContent = tab.title;
        entry.closeBtn?.setAttribute('aria-label', `关闭 ${tab.title}`);
    }

    function nextItem(el) {
        let node = el?.nextElementSibling || null;
        while (node && !node.classList?.contains('side-pane-tab-item')) node = node.nextElementSibling;
        return node;
    }

    // 按 tabId 复用标签节点，只增删、调顺序、改激活态和标题。原来每次（浏览器每次导航改标题、每次切换）都删光重建，
    // 打断悬停提示，并在同一帧里同步量一次几何；量几何现在推到下一帧（scheduleLayout）。
    function render() {
        // 拖拽期间不动标签节点（换掉或挪动被拖的节点会让拖拽会话挂在旧节点上），松手后补一次
        if (dragging) {
            renderPending = true;
            return;
        }
        renderPending = false;
        tabListElement.setAttribute('role', 'tablist');
        tabListElement.setAttribute('aria-label', '工作区侧栏标签页');

        const activeTabId = getActiveTabId();
        const insertAnchor = addButton?.parentElement === tabListElement ? addButton : null;
        const tabs = getTabs();
        const keep = new Set(tabs.map(tab => tab.id));
        for (const [id, entry] of itemEntries) {
            const stale = !keep.has(id) || entry.sig !== itemSignature(tabs.find(tab => tab.id === id));
            if (!stale) continue;
            if (tooltipAnchor === entry.el) hideTooltip();
            entry.el.remove();
            itemEntries.delete(id);
        }
        // 不归本标签条管理的残留项（比如外部插进来的）一并清掉
        tabListElement.querySelectorAll('.side-pane-tab-item').forEach((el) => {
            if (![...itemEntries.values()].some(entry => entry.el === el)) el.remove();
        });

        let cursor = tabListElement.querySelector('.side-pane-tab-item');
        for (const tab of tabs) {
            const isActive = tab.id === activeTabId;
            let entry = itemEntries.get(tab.id);
            if (entry) updateTabItem(entry, tab, isActive);
            else {
                entry = createTabItem(tab, isActive);
                itemEntries.set(tab.id, entry);
            }
            if (entry.el === cursor) cursor = nextItem(cursor);
            else tabListElement.insertBefore(entry.el, cursor || insertAnchor);
        }
        // 激活的是新标签页或藏起来的通知时没有标签带 tabindex=0，给第一个，标签条仍能用 Tab 键进来
        if (!tabListElement.querySelector('[role="tab"][tabindex="0"]')) {
            tabListElement.querySelector('[role="tab"]')?.setAttribute('tabindex', '0');
        }
        syncStatus();
        onRendered();
        // 新开或切换到的标签在溢出区时滚进可见范围；激活项不变时不打扰用户手动滚动
        if (activeTabId !== lastRenderedActiveTabId) {
            lastRenderedActiveTabId = activeTabId;
            scrollActivePending = true;
        }
        scheduleLayout();
    }

    const sortable = createTabSortable({
        container: tabListElement,
        isDraggable: (item) => item.getAttribute('data-tab-id') !== statusTabId,
        onReorder: (activeId, overId) => onReorder(activeId, overId),
        onDragStateChange: (isDragging) => {
            dragging = isDragging;
            if (isDragging) hideTooltip();
            else if (renderPending) render();
        }
    });
    cleanups.push(() => sortable?.dispose());

    tabListElement.addEventListener('scroll', scheduleLayout, { passive: true });
    cleanups.push(() => tabListElement.removeEventListener('scroll', scheduleLayout));
    if (typeof win.ResizeObserver === 'function') {
        const resizeObserver = new win.ResizeObserver(scheduleLayout);
        resizeObserver.observe(tabListElement);
        cleanups.push(() => resizeObserver.disconnect());
    }

    // 方向键 / Home / End 在标签之间移动并激活（同 ZCode 用的 Radix Tabs：焦点跟着走、自动激活）；Delete 关掉聚焦的标签
    const onKeydown = (e) => {
        const tabButtons = Array.from(tabListElement.querySelectorAll('[role="tab"]'));
        if (tabButtons.length === 0) return;
        if (e.key === 'Delete' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
            const focusedId = e.target?.closest?.('[role="tab"]')?.getAttribute('data-tab-id');
            const focusedTab = focusedId ? getTabs().find(tab => tab.id === focusedId) : null;
            if (focusedTab && isClosable(focusedTab)) {
                e.preventDefault();
                onClose(focusedId);
            }
            return;
        }
        const currentIndex = tabButtons.findIndex(b => b.getAttribute('data-tab-id') === getActiveTabId());
        let targetIndex = currentIndex;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            targetIndex = (currentIndex + 1) % tabButtons.length;
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            // 当前是新标签页（不在标签条上）时，往左落到最后一个
            targetIndex = currentIndex < 0 ? tabButtons.length - 1 : (currentIndex - 1 + tabButtons.length) % tabButtons.length;
        } else if (e.key === 'Home') {
            targetIndex = 0;
        } else if (e.key === 'End') {
            targetIndex = tabButtons.length - 1;
        } else {
            return;
        }
        e.preventDefault();
        if (targetIndex !== currentIndex && targetIndex >= 0 && targetIndex < tabButtons.length) {
            // 焦点跟着移到新标签上（WAI-ARIA Tabs）；激活后按 id 重新取按钮，不依赖激活前拿到的节点
            const targetId = tabButtons[targetIndex].getAttribute('data-tab-id');
            onActivate(targetId, { focus: false });
            findByTabId(tabListElement, '[role="tab"][data-tab-id]', targetId)?.focus?.();
        }
    };
    tabListElement.addEventListener('keydown', onKeydown);
    cleanups.push(() => tabListElement.removeEventListener('keydown', onKeydown));
    cleanups.push(hideTooltip);

    return Object.freeze({
        render,
        layout,
        scheduleLayout,
        scrollActiveIntoView,
        syncStatus,
        hideTooltip,
        focusTab(tabId) {
            findByTabId(tabListElement, '[role="tab"][data-tab-id]', tabId)?.focus?.();
        },
        dispose() {
            disposed = true;
            cleanups.forEach(cleanup => cleanup());
            cleanups.length = 0;
        }
    });
}
