import { createSidePaneController } from '../ui-system/side-pane/side-pane-controller.js';
import { createSideChatWiring } from './sideChatWiring.js';
import { createFloatingSelectionButton } from './floatingSelectionButton.js';
import { createSidePaneLauncherWiring } from './sidePaneLauncherWiring.js';
import { createSidePaneWorkspaceServices } from './sidePaneWorkspaceServices.js';
import { createSidePaneHostBindings } from './sidePaneHostBindings.js';
import { defineNotificationsTabType } from '../ui-system/side-pane/tab-types/notifications.js';
import { defineChatTabType } from '../ui-system/side-pane/tab-types/chat.js';
import { defineNotesTabType } from '../ui-system/side-pane/tab-types/notes.js';
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
        toggleChatBtn,
        closeSidePaneBtn: closeBtn,
        addChatTabBtn: addBtn,
        settingsRef,
        electronAPI: chatAPI,
        onOpenSideChat: sideChat.openSideChat,
        onTabClosed: sideChat.onTabClosed,
        onRestoreSessions: sideChat.restoreSessions
    });
    win.vcpSidePaneController = controller;
    subscriptions.add(controller);

    subscriptions.add(sideChat);
    const openProjectForge = () => {
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
    for (const definition of [defineNotificationsTabType(), defineChatTabType({ provider: sideChat.provider, sidePaneController: controller }), defineNotesTabType(deps), codeViewer, git, browser, terminal, toolOutput, planDetail]) {
        controller.registerTabType(definition);
    }
    controller.setLauncherAddressHandler(browser.addressHandler);
    subscriptions.add(createSidePaneWorkspaceServices({ doc, win, chatAPI, chatManager, uiHelper, historyRef, codeViewerProvider: codeViewer.provider, gitProvider: git.provider, toolOutputProvider: toolOutput.provider, planDetailProvider: planDetail.provider, openProjectForge }));
    subscriptions.add(createSidePaneLauncherWiring({ doc, win, chatAPI, chatManager, uiHelper, selectedItemRef, controller }));
    subscriptions.add(createSidePaneHostBindings({ win, chatAPI, uiHelper, chatManager, selectedItemRef, topicIdRef, toggleChatBtn, controller }));
    subscriptions.add(createFloatingSelectionButton({ doc, win, notify: (message, type) => uiHelper?.showToastNotification?.(message, type) }));
    return controller;
}
