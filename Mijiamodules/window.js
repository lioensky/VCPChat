import { mountMijiaPanel } from './panel.js';

const api = window.utilityAPI || window.electronAPI;
const panel = mountMijiaPanel(document.getElementById('mijia-root'), api);
const applyTheme = theme => document.body.classList.toggle('light-theme', theme === 'light');
let themeReceived = false;
const unsubscribe = api?.onThemeUpdated?.(theme => {
    themeReceived = true;
    applyTheme(theme);
});
void Promise.resolve(api?.getCurrentTheme?.()).then(theme => {
    if (!themeReceived) applyTheme(theme);
}).catch(() => {});

const stylesheet = document.querySelector('link[href="../styles/themes.css"]');
const offStyles = api?.onThemeStylesheetUpdated?.(version => {
    if (!stylesheet || !Number.isSafeInteger(version)) return;
    const url = new URL(stylesheet.href);
    url.searchParams.set('themeVersion', String(version));
    stylesheet.href = url.href;
});

let maximized = false;
const offMax = api?.onWindowMaximized?.(() => { maximized = true; });
const offRestore = api?.onWindowUnmaximized?.(() => { maximized = false; });
document.getElementById('minimize-btn').addEventListener('click', () => api?.minimizeWindow?.());
document.getElementById('maximize-btn').addEventListener('click', () => {
    if (maximized) api?.unmaximizeWindow?.();
    else api?.maximizeWindow?.();
});
document.getElementById('close-btn').addEventListener('click', () => api?.closeWindow?.());
api?.windowReady?.('mijia');

window.addEventListener('pagehide', () => {
    panel.dispose();
    for (const off of [unsubscribe, offStyles, offMax, offRestore]) if (typeof off === 'function') off();
}, { once: true });