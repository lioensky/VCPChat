// Agent ModelPicker directory capability.
//
// This module is deliberately presentation-neutral: it adapts the canonical
// chatAPI model directory to the short-lived option contract consumed by the
// generated AgentModelPicker. It never owns durable model state and never
// writes the canonical #agentModel input.

export function normalizeAgentModels(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.models)) return payload.models;
    if (typeof payload?.id === 'string') return [payload];
    return [];
}

export function createAgentModelPickerDirectory({ electronAPI, input }) {
    const modelOptions = async signal => {
        let models = await electronAPI?.getCachedModels?.();
        if (signal.aborted) return [];
        if (normalizeAgentModels(models).length === 0 && electronAPI?.refreshModels) {
            await electronAPI.refreshModels();
            if (signal.aborted) return [];
            models = await electronAPI.getCachedModels?.();
        }
        if (signal.aborted) return [];

        let hotModelIds = [];
        let favoriteModelIds = [];
        try {
            [hotModelIds, favoriteModelIds] = await Promise.all([
                electronAPI?.getHotModels?.() ?? [],
                electronAPI?.getFavoriteModels?.() ?? [],
            ]);
        } catch {
            // Metadata is presentation-only; model selection remains usable.
        }
        if (signal.aborted) return [];

        const hotIds = Array.isArray(hotModelIds) ? hotModelIds.map(String) : [];
        const favoriteIds = Array.isArray(favoriteModelIds) ? favoriteModelIds.map(String) : [];
        const hotSet = new Set(hotIds);
        const favoriteSet = new Set(favoriteIds);
        const normalized = normalizeAgentModels(models).map(model => {
            const rawId = typeof model === 'string' ? model : model?.id;
            if (!rawId) return null;
            const id = String(rawId);
            const provider = typeof model === 'object' ? (model.provider || model.owned_by) : undefined;
            const label = typeof model === 'object' ? (model.name || id) : id;
            const metadata = [provider, hotSet.has(id) ? '热门' : undefined, favoriteSet.has(id) ? '收藏' : undefined]
                .filter(Boolean).join(' · ');
            return {
                id,
                label: String(label),
                provider: metadata || undefined,
                favorite: favoriteSet.has(id),
                active: id === String(input?.value || ''),
            };
        }).filter(Boolean);
        const byId = new Map(normalized.map(option => [option.id, option]));
        const inOrder = (ids, group) => ids
            .map(id => byId.get(id))
            .filter(Boolean)
            .map(option => ({ ...option, group }));
        return [
            ...inOrder(hotIds, '热门模型'),
            ...inOrder(favoriteIds, '收藏模型'),
            ...normalized.map(option => ({ ...option, group: '全部模型' })),
        ];
    };

    return {
        options: modelOptions,
        refresh: async signal => {
            if (!electronAPI?.refreshModels) throw new Error('当前环境不支持刷新模型列表');
            await electronAPI.refreshModels();
            if (signal.aborted) return;
        },
        toggleFavorite: async (modelId, signal) => {
            if (!electronAPI?.toggleFavoriteModel) throw new Error('当前环境不支持收藏模型');
            await electronAPI.toggleFavoriteModel(modelId);
            if (signal.aborted) return;
        },
        subscribeUpdated(listener) {
            if (!electronAPI?.onModelsUpdated) return undefined;
            return electronAPI.onModelsUpdated(() => listener());
        },
    };
}
