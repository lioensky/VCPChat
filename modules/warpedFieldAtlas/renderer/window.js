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
// Subscribe first: a slow initial read must not undo a newer broadcast.
let themeRevision = 0;
function applyTheme(mode) {
    if (mode !== 'dark' && mode !== 'light') return;
    document.body.classList.toggle('light-theme', mode === 'light');
    window.__warpedFieldAtlas.refreshTheme();
}
const offTheme = api?.onThemeUpdated?.(mode => { themeRevision++; applyTheme(mode); });
api?.getCurrentTheme?.().then(mode => { if (!themeRevision) applyTheme(mode); }).catch(() => {});
window.addEventListener('pagehide', () => {
    if (typeof offTheme === 'function') offTheme();
    window.__warpedFieldAtlas.dispose();
}, { once: true });
