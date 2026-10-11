'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-game-smoke-')));
const timer = setTimeout(() => { console.error('GAME_SMOKE_TIMEOUT'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
    require('../../modules/ipc/gameHandlers').initialize();
    const hall = new BrowserWindow({
        show: false,
        webPreferences: {
            preload: path.join(root, 'preloads/utility.js'),
            sandbox: false, contextIsolation: true, nodeIntegration: false,
        },
    });
    await hall.loadFile(path.join(root, 'Gamemodules/game.html'));
    assert.equal(await hall.webContents.executeJavaScript('typeof window.utilityAPI.launchGame'), 'function');
    await hall.webContents.executeJavaScript("document.querySelector('[data-game=\"neon\"]').click()");
    let neon;
    for (let i = 0; i < 50; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        neon = BrowserWindow.getAllWindows().find(win => win !== hall);
        const text = await hall.webContents.executeJavaScript("document.getElementById('game-status').textContent");
        if (text.includes('游戏窗口已打开')) break;
    }
    assert.ok(neon, 'neon window created');
    assert.match(await hall.webContents.executeJavaScript("document.getElementById('game-status').textContent"), /游戏窗口已打开/);
    await neon.webContents.executeJavaScript("document.getElementById('start-button').click()");
    neon.webContents.on('console-message', (_event, level, message) => {
        if (level >= 2) console.error('NEON_CONSOLE', message);
    });
    for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const time = await neon.webContents.executeJavaScript("document.getElementById('hud-time').textContent");
        if (time !== '00:00') break;
    }
    const started = await neon.webContents.executeJavaScript(`({
        active: document.getElementById('start-screen').classList.contains('active'),
        time: document.getElementById('hud-time').textContent,
        canvas: document.getElementById('game-canvas').width
    })`);
    assert.equal(started.active, false, 'ES module wired start button');
    assert.notEqual(started.time, '00:00', 'game loop advanced');
    assert.ok(started.canvas > 0);
    const count = BrowserWindow.getAllWindows().length;
    await hall.webContents.executeJavaScript("window.utilityAPI.launchGame('neon')");
    assert.equal(BrowserWindow.getAllWindows().length, count);
    console.log('GAME_SMOKE_PASS', JSON.stringify(started));
    clearTimeout(timer);
    app.exit(0);
}).catch(error => {
    console.error(error);
    clearTimeout(timer);
    app.exit(1);
});