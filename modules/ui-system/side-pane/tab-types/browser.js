import { createBrowserSideProvider } from '../browserSideProvider.js';

export function defineBrowserTabType({ document: doc, window: win, chatAPI, sidePaneController }) {
    const provider = createBrowserSideProvider({ document: doc, api: chatAPI || win.electronAPI, sidePaneController });
    return Object.freeze({
        kind: 'browser', label: '浏览器', icon: 'public', searchHint: '浏览器', provider,
        entry: { id: 'browser', order: 40, open: () => provider.openBrowserTab() }
    });
}
