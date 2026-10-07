import { createLazyProvider } from './lazy-provider.js';

export function defineModelTrajectoryTabType({ document: doc, window: win, chatAPI, sidePaneController, uiHelper, selectedItemRef, topicIdRef, chatManager }) {
    const provider = createLazyProvider(async () => {
        const { createModelTrajectorySideProvider } = await import('../modelTrajectorySideProvider.js');
        return createModelTrajectorySideProvider({
            document: doc, api: chatAPI || win.electronAPI, sidePaneController, uiHelper,
            getConversation: () => ({ item: selectedItemRef.get(), topicId: topicIdRef.get() }),
            onConversationChange: (callback) => chatManager?.onSelectionChange?.(callback)
        });
    }, ['openModelTrajectoryTab'], { label: '调用轨迹', notify: (message, type) => uiHelper?.showToastNotification?.(message, type) });
    return Object.freeze({
        kind: 'model-trajectory', label: '调用轨迹', icon: 'monitoring', searchHint: '模型调用 请求 响应 token 轨迹',
        entry: { id: 'model-trajectory', order: 65, open: () => provider.openModelTrajectoryTab() },
        provider
    });
}
