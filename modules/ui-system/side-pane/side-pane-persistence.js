/*
 * 副屏布局的持久化：打开的标签、当前标签和展开状态，以及每个对话最后激活的标签和收起状态。
 * 存储格式带版本号，读出来逐项校验，坏数据和不认识的标签类型直接丢掉，不会把副屏带崩。
 * 每个对话的记忆只留最近 PARENT_MEMORY_LIMIT 个（ZCode taskSidePaneMemory.ts 同款上限）。
 */

export const SIDE_PANE_LAYOUT_KEY = 'vcp.sidePane.layout.v1';
export const SIDE_PANE_LAYOUT_VERSION = 1;
export const PARENT_MEMORY_LIMIT = 50;
export const MAX_PERSISTED_TABS = 30;
// 单个标签序列化后超过这个大小就不存（比如很大的 diff），重启后不恢复它
export const MAX_PERSISTED_TAB_CHARS = 64 * 1024;

const TAB_FIELDS = ['id', 'kind', 'title', 'icon', 'closable', 'scopeMode', 'searchHint', 'openedAt'];

/** LRU 写入：刷新 key 的位置，超出上限时丢掉最久没碰过的 */
export function rememberBounded(map, key, value, limit = PARENT_MEMORY_LIMIT) {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
}

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;

function sanitizeParent(parent) {
    if (!isPlainObject(parent)) return null;
    const { itemType, itemId, topicId } = parent;
    if (typeof itemId !== 'string' || typeof topicId !== 'string') return null;
    return { itemType: typeof itemType === 'string' ? itemType : 'agent', itemId, topicId };
}

/** 一个标签能否存下来：类型认识且允许持久化、字段齐全、payload 能 JSON 往返、体积不超限。不行就返回 null。 */
export function sanitizeTab(tab, canPersist) {
    if (!tab || typeof tab.id !== 'string' || !tab.id || typeof tab.kind !== 'string' || !tab.kind) return null;
    if (tab.ephemeral || !canPersist(tab.kind)) return null;
    const out = {};
    for (const field of TAB_FIELDS) {
        const value = tab[field];
        if (value === undefined) continue;
        if (field === 'closable' ? typeof value !== 'boolean'
            : field === 'openedAt' ? !Number.isFinite(value)
                : typeof value !== 'string') continue;
        out[field] = value;
    }
    if (out.scopeMode === 'topic') {
        const parent = sanitizeParent(tab.parent);
        if (!parent) return null;
        out.parent = parent;
    }
    if (tab.payload !== undefined) {
        if (!isPlainObject(tab.payload)) return null;
        try {
            out.payload = JSON.parse(JSON.stringify(tab.payload));
        } catch {
            return null;
        }
    }
    try {
        if (JSON.stringify(out).length > MAX_PERSISTED_TAB_CHARS) return null;
    } catch {
        return null;
    }
    return out;
}

function sanitizeEntries(entries, isValidValue) {
    if (!Array.isArray(entries)) return [];
    return entries
        .filter(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && isValidValue(entry[1]))
        .slice(-PARENT_MEMORY_LIMIT);
}

/**
 * tabs / activeTabId / visible：副屏状态；activeByParent / collapsedByParent：Map(parentKey -> 值)。
 * canPersist(kind)：这种标签能不能存。
 */
export function serializeLayout({
    tabs = [], activeTabId = null, visible = false, activeByParent = new Map(), collapsedByParent = new Map()
}, canPersist) {
    const persistedTabs = tabs.map(tab => sanitizeTab(tab, canPersist)).filter(Boolean).slice(-MAX_PERSISTED_TABS);
    return {
        version: SIDE_PANE_LAYOUT_VERSION,
        tabs: persistedTabs,
        // 当前标签没存下来（比如是辅助对话）时不记，恢复后由对话记忆决定
        activeTabId: persistedTabs.some(tab => tab.id === activeTabId) ? activeTabId : null,
        visible: visible === true,
        activeByParent: [...activeByParent].slice(-PARENT_MEMORY_LIMIT),
        collapsedByParent: [...collapsedByParent].slice(-PARENT_MEMORY_LIMIT)
    };
}

/** 读出来的东西不合格（版本不对、不是对象、JSON 坏了）就返回 null，当作没有存过 */
export function parseLayout(raw, canPersist) {
    let data = raw;
    if (typeof raw === 'string') {
        try { data = JSON.parse(raw); } catch { return null; }
    }
    if (!isPlainObject(data) || data.version !== SIDE_PANE_LAYOUT_VERSION) return null;
    const seen = new Set();
    const tabs = (Array.isArray(data.tabs) ? data.tabs : [])
        .map(tab => sanitizeTab(tab, canPersist))
        .filter(tab => tab && !seen.has(tab.id) && seen.add(tab.id))
        .slice(-MAX_PERSISTED_TABS);
    return {
        tabs,
        activeTabId: typeof data.activeTabId === 'string' && tabs.some(tab => tab.id === data.activeTabId) ? data.activeTabId : null,
        visible: data.visible === true,
        activeByParent: new Map(sanitizeEntries(data.activeByParent, value => typeof value === 'string' && !!value)),
        collapsedByParent: new Map(sanitizeEntries(data.collapsedByParent, value => typeof value === 'boolean'))
    };
}

/**
 * storage 用 localStorage 那套 getItem / setItem。保存做了防抖，页面隐藏或卸载前会立刻写一次。
 * getLayout() 在真正写入时才调用，拿到的总是最新状态。
 */
export function createSidePaneLayoutStore({ storage, key = SIDE_PANE_LAYOUT_KEY, win = null, delayMs = 400, getLayout }) {
    let timer = null;
    let disposed = false;

    function writeNow() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!storage || typeof getLayout !== 'function') return;
        try {
            storage.setItem(key, JSON.stringify(getLayout()));
        } catch (error) {
            console.warn('[SidePaneLayout] Failed to save layout:', error);
        }
    }

    const onPageHide = () => { if (timer) writeNow(); };
    win?.addEventListener?.('pagehide', onPageHide);
    win?.addEventListener?.('beforeunload', onPageHide);

    return Object.freeze({
        load() {
            if (!storage) return null;
            try {
                return storage.getItem(key);
            } catch {
                return null;
            }
        },
        scheduleSave() {
            if (disposed || !storage) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(writeNow, delayMs);
        },
        flush() {
            if (!disposed) writeNow();
        },
        dispose() {
            if (disposed) return;
            if (timer) writeNow();
            disposed = true;
            win?.removeEventListener?.('pagehide', onPageHide);
            win?.removeEventListener?.('beforeunload', onPageHide);
        }
    });
}
