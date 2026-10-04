import { createTerminalSideProvider } from '../terminalSideProvider.js';

export function defineTerminalTabType({ document: doc, window: win, chatAPI, sidePaneController, uiHelper, onOpenUrl }) {
    const provider = createTerminalSideProvider({ document: doc, api: chatAPI || win.electronAPI, sidePaneController, onOpenUrl });
    return Object.freeze({
        kind: 'terminal', label: '终端', icon: 'terminal', searchHint: '终端',
        entry: { id: 'terminal', order: 50, open: () => provider.openTerminalTab() },
        provider
    });
}
