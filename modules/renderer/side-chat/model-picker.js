/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

import { createModelPickerPopup } from '../model-picker-popup.js';

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

    // 移除模板中遗留的静态 popover，改由通用组件动态管理与渲染
    if (modelPopover && modelPopover.parentNode) {
        modelPopover.remove();
    }

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
        popup?.close();
        persistMetadata().catch(e => console.warn('[SideChat] Failed to persist model update:', e));
    }

    let popup = null;
    if (modelPickerBtn) {
        const wrap = modelPickerBtn.closest('.side-chat-model-picker-wrapper') || modelPickerBtn.parentElement;
        popup = createModelPickerPopup({
            doc,
            win: doc.defaultView,
            wrap,
            trigger: modelPickerBtn,
            getCatalog: async () => {
                try {
                    return await (chatCapabilities?.listModels?.() ?? { ids: [], favorites: new Set() });
                } catch (error) {
                    console.warn('[SideChat] Failed to load model list:', error);
                    return { ids: [], favorites: new Set() };
                }
            },
            getActiveModel: () => store.currentModel || '',
            onSelect: (newModel) => {
                if (!newModel) return;
                updateModel(newModel);
                updateComposerState?.();
                modelPickerBtn.focus?.();
            },
            enableCheckMenu: true
        });

        disposeCleanups.push(() => {
            popup?.dispose();
        });
    }

    return Object.freeze({
        updateModel,
        dispose() {
            disposeCleanups.splice(0).forEach(fn => { try { fn(); } catch {} });
        }
    });
}
