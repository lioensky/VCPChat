/* Side pane tab overview: the popover that searches open and recently closed tabs. */
'use strict';

import {
    buildSearchFields,
    filterAndRankSearchItems,
    formatRelativeTime,
    getTabIconName,
    getTabSearchHint,
    getTabTypeLabel,
    normalizeSearchQuery
} from './side-pane-tab-utils.js';

/**
 * button 打开 / 收起 popover；列表数据和动作都从外面来：
 *   getTabs() / getActiveTabId() / getRecentlyClosed()
 *   isClosable(tab)
 *   onActivate(tabId)   点开一个打开的标签（同时展开面板）
 *   onClose(tabId)      关闭按钮，返回 Promise
 *   onReopen(closedId)  重新打开最近关闭的标签
 *   onShow()            popover 打开前调用，用来收起别的浮层
 */
export function createSidePaneTabOverview({
    button,
    popover,
    getTabs,
    getTabType = () => null,
    getActiveTabId,
    getRecentlyClosed,
    isClosable,
    onActivate,
    onClose,
    onReopen,
    onShow = () => {}
}) {
    const doc = popover.ownerDocument;
    const cleanups = [];
    const listEl = popover.querySelector('#sidePaneOpenTabsList');
    const searchInput = popover.querySelector('.side-pane-overview-input');

    const isOpen = () => !popover.hidden;
    const currentQuery = () => searchInput?.value || '';

    function hide() {
        popover.hidden = true;
        button?.setAttribute('aria-expanded', 'false');
    }

    function createIcon(name) {
        const icon = doc.createElement('span');
        icon.className = 'vcp-ui-icon';
        icon.classList.add('vcp-side-pane-icon-base');
        icon.textContent = name;
        return icon;
    }

    function createItemTitle(iconName, text) {
        const titleDiv = doc.createElement('div');
        titleDiv.className = 'side-pane-overview-item-title';
        const label = doc.createElement('span');
        label.textContent = text;
        titleDiv.append(createIcon(iconName), label);
        return titleDiv;
    }

    function createSectionTitle(text) {
        const title = doc.createElement('div');
        title.className = 'side-pane-overview-section-title';
        title.textContent = text;
        return title;
    }

    function createTime(text) {
        const timeSpan = doc.createElement('span');
        timeSpan.className = 'side-pane-overview-time';
        timeSpan.textContent = text;
        return timeSpan;
    }

    function render(filterQuery = '') {
        if (!listEl) return;
        listEl.innerHTML = '';
        const queryParts = normalizeSearchQuery(filterQuery);
        const activeTabId = getActiveTabId();
        const now = Date.now();

        const openItems = filterAndRankSearchItems(getTabs().map(tab => ({
            tab,
            searchFields: buildSearchFields(tab.title, getTabSearchHint(tab, getTabType), getTabTypeLabel(tab, getTabType))
        })), queryParts);
        const closedItems = filterAndRankSearchItems(getRecentlyClosed().map(closed => ({
            closed,
            searchFields: buildSearchFields(closed.title, getTabSearchHint(closed.tab, getTabType), getTabTypeLabel(closed.tab, getTabType))
        })), queryParts);

        if (openItems.length === 0 && closedItems.length === 0) {
            const emptyEl = doc.createElement('div');
            emptyEl.className = 'side-pane-overview-empty';
            emptyEl.textContent = '未找到匹配的标签页';
            listEl.appendChild(emptyEl);
            return;
        }

        if (openItems.length > 0) {
            listEl.appendChild(createSectionTitle('打开的标签页'));
            openItems.forEach(({ tab }) => {
                const item = doc.createElement('div');
                item.className = `side-pane-overview-item${tab.id === activeTabId ? ' active' : ''}`;
                item.setAttribute('data-tab-id', tab.id);
                item.appendChild(createItemTitle(getTabIconName(tab, getTabType), tab.title));
                if (tab.openedAt) item.appendChild(createTime(formatRelativeTime(tab.openedAt, now)));

                if (isClosable(tab)) {
                    const closeBtn = doc.createElement('button');
                    closeBtn.type = 'button';
                    closeBtn.className = 'side-pane-tab-close';
                    closeBtn.title = '关闭';
                    closeBtn.setAttribute('aria-label', `关闭 ${tab.title}`);
                    closeBtn.innerHTML = '<span class="vcp-ui-icon vcp-side-pane-icon-caption">close</span>';
                    closeBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await onClose(tab.id);
                        render(currentQuery());
                    });
                    item.appendChild(closeBtn);
                }

                item.addEventListener('click', () => {
                    onActivate(tab.id);
                    hide();
                });
                listEl.appendChild(item);
            });
        }

        if (closedItems.length > 0) {
            listEl.appendChild(createSectionTitle('最近关闭的标签页'));
            closedItems.forEach(({ closed }) => {
                const item = doc.createElement('div');
                item.className = 'side-pane-overview-item recently-closed';
                item.setAttribute('data-closed-tab-id', closed.id);
                item.append(createItemTitle(getTabIconName(closed.tab, getTabType), closed.title), createTime(formatRelativeTime(closed.closedAt, now)));
                item.addEventListener('click', async () => {
                    hide();
                    await onReopen(closed.id);
                });
                listEl.appendChild(item);
            });
        }
    }

    if (searchInput) {
        const onSearchInput = () => render(searchInput.value);
        searchInput.addEventListener('input', onSearchInput);
        cleanups.push(() => searchInput.removeEventListener('input', onSearchInput));

        // 键盘操作：上下键移动高亮，回车打开，Esc 关闭并回到触发按钮。
        const onSearchKeydown = (event) => {
            const items = Array.from(popover.querySelectorAll('.side-pane-overview-item'));
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
                hide();
                button?.focus?.();
            }
        };
        searchInput.addEventListener('keydown', onSearchKeydown);
        cleanups.push(() => searchInput.removeEventListener('keydown', onSearchKeydown));
    }

    if (button) {
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', 'false');
        const onButtonClick = (e) => {
            e.stopPropagation();
            if (isOpen()) {
                hide();
                return;
            }
            onShow();
            popover.hidden = false;
            button.setAttribute('aria-expanded', 'true');
            if (searchInput) searchInput.value = '';
            render();
            searchInput?.focus?.();
        };
        button.addEventListener('click', onButtonClick);
        cleanups.push(() => button.removeEventListener('click', onButtonClick));
    }

    // 点外面或按 Esc 收起
    const onDocPointerDown = (e) => {
        if (isOpen() && !popover.contains(e.target) && !button?.contains?.(e.target)) hide();
    };
    const onDocKeydown = (e) => {
        if (e.key !== 'Escape' || !isOpen()) return;
        e.preventDefault();
        hide();
        button?.focus?.();
    };
    // 点进浏览器标签的 webview 或别的窗口时主页面只会失焦
    const win = doc.defaultView;
    const onWindowBlur = () => { if (isOpen()) hide(); };
    doc.addEventListener('pointerdown', onDocPointerDown, true);
    doc.addEventListener('keydown', onDocKeydown);
    win?.addEventListener('blur', onWindowBlur);
    cleanups.push(() => {
        doc.removeEventListener('pointerdown', onDocPointerDown, true);
        doc.removeEventListener('keydown', onDocKeydown);
        win?.removeEventListener('blur', onWindowBlur);
    });

    return Object.freeze({
        isOpen,
        hide,
        render,
        refresh: () => render(currentQuery()),
        dispose() {
            cleanups.forEach(cleanup => cleanup());
            cleanups.length = 0;
        }
    });
}
