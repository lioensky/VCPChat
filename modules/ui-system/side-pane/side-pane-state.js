/* Pure state transitions for the Workspace Side Pane. Knows no tab kind except the built-in notifications tab. */
'use strict';

import { getTabIconName } from './side-pane-tab-utils.js';

export const SCHEMA_VERSION = 1;
export const DEFAULT_WIDTH = 360;
export const MIN_WIDTH = 240;
export const MAX_WIDTH = 800;
export const NOTIFICATIONS_TAB_ID = 'notifications';

export const TAB_KINDS = Object.freeze({
    NOTIFICATIONS: 'notifications'
});

export const NOTIFICATIONS_TAB = Object.freeze({
    id: NOTIFICATIONS_TAB_ID,
    kind: 'notifications',
    title: '通知',
    icon: 'notifications',
    closable: false,
    scopeMode: 'global'
});

export function matchesConversation(refA, refB) {
    if (!refA || !refB) return false;
    return refA.itemType === refB.itemType
        && refA.itemId === refB.itemId
        && refA.topicId === refB.topicId;
}

/** 话题级标签所属的对话记在 tab.parent */
export function getTabParent(tab) {
    if (!tab || tab.scopeMode !== 'topic') return null;
    return tab.parent || null;
}

export function getParentKey(parentRef) {
    if (!parentRef) return '';
    return `${parentRef.itemType || 'agent'}:${parentRef.itemId || ''}:${parentRef.topicId || ''}`;
}

export function createInitialSidePaneState(options = {}) {
    const preferredWidth = Number.isFinite(options.preferredWidth)
        ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(options.preferredWidth)))
        : DEFAULT_WIDTH;

    const initialTabs = [NOTIFICATIONS_TAB];

    const activeTabId = options.activeTabId && initialTabs.some(t => t.id === options.activeTabId)
        ? options.activeTabId
        : NOTIFICATIONS_TAB_ID;

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        visible: Boolean(options.visible),
        preferredWidth,
        activeTabId,
        tabs: Object.freeze(initialTabs),
        parent: options.parent ? Object.freeze({ ...options.parent }) : null
    });
}

export function setVisible(state, visible) {
    const nextVisible = Boolean(visible);
    if (state.visible === nextVisible) return state;
    return Object.freeze({
        ...state,
        visible: nextVisible
    });
}

export function setPreferredWidth(state, width, bounds = {}) {
    const min = Number.isFinite(bounds.min) ? bounds.min : MIN_WIDTH;
    const max = Number.isFinite(bounds.max) ? bounds.max : MAX_WIDTH;
    const normalized = Math.max(min, Math.min(max, Math.round(width)));
    if (state.preferredWidth === normalized) return state;
    return Object.freeze({
        ...state,
        preferredWidth: normalized
    });
}

export function resolveSidePaneScopeState(state, parentRef, options = {}) {
    const parentChatTabs = parentRef
        ? state.tabs.filter(t => matchesConversation(getTabParent(t), parentRef))
        : [];

    // 回到一个对话时先还原它上次停留的标签（ZCode workspaceSidePane.ts resolveActiveTabForOwner 也是 preferred 优先）。
    // 否则在 A 话题看辅助对话、切到没有标签的 B 话题落到浏览器，再切回 A 时仍停在浏览器，辅助对话被晾在后面
    const preferred = options.preferredTabId
        ? state.tabs.find(tab => tab.id === options.preferredTabId)
        : null;
    if (preferred && preferred.id !== NOTIFICATIONS_TAB_ID
        && (preferred.scopeMode === 'global' || parentChatTabs.includes(preferred))) {
        // 全局工具沿用当前的展开状态，话题自己的标签按这个话题的展开偏好
        if (preferred.scopeMode === 'global') return { activeTabId: preferred.id, visible: state.visible };
        return { activeTabId: preferred.id, visible: !options.collapsedPreference };
    }

    // Workspace/global tools survive topic changes, including their collapsed state.
    const active = state.tabs.find(tab => tab.id === state.activeTabId);
    if (active?.scopeMode === 'global' && active.id !== NOTIFICATIONS_TAB_ID) {
        return { activeTabId: active.id, visible: state.visible };
    }
    if (state.activeTabId === LAUNCHER_TAB_ID) return { activeTabId: LAUNCHER_TAB_ID, visible: state.visible };

    if (parentChatTabs.length === 0) {
        const tool = state.tabs.find(tab => tab.scopeMode === 'global' && tab.id !== NOTIFICATIONS_TAB_ID);
        if (tool) return { activeTabId: tool.id, visible: state.visible };
        // Auto-collapse when the owner has no tabs
        return {
            activeTabId: NOTIFICATIONS_TAB_ID,
            visible: false
        };
    }

    let resolvedActiveTabId = null;
    if (options.preferredTabId && parentChatTabs.some(t => t.id === options.preferredTabId)) {
        resolvedActiveTabId = options.preferredTabId;
    } else if (parentChatTabs.some(t => t.id === state.activeTabId)) {
        resolvedActiveTabId = state.activeTabId;
    } else {
        resolvedActiveTabId = parentChatTabs[parentChatTabs.length - 1].id;
    }

    const isCollapsed = options.collapsedPreference !== undefined ? Boolean(options.collapsedPreference) : false;

    return {
        activeTabId: resolvedActiveTabId,
        visible: !isCollapsed
    };
}

