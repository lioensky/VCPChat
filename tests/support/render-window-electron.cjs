const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-render-window-'));
app.setPath('userData', profile);
let window;
let timer;
async function finish(code) {
    clearTimeout(timer);
    if (window && !window.isDestroyed()) window.destroy();
    app.quit();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    app.exit(code);
}
app.whenReady().then(async () => {
    timer = setTimeout(() => { console.error('RENDER_WINDOW_TIMEOUT'); void finish(1); }, 90000);
    window = new BrowserWindow({
        width: 1000, height: 800, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    window.webContents.on('console-message', (_event, ...args) => {
        const message = typeof args[0] === 'object' ? args[0].message : args[1];
        if (/error|failed|rejected/i.test(message || '')) console.error(message);
    });
    try {
        await window.loadFile(path.join(__dirname, 'render-window.html'));
        const result = await window.webContents.executeJavaScript('window.runRenderWindowSmoke()');
        console.log('RENDER_WINDOW_RESULT ' + JSON.stringify(result));
        await finish(0);
    } catch (error) {
        console.error(error.stack || error);
        await finish(1);
    }
}).catch(error => { console.error(error); void finish(1); });