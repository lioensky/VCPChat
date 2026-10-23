import { createLazyProvider } from './lazy-provider.js';

export function defineAppearanceTabType({ document: doc, window: win, sidePaneController, uiHelper }) {
    const provider = createLazyProvider(async () => {
        const { createAppearanceSideProvider } = await import('../appearanceSideProvider.js');
        return createAppearanceSideProvider({ studio: win.VCPAppearanceStudio, sidePaneController });
    }, ['openAppearanceTab', 'closeAppearanceTab'], { label: '外观与布局', notify: (message, type) => uiHelper?.showToastNotification?.(message, type) });
    return Object.freeze({
        kind: 'appearance', label: '外观与布局', icon: 'palette', searchHint: '外观 主题 圆角 预设 胶囊 布局',
        provider
    });
}

// 账户菜单、设置卡片等入口调用的是 window.VCPAppearanceStudio.open()，在这里落到侧栏标签页上
export function registerAppearanceStudioOpener({ window: win, provider }) {
    const unregister = win.VCPAppearanceStudio?.registerOpener?.({
        open: () => provider.openAppearanceTab(),
        close: () => provider.closeAppearanceTab()
    });
    return { dispose: () => { if (typeof unregister === 'function') unregister(); } };
}
