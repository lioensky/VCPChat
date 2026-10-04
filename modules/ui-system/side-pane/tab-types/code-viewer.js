import { createCodeViewerSideProvider } from '../codeViewerSideProvider.js';

export function defineCodeViewerTabType({ document: doc, window: win, chatAPI, sidePaneController, uiHelper }) {
    const provider = createCodeViewerSideProvider({ document: doc, api: chatAPI || win.utilityAPI || win.electronAPI, sidePaneController, uiHelper });
    const label = '代码查看';
    const icon = 'code';
    return Object.freeze({
        kind: 'code-viewer', label, icon, searchHint: '代码', provider,
        entry: { id: 'code-viewer', order: 30, open: async () => {
            await sidePaneController.openTab({ id: 'code-viewer:browse', kind: 'code-viewer', title: label, icon, closable: true, scopeMode: 'global', payload: {} });
            sidePaneController.setVisible(true);
        } }
    });
}
