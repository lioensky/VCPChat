import { createLazyProvider } from './lazy-provider.js';

export function defineToolOutputTabType({ document: doc, window: win, chatAPI, sidePaneController, uiHelper }) {
    const provider = createLazyProvider(async () => {
        const { createToolOutputSideProvider } = await import('../toolOutputSideProvider.js');
        return createToolOutputSideProvider({ document: doc, api: chatAPI || win.electronAPI, sidePaneController, uiHelper });
    }, ['openToolOutputTab'], { label: '命令输出', notify: (message, type) => uiHelper?.showToastNotification?.(message, type) });
    return Object.freeze({
        kind: 'tool-output', label: '命令输出', icon: 'description', searchHint: '命令输出 后台输出 终端',
        // 命令记录只在内存里，重启后没有可看的
        persist: false,
        // 不进启动器：命令输出从状态面板的命令行点进来，单独打开一个空的列表没有意义
        provider
    });
}
