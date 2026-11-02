'use strict';
// defaults for every Chat window, applied when it is created.
// - The VCP icon and taskbar identity: windows built from upstream code still carried VCP's assets/icon.png.
// - A dark base color. Electron's default base is white, and a window shown from hidden (Chat behind the lobby) or
//   still painting its first frame shows that base for 0.1-0.3 s, so it flashed white. VCP is dark only, and every
//   Chat page is opaque over its base, so the dark base is seen only during that gap. Windows that chose their own
//   color (or are transparent) keep it; one that chose white itself calls keepBase() right after creating it.
// - Open maximized, not full screen : main windows are created at the work-area size with
//   maximizedBounds() and enter the maximized state on first show with maximizeOnFirstShow(), so they never show
//   small first and then jump. Small floating windows (assistant bar, mini notes, voice overlay, viewers) do not use it.
const { app, screen } = require('electron');

const DARK_BASE = '#1a130f'; // average color of the VCP wallpaper (assets/wallpaper/uttu_charcoal_dark.webp)
const kept = new WeakSet();

function keepBase(win) {
    kept.add(win);
    return win;
}

function applyWindowDefaults(win) {
    if (win.isDestroyed()) return;
    // Explicit white and Electron's default both read back as #FFFFFF.
    if (!kept.has(win) && String(win.getBackgroundColor()).toUpperCase() === '#FFFFFF') win.setBackgroundColor(DARK_BASE);
}

function install() {
    // The event fires inside the BrowserWindow constructor, before it applies its own background color, so wait
    // for the constructor to finish; that is still before the window can paint.
    app.on('browser-window-created', (_event, win) => queueMicrotask(() => applyWindowDefaults(win)));
}

function maximizedBounds() {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
}

function maximizeOnFirstShow(win) {
    //  Created with the work area as its bounds, a frameless window's content came out about 3 px wider
    // than when maximized, so its first frame was wide and maximize() then shrank it: a visible jump to the right.
    // A frameless window's maximized content area is the work area, so give it exactly that before it shows.
    if (!win.isVisible()) {
        const { workArea } = screen.getDisplayMatching(win.getBounds());
        const content = win.getContentBounds();
        if (Math.abs(content.width - workArea.width) <= 16 && Math.abs(content.height - workArea.height) <= 16) {
            win.setContentBounds(workArea);
        }
    }
    win.once('show', () => {
        if (!win.isDestroyed() && !win.isMaximized()) win.maximize();
    });
    return win;
}

module.exports = { DARK_BASE, applyWindowDefaults, keepBase, install, maximizedBounds, maximizeOnFirstShow };
