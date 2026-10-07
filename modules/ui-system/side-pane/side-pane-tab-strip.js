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
 *   onActivate / onClose / onReorder / onContextMenu / onRendered
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
    let layoutRaf = 0;
    let lastRenderedActiveTabId = null;

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
    }

    function scheduleTooltip(anchor, text) {
        hideTooltip();
        if (!anchor || !text) return;
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
            const measured = addButton.getBoundingClientRect?.().width || 0;
            const overflow = resolveTabsOverflow({
                addButtonInside: addInside,
                addButtonWidth: measured || 28,
                tabCount: items.length,
                viewportWidth: tabListElement.clientWidth || 0
            });
            // 视口宽度未知（隐藏或无布局）时保持在右侧操作区，避免来回搬动
            overflowing = tabListElement.clientWidth ? overflow : true;
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
            if (!disposed) layout();
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

        // 关闭按钮和标签按钮并列
        const closable = isClosable(tab);
        if (closable) {
            const closeBtn = doc.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'side-pane-tab-close';
            closeBtn.setAttribute('aria-label', `关闭 ${tab.title}`);
            closeBtn.setAttribute('tabindex', '-1');
            closeBtn.innerHTML = '<span class="vcp-ui-icon vcp-side-pane-icon-caption">close</span>';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onClose(tab.id);
            });
            tabItem.appendChild(closeBtn);
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
        tabItem.addEventListener('mouseenter', () => scheduleTooltip(tabItem, tooltipText(tab)));
        tabItem.addEventListener('mouseleave', hideTooltip);
        tabItem.addEventListener('pointerdown', hideTooltip);

        tabItem.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            hideTooltip();
            onContextMenu(tab.id, e.clientX, e.clientY);
        });
        return tabItem;
    }

    function render() {
        hideTooltip();
        // 只清标签项：新增按钮在不溢出时会住在标签条里
        tabListElement.querySelectorAll('.side-pane-tab-item').forEach((el) => el.remove());
        tabListElement.setAttribute('role', 'tablist');
        tabListElement.setAttribute('aria-label', '工作区侧栏标签页');

        const activeTabId = getActiveTabId();
        const insertAnchor = addButton?.parentElement === tabListElement ? addButton : null;
        getTabs().forEach(tab => {
            tabListElement.insertBefore(createTabItem(tab, tab.id === activeTabId), insertAnchor);
        });
        syncStatus();
        onRendered();
        layout();
        // 新开或切换到的标签在溢出区时滚进可见范围；激活项不变时不打扰用户手动滚动
        if (activeTabId !== lastRenderedActiveTabId) {
            lastRenderedActiveTabId = activeTabId;
            scrollActiveIntoView();
        }
    }

    const sortable = createTabSortable({
        container: tabListElement,
        isDraggable: (item) => item.getAttribute('data-tab-id') !== statusTabId,
        onReorder: (activeId, overId) => onReorder(activeId, overId),
        onDragStateChange: (isDragging) => {
            dragging = isDragging;
            if (isDragging) hideTooltip();
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

    // 方向键 / Home / End 在标签之间移动并激活
    const onKeydown = (e) => {
        const tabButtons = Array.from(tabListElement.querySelectorAll('[role="tab"]'));
        if (tabButtons.length === 0) return;
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
            // 激活会重建标签条，旧按钮随之离开文档；焦点留在标签上（WAI-ARIA Tabs），按 id 找重建后的按钮
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
