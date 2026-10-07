import { createLazyProvider } from './lazy-provider.js';
import { collectConversationScope } from '../../conversation-scope.js';
import { watchConversationHistory } from '../../sources/conversation-current.js';

const RESCOPE_DEBOUNCE_MS = 700;

export function definePlanDetailTabType({ document: doc, window: win, chatAPI, sidePaneController, uiHelper, historyRef, openProjectForge }) {
    const provider = createLazyProvider(async () => (await import('../planDetailSideProvider.js')).createPlanDetailSideProvider({
        document: doc, api: chatAPI || win.electronAPI, sidePaneController, uiHelper,
        onOpenProjectForge: openProjectForge,
        getConversationProjects: async () => {
            const api = chatAPI || win.electronAPI;
            const ids = collectConversationScope(historyRef.get() || []).projectIds;
            if (!ids.length || !api?.projectForgeListProjects) return [];
            const res = await api.projectForgeListProjects({});
            const byId = new Map((res?.success ? res.data || [] : []).filter(p => !p.deleted_at).map(p => [p.id, p]));
            return ids.map(id => byId.get(id)).filter(Boolean);
        },
        getTopicScope: () => collectConversationScope(historyRef.get() || []),
        // 和状态面板一样跟着当前会话的记录：新的施工结果写进记录后重新圈定话题批次
        watchTopic: (callback) => {
            let timer = null;
            const off = watchConversationHistory(() => {
                win.clearTimeout(timer);
                timer = win.setTimeout(callback, RESCOPE_DEBOUNCE_MS);
            });
            return () => { win.clearTimeout(timer); off(); };
        }
    }), ['openPlanDetailTab'], { label: 'V工程计划', notify: (message, type) => uiHelper?.showToastNotification?.(message, type) });
    return Object.freeze({
        kind: 'plan-detail', label: 'V工程计划', icon: 'checklist', searchHint: '计划', provider,
        entry: { id: 'plan-detail', order: 70, open: () => provider.openPlanDetailTab() }
    });
}
