/**
 * 输入框内的 AI 模型选择器。
 * 位于语音按钮左侧，读写当前 Agent 的 model 配置，与设置页的 Agent 模型保持一致。
 */
(function () {
    const STYLE_ID = 'vcp-composer-model-select-style';
    const CSS = `
.vcp-model-select { position: relative; display: inline-flex; margin-left: auto !important; margin-right: 2px; flex: 0 1 auto; min-width: 0; }
.vcp-model-select ~ #mainVoiceInputBtn { margin-left: 0 !important; }
.vcp-model-select[hidden] { display: none !important; }
.vcp-model-select-trigger {
    display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 4px 0 8px; max-width: 200px;
    border: 0; border-radius: 8px; background: transparent; cursor: pointer;
    color: var(--vcp-ui-text-2, #a7afb1); font: inherit; font-size: 13px; line-height: 20px;
    transition: background-color .15s, color .15s;
}
.vcp-model-select-trigger:hover, .vcp-model-select-trigger[aria-expanded="true"] {
    background: var(--vcp-ui-interactive-hover, rgba(127,127,127,.16)); color: var(--vcp-ui-text-0, currentColor);
}
.vcp-model-select-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vcp-model-select-trigger svg { width: 12px; height: 12px; opacity: .7; flex: none; }
.vcp-model-select-menu {
    position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 1000; width: 280px; padding: 4px;
    border-radius: 10px; background: var(--vcp-ui-surface-raised, var(--secondary-bg, #2b2f31));
    color: var(--vcp-ui-text-0, var(--primary-text, #e6e9ea));
    border: 1px solid var(--vcp-ui-border, rgba(127,127,127,.25)); box-shadow: 0 8px 24px rgba(0,0,0,.28);
}
.vcp-model-select-search {
    box-sizing: border-box; width: 100%; height: 28px; margin: 0 0 4px; padding: 0 8px; border-radius: 6px;
    border: 1px solid var(--vcp-ui-border, rgba(127,127,127,.25)); background: transparent; color: inherit; font: inherit; font-size: 13px; outline: none;
}
.vcp-model-select-list { max-height: 260px; overflow-y: auto; }
.vcp-model-select-group { padding: 6px 8px 2px; font-size: 11px; opacity: .55; }
.vcp-model-select-item {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 8px; border: 0; border-radius: 6px;
    background: transparent; color: inherit; font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer;
}
.vcp-model-select-item:hover, .vcp-model-select-item:focus-visible { background: var(--vcp-ui-interactive-hover, rgba(127,127,127,.16)); outline: none; }
.vcp-model-select-item .check { width: 14px; flex: none; }
.vcp-model-select-item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
            trigger.title = model ? `当前模型：${model}（点击切换）` : '点击选择模型';
        };

        function closeMenu() {
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

        async function openMenu() {
            closeMenu();
            trigger.setAttribute('aria-expanded', 'true');
            const el = document.createElement('div');
            el.className = 'vcp-model-select-menu';
            const search = document.createElement('input');
            search.type = 'text';
            search.className = 'vcp-model-select-search';
            search.placeholder = '搜索模型...';
            const list = document.createElement('div');
            list.className = 'vcp-model-select-list';
            list.setAttribute('role', 'listbox');
            el.append(search, list);
            wrap.appendChild(el);
            menu = el;
            list.innerHTML = '<div class="vcp-model-select-empty">加载中…</div>';

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
            if (menu !== el) return;
            const ids = normalize(models);
            const favSet = new Set(Array.isArray(favorites) ? favorites : []);
            const current = readModel(currentItem());

            const render = () => {
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
            if (menu) closeMenu(); else openMenu();
        };
        const onDocDown = event => {
            if (menu && !wrap.contains(event.target)) closeMenu();
        };
        const onKey = event => {
            if (event.key === 'Escape' && menu) { closeMenu(); event.stopPropagation(); }
        };
        trigger.addEventListener('click', onTrigger);
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
