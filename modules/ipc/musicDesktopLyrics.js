// modules/ipc/musicDesktopLyrics.js
//
// 桌面歌词：音乐窗口之外的一条透明、置顶的歌词条，切到别的程序也能看到唱到哪一句。
// - 音乐窗口每换一行（或每隔几秒）把当前行、下一行、逐字时间和播放进度送过来，这里原样转给歌词条，
//   歌词条按收到时的进度自己往前走，不需要每帧通信。
// - 歌词条上悬停出现：上一首 / 播放暂停 / 下一首、字号、锁定、打开播放器、关闭。
//   锁定后鼠标穿过歌词条点到下面的窗口，只有悬停在锁形按钮上时才接收点击（用来解锁）。
// - 开关、位置、大小、锁定、字号都记在 music-desktop-lyrics.json；音乐窗口关了歌词条跟着关，下次开音乐窗口时按上次的开关恢复。

const fs = require('fs');
const path = require('path');
const electron = require('electron');
const windowBounds = require('../musicWindowBounds');
const { PRELOAD_ROLES, resolveProjectPreload } = require('../services/preloadPaths');

const DEFAULTS = Object.freeze({ on: false, locked: false, size: 34, bounds: null });
const SIZE_MIN = 20;
const SIZE_MAX = 64;
const COMMANDS = new Set(['previous', 'next', 'play', 'pause']);

function createDesktopLyrics({ ipcMain, getMusicWindow, stateFile, projectRoot, electronApi = electron }) {
    let prefs = { ...DEFAULTS };
    try {
        const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (raw && typeof raw === 'object') prefs = { ...DEFAULTS, ...raw };
    } catch (_) { /* 第一次用 */ }
    let win = null;
    let last = null;          // 音乐窗口最近送来的状态，歌词条刚打开时先补一份
    let saveTimer = null;

    const save = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try { fs.writeFileSync(stateFile, JSON.stringify(prefs)); } catch (e) { console.error('[Music] 桌面歌词设置没存上:', e.message); }
        }, 300);
    };
    const musicWin = () => {
        const w = getMusicWindow();
        return w && !w.isDestroyed() ? w : null;
    };
    const tellMusic = () => musicWin()?.webContents.send('music-desktop-lyrics-changed', { on: prefs.on, locked: prefs.locked, size: prefs.size });
    const tellBar = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
    const applyLock = () => {
        if (!win || win.isDestroyed()) return;
        win.setIgnoreMouseEvents(prefs.locked, { forward: true });
    };

    const defaultBounds = () => {
        let area = { x: 0, y: 0, width: 1280, height: 720 };
        try { area = electronApi.screen.getPrimaryDisplay().workArea; } catch (_) { /* 拿不到屏幕信息 */ }
        const width = Math.min(960, Math.round(area.width * 0.7));
        const height = 150;
        return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + area.height - height - 40), width, height };
    };
    const restoredBounds = () => {
        let areas = [];
        try { areas = electronApi.screen.getAllDisplays().map((d) => d.workArea); } catch (_) { /* 同上 */ }
        return windowBounds.restoreBounds(prefs.bounds, areas, { minWidth: 360, minHeight: 90 }) || defaultBounds();
    };
    const rememberBounds = () => {
        if (!win || win.isDestroyed()) return;
        const b = win.getBounds();
        prefs.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        save();
    };

    const open = () => {
        if (win && !win.isDestroyed()) { win.showInactive(); return win; }
        if (!musicWin()) return null;
        const b = restoredBounds();
        win = new electronApi.BrowserWindow({
            x: b.x, y: b.y, width: b.width, height: b.height,
            minWidth: 360, minHeight: 90,
            title: '桌面歌词',
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            hasShadow: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            resizable: true,
            maximizable: false,
            minimizable: false,
            fullscreenable: false,
            show: false,
            webPreferences: {
                preload: resolveProjectPreload(projectRoot, PRELOAD_ROLES.UTILITY),
                sandbox: false,
                contextIsolation: true,
                nodeIntegration: false,
                backgroundThrottling: false
            }
        });
        win.setAlwaysOnTop(true, 'screen-saver');
        win.setMenu?.(null);
        win.loadFile(path.join(projectRoot, 'Musicmodules', 'desktop-lyrics', 'desktop-lyrics.html'));
        win.once('ready-to-show', () => { if (win && !win.isDestroyed()) { applyLock(); win.showInactive(); } });
        win.webContents.on('did-finish-load', () => {
            tellBar('music-desktop-lyrics-prefs', { locked: prefs.locked, size: prefs.size });
            if (last) tellBar('music-desktop-lyrics-state', last);
        });
        win.webContents.on('will-navigate', (event) => event.preventDefault());
        win.on('moved', rememberBounds);
        win.on('resized', rememberBounds);
        const self = win;
        win.on('closed', () => {
            if (win === self) win = null;
            // 用户在歌词条上点了关闭（或被系统关掉）：记成关；跟着音乐窗口一起关的不改开关
            if (!self.withMusic && prefs.on) { prefs.on = false; save(); tellMusic(); }
        });
        return win;
    };
    const close = () => { if (win && !win.isDestroyed()) win.close(); };

    const setOn = (on) => {
        prefs.on = Boolean(on);
        save();
        if (prefs.on) open(); else close();
        tellMusic();
        return prefs.on;
    };

    ipcMain.handle('music-desktop-lyrics-get', () => ({ on: prefs.on, locked: prefs.locked, size: prefs.size }));
    ipcMain.handle('music-desktop-lyrics-toggle', (event, on) => {
        if (!musicWin() || event.sender !== musicWin().webContents) throw new Error('只有音乐窗口能开关桌面歌词。');
        return setOn(on === undefined || on === null ? !prefs.on : on === true);
    });
    ipcMain.on('music-desktop-lyrics-publish', (event, payload) => {
        if (!musicWin() || event.sender !== musicWin().webContents || !payload || typeof payload !== 'object') return;
        last = payload;
        tellBar('music-desktop-lyrics-state', payload);
    });
    ipcMain.on('music-desktop-lyrics-command', (event, command, value) => {
        if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
        if (COMMANDS.has(command)) { musicWin()?.webContents.send('music-control', command); return; }
        if (command === 'close') { setOn(false); return; }
        if (command === 'open-music') { const m = musicWin(); if (m) { if (m.isMinimized()) m.restore(); m.show(); m.focus(); } return; }
        if (command === 'lock') { prefs.locked = value === true; save(); applyLock(); tellBar('music-desktop-lyrics-prefs', { locked: prefs.locked, size: prefs.size }); tellMusic(); return; }
        // 锁定时悬停在锁形按钮上：临时接收点击，移开再穿透
        if (command === 'hover') { if (prefs.locked) win.setIgnoreMouseEvents(value !== true, { forward: true }); return; }
        if (command === 'size') {
            const n = Math.round(Number(value));
            if (!Number.isFinite(n)) return;
            prefs.size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, n));
            save();
            tellBar('music-desktop-lyrics-prefs', { locked: prefs.locked, size: prefs.size });
        }
    });

    return {
        // 音乐窗口的页面就绪后调用：上次开着就重新打开
        musicReady() { if (prefs.on) open(); tellMusic(); },
        // 音乐窗口关了：歌词条跟着关，开关保持
        musicClosed() {
            last = null;
            if (win && !win.isDestroyed()) { win.withMusic = true; win.close(); }
        },
        isOpen: () => Boolean(win && !win.isDestroyed()),
        prefs: () => ({ ...prefs })
    };
}

module.exports = { createDesktopLyrics, SIZE_MIN, SIZE_MAX };
