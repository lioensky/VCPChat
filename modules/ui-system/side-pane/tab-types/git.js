import { createGitSideProvider } from '../gitSideProvider.js';

export function defineGitTabType({ document: doc, window: win, chatAPI, sidePaneController, uiHelper }) {
    const provider = createGitSideProvider({ electronAPI: chatAPI || win.electronAPI, sidePaneController, uiHelper });
    return Object.freeze({
        kind: 'git', label: 'Git 变更', icon: 'branch', searchHint: 'Git 变更',
        entry: { id: 'git', order: 35, open: () => provider.openGitTab() },
        provider
    });
}
