/**
 * 输入框内的 AI 模型选择器。
 * 位于语音按钮左侧，读写当前 Agent 的 model 配置，与设置页的 Agent 模型保持一致。
 */
(function () {
    const STYLE_ID = 'vcp-composer-model-select-style';
    const CSS = `
.vcp-model-select { position: relative; display: inline-flex; margin-left: auto !important; margin-right: 2px; flex: 0 0 auto; min-width: max-content; }
.vcp-model-select:not([hidden]) ~ #mainVoiceInputBtn { margin-left: 0 !important; }
.vcp-model-select:not([hidden]) ~ :is(#sendMessageBtn, .chat-send-button) { margin-left: 0 !important; }
.vcp-model-select[hidden] { display: none !important; }
.vcp-model-select-trigger {
    display: inline-flex; align-items: center; gap: 4px; min-height: 28px; height: auto; padding: 4px 4px 4px 8px; max-width: none;
    border: 0; border-radius: 8px; background: transparent; cursor: pointer;
    color: var(--vcp-ui-text-2, #a7afb1); font: inherit; font-size: 13px; line-height: 20px;
    transition: background-color .15s, color .15s;
}
.vcp-model-select-trigger:hover, .vcp-model-select-trigger[aria-expanded="true"] {
    background: var(--vcp-ui-interactive-hover, rgba(127,127,127,.16)); color: var(--vcp-ui-text-0, currentColor);
}
.vcp-model-select-label { overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; text-align: left; }
.vcp-model-select-trigger svg { width: 12px; height: 12px; opacity: .7; flex: none; }
.vcp-model-select-menu {
    position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 1000; width: 280px; padding: 4px;
    border-radius: 10px; background: var(--vcp-ui-surface-raised, var(--secondary-bg, #2b2f31));
    color: var(--vcp-ui-text-0, var(--primary-text, #e6e9ea));
    border: 1px solid var(--vcp-ui-border, rgba(127,127,127,.25)); box-shadow: 0 8px 24px rgba(0,0,0,.28);
}
.vcp-model-select-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 8px 6px; font-size: 12px; font-weight: 600;
    border-bottom: 1px solid var(--vcp-ui-border, rgba(127,127,127,.18)); margin-bottom: 4px;
}
.vcp-model-select-header-title { display: flex; align-items: center; gap: 4px; }
.vcp-model-select-header-count { font-size: 11px; opacity: .6; font-weight: normal; }
.vcp-model-select-actions { display: flex; gap: 8px; font-size: 11px; }
.vcp-model-select-action-btn {
    border: 0; background: transparent; color: var(--vcp-ui-accent, #4daafc); cursor: pointer; padding: 0; font: inherit;
}
.vcp-model-select-action-btn:hover { text-decoration: underline; }
.vcp-model-select-search {
    box-sizing: border-box; width: 100%; height: 28px; margin: 0 0 4px; padding: 0 8px; border-radius: 6px;
    border: 1px solid var(--vcp-ui-border, rgba(127,127,127,.25)); background: transparent; color: inherit; font: inherit; font-size: 13px; outline: none;
}
.vcp-model-select-list { max-height: 260px; overflow-y: auto; }
.vcp-model-select-group { padding: 6px 8px 2px; font-size: 11px; opacity: .55; }
.vcp-model-select-item, .vcp-model-check-item {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 8px; border: 0; border-radius: 6px;
    background: transparent; color: inherit; font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer;
    user-select: none;
}
.vcp-model-select-item:hover, .vcp-model-select-item:focus-visible,
.vcp-model-check-item:hover, .vcp-model-check-item:focus-visible { background: var(--vcp-ui-interactive-hover, rgba(127,127,127,.16)); outline: none; }
.vcp-model-select-item .check { width: 14px; flex: none; }
.vcp-model-select-item .name, .vcp-model-check-item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.vcp-model-check-box {
    width: 14px; height: 14px; border: 1px solid var(--vcp-ui-border, rgba(127,127,127,.4));
    border-radius: 3px; display: inline-flex; align-items: center; justify-content: center;
    font-size: 11px; flex: none; line-height: 1; transition: background-color .1s, border-color .1s;
}
.vcp-model-check-item[aria-checked="true"] .vcp-model-check-box {
    background: var(--vcp-ui-accent, #3b82f6); border-color: var(--vcp-ui-accent, #3b82f6); color: #fff;
}
.vcp-model-select-empty { padding: 8px; font-size: 12px; opacity: .6; }
`;

    function init({ electronAPI, selectedItemRef, nameObserveTarget, sendMessageBtn }) {
        const actions = document.querySelector('.chat-input-actions');
        if (!actions || !electronAPI || !selectedItemRef) return { dispose() {} };

        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.appendChild(style);
        }

        const wrap = document.createElement('div');
        wrap.className = 'vcp-model-select';
        wrap.hidden = true;
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'vcp-model-select-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        const labelEl = document.createElement('span');
        labelEl.className = 'vcp-model-select-label';
        const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        chevron.setAttribute('viewBox', '0 0 16 16');
        chevron.setAttribute('fill', 'none');
        chevron.setAttribute('stroke', 'currentColor');
        chevron.setAttribute('stroke-width', '1.5');
        const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        chevronPath.setAttribute('d', 'M4 6l4 4 4-4');
        chevron.appendChild(chevronPath);
        trigger.append(labelEl, chevron);
        wrap.appendChild(trigger);

        const anchor = document.getElementById('mainVoiceInputBtn')
            || sendMessageBtn
            || document.getElementById('sendMessageBtn');
        if (anchor && anchor.parentNode === actions) actions.insertBefore(wrap, anchor);
        else actions.appendChild(wrap);

        let menu = null;
        let busy = false;
        const CHECKED_STORAGE_KEY = 'vcp-composer-checked-models';

        function getCheckedModels() {
            try {
                const raw = localStorage.getItem(CHECKED_STORAGE_KEY);
                if (!raw) return new Set();
                const parsed = JSON.parse(raw);
                return new Set(Array.isArray(parsed) ? parsed : []);
            } catch {
                return new Set();
            }
        }

        function saveCheckedModels(set) {
            try {
                localStorage.setItem(CHECKED_STORAGE_KEY, JSON.stringify(Array.from(set)));
            } catch (e) {
                console.warn('[ComposerModelSelect] 保存勾选模型失败', e);
            }
        }

        const currentItem = () => selectedItemRef.get?.() || null;
        const isAgent = item => !!item && item.type === 'agent' && !!item.id;
        const readModel = item => (item?.config?.model ?? item?.model ?? '') || '';

        const refresh = () => {
            const item = currentItem();
            const show = isAgent(item);
            wrap.hidden = !show;
            if (!show) { closeMenu(); return; }
            const model = readModel(item);
            labelEl.textContent = model || '选择模型';
            trigger.title = model
                ? `当前模型：${model}（左键切换 / 右键勾选候选列表）`
                : '左键选择模型 / 右键勾选候选模型';
        };

        let menuResizeObserver = null;

        function positionMenu() {
            if (!menu) return;
            const card = wrap.closest('.chat-input-card');
            if (!card) return;
            const cardRect = card.getBoundingClientRect();
            const wrapRect = wrap.getBoundingClientRect();
            // 保持 absolute 定位在触发器内，避开磨砂卡片对 fixed 的包含块影响。
            // 弹层下沿位于整个卡片上方 4px，右沿与卡片对齐。
            menu.style.bottom = `${wrapRect.bottom - cardRect.top + 4}px`;
            menu.style.right = `${wrapRect.right - cardRect.right}px`;
        }

        function closeMenu() {
            menuResizeObserver?.disconnect();
            menuResizeObserver = null;
            window.removeEventListener('resize', positionMenu);
            menu?.remove();
            menu = null;
            trigger.setAttribute('aria-expanded', 'false');
        }

        async function choose(modelId) {
            const item = currentItem();
            if (!isAgent(item) || busy) return;
            busy = true;
            try {
                const result = await electronAPI.saveAgentConfig(item.id, { model: modelId });
                if (!result?.success) throw new Error(result?.error || 'save-failed');
                // 以磁盘为准回写选中项，保持设置页和发送链路一致
                const latest = currentItem();
                if (latest?.id === item.id) {
                    const next = { ...latest, model: modelId };
                    if (latest.config) next.config = { ...latest.config, model: modelId };
                    selectedItemRef.set(next);
                }
                const settingsInput = document.getElementById('agentModel');
                if (settingsInput && document.getElementById('editingAgentId')?.value === item.id) {
                    settingsInput.value = modelId;
                }
            } catch (error) {
                console.error('[ComposerModelSelect] 切换模型失败:', error);
                window.uiHelperFunctions?.showToastNotification?.(`切换模型失败: ${error.message || error}`, 'error');
            } finally {
                busy = false;
                refresh();
            }
        }

        function normalize(models) {
            const list = Array.isArray(models) ? models
                : Array.isArray(models?.data) ? models.data
                    : Array.isArray(models?.models) ? models.models : [];
            return list.map(m => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
        }

        async function fetchModelsAndFavorites() {
            let models = [];
            let favorites = [];
            try {
                [models, favorites] = await Promise.all([
                    electronAPI.getCachedModels?.() ?? [],
                    electronAPI.getFavoriteModels?.() ?? [],
                ]);
                if ((!normalize(models).length) && electronAPI.refreshModels) {
                    electronAPI.refreshModels();
                    await new Promise(r => setTimeout(r, 1500));
                    models = await electronAPI.getCachedModels();
                }
            } catch (error) {
                console.warn('[ComposerModelSelect] 获取模型列表失败', error);
            }
            return {
                ids: normalize(models),
                favSet: new Set(Array.isArray(favorites) ? favorites : [])
            };
        }

        async function openMenu() {
            closeMenu();
            trigger.setAttribute('aria-expanded', 'true');
            const el = document.createElement('div');
            el.className = 'vcp-model-select-menu';
            el.dataset.mode = 'select';
            const search = document.createElement('input');
            search.type = 'text';
            search.className = 'vcp-model-select-search';
            search.placeholder = '搜索候选模型...';
            const list = document.createElement('div');
            list.className = 'vcp-model-select-list';
            list.setAttribute('role', 'listbox');
            el.append(search, list);
            wrap.appendChild(el);
            menu = el;
            positionMenu();
            window.addEventListener('resize', positionMenu);
            if (typeof ResizeObserver !== 'undefined') {
                menuResizeObserver = new ResizeObserver(positionMenu);
                menuResizeObserver.observe(wrap);
                const card = wrap.closest('.chat-input-card');
                if (card) menuResizeObserver.observe(card);
            }
            list.innerHTML = '<div class="vcp-model-select-empty">加载中…</div>';

            const { ids, favSet } = await fetchModelsAndFavorites();
            if (menu !== el) return;

            const checkedSet = getCheckedModels();
            const availableIds = ids.filter(id => checkedSet.has(id));
            const current = readModel(currentItem());

            const render = () => {
                const q = search.value.trim().toLowerCase();
                list.replaceChildren();
                const match = id => !q || id.toLowerCase().includes(q);
                const favs = availableIds.filter(id => favSet.has(id) && match(id));
                const rest = availableIds.filter(id => !favSet.has(id) && match(id));
                const addGroup = (title, arr) => {
                    if (!arr.length) return;
                    if (title) {
                        const g = document.createElement('div');
                        g.className = 'vcp-model-select-group';
                        g.textContent = title;
                        list.appendChild(g);
                    }
                    arr.forEach(id => {
                        const b = document.createElement('button');
                        b.type = 'button';
                        b.className = 'vcp-model-select-item';
                        b.setAttribute('role', 'option');
                        b.setAttribute('aria-selected', String(id === current));
                        const check = document.createElement('span');
                        check.className = 'check';
                        check.textContent = id === current ? '✓' : '';
                        const name = document.createElement('span');
                        name.className = 'name';
                        name.textContent = id;
                        name.title = id;
                        b.append(check, name);
                        b.addEventListener('click', event => {
                            event.stopPropagation();
                            closeMenu();
                            if (id !== current) choose(id);
                        });
                        list.appendChild(b);
                    });
                };
                addGroup(favs.length && rest.length ? '收藏' : '', favs);
                addGroup(favs.length && rest.length ? '全部' : '', rest);
                if (!favs.length && !rest.length) {
                    const empty = document.createElement('div');
                    empty.className = 'vcp-model-select-empty';
                    if (availableIds.length === 0) {
                        empty.textContent = ids.length ? '未勾选任何模型（右键【模型】按钮进行勾选）' : '没有可用的模型，请检查 VCP 服务器地址';
                    } else {
                        empty.textContent = '没有匹配的模型';
                    }
                    list.appendChild(empty);
                }
            };
            search.addEventListener('input', render);
            render();
            search.focus();
        }

        async function openCheckMenu() {
            closeMenu();
            trigger.setAttribute('aria-expanded', 'true');
            const el = document.createElement('div');
            el.className = 'vcp-model-select-menu';
            el.dataset.mode = 'check';

            const header = document.createElement('div');
            header.className = 'vcp-model-select-header';
            const titleBox = document.createElement('div');
            titleBox.className = 'vcp-model-select-header-title';
            const titleSpan = document.createElement('span');
            titleSpan.textContent = '勾选候选模型';
            const countSpan = document.createElement('span');
            countSpan.className = 'vcp-model-select-header-count';
            titleBox.append(titleSpan, countSpan);

            const actionsBox = document.createElement('div');
            actionsBox.className = 'vcp-model-select-actions';
            const selectAllBtn = document.createElement('button');
            selectAllBtn.type = 'button';
            selectAllBtn.className = 'vcp-model-select-action-btn';
            selectAllBtn.textContent = '全选';
            const clearAllBtn = document.createElement('button');
            clearAllBtn.type = 'button';
            clearAllBtn.className = 'vcp-model-select-action-btn';
            clearAllBtn.textContent = '清空';
            actionsBox.append(selectAllBtn, clearAllBtn);
            header.append(titleBox, actionsBox);

            const search = document.createElement('input');
            search.type = 'text';
            search.className = 'vcp-model-select-search';
            search.placeholder = '搜索需要勾选的模型...';

            const list = document.createElement('div');
            list.className = 'vcp-model-select-list';
            list.setAttribute('role', 'group');

            el.append(header, search, list);
            wrap.appendChild(el);
            menu = el;
            positionMenu();
            window.addEventListener('resize', positionMenu);
            if (typeof ResizeObserver !== 'undefined') {
                menuResizeObserver = new ResizeObserver(positionMenu);
                menuResizeObserver.observe(wrap);
                const card = wrap.closest('.chat-input-card');
                if (card) menuResizeObserver.observe(card);
            }
            list.innerHTML = '<div class="vcp-model-select-empty">加载中…</div>';

            const { ids, favSet } = await fetchModelsAndFavorites();
            if (menu !== el) return;

            let checkedSet = getCheckedModels();

            const updateCount = () => {
                countSpan.textContent = `(${checkedSet.size}/${ids.length})`;
            };

            const toggleModel = (id, checked) => {
                if (checked) checkedSet.add(id);
                else checkedSet.delete(id);
                saveCheckedModels(checkedSet);
                updateCount();
            };

            selectAllBtn.onclick = event => {
                event.stopPropagation();
                ids.forEach(id => checkedSet.add(id));
                saveCheckedModels(checkedSet);
                render();
            };

            clearAllBtn.onclick = event => {
                event.stopPropagation();
                checkedSet.clear();
                saveCheckedModels(checkedSet);
                render();
            };

            const render = () => {
                updateCount();
                const q = search.value.trim().toLowerCase();
                list.replaceChildren();
                const match = id => !q || id.toLowerCase().includes(q);
                const favs = ids.filter(id => favSet.has(id) && match(id));
                const rest = ids.filter(id => !favSet.has(id) && match(id));

                const addGroup = (title, arr) => {
                    if (!arr.length) return;
                    if (title) {
                        const g = document.createElement('div');
                        g.className = 'vcp-model-select-group';
                        g.textContent = title;
                        list.appendChild(g);
                    }
                    arr.forEach(id => {
                        const isChecked = checkedSet.has(id);
                        const item = document.createElement('button');
                        item.type = 'button';
                        item.className = 'vcp-model-check-item';
                        item.setAttribute('role', 'checkbox');
                        item.setAttribute('aria-checked', String(isChecked));

                        const box = document.createElement('span');
                        box.className = 'vcp-model-check-box';
                        box.textContent = isChecked ? '✓' : '';

                        const name = document.createElement('span');
                        name.className = 'name';
                        name.textContent = id;
                        name.title = id;

                        item.append(box, name);
                        item.addEventListener('click', event => {
                            event.stopPropagation();
                            const nextChecked = !checkedSet.has(id);
                            toggleModel(id, nextChecked);
                            item.setAttribute('aria-checked', String(nextChecked));
                            box.textContent = nextChecked ? '✓' : '';
                        });
                        list.appendChild(item);
                    });
                };

                addGroup(favs.length && rest.length ? '收藏' : '', favs);
                addGroup(favs.length && rest.length ? '全部' : '', rest);

                if (!favs.length && !rest.length) {
                    const empty = document.createElement('div');
                    empty.className = 'vcp-model-select-empty';
                    empty.textContent = ids.length ? '没有匹配的模型' : '没有可用的模型，请检查 VCP 服务器地址';
                    list.appendChild(empty);
                }
            };

            search.addEventListener('input', render);
            render();
            search.focus();
        }

        const onTrigger = event => {
            event.preventDefault();
            event.stopPropagation();
            if (menu && menu.dataset.mode === 'select') closeMenu();
            else openMenu();
        };
        const onContextMenu = event => {
            event.preventDefault();
            event.stopPropagation();
            if (menu && menu.dataset.mode === 'check') closeMenu();
            else openCheckMenu();
        };
        const onDocDown = event => {
            if (menu && !wrap.contains(event.target)) closeMenu();
        };
        const onKey = event => {
            if (event.key === 'Escape' && menu) { closeMenu(); event.stopPropagation(); }
        };
        trigger.addEventListener('click', onTrigger);
        trigger.addEventListener('contextmenu', onContextMenu);
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey, true);

        // 切换 Agent / 保存设置后会刷新标题，借此同步显示
        let observer = null;
        if (nameObserveTarget && typeof MutationObserver !== 'undefined') {
            observer = new MutationObserver(() => { refresh(); setTimeout(refresh, 200); });
            observer.observe(nameObserveTarget, { childList: true, characterData: true, subtree: true });
        }
        window.addEventListener('focus', refresh);
        refresh();

        return {
            refresh,
            dispose() {
                closeMenu();
                trigger.removeEventListener('click', onTrigger);
                trigger.removeEventListener('contextmenu', onContextMenu);
                document.removeEventListener('mousedown', onDocDown, true);
                document.removeEventListener('keydown', onKey, true);
                window.removeEventListener('focus', refresh);
                observer?.disconnect();
                wrap.remove();
                document.getElementById(STYLE_ID)?.remove();
            },
        };
    }

    window.ComposerModelSelect = { init };
})();
