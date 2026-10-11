'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tax-smoke-'));
app.setPath('userData', temp);
app.on('window-all-closed', () => {});
const errors = [];
let win;
async function open() {
    win = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    win.webContents.on('console-message', (_event, level, message) => {
        if (level >= 3) errors.push(message);
    });
    await win.loadFile(path.resolve(__dirname, '../Gamemodules/forge-tax/index.html'));
}
app.whenReady().then(async () => {
    await open();
    const inline = await win.webContents.executeJavaScript(`(() => {
        window.confirm = window.alert = window.prompt = () => { throw new Error('禁止原生模态'); };
        const api = window.forgeTaxGame;
        const panel = document.getElementById('info-panel');
        document.getElementById('help').click();
        const helpVisible = !panel.hidden;
        const before = api.getState();
        document.querySelector('[data-hits="1"]').click();
        const interactive = api.getState().revision === before.revision + 1 && panel.hidden;
        document.getElementById('tribute').click();
        const pendingDay = api.getState().day;
        const confirmVisible = !panel.hidden && !!document.getElementById('confirm-action');
        document.getElementById('cancel-action').click();
        const cancelled = api.getState().day === pendingDay && panel.hidden;
        document.getElementById('tribute').click();
        document.querySelector('[data-hits="1"]').click();
        const invalidated = panel.hidden && !document.getElementById('confirm-action');
        document.getElementById('tribute').click();
        document.getElementById('confirm-action').click();
        return { helpVisible, interactive, confirmVisible, cancelled, invalidated,
            advanced: api.getState().day === pendingDay + 1,
            dialogs: document.querySelectorAll('dialog,[aria-modal="true"]').length };
    })()`);
    assert.deepEqual(inline, { helpVisible: true, interactive: true, confirmVisible: true,
        cancelled: true, invalidated: true, advanced: true, dialogs: 0 });
    console.log('FORGETAX_NONMODAL_PASS', JSON.stringify(inline));
    const result = await win.webContents.executeJavaScript(`(async () => {
        localStorage.removeItem('forge-tax-save-v1');
        const api = window.forgeTaxGame;
        const before = api.getState();
        const result = await api.dispatch({type:'hammer', swordId:before.swords[0].id, count:1, revision:before.revision});
        return {
            ok:result.ok, revision:result.state.revision,
            slots:document.querySelectorAll('.relic-slot').length,
            relicShop:document.querySelectorAll('#relic-shop .shop-card').length,
            itemShop:document.querySelectorAll('#item-shop .shop-card').length,
            logs:document.querySelectorAll('#log li').length,
            saved:JSON.parse(localStorage.getItem('forge-tax-save-v1')).revision
        };
    })()`);
    assert.equal(result.ok, true);
    assert.equal(result.slots, 8);
    assert.equal(result.relicShop, 3);
    assert.equal(result.itemShop, 5);
    assert.ok(result.logs >= 1);
    assert.equal(result.saved, result.revision);
    win.destroy();
    await open();
    const restored = await win.webContents.executeJavaScript('window.forgeTaxGame.getState().revision');
    assert.equal(restored, result.revision);
    assert.deepEqual(errors, []);
    console.log('FORGETAX_ELECTRON_SMOKE_PASS', JSON.stringify(result));
    win.destroy();
    app.exit(0);
}).catch(error => {
    console.error(error);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
});
setTimeout(() => { console.error('Smoke timed out'); app.exit(1); }, 20000).unref();
// Temporary profile intentionally retained for diagnosis; never touches user game saves.