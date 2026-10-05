import { createSidePaneController } from '../ui-system/side-pane/side-pane-controller.js';
import { createSideChatWiring } from './sideChatWiring.js';
import { createFloatingSelectionButton } from './floatingSelectionButton.js';
import { createSidePaneHomeWiring } from './sidePaneHomeWiring.js';
import { createSidePaneWorkspaceServices } from './sidePaneWorkspaceServices.js';
import { createSidePaneHostBindings } from './sidePaneHostBindings.js';
import { defineNotificationsTabType } from '../ui-system/side-pane/tab-types/notifications.js';
import { defineChatTabType } from '../ui-system/side-pane/tab-types/chat.js';
import { defineCodeViewerTabType } from '../ui-system/side-pane/tab-types/code-viewer.js';
import { defineGitTabType } from '../ui-system/side-pane/tab-types/git.js';
import { defineBrowserTabType } from '../ui-system/side-pane/tab-types/browser.js';
import { defineTerminalTabType } from '../ui-system/side-pane/tab-types/terminal.js';
import { defineToolOutputTabType } from '../ui-system/side-pane/tab-types/tool-output.js';
import { definePlanDetailTabType } from '../ui-system/side-pane/tab-types/plan-detail.js';

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
    const { root, resizerHandle, tabList, contentContainer, toggleNotificationsBtn, toggleChatBtn, closeBtn, addBtn } = elements;
    if (!root) return null;


    const sideChat = createSideChatWiring({ doc, win, chatAPI, chatRepository, chatManager, uiHelper, createRenderer, selectedItemRef, topicIdRef, historyRef, getController: () => controller });
    const controller = createSidePaneController({
        root,
        resizerHandle,
        tabListElement: tabList,
        contentContainer,
        toggleNotificationsBtn,
        expandButton: toggleChatBtn,
        closeSidePaneBtn: closeBtn,
        addTabButton: addBtn,
        settingsRef,
        electronAPI: chatAPI,
        persistence: { storage: win.localStorage }
    });
    win.vcpSidePaneController = controller;
    subscriptions.add(controller);

    subscriptions.add(sideChat);
    // 带工程号时让 V工程 页打开后直接定位到这个工程（projectforge.js 读同一个本地键）
    const openProjectForge = (projectId) => {
        if (typeof projectId === 'string' && projectId) {
            try { win.localStorage.setItem('vcp-projectforge-focus', JSON.stringify({ id: projectId, at: Date.now() })); } catch (_e) { /* 打开窗口不受影响 */ }
        }
        const launcher = doc.querySelector('[data-action="open-project-forge-window"]');
        if (launcher) launcher.click();
        else chatAPI?.desktopCreateEmbeddedVchatApp?.('open-project-forge-window');
    };

    const deps = { document: doc, window: win, chatAPI, sidePaneController: controller, uiHelper };
    const codeViewer = defineCodeViewerTabType(deps);
    const git = defineGitTabType(deps);
    const browser = defineBrowserTabType(deps);
    const toolOutput = defineToolOutputTabType(deps);
    const planDetail = definePlanDetailTabType({ ...deps, historyRef, openProjectForge });
    const terminal = defineTerminalTabType({ ...deps, onOpenUrl: url => browser.provider.openBrowserTab({ url, forceNew: true }) });
    for (const definition of [defineNotificationsTabType(), defineChatTabType({ provider: sideChat.provider, openSideChat: sideChat.openSideChat, onClosed: sideChat.onTabClosed }), codeViewer, git, browser, terminal, toolOutput, planDetail]) {
        controller.registerTabType(definition);
    }
    // 标签类型都登记完才能认出存档里的标签
    controller.restoreLayout();
    // 焦点在侧栏网页里时按键到不了这个窗口，主进程截下副屏快捷键转过来
    const unsubscribeBrowserShortcut = chatAPI?.onBrowserSidePaneShortcut?.((shortcut) => {
        if (shortcut?.action === 'toggle') controller.toggleFromUser();
        else if (shortcut?.action === 'cycle') controller.cycleTab(shortcut.delta);
    });
    if (typeof unsubscribeBrowserShortcut === 'function') subscriptions.add({ dispose: unsubscribeBrowserShortcut });
    subscriptions.add(createSidePaneWorkspaceServices({ doc, win, chatAPI, chatManager, uiHelper, historyRef, codeViewerProvider: codeViewer.provider, gitProvider: git.provider, toolOutputProvider: toolOutput.provider, planDetailProvider: planDetail.provider }));
    subscriptions.add(createSidePaneHomeWiring({ doc, win, chatAPI, chatManager, uiHelper, selectedItemRef, controller }));
    subscriptions.add(createSidePaneHostBindings({ win, chatAPI, uiHelper, chatManager, selectedItemRef, topicIdRef, toggleChatBtn, controller, restoreSessions: sideChat.restoreSessions }));
    subscriptions.add(createFloatingSelectionButton({ doc, win, notify: (message, type) => uiHelper?.showToastNotification?.(message, type) }));
    return controller;
}
