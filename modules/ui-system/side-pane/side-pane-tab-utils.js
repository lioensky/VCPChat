/**
 * modules/ui-system/side-pane/side-pane-tab-utils.js
 * 侧栏标签条用到的纯函数：搜索排序、类型标签、溢出判定、拖拽排序落点。
 *
 * 搜索排序与溢出判定移植自 ZCode（https://github.com/zai-org/ZCode，Apache-2.0）的
 * packages/ui/src/app-shell/sidePaneTabSearch.ts 与 sidePaneLayout.ts，去掉类型声明后保持算法不变。
 */

'use strict';

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

function normalizeSearchText(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
}

export function buildSearchFields(title, hint, typeLabel) {
    return {
        title: normalizeSearchText(title),
        hint: normalizeSearchText(hint),
        typeLabel: normalizeSearchText(typeLabel),
        all: normalizeSearchText(`${title} ${hint} ${typeLabel}`)
    };
}

export function normalizeSearchQuery(query) {
    return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

function hasWordPrefix(value, part) {
    return value.split(/[\s/_.:-]+/).some((word) => word.startsWith(part));
}

function getSearchScore(fields, queryParts) {
    if (!queryParts.every((part) => fields.all.includes(part))) return 0;
    return queryParts.reduce((score, part) => {
        if (fields.title.startsWith(part)) return score + 120;
        if (hasWordPrefix(fields.title, part)) return score + 90;
        if (fields.title.includes(part)) return score + 70;
        if (fields.hint.includes(part)) return score + 40;
        if (fields.typeLabel.includes(part)) return score + 20;
        return score + 1;
    }, 0);
}

export function filterAndRankSearchItems(items, queryParts) {
    if (!queryParts || queryParts.length === 0) return items;
    return items
        .map((item, index) => ({ item, index, score: getSearchScore(item.searchFields, queryParts) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map((entry) => entry.item);
}

// ---------------------------------------------------------------------------
// 标签展示
// ---------------------------------------------------------------------------

// 只有框架自带的两类标签在这里给默认值；其他标签由打开它的模块在 openTab 时带上 typeLabel / icon / searchHint。
const TYPE_LABELS = Object.freeze({
    notifications: '通知',
    chat: '辅助对话'
});

const DEFAULT_ICONS = Object.freeze({
    notifications: 'notifications',
    chat: 'chat_bubble'
});

export function getTabTypeLabel(tab, getTabType = () => null) {
    if (typeof tab?.typeLabel === 'string' && tab.typeLabel) return tab.typeLabel;
    return getTabType(tab?.kind)?.label || TYPE_LABELS[tab?.kind] || '标签页';
}

export function getTabIconName(tab, getTabType = () => null) {
    return tab?.icon || getTabType(tab?.kind)?.icon || DEFAULT_ICONS[tab?.kind] || 'tab';
}

/** 搜索提示：标题里没有、但用户可能记得的内容（URL、文件路径等），由打开标签的模块提供 */
export function getTabSearchHint(tab, getTabType = () => null) {
    return typeof tab?.searchHint === 'string' ? tab.searchHint : getTabType(tab?.kind)?.searchHint || '';
}

export function formatRelativeTime(timestamp, now = Date.now()) {
    const diff = Math.max(0, now - Number(timestamp || 0));
    if (diff < 60_000) return '刚刚';
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    return `${Math.floor(hours / 24)}天前`;
}

// ---------------------------------------------------------------------------
// 标签条布局
// ---------------------------------------------------------------------------

export const TAB_MIN_WIDTH_PX = 32;
export const TAB_ACTIVE_MIN_WIDTH_PX = 96;
export const TAB_GAP_PX = 4;
const TAB_OVERFLOW_TOLERANCE_PX = 1;

/**
 * 只用"激活标签与其余标签最小宽度之和"这个稳定预算判断溢出，避免"新增按钮在标签条里外来回搬"改变视口宽度后形成反馈环。
 */
export function resolveTabsOverflow({ addButtonInside, addButtonWidth, tabCount, viewportWidth }) {
    const tabsBaseWidth = tabCount > 0 ? TAB_ACTIVE_MIN_WIDTH_PX + (tabCount - 1) * TAB_MIN_WIDTH_PX : 0;
    const tabsWidth = tabsBaseWidth + Math.max(0, tabCount - 1) * TAB_GAP_PX;
    const addButtonGap = tabCount > 0 ? TAB_GAP_PX : 0;
    const viewportWidthWithAddButtonInside = viewportWidth + (addButtonInside ? 0 : addButtonWidth);
    const contentWidthWithAddButtonInside = tabsWidth + addButtonGap + addButtonWidth;
    return contentWidthWithAddButtonInside > viewportWidthWithAddButtonInside + TAB_OVERFLOW_TOLERANCE_PX;
}

// ---------------------------------------------------------------------------
// 拖拽排序
// ---------------------------------------------------------------------------

/**
 * 依据拖动中心点找到目标下标：取中心点距离最近的一格（与 dnd-kit 的 closestCenter 一致）。
 * `rects` 为按 DOM 顺序排列的 { left, width }。
 */
export function findClosestCenterIndex(rects, pointerX) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    rects.forEach((rect, index) => {
        const distance = Math.abs(rect.left + rect.width / 2 - pointerX);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    });
    return bestIndex;
}

/** 拖动 activeId 到 overId 所在位置（arrayMove 语义），ids 不含则原样返回 */
export function moveIdBefore(ids, activeId, overId) {
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    if (from === -1 || to === -1 || from === to) return ids;
    const next = ids.slice();
    next.splice(from, 1);
    next.splice(to, 0, activeId);
    return next;
}
