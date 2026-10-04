/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

export function createSideChatModelPicker({
    store,
    chatCapabilities,
    doc,
    modelNameSpan,
    modelPickerBtn,
    modelPopover,
    persistMetadata,
    onModelChange,
    updateComposerState
}) {
    const disposeCleanups = [];
    function updateModel(newModel) {
        if (!newModel || store.isDisposed) return;
        store.currentModel = newModel;
        store.currentDescriptor = { ...store.currentDescriptor, model: newModel };
        onModelChange(newModel);
        if (modelNameSpan) modelNameSpan.textContent = newModel;
        if (modelPickerBtn) {
            modelPickerBtn.title = `切换模型 (当前: ${newModel})`;
            modelPickerBtn.setAttribute('aria-expanded', 'false');
        }
        if (modelPopover) modelPopover.hidden = true;
        persistMetadata().catch(e => console.warn('[SideChat] Failed to persist model update:', e));
    }

    if (modelPickerBtn && modelPopover) {
        const modelSearch = modelPopover.querySelector('.side-chat-model-search');
        const modelList = modelPopover.querySelector('.side-chat-model-list');
        let modelCatalog = null;

        const renderModelList = () => {
            const q = (modelSearch?.value || '').trim().toLowerCase();
            modelList.replaceChildren();
            const { ids = [], favorites = new Set() } = modelCatalog || {};
            const match = (id) => !q || id.toLowerCase().includes(q);
            const favs = ids.filter(id => favorites.has(id) && match(id));
            const rest = ids.filter(id => !favorites.has(id) && match(id));
            const addGroup = (title, arr) => {
                if (!arr.length) return;
                if (title) {
                    const g = doc.createElement('div');
                    g.className = 'side-chat-model-group';
                    g.textContent = title;
                    modelList.appendChild(g);
                }
                arr.forEach((id) => {
                    const item = doc.createElement('div');
                    item.className = 'side-chat-model-item' + (id === store.currentModel ? ' active' : '');
                    item.setAttribute('role', 'option');
                    item.setAttribute('aria-selected', String(id === store.currentModel));
                    item.setAttribute('data-model', id);
                    item.tabIndex = -1;
                    item.textContent = id;
                    item.title = id;
                    modelList.appendChild(item);
                });
            };
            addGroup(favs.length && rest.length ? '收藏' : '', favs);
            addGroup(favs.length && rest.length ? '全部' : '', rest);
            if (!favs.length && !rest.length) {
                const empty = doc.createElement('div');
                empty.className = 'side-chat-model-empty';
                empty.textContent = modelCatalog === null ? '加载中…'
                    : (ids.length ? '没有匹配的模型' : '没有可用的模型，请检查 VCP 服务器地址');
                modelList.appendChild(empty);
            }
        };

        const loadModelCatalog = async () => {
            renderModelList();
            try {
                modelCatalog = await (chatCapabilities?.listModels?.() ?? { ids: [], favorites: new Set() });
            } catch (error) {
                console.warn('[SideChat] Failed to load model list:', error);
                modelCatalog = { ids: [], favorites: new Set() };
            }
            if (!store.isDisposed) renderModelList();
        };

        const closePopover = () => {
            modelPopover.hidden = true;
            modelPickerBtn.setAttribute('aria-expanded', 'false');
        };

        const openPopover = () => {
            modelPopover.hidden = false;
            modelPickerBtn.setAttribute('aria-expanded', 'true');
            if (modelSearch) modelSearch.value = '';
            loadModelCatalog();
            modelSearch?.focus?.();
        };

        modelPickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (modelPopover.hidden) openPopover(); else closePopover();
        });

        modelSearch?.addEventListener('input', renderModelList);

        modelList.addEventListener('click', (e) => {
            const item = e.target.closest('.side-chat-model-item');
            const newModel = item?.getAttribute('data-model');
            if (!newModel) return;
            updateModel(newModel);
            updateComposerState();
            modelPickerBtn.focus();
        });

        modelPopover.addEventListener('keydown', (e) => {
            const items = Array.from(modelList.querySelectorAll('.side-chat-model-item'));
            const idx = items.indexOf(doc.activeElement);
            if (e.key === 'Escape') {
                e.preventDefault();
                closePopover();
                modelPickerBtn.focus();
            } else if (e.key === 'ArrowDown' && items.length) {
                e.preventDefault();
                items[(idx + 1) % items.length].focus();
            } else if (e.key === 'ArrowUp' && items.length) {
                e.preventDefault();
                items[(idx - 1 + items.length) % items.length].focus();
            } else if (e.key === 'Enter' && doc.activeElement?.classList?.contains('side-chat-model-item')) {
                e.preventDefault();
                doc.activeElement.click();
            }
        });

        const onDocClick = (e) => {
            if (!modelPickerBtn.contains?.(e.target) && !modelPopover.contains?.(e.target)) closePopover();
        };
        doc.addEventListener('click', onDocClick);
        disposeCleanups.push(() => doc.removeEventListener('click', onDocClick));
    }

    return Object.freeze({ updateModel, dispose() { disposeCleanups.splice(0).forEach(fn => { try { fn(); } catch {} }); } });
}