export function setParent(state, parentRef, options = {}) {
    const nextParent = parentRef
        ? Object.freeze({
            itemType: parentRef.itemType || 'agent',
            itemId: String(parentRef.itemId || ''),
            topicId: String(parentRef.topicId || '')
        })
        : null;

    if (matchesConversation(state.parent, nextParent) && options.force !== true) return state;

    const resolved = resolveSidePaneScopeState({ ...state, parent: nextParent }, nextParent, options);

    return Object.freeze({
        ...state,
        parent: nextParent,
        activeTabId: resolved.activeTabId,
        visible: resolved.visible
    });
}

export const LAUNCHER_TAB_ID = 'launcher';

export function activateTab(state, tabId) {
    if (!tabId || state.activeTabId === tabId) return state;
    if (tabId !== LAUNCHER_TAB_ID && !getVisibleTabs(state, state.parent).some(tab => tab.id === tabId)) return state;
    return Object.freeze({
        ...state,
        activeTabId: tabId
    });
}

export function showNotifications(state) {
    if (state.activeTabId === NOTIFICATIONS_TAB_ID && state.visible) return state;
    return Object.freeze({
        ...state,
        visible: true,
        activeTabId: NOTIFICATIONS_TAB_ID
    });
}

export function showLauncher(state) {
    if (state.activeTabId === LAUNCHER_TAB_ID && state.visible) return state;
    return Object.freeze({
        ...state,
        visible: true,
        activeTabId: LAUNCHER_TAB_ID
    });
}

function normalizeTabFields(rawTab) {
    if (!rawTab || typeof rawTab !== 'object' || !rawTab.id) {
        throw new TypeError('SidePaneTab requires an object with a valid id');
    }
    const kind = String(rawTab.kind || 'tab');
    const id = String(rawTab.id);
    return {
        kind,
        id,
        title: String(rawTab.title || '标签页'),
        icon: rawTab.icon ? String(rawTab.icon) : getTabIconName({ kind }),
        scopeMode: rawTab.scopeMode === 'topic' ? 'topic' : 'global',
        closable: rawTab.closable !== undefined ? Boolean(rawTab.closable) : (id !== NOTIFICATIONS_TAB_ID)
    };
}

export function openTab(state, rawTab) {
    const { kind, id, title, icon, scopeMode, closable } = normalizeTabFields(rawTab);

    const existingIndex = state.tabs.findIndex(t => t.id === id);
    let nextTabs = state.tabs;
    let targetTabId = id;

    if (existingIndex >= 0) {
        targetTabId = state.tabs[existingIndex].id;
        const existing = state.tabs[existingIndex];
        const updated = Object.freeze({
            ...existing,
            ...rawTab,
            title,
            icon,
            closable,
            scopeMode
        });
        const copy = [...state.tabs];
        copy[existingIndex] = updated;
        nextTabs = Object.freeze(copy);
    } else {
        const newTab = Object.freeze({
            ...rawTab,
            id,
            kind,
            title,
            icon,
            closable,
            scopeMode,
            openedAt: Number.isFinite(rawTab.openedAt) ? rawTab.openedAt : Date.now()
        });
        nextTabs = Object.freeze([...state.tabs, newTab]);
    }

    const tabParent = getTabParent({ ...rawTab, scopeMode });
    const isVisibleForCurrentParent = isTabVisibleForParent({ ...rawTab, scopeMode }, state.parent);

    return Object.freeze({
        ...state,
        visible: isVisibleForCurrentParent ? true : state.visible,
        activeTabId: isVisibleForCurrentParent ? targetTabId : state.activeTabId,
        tabs: nextTabs
    });
}

/**
 * 把恢复出来的标签放回状态里：不激活、不展开，已有同 id 的跳过。
 * 只放当前没有的标签；挂载留给第一次激活。
 */
export function restoreTabs(state, rawTabs = []) {
    const known = new Set(state.tabs.map(tab => tab.id));
    const added = [];
    for (const rawTab of rawTabs) {
        let fields;
        try { fields = normalizeTabFields(rawTab); } catch { continue; }
        if (known.has(fields.id) || fields.id === NOTIFICATIONS_TAB_ID) continue;
        known.add(fields.id);
        added.push(Object.freeze({
            ...rawTab,
            ...fields,
            openedAt: Number.isFinite(rawTab.openedAt) ? rawTab.openedAt : Date.now()
        }));
    }
    if (added.length === 0) return state;
    return Object.freeze({ ...state, tabs: Object.freeze([...state.tabs, ...added]) });
}

function isClosable(tab) {
    return tab.id !== NOTIFICATIONS_TAB_ID && tab.closable !== false;
}

/** 当前对话下还能关的标签（通知页常驻，不算） */
export function getClosableVisibleTabs(state, parentRef = state.parent) {
    return getVisibleTabs(state, parentRef).filter(isClosable);
}

export function closeTab(state, tabId, options = {}) {
    if (!tabId || tabId === NOTIFICATIONS_TAB_ID) return state;
    const target = state.tabs.find(tab => tab.id === tabId);
    if (!target || !isClosable(target)) return state;

    const nextTabs = Object.freeze(state.tabs.filter(tab => tab.id !== tabId));
    let nextActiveTabId = state.activeTabId;
    const visibleBefore = getVisibleTabs(state, state.parent);
    const index = visibleBefore.findIndex(tab => tab.id === tabId);

    if (state.activeTabId === tabId) {
        // 只在当前对话看得见的标签里找替补：先左邻，再右邻，最后回到通知页
        const fallback = visibleBefore[index - 1] && visibleBefore[index - 1].id !== NOTIFICATIONS_TAB_ID
            ? visibleBefore[index - 1]
            : visibleBefore[index + 1] || visibleBefore[index - 1] || NOTIFICATIONS_TAB;
        nextActiveTabId = fallback.id;
    }

    const next = Object.freeze({ ...state, activeTabId: nextActiveTabId, tabs: nextTabs });
    // 关掉的是当前对话最后一个可关标签时，面板收起；后台清理别的对话的标签不影响面板
    return options.collapseWhenEmpty !== false && index !== -1 && getClosableVisibleTabs(next).length === 0
        ? Object.freeze({ ...next, activeTabId: NOTIFICATIONS_TAB_ID, visible: false })
        : next;
}

/** 只改标题 / payload，不激活、不改可见性（比如浏览器标签跟着页面标题走） */
export function updateTab(state, tabId, patch = {}) {
    const index = state.tabs.findIndex(tab => tab.id === tabId);
    if (index === -1) return state;
    const current = state.tabs[index];
    const title = typeof patch.title === 'string' && patch.title.trim() ? patch.title.trim() : current.title;
    const payload = patch.payload && typeof patch.payload === 'object' ? patch.payload : current.payload;
    if (title === current.title && payload === current.payload) return state;
    const copy = [...state.tabs];
    copy[index] = Object.freeze({ ...current, title, payload });
    return Object.freeze({ ...state, tabs: Object.freeze(copy) });
}

/** 把 activeId 挪到 overId 的位置（arrayMove 语义）。通知标签始终留在最前面。 */
export function reorderTabs(state, activeId, overId) {
    if (!activeId || !overId || activeId === overId) return state;
    if (activeId === NOTIFICATIONS_TAB_ID) return state;
    const from = state.tabs.findIndex(t => t.id === activeId);
    const to = state.tabs.findIndex(t => t.id === overId);
    if (from === -1 || to === -1) return state;
    const next = state.tabs.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const notifIndex = next.findIndex(t => t.id === NOTIFICATIONS_TAB_ID);
    if (notifIndex > 0) {
        const [notif] = next.splice(notifIndex, 1);
        next.unshift(notif);
    }
    return Object.freeze({ ...state, tabs: Object.freeze(next) });
}

// 话题级标签只在所属对话里可见；没有当前对话（群组、启动早期）时一律不可见，
// 否则「关闭所有」会关掉、进而删除别的对话的辅助对话（对照 ZCode workspaceSidePane.ts isSidePaneTabVisibleForParent）
export function isTabVisibleForParent(tab, parentRef) {
    if (tab.id === NOTIFICATIONS_TAB_ID || tab.scopeMode === 'global') return true;
    const tabParent = getTabParent(tab);
    if (!tabParent) return true;
    return matchesConversation(tabParent, parentRef);
}

export function getVisibleTabs(state, parentRef = null) {
    return state.tabs.filter(tab => isTabVisibleForParent(tab, parentRef));
}

const api = Object.freeze({
    SCHEMA_VERSION,
    DEFAULT_WIDTH,
    MIN_WIDTH,
    MAX_WIDTH,
    NOTIFICATIONS_TAB_ID,
    NOTIFICATIONS_TAB,
    TAB_KINDS,
    LAUNCHER_TAB_ID,
    matchesConversation,
    getParentKey,
    createInitialSidePaneState,
    setVisible,
    setPreferredWidth,
    resolveSidePaneScopeState,
    setParent,
    activateTab,
    showNotifications,
    showLauncher,
    openTab,
    restoreTabs,
    closeTab,
    reorderTabs,
    getVisibleTabs,
    isTabVisibleForParent,
    getClosableVisibleTabs,
    getTabParent
});

if (typeof globalThis !== 'undefined') {
    globalThis.VCPSidePaneState = api;
}

export default api;
