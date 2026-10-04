export function createSidePaneHostBindings({ win, chatAPI, uiHelper, chatManager, selectedItemRef, topicIdRef, toggleChatBtn, controller, restoreSessions }) {
    const notify = (message, type) => uiHelper?.showToastNotification?.(message, type);
    const owners = [];
    const subscriptions = { add: owner => owners.push(owner) };
    // 侧栏按钮取代了铃铛，右键照旧打开监控面板
    if (toggleChatBtn) {
        const onToggleContextMenu = (e) => {
            e.preventDefault();
            if (chatAPI?.openRAGObserverWindow) {
                chatAPI.openRAGObserverWindow();
            } else {
                notify('功能缺失: preload.js需要更新。', 'error');
            }
        };
        toggleChatBtn.addEventListener('contextmenu', onToggleContextMenu);
        subscriptions.add({ dispose: () => toggleChatBtn.removeEventListener('contextmenu', onToggleContextMenu) });
    }

    // 跟随主聊天：切换助手或话题时，侧栏换成那个话题的标签
    const syncSidePaneParent = async ({ item, topicId }) => {
        if (item?.type !== 'agent') {
            controller.setParent(null);
            return;
        }
        controller.setParent({ itemType: 'agent', itemId: item.id, topicId: topicId || '' });
        if (topicId) await restoreSessions?.(item.id, topicId);
    };
    const unbindSelection = chatManager?.onSelectionChange?.(syncSidePaneParent);
    if (unbindSelection) subscriptions.add({ dispose: unbindSelection });
    const initialItem = selectedItemRef.get();
    if (initialItem?.id) syncSidePaneParent({ item: initialItem, topicId: topicIdRef.get() });


    return Object.freeze({ dispose() { owners.splice(0).forEach(owner => owner.dispose?.()); } });
}
