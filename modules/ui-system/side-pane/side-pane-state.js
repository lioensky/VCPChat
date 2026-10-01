/* Pure state transitions and validation for the Workspace Side Pane and Side Chat. */
'use strict';

import { getTabIconName } from './side-pane-tab-utils.js';

export const SCHEMA_VERSION = 1;
export const DEFAULT_WIDTH = 360;
export const MIN_WIDTH = 240;
export const MAX_WIDTH = 800;
export const NOTIFICATIONS_TAB_ID = 'notifications';

export const TAB_KINDS = Object.freeze({
    NOTIFICATIONS: 'notifications',
    CHAT: 'chat'
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

export function getParentKey(parentRef) {
    if (!parentRef) return '';
    return `${parentRef.itemType || 'agent'}:${parentRef.itemId || ''}:${parentRef.topicId || ''}`;
}

export function freezeDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
        throw new TypeError('SideChatDescriptor must be an object');
    }
    if (!descriptor.id || typeof descriptor.id !== 'string') {
        throw new TypeError('SideChatDescriptor requires a string id');
    }
    if (!descriptor.parent || typeof descriptor.parent !== 'object') {
        throw new TypeError('SideChatDescriptor requires a parent conversation reference');
    }
    if (!descriptor.child || typeof descriptor.child !== 'object') {
        throw new TypeError('SideChatDescriptor requires a child conversation reference');
    }
    if (descriptor.parent.topicId === descriptor.child.topicId) {
        throw new Error('Child topicId must differ from parent topicId');
    }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        id: descriptor.id,
        parent: Object.freeze({
            itemType: descriptor.parent.itemType || 'agent',
            itemId: String(descriptor.parent.itemId || ''),
            topicId: String(descriptor.parent.topicId || '')
        }),
        child: Object.freeze({
            itemType: descriptor.child.itemType || 'agent',
            itemId: String(descriptor.child.itemId || ''),
            topicId: String(descriptor.child.topicId || '')
        }),
        title: String(descriptor.title || '辅助对话'),
        createdAt: Number.isFinite(descriptor.createdAt) ? descriptor.createdAt : Date.now(),
        contextMode: descriptor.contextMode === 'parent-snapshot' ? 'parent-snapshot' : 'references-only',
        snapshotId: descriptor.snapshotId ? String(descriptor.snapshotId) : undefined,
        model: descriptor.model ? String(descriptor.model) : undefined,
        parentSnapshot: Array.isArray(descriptor.parentSnapshot) ? descriptor.parentSnapshot : []
    });
}

export function createInitialSidePaneState(options = {}) {
    const preferredWidth = Number.isFinite(options.preferredWidth)
        ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(options.preferredWidth)))
        : DEFAULT_WIDTH;

    const initialTabs = [NOTIFICATIONS_TAB];
    if (Array.isArray(options.tabs)) {
        options.tabs.forEach(tab => {
            if (tab && tab.id !== NOTIFICATIONS_TAB_ID && tab.kind === 'chat' && tab.descriptor) {
                initialTabs.push(Object.freeze({
                    id: tab.id,
                    kind: 'chat',
                    title: tab.title || tab.descriptor.title || '辅助对话',
                    descriptor: freezeDescriptor(tab.descriptor)
                }));
            }
        });
    }

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
        ? state.tabs.filter(t => t.kind === 'chat' && t.descriptor && matchesConversation(t.descriptor.parent, parentRef))
        : [];

    // Workspace/global tools survive topic changes, including their collapsed state.
    const active = state.tabs.find(tab => tab.id === state.activeTabId);
    if (active?.scopeMode === 'global' && active.id !== NOTIFICATIONS_TAB_ID) {
        return { activeTabId: active.id, visible: state.visible };
    }
    if (state.activeTabId === LAUNCHER_TAB_ID) return { activeTabId: LAUNCHER_TAB_ID, visible: state.visible };

    if (parentChatTabs.length === 0) {
        const tool = state.tabs.find(tab => tab.scopeMode === 'global' && tab.id !== NOTIFICATIONS_TAB_ID);
        if (tool) return { activeTabId: tool.id, visible: state.visible };
        // Auto-collapse per ZCode resolveSidePaneScopeState parity when owner has no tabs
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
    if (tabId !== LAUNCHER_TAB_ID && !state.tabs.some(tab => tab.id === tabId)) return state;
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

export function openTab(state, rawTab) {
    if (!rawTab || typeof rawTab !== 'object' || !rawTab.id) {
        throw new TypeError('SidePaneTab requires an object with a valid id');
    }
    const kind = rawTab.kind || 'chat';
    const id = String(rawTab.id);
    const title = String(rawTab.title || '标签页');
    const icon = rawTab.icon ? String(rawTab.icon) : getTabIconName({ kind });
    const scopeMode = rawTab.scopeMode || (kind === 'chat' ? 'topic' : 'global');
    const closable = rawTab.closable !== undefined ? Boolean(rawTab.closable) : (id !== NOTIFICATIONS_TAB_ID);

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

    const isVisibleForCurrentParent = scopeMode === 'global' || !state.parent || (
        rawTab.descriptor?.parent && matchesConversation(rawTab.descriptor.parent, state.parent)
    );

    return Object.freeze({
        ...state,
        visible: isVisibleForCurrentParent ? true : state.visible,
        activeTabId: isVisibleForCurrentParent ? targetTabId : state.activeTabId,
        tabs: nextTabs
    });
}

export function openChatTab(state, rawDescriptor) {
    const descriptor = freezeDescriptor(rawDescriptor);
    const existingIndex = state.tabs.findIndex(tab => tab.id === descriptor.id || (
        tab.kind === 'chat' && tab.descriptor && tab.descriptor.child.topicId === descriptor.child.topicId
    ));

    const targetTabId = existingIndex >= 0 ? state.tabs[existingIndex].id : descriptor.id;

    return openTab(state, {
        id: targetTabId,
        kind: 'chat',
        type: 'selection-side-chat',
        ephemeral: true,
        title: descriptor.title,
        icon: 'chat_bubble',
        closable: true,
        scopeMode: 'topic',
        descriptor
    });
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

export function getVisibleTabs(state, parentRef = null) {
    if (!parentRef) return state.tabs;
    return state.tabs.filter(tab => {
        if (tab.id === NOTIFICATIONS_TAB_ID) return true;
        if (tab.scopeMode === 'global') return true;
        if (tab.kind === 'chat' && tab.descriptor) {
            return matchesConversation(tab.descriptor.parent, parentRef);
        }
        return true;
    });
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
    freezeDescriptor,
    createInitialSidePaneState,
    setVisible,
    setPreferredWidth,
    resolveSidePaneScopeState,
    setParent,
    activateTab,
    showNotifications,
    showLauncher,
    openTab,
    openChatTab,
    closeTab,
    reorderTabs,
    getVisibleTabs,
    getClosableVisibleTabs
});

if (typeof globalThis !== 'undefined') {
    globalThis.VCPSidePaneState = api;
}

export default api;
