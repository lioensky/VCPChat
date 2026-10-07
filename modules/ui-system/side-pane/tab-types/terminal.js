import { createLazyProvider } from './lazy-provider.js';

export function defineTerminalTabType({ document: doc, window: win, chatAPI, sidePaneController, uiHelper, onOpenUrl }) {
    const provider = createLazyProvider(async () => {
        const { createTerminalSideProvider } = await import('../terminalSideProvider.js');
        return createTerminalSideProvider({ document: doc, api: chatAPI || win.electronAPI, sidePaneController, onOpenUrl, uiHelper });
    }, ['openTerminalTab'], { label: '终端', notify: (message, type) => uiHelper?.showToastNotification?.(message, type) });
    return Object.freeze({
        kind: 'terminal', label: '终端', icon: 'terminal', searchHint: '终端',
        // 重启后不自动拉起新的 shell
        persist: false,
        // 隐藏久了只把终端画面摘下来，shell 会话保留，再显示时接回去
        dormancy: 'detach',
        entry: { id: 'terminal', order: 50, open: () => provider.openTerminalTab() },
        provider
    });
}
