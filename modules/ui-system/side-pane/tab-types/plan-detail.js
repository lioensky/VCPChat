import { createPlanDetailSideProvider } from '../planDetailSideProvider.js';
import { collectConversationScope } from '../../conversation-scope.js';

export function definePlanDetailTabType({ document: doc, window: win, chatAPI, sidePaneController, uiHelper, historyRef, openProjectForge }) {
    const provider = createPlanDetailSideProvider({
        document: doc, api: chatAPI || win.electronAPI, sidePaneController, uiHelper,
        onOpenProjectForge: openProjectForge,
        getConversationProjects: async () => {
            const api = chatAPI || win.electronAPI;
            const ids = collectConversationScope(historyRef.get() || []).projectIds;
            if (!ids.length || !api?.projectForgeListProjects) return [];
            const res = await api.projectForgeListProjects({});
            const byId = new Map((res?.success ? res.data || [] : []).filter(p => !p.deleted_at).map(p => [p.id, p]));
            return ids.map(id => byId.get(id)).filter(Boolean);
        }

    });
    return Object.freeze({
        kind: 'plan-detail', label: 'V工程计划', icon: 'checklist', searchHint: '计划', provider,
        entry: { id: 'plan-detail', order: 70, open: () => provider.openPlanDetailTab() }
    });
}
