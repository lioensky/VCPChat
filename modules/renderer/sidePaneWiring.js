import { createSidePaneController } from '../ui-system/side-pane/side-pane-controller.js';
import { createSideChatWiring } from './sideChatWiring.js';
import { createFloatingSelectionButton } from './floatingSelectionButton.js';
import { createSidePaneLauncherWiring } from './sidePaneLauncherWiring.js';
import { createSidePaneWorkspaceServices } from './sidePaneWorkspaceServices.js';
import { createSidePaneHostBindings } from './sidePaneHostBindings.js';
import { registerSidePaneCommands } from './sidePaneCommands.js';
import { defineNotificationsTabType } from '../ui-system/side-pane/tab-types/notifications.js';
import { defineChatTabType } from '../ui-system/side-pane/tab-types/chat.js';
import { defineCodeViewerTabType } from '../ui-system/side-pane/tab-types/code-viewer.js';
import { defineBrowserTabType } from '../ui-system/side-pane/tab-types/browser.js';
import { defineTerminalTabType } from '../ui-system/side-pane/tab-types/terminal.js';
import { defineToolOutputTabType } from '../ui-system/side-pane/tab-types/tool-output.js';
import { definePlanDetailTabType } from '../ui-system/side-pane/tab-types/plan-detail.js';
import { defineModelTrajectoryTabType } from '../ui-system/side-pane/tab-types/model-trajectory.js';

export function initWorkspaceSidePane({
    document: doc,
    window: win,
    elements,
    chatAPI,
    chatRepository,
    chatManager,
    uiHelper,
    createRenderer,
    settingsRef,
    selectedItemRef,
    topicIdRef,
    historyRef,
    subscriptions,
}) {
    const { root, resizerHandle, tabList, contentContainer, toggleNotificationsBtn, notificationsPanel, toggleChatBtn, closeBtn, addBtn } = elements;
    if (!root) return null;


    const sideChat = createSideChatWiring({ doc, win, chatAPI, chatRepository, chatManager, uiHelper, createRenderer, selectedItemRef, topicIdRef, historyRef, getController: () => controller });
    const controller = createSidePaneController({
        root,
        resizerHandle,
        tabListElement: tabList,
        contentContainer,
        toggleNotificationsBtn,
        notificationsPanel,
        notificationState: win.notificationCenter?.getStateChannel?.() || null,
        onNotificationsShown: () => win.notificationRenderer?.dismissFloatingToasts?.(),
        expandButton: toggleChatBtn,
        closeSidePaneBtn: closeBtn,
        addTabButton: addBtn,
        settingsRef,
        electronAPI: chatAPI,
        persistence: { storage: win.localStorage }
    });
    subscriptions.add(controller);
    const releaseDiagnostics = win.VCPLifecycleInspector?.setSidePaneDiagnosticsProvider?.(() => controller.getDiagnostics());
    if (typeof releaseDiagnostics === 'function') subscriptions.add({ dispose: releaseDiagnostics });

    subscriptions.add(sideChat);
    // 带工程号时让 V工程 页打开后直接定位到这个工程
    const openProjectForge = (projectId) => win.VCPContributions?.commands?.execute?.('projectforge.open', { projectId });

    const deps = { document: doc, window: win, chatAPI, sidePaneController: controller, uiHelper };
    const codeViewer = defineCodeViewerTabType(deps);
    const browser = defineBrowserTabType(deps);
    const toolOutput = defineToolOutputTabType(deps);
    const planDetail = definePlanDetailTabType({ ...deps, historyRef, openProjectForge });
    const modelTrajectory = defineModelTrajectoryTabType({ ...deps, selectedItemRef, topicIdRef, chatManager });
    // 消息右键「查看调用轨迹」、代码块「副屏」、通知开关、打开 V工程 都走命令（sidePaneCommands.js）
    subscriptions.add(registerSidePaneCommands({
        win,
        chatAPI,
        controller,
        openModelTrajectory: (options = {}) => modelTrajectory.provider.openModelTrajectoryTab(options)
    }));
    const terminal = defineTerminalTabType({ ...deps, onOpenUrl: url => browser.provider.openBrowserTab({ url, forceNew: true }) });
    for (const definition of [defineNotificationsTabType(), defineChatTabType({ provider: sideChat.provider, openSideChat: sideChat.openSideChat, onClosed: sideChat.onTabClosed, requestClose: sideChat.requestTabClose, canOpen: () => controller.getSnapshot().parent?.itemType === 'agent' }), codeViewer, browser, terminal, toolOutput, planDetail, modelTrajectory]) {
        controller.registerTabType(definition);
    }
    const offTerminalView = chatAPI?.onTerminalViewRequest?.(async request => {
        try {
            // 已挂载的标签直接复用，不因每条 AI 命令抢走用户当前标签与焦点。
            const handle = controller.getTabHandle('terminal:main') || await terminal.provider.openTerminalTab();
            if (!handle?.getSessionId?.()) throw new Error('侧栏终端未能连接。');
            const data = await handle.handleTerminalRequest(request);
            await chatAPI.terminalViewResponse({ requestId: request.requestId, success: true, data });
        } catch (error) {
            await chatAPI.terminalViewResponse({ requestId: request.requestId, success: false, error: error.message });
        }
    });
    if (typeof offTerminalView === 'function') {
        subscriptions.add({ dispose: offTerminalView });
        // 激活轻量 IPC 桥并绑定主窗口；不会加载执行器或启动 shell。
        chatAPI.terminalViewResponse({}).catch(error => console.warn('[SideTerminal] Bridge activation failed:', error));
    }
    const offBrowserAgent = chatAPI?.onBrowserAgentRequest?.(async request => {
        try {
            const data = await browser.provider.handleAgentRequest(request);
            await chatAPI.browserAgentResponse({ requestId: request.requestId, success: true, data });
        } catch (error) {
            await chatAPI.browserAgentResponse({ requestId: request.requestId, success: false, error: error.message });
        }
    });
    if (typeof offBrowserAgent === 'function') subscriptions.add({ dispose: offBrowserAgent });
    // 焦点在侧栏网页里时按键到不了这个窗口，主进程截下副屏快捷键转过来
    const unsubscribeBrowserShortcut = chatAPI?.onBrowserSidePaneShortcut?.((shortcut) => {
        if (shortcut?.action === 'toggle') controller.toggleFromUser();
        else if (shortcut?.action === 'cycle') controller.cycleTab(shortcut.delta);
    });
    if (typeof unsubscribeBrowserShortcut === 'function') subscriptions.add({ dispose: unsubscribeBrowserShortcut });
    subscriptions.add(createSidePaneWorkspaceServices({ doc, win, chatAPI, chatManager, uiHelper, historyRef, controller, codeViewerProvider: codeViewer.provider, toolOutputProvider: toolOutput.provider, planDetailProvider: planDetail.provider }));
    subscriptions.add(createSidePaneLauncherWiring({ doc, win, chatAPI, chatManager, uiHelper, selectedItemRef, controller }));
    subscriptions.add(createSidePaneHostBindings({ win, chatAPI, uiHelper, chatManager, selectedItemRef, topicIdRef, toggleChatBtn, controller, restoreSessions: sideChat.restoreSessions }));
    // 标签类型都登记完才能认出存档里的标签；放在宿主同步 setParent 之后，存档直接按当前对话投影，
    // 不会先展开、挂上上次话题的激活标签，再被 setParent 收起
    controller.restoreLayout();
    subscriptions.add(createFloatingSelectionButton({ doc, win, notify: (message, type) => uiHelper?.showToastNotification?.(message, type) }));
    return controller;
}
