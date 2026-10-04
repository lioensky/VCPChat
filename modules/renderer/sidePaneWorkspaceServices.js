import { createGitFileDiffResolver, toWorkspaceRelative } from '../ui-system/git-file-diff.js';
import { createMessageFileChanges } from '../ui-system/message-file-changes.js';
import { createConversationStatusPanel } from '../ui-system/conversation-status-panel.js';
import { getParentKey } from '../ui-system/side-pane/side-pane-state.js';

export function createSidePaneWorkspaceServices({ doc, win, chatAPI, chatManager, uiHelper, historyRef, codeViewerProvider, gitProvider, toolOutputProvider, planDetailProvider }) {
    const owners = [];
    const subscriptions = { add: owner => owners.push(owner) };
    // 回答下方的「本轮改动」：文件名打开代码查看，+N -N 打开 Git 标签定位到该文件
    const gitFileDiffResolver = createGitFileDiffResolver({ api: chatAPI || win.electronAPI });
    let knownWorkspaces = [];
    const messageFileChanges = createMessageFileChanges({
        document: doc,
        messagesRoot: doc.getElementById('chatMessages'),
        getHistory: () => historyRef.get() || [],
        openFile: (filePath) => codeViewerProvider.openViewer({ filePath }),
        getDiffStats: (filePath) => gitFileDiffResolver.resolve(filePath),
        openDiff: (filePath) => gitProvider.openGitTab({ focusPath: filePath }),
        relativePath: (filePath) => toWorkspaceRelative(filePath, knownWorkspaces)?.relPath || null
    });
    // 先拿到工作区列表再挂载，已有消息的目录才能按工作区相对路径显示
    gitFileDiffResolver.listWorkspaces()
        .then((list) => { knownWorkspaces = list; })
        .catch(() => {})
        .finally(() => messageFileChanges.mount());
    subscriptions.add({ dispose: () => messageFileChanges.dispose() });
    // 聊天区右上角的状态面板：只显示当前话题用过的 V工程、它所在工作区的 Git 和它发起过的命令
    const conversationStatusPanel = createConversationStatusPanel({
        document: doc,
        api: chatAPI || win.electronAPI,
        uiHelper,
        onOpenGitTab: () => gitProvider.openGitTab(),
        // 不钉住工程：侧栏按同一条规则选，和面板显示的是同一个；focus 让侧栏定位到某条计划或时间线
        onOpenPlanDetail: (_project, focus = null) => planDetailProvider.openPlanDetailTab({ focus }),
        onOpenToolOutput: (run) => toolOutputProvider.openToolOutputTab({ runId: run?.id }),
        getTopicKey: () => {
            const parent = win.vcpSidePaneController?.getSnapshot?.()?.parent;
            return parent ? getParentKey(parent) : '';
        },
        onScopeWorkspace: (workspace) => gitProvider.followWorkspace?.(workspace.id),
        getHistory: () => historyRef.get() || [],
        messagesRoot: doc.getElementById('chatMessages'),
        onConversationChange: (callback) => chatManager?.onSelectionChange?.(callback)
    });
    conversationStatusPanel.mount();
    subscriptions.add({ dispose: () => conversationStatusPanel.dispose() });


    return Object.freeze({ dispose() { owners.splice(0).forEach(owner => owner.dispose?.()); } });
}
