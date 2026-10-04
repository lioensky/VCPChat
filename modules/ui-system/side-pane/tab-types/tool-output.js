import { createToolOutputSideProvider } from '../toolOutputSideProvider.js';

export function defineToolOutputTabType({ document: doc, window: win, chatAPI, sidePaneController, uiHelper }) {
    const provider = createToolOutputSideProvider({ document: doc, api: chatAPI || win.electronAPI, sidePaneController, uiHelper });
    return Object.freeze({
        kind: 'tool-output', label: '命令输出', icon: 'description', searchHint: '命令输出',
        entry: { id: 'tool-output', order: 60, open: () => provider.openToolOutputTab() },
        provider
    });
}
