// 双曲场图自己的窗口（window.html）。数据经 preload 的 warpedFieldAtlasGet 走主进程转到后端插件。
import { mountAtlas } from './atlas-app.js';

const api = window.utilityAPI || window.electronAPI;
const source = {
    async get(route) {
        if (!api?.warpedFieldAtlasGet) throw new Error('这个窗口没有取到双曲场图的接口。');
        const result = await api.warpedFieldAtlasGet(route);
        if (!result?.success) throw new Error(result?.message || '读取双曲场失败。');
        return result.data;
    },
};
const controls = document.getElementById('window-controls').content.firstElementChild.cloneNode(true);
controls.querySelector('[data-action="minimize"]').addEventListener('click', () => api?.minimizeWindow?.());
controls.querySelector('[data-action="maximize"]').addEventListener('click', () => api?.maximizeWindow?.());
controls.querySelector('[data-action="close"]').addEventListener('click', () => {
    if (api?.closeWindow) api.closeWindow();
    else window.close();
});
window.__warpedFieldAtlas = mountAtlas(document.getElementById('app'), source, {
    ownWindow: true,
    windowControls: controls,
});
