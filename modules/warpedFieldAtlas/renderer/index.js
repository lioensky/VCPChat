// 双曲场图在主窗口这一侧（feature.json 的 renderer，由 modules/renderer/appFeatures.js 载入）。
// 通过 window.nextUiApps 登记到 VCPContributions.apps，供右栏“应用”显示。
// 点开时只做一件事：让主进程打开双曲场图自己的窗口（window.html）。主窗口里不挂界面，登记表要的那一页随即收掉。

// 系统图标一族：灰色单线、方头、有断口、菱形点缀。外圈和里圈是场的两道边界，菱形是一个节点。
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square">'
    + '<path d="M19.4 7.5A9 9 0 1 0 21 12"/><path d="M12 8a4 4 0 1 0 4 4"/><path d="M18.5 2.5 21 5 18.5 7.5 16 5Z"/></svg>';

export function install(context = {}) {
    const chatAPI = context.chatAPI || window.chatAPI || null;
    if (!chatAPI?.warpedFieldAtlasOpen) return;
    const register = () => window.nextUiApps.register({
        id: 'warped-field-atlas',
        title: '双曲场图',
        kind: 'internal',
        launchpadIcon: 'warped-field-atlas',
        iconSvg: ICON,
        mount(container, app) {
            chatAPI.warpedFieldAtlasOpen();
            // 等登记表把这一页记下之后再收：这样它不会留在标签里，也不会被记进“上次打开的标签”。
            setTimeout(() => app?.close?.(), 0);
            return () => {};
        },
    });
    if (window.nextUiApps?.register) register();
    else window.addEventListener('next-ui-apps-ready', register, { once: true });
}
