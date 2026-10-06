import { createLazyProvider } from './lazy-provider.js';

export function defineCodeViewerTabType({ document: doc, window: win, chatAPI, sidePaneController, uiHelper }) {
    const provider = createLazyProvider(async () => {
        const { createCodeViewerSideProvider } = await import('../codeViewerSideProvider.js');
        return createCodeViewerSideProvider({ document: doc, api: chatAPI || win.utilityAPI || win.electronAPI, sidePaneController, uiHelper });
    }, ['openViewer']);
    const label = '代码查看';
    const icon = 'code';
    return Object.freeze({
        // 不进启动器：代码查看总是从消息里的文件名、Git 改动等具体文件点进来
        kind: 'code-viewer', label, icon, searchHint: '代码', provider
    });
}
