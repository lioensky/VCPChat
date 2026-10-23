/**
 * modules/ui-system/side-pane/appearanceSideProvider.js
 * VCPChat Universal Sub-screen - 外观与布局 Provider
 *
 * 把「外观配置工作台」放进右侧栏的一个子标签页，而不是盖住整个窗口的浮层。
 * 工作台的状态与持久化仍由 window.VCPAppearanceStudio 持有；这里只负责：
 *   1. 打开 / 聚焦唯一的 appearance 标签页；
 *   2. 把标签页的视图容器交给工作台挂载，并在标签关闭时让工作台回滚未应用的预览。
 */

'use strict';

export const APPEARANCE_TAB_ID = 'side-pane-appearance';

export function createAppearanceSideProvider({
    studio = (typeof window !== 'undefined' ? window.VCPAppearanceStudio : null),
    sidePaneController = null
} = {}) {
    const kind = 'appearance';

    async function openAppearanceTab() {
        if (!sidePaneController) return null;
        const handle = await sidePaneController.openTab({
            id: APPEARANCE_TAB_ID,
            kind,
            title: '外观与布局',
            icon: 'palette',
            closable: true,
            scopeMode: 'global',
            searchHint: '外观 主题 圆角 预设 胶囊 布局'
        });
        sidePaneController.setVisible?.(true);
        handle?.focus?.();
        return handle;
    }

    async function closeAppearanceTab() {
        await sidePaneController?.closeTab?.(APPEARANCE_TAB_ID);
    }

    return {
        kind,
        tabId: APPEARANCE_TAB_ID,
        openAppearanceTab,
        closeAppearanceTab,

        async mountTab(_tab, viewElement) {
            if (!viewElement || !studio?.mount) return null;
            return studio.mount(viewElement, { onRequestClose: closeAppearanceTab });
        }
    };
}
