/**
 * model-picker-popup.js
 * 通用的 AI 模型选择弹层组件引擎。
 * 
 * 核心设计原则：
 * 1. 视图与业务解耦：纯 DOM 驱动，不绑定特定的 Agent 配置或侧栏 Descriptor，通过回调与宿主通讯；
 * 2. 块级文档流渲染：列表采用原生 block 流式布局与 DocumentFragment 批量挂载，全量渲染 1000+ 模型零弹性挤压；
 * 3. 常用候选池共享：统一读取与同步 localStorage['vcp-composer-checked-models']，支持左键直选与右键勾选配置；
 * 4. 健壮的防穿透与事件防御：拦截 Esc/Enter，失焦自动回收，避免弹层与外部快捷键抢占。
 */
'use strict';

const CHECKED_STORAGE_KEY = 'vcp-composer-checked-models';
const POPUP_STYLE_ID = 'vcp-model-picker-popup-style';

const POPUP_CSS = `
.vcp-model-picker-popup {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 1000;
    width: 280px;
    max-width: calc(100vw - 32px);
    padding: 6px;
    border-radius: 10px;
    background: var(--vcp-ui-surface-raised, var(--secondary-bg, #2b2f31));
    color: var(--vcp-ui-text-0, var(--primary-text, #e6e9ea));
    border: 1px solid var(--vcp-ui-border, rgba(127,127,127,.25));
    box-shadow: 0 8px 24px rgba(0,0,0,.28);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
}
.vcp-model-picker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 6px 8px;
    font-size: 12px;
    font-weight: 600;
    border-bottom: 1px solid var(--vcp-ui-border, rgba(127,127,127,.18));
    margin-bottom: 6px;
}
.vcp-model-picker-header-title {
    display: flex;
    align-items: center;
    gap: 4px;
}
.vcp-model-picker-header-count {
    font-size: 11px;
    opacity: .65;
    font-weight: normal;
}
.vcp-model-picker-actions {
    display: flex;
    gap: 8px;
    font-size: 11px;
}
.vcp-model-picker-action-btn {
    border: 0;
    background: transparent;
    color: var(--vcp-ui-accent, #4daafc);
    cursor: pointer;
    padding: 0;
    font: inherit;
}
.vcp-model-picker-action-btn:hover {
    text-decoration: underline;
}
.vcp-model-picker-search {
    box-sizing: border-box;
    width: 100%;
    height: 28px;
    margin: 0 0 6px;
    padding: 0 8px;
    border-radius: 6px;
    border: 1px solid var(--vcp-ui-border, rgba(127,127,127,.25));
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 13px;
    outline: none;
}
.vcp-model-picker-search:focus {
    border-color: var(--vcp-ui-accent, #3b82f6);
}
.vcp-model-picker-list {
    display: block !important;
    max-height: 260px;
    overflow-y: auto;
    overflow-x: hidden;
    margin: 0;
    padding: 0;
}
.vcp-model-picker-group {
    display: block;
    padding: 6px 8px 2px;
    font-size: 11px;
    opacity: .6;
    font-weight: 500;
    user-select: none;
}
.vcp-model-picker-item,
.vcp-model-picker-check-item {
    display: flex !important;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 26px;
    box-sizing: border-box;
    padding: 3px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 13px;
    line-height: 20px;
    text-align: left;
    cursor: pointer;
    user-select: none;
    flex-shrink: 0 !important;
}
.vcp-model-picker-item:hover,
.vcp-model-picker-item:focus-visible,
.vcp-model-picker-check-item:hover,
.vcp-model-picker-check-item:focus-visible {
    background: var(--vcp-ui-interactive-hover, rgba(127,127,127,.16));
    outline: none;
}
.vcp-model-picker-item .picker-check {
    width: 14px;
    flex: none;
    font-weight: bold;
    color: var(--vcp-ui-text-0, currentColor);
}
.vcp-model-picker-item.active {
    font-weight: 550;
}
.vcp-model-picker-item .picker-name,
.vcp-model-picker-check-item .picker-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
}
.vcp-model-picker-check-box {
    width: 14px;
    height: 14px;
    border: 1px solid var(--vcp-ui-border, rgba(127,127,127,.4));
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    flex: none;
    line-height: 1;
    transition: background-color .1s, border-color .1s;
}
.vcp-model-picker-check-item[aria-checked="true"] .vcp-model-picker-check-box {
    background: var(--vcp-ui-accent, #3b82f6);
    border-color: var(--vcp-ui-accent, #3b82f6);
    color: #fff;
}
.vcp-model-picker-empty {
    padding: 10px 8px;
    font-size: 12px;
    opacity: .7;
    text-align: center;
}
.vcp-model-picker-hint {
    padding: 4px 8px 6px;
    font-size: 11px;
    opacity: .5;
    user-select: none;
}
`;

function ensurePopupStyles(doc = document) {
    if (!doc || doc.getElementById(POPUP_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = POPUP_STYLE_ID;
    style.textContent = POPUP_CSS;
    (doc.head || doc.documentElement).appendChild(style);
}

function resolveStorage(win = globalThis.window) {
    try {
        if (win && win.localStorage) return win.localStorage;
        if (typeof globalThis.localStorage !== 'undefined') return globalThis.localStorage;
    } catch (e) {
        void e;
    }
    return null;
}

const memoryStoreFallback = new Set();

/**
 * 常用模型勾选状态的跨模块与跨窗口持久化存储
 */
export const modelCheckStore = {
    get(win = globalThis.window) {
        try {
            const storage = resolveStorage(win);
            if (!storage) return new Set(memoryStoreFallback);
            const raw = storage.getItem(CHECKED_STORAGE_KEY);
            if (!raw) return new Set();
            const parsed = JSON.parse(raw);
            return new Set(Array.isArray(parsed) ? parsed : []);
        } catch (e) {
            void e;
            return new Set(memoryStoreFallback);
        }
    },
    set(setOrArray, win = globalThis.window) {
        const list = Array.from(setOrArray);
        memoryStoreFallback.clear();
        list.forEach(id => memoryStoreFallback.add(id));
        try {
            const storage = resolveStorage(win);
            if (storage) {
                storage.setItem(CHECKED_STORAGE_KEY, JSON.stringify(list));
            }
            const targetWin = win || (typeof window !== 'undefined' ? window : null);
            if (targetWin && typeof targetWin.dispatchEvent === 'function') {
                const EventCtor = targetWin.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
                if (EventCtor) {
                    targetWin.dispatchEvent(new EventCtor('vcp-checked-models-changed', { detail: list }));
                }
            }
        } catch (e) {
            console.warn('[ModelCheckStore] 保存勾选模型失败:', e);
        }
    },
    subscribe(callback, win = globalThis.window) {
        const targetWin = win || (typeof window !== 'undefined' ? window : null);
        if (!targetWin) return () => {};
        const onStorage = (e) => {
            if (e.key === CHECKED_STORAGE_KEY) callback(modelCheckStore.get(targetWin));
        };
        const onCustom = () => callback(modelCheckStore.get(targetWin));
        targetWin.addEventListener('storage', onStorage);
        targetWin.addEventListener('vcp-checked-models-changed', onCustom);
        return () => {
            targetWin.removeEventListener('storage', onStorage);
            targetWin.removeEventListener('vcp-checked-models-changed', onCustom);
        };
    }
};

/**
 * 通用模型选择器弹层工厂
 * @param {Object} options
 * @param {Document} [options.doc] 宿主文档
 * @param {Window} [options.win] 宿主窗口
 * @param {HTMLElement} options.wrap 容器元素（包含触发按钮和弹层的外壳）
 * @param {HTMLElement} options.trigger 触发按钮
 * @param {Function} options.getCatalog 异步获取完整模型与收藏列表: () => Promise<{ ids: string[], favorites: Set<string> | string[] }>
 * @param {Function} options.getActiveModel 获取当前选中的模型 ID: () => string
 * @param {Function} options.onSelect 选中模型的回调: (modelId: string) => void
 * @param {Function} [options.positionMenu] 自定义定位函数，缺省时吸附于 wrap
 * @param {boolean} [options.enableCheckMenu=true] 是否支持右键打开勾选面板
 */
export function createModelPickerPopup({
    doc = globalThis.document,
    win = globalThis.window || doc?.defaultView,
    wrap,
    trigger,
    getCatalog,
    getActiveModel = () => '',
    onSelect,
    positionMenu: customPositionMenu = null,
    enableCheckMenu = true
}) {
    if (!wrap || !trigger) {
        throw new TypeError('[createModelPickerPopup] requires valid wrap and trigger elements');
    }

    ensurePopupStyles(doc);

    let activeMenu = null;
    let menuResizeObserver = null;
    let isDisposed = false;

    function defaultPositionMenu() {
        if (!activeMenu) return;
        const card = wrap.closest('.chat-input-card, .side-chat-input-card');
        if (card) {
            const cardRect = card.getBoundingClientRect();
            const wrapRect = wrap.getBoundingClientRect();
            activeMenu.style.bottom = `${wrapRect.bottom - cardRect.top + 4}px`;
            activeMenu.style.right = `${wrapRect.right - cardRect.right}px`;
        }
    }

    const positionMenu = customPositionMenu || defaultPositionMenu;

    function close() {
        menuResizeObserver?.disconnect();
        menuResizeObserver = null;
        win?.removeEventListener('resize', positionMenu);
        if (activeMenu) {
            activeMenu.remove();
            activeMenu = null;
        }
        trigger.setAttribute('aria-expanded', 'false');
    }

    function isOpen() {
        return Boolean(activeMenu);
    }

    function getMode() {
        return activeMenu?.dataset?.mode || null;
    }

    /**
     * 打开左键选择菜单（展示常用候选模型）
     */
    async function openSelectMenu() {
        if (isDisposed) return;
        close();
        trigger.setAttribute('aria-expanded', 'true');

        const menuEl = doc.createElement('div');
        menuEl.className = 'vcp-model-picker-popup vcp-model-select-menu side-chat-model-popover';
        menuEl.dataset.mode = 'select';

        const searchInput = doc.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'vcp-model-picker-search side-chat-model-search';
        searchInput.placeholder = '搜索候选模型...';
        searchInput.setAttribute('aria-label', '搜索候选模型');

        const listContainer = doc.createElement('div');
        listContainer.className = 'vcp-model-picker-list side-chat-model-list';
        listContainer.setAttribute('role', 'listbox');

        menuEl.append(searchInput, listContainer);
        wrap.appendChild(menuEl);
        activeMenu = menuEl;

        positionMenu();
        win?.addEventListener('resize', positionMenu);
        if (typeof ResizeObserver !== 'undefined') {
            menuResizeObserver = new ResizeObserver(positionMenu);
            menuResizeObserver.observe(wrap);
            const card = wrap.closest('.chat-input-card, .side-chat-input-card');
            if (card) menuResizeObserver.observe(card);
        }

        listContainer.innerHTML = '<div class="vcp-model-picker-empty">加载中…</div>';

        let catalog = { ids: [], favorites: new Set() };
        try {
            const raw = await getCatalog();
            catalog = {
                ids: Array.isArray(raw?.ids) ? raw.ids : [],
                favorites: raw?.favorites instanceof Set ? raw.favorites : new Set(Array.isArray(raw?.favorites) ? raw.favorites : [])
            };
        } catch (err) {
            console.warn('[ModelPickerPopup] 获取模型目录失败:', err);
        }

        if (activeMenu !== menuEl || isDisposed) return;

        const { ids, favorites: favSet } = catalog;
        const checkedSet = modelCheckStore.get(win);
        // 自适应：若用户从未配置勾选池，默认显示全部模型，避免冷启动白屏
        const isDefaultAll = checkedSet.size === 0;
        const availableIds = isDefaultAll ? ids : ids.filter(id => checkedSet.has(id));
        const currentSelected = getActiveModel();

        const render = () => {
            const q = searchInput.value.trim().toLowerCase();
            listContainer.replaceChildren();

            const match = id => !q || id.toLowerCase().includes(q);
            const favs = availableIds.filter(id => favSet.has(id) && match(id));
            const rest = availableIds.filter(id => !favSet.has(id) && match(id));

            const fragment = doc.createDocumentFragment();

            if (isDefaultAll && availableIds.length > 0 && !q) {
                const hint = doc.createElement('div');
                hint.className = 'vcp-model-picker-hint';
                hint.textContent = '当前显示全部模型（右键按钮可自定义常用候选）';
                fragment.appendChild(hint);
            }

            const addGroup = (title, items) => {
                if (!items.length) return;
                if (title) {
                    const g = doc.createElement('div');
                    g.className = 'vcp-model-picker-group side-chat-model-group';
                    g.textContent = title;
                    fragment.appendChild(g);
                }
                items.forEach(id => {
                    const btn = doc.createElement('button');
                    btn.type = 'button';
                    btn.className = 'vcp-model-picker-item vcp-model-select-item side-chat-model-item' + (id === currentSelected ? ' active' : '');
                    btn.setAttribute('role', 'option');
                    btn.setAttribute('aria-selected', String(id === currentSelected));
                    btn.setAttribute('data-model', id);

                    const checkSpan = doc.createElement('span');
                    checkSpan.className = 'picker-check';
                    checkSpan.textContent = id === currentSelected ? '✓' : '';

                    const nameSpan = doc.createElement('span');
                    nameSpan.className = 'picker-name name';
                    nameSpan.textContent = id;
                    nameSpan.title = id;

                    btn.append(checkSpan, nameSpan);
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        close();
                        if (typeof onSelect === 'function') {
                            onSelect(id);
                        }
                    });
                    fragment.appendChild(btn);
                });
            };

            addGroup(favs.length && rest.length ? '收藏' : '', favs);
            addGroup(favs.length && rest.length ? '全部' : '', rest);

            if (!favs.length && !rest.length) {
                const empty = doc.createElement('div');
                empty.className = 'vcp-model-picker-empty vcp-model-select-empty side-chat-model-empty';
                if (availableIds.length === 0) {
                    empty.textContent = ids.length ? '未勾选任何常用模型（右键按钮进行勾选）' : '没有可用的模型，请检查服务器连接';
                } else {
                    empty.textContent = '没有匹配的模型';
                }
                fragment.appendChild(empty);
            }

            listContainer.appendChild(fragment);
        };

        searchInput.addEventListener('input', render);
        render();
        searchInput.focus();
    }

    /**
     * 打开右键勾选配置菜单（展示全量模型供勾选）
     */
    async function openCheckMenu() {
        if (!enableCheckMenu || isDisposed) return;
        close();
        trigger.setAttribute('aria-expanded', 'true');

        const menuEl = doc.createElement('div');
        menuEl.className = 'vcp-model-picker-popup vcp-model-select-menu';
        menuEl.dataset.mode = 'check';

        const header = doc.createElement('div');
        header.className = 'vcp-model-picker-header';

        const titleBox = doc.createElement('div');
        titleBox.className = 'vcp-model-picker-header-title';
        const titleSpan = doc.createElement('span');
        titleSpan.textContent = '勾选候选模型';
        const countSpan = doc.createElement('span');
        countSpan.className = 'vcp-model-picker-header-count';
        titleBox.append(titleSpan, countSpan);

        const actionsBox = doc.createElement('div');
        actionsBox.className = 'vcp-model-picker-actions';
        const selectAllBtn = doc.createElement('button');
        selectAllBtn.type = 'button';
        selectAllBtn.className = 'vcp-model-picker-action-btn vcp-model-select-action-btn';
        selectAllBtn.textContent = '全选';
        const clearAllBtn = doc.createElement('button');
        clearAllBtn.type = 'button';
        clearAllBtn.className = 'vcp-model-picker-action-btn vcp-model-select-action-btn';
        clearAllBtn.textContent = '清空';
        actionsBox.append(selectAllBtn, clearAllBtn);
        header.append(titleBox, actionsBox);

        const searchInput = doc.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'vcp-model-picker-search';
        searchInput.placeholder = '搜索需要勾选的模型...';
        searchInput.setAttribute('aria-label', '搜索需要勾选的模型');

        const listContainer = doc.createElement('div');
        listContainer.className = 'vcp-model-picker-list';
        listContainer.setAttribute('role', 'group');

        menuEl.append(header, searchInput, listContainer);
        wrap.appendChild(menuEl);
        activeMenu = menuEl;

        positionMenu();
        win?.addEventListener('resize', positionMenu);
        if (typeof ResizeObserver !== 'undefined') {
            menuResizeObserver = new ResizeObserver(positionMenu);
            menuResizeObserver.observe(wrap);
            const card = wrap.closest('.chat-input-card, .side-chat-input-card');
            if (card) menuResizeObserver.observe(card);
        }

        listContainer.innerHTML = '<div class="vcp-model-picker-empty">加载中…</div>';

        let catalog = { ids: [], favorites: new Set() };
        try {
            const raw = await getCatalog();
            catalog = {
                ids: Array.isArray(raw?.ids) ? raw.ids : [],
                favorites: raw?.favorites instanceof Set ? raw.favorites : new Set(Array.isArray(raw?.favorites) ? raw.favorites : [])
            };
        } catch (err) {
            console.warn('[ModelPickerPopup] 获取模型目录失败:', err);
        }

        if (activeMenu !== menuEl || isDisposed) return;

        const { ids, favorites: favSet } = catalog;
        let checkedSet = modelCheckStore.get(win);

        const updateCount = () => {
            countSpan.textContent = `(${checkedSet.size}/${ids.length})`;
        };

        const toggleModel = (id, checked) => {
            if (checked) checkedSet.add(id);
            else checkedSet.delete(id);
            modelCheckStore.set(checkedSet, win);
            updateCount();
        };

        selectAllBtn.onclick = (e) => {
            e.stopPropagation();
            ids.forEach(id => checkedSet.add(id));
            modelCheckStore.set(checkedSet, win);
            render();
        };

        clearAllBtn.onclick = (e) => {
            e.stopPropagation();
            checkedSet.clear();
            modelCheckStore.set(checkedSet, win);
            render();
        };

        const render = () => {
            updateCount();
            const q = searchInput.value.trim().toLowerCase();
            listContainer.replaceChildren();

            const match = id => !q || id.toLowerCase().includes(q);
            const favs = ids.filter(id => favSet.has(id) && match(id));
            const rest = ids.filter(id => !favSet.has(id) && match(id));

            const fragment = doc.createDocumentFragment();

            const addGroup = (title, items) => {
                if (!items.length) return;
                if (title) {
                    const g = doc.createElement('div');
                    g.className = 'vcp-model-picker-group';
                    g.textContent = title;
                    fragment.appendChild(g);
                }
                items.forEach(id => {
                    const isChecked = checkedSet.has(id);
                    const item = doc.createElement('button');
                    item.type = 'button';
                    item.className = 'vcp-model-picker-check-item vcp-model-check-item';
                    item.setAttribute('role', 'checkbox');
                    item.setAttribute('aria-checked', String(isChecked));

                    const box = doc.createElement('span');
                    box.className = 'vcp-model-picker-check-box';
                    box.textContent = isChecked ? '✓' : '';

                    const nameSpan = doc.createElement('span');
                    nameSpan.className = 'picker-name name';
                    nameSpan.textContent = id;
                    nameSpan.title = id;

                    item.append(box, nameSpan);
                    item.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const next = !checkedSet.has(id);
                        toggleModel(id, next);
                        item.setAttribute('aria-checked', String(next));
                        box.textContent = next ? '✓' : '';
                    });
                    fragment.appendChild(item);
                });
            };

            addGroup(favs.length && rest.length ? '收藏' : '', favs);
            addGroup(favs.length && rest.length ? '全部' : '', rest);

            if (!favs.length && !rest.length) {
                const empty = doc.createElement('div');
                empty.className = 'vcp-model-picker-empty vcp-model-select-empty side-chat-model-empty';
                empty.textContent = ids.length ? '没有匹配的模型' : '没有可用的模型，请检查服务器连接';
                fragment.appendChild(empty);
            }

            listContainer.appendChild(fragment);
        };

        searchInput.addEventListener('input', render);
        render();
        searchInput.focus();
    }

    // 事件绑定与拦截防穿透
    const onTriggerClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isOpen() && getMode() === 'select') close();
        else openSelectMenu();
    };

    const onTriggerContextMenu = (e) => {
        if (!enableCheckMenu) return;
        e.preventDefault();
        e.stopPropagation();
        if (isOpen() && getMode() === 'check') close();
        else openCheckMenu();
    };

    const onDocDown = (e) => {
        if (activeMenu && !wrap.contains(e.target)) {
            close();
        }
    };

    const onKeyDown = (e) => {
        if (!activeMenu) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
            trigger.focus?.();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const items = Array.from(activeMenu.querySelectorAll('.vcp-model-picker-item, .vcp-model-picker-check-item'));
            if (!items.length) return;
            const currentIdx = items.indexOf(doc.activeElement);
            e.preventDefault();
            if (e.key === 'ArrowDown') {
                const next = (currentIdx + 1) % items.length;
                items[next]?.focus();
            } else {
                const prev = (currentIdx - 1 + items.length) % items.length;
                items[prev]?.focus();
            }
        } else if (e.key === 'Enter' && (doc.activeElement?.classList?.contains('vcp-model-picker-item') || doc.activeElement?.classList?.contains('vcp-model-picker-check-item'))) {
            e.preventDefault();
            doc.activeElement.click();
        }
    };

    const onWindowBlur = () => {
        if (activeMenu) close();
    };

    trigger.addEventListener('click', onTriggerClick);
    if (enableCheckMenu) trigger.addEventListener('contextmenu', onTriggerContextMenu);
    doc.addEventListener('mousedown', onDocDown, true);
    doc.addEventListener('keydown', onKeyDown, true);
    win?.addEventListener('blur', onWindowBlur);

    return {
        openSelectMenu,
        openCheckMenu,
        close,
        isOpen,
        getMode,
        dispose() {
            if (isDisposed) return;
            isDisposed = true;
            close();
            trigger.removeEventListener('click', onTriggerClick);
            if (enableCheckMenu) trigger.removeEventListener('contextmenu', onTriggerContextMenu);
            doc.removeEventListener('mousedown', onDocDown, true);
            doc.removeEventListener('keydown', onKeyDown, true);
            win?.removeEventListener('blur', onWindowBlur);
        }
    };
}

if (typeof window !== 'undefined') {
    window.ModelPickerPopup = {
        modelCheckStore,
        createModelPickerPopup
    };
}