import { createCodeViewerSideProvider } from '../codeViewerSideProvider.js';

export function defineCodeViewerTabType({ document: doc, window: win, chatAPI, sidePaneController, uiHelper }) {
    const provider = createCodeViewerSideProvider({ document: doc, api: chatAPI || win.utilityAPI || win.electronAPI, sidePaneController, uiHelper });
    const label = '代码查看';
    const icon = 'code';
    return Object.freeze({
        // 不进启动器：代码查看总是从消息里的文件名、Git 改动等具体文件点进来
        kind: 'code-viewer', label, icon, searchHint: '代码', provider
    });
}
