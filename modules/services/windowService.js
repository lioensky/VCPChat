const { ipcMain } = require('electron');
const { CHANNELS } = require('../ipc/ipcContracts');

const registry = new Map();
let lifecycleBridgeInitialized = false;

function initializeLifecycleBridge() {
    if (lifecycleBridgeInitialized) {
        return;
    }

    ipcMain.on(CHANNELS.WINDOW_READY, (event, payload = {}) => {
        const appId = payload.appId || findAppIdBySender(event.sender);
        if (!appId) {
            return;
        }

        markReady(appId, {
            sender: event.sender,
            payload,
        });
    });

    lifecycleBridgeInitialized = true;
}

function findAppIdBySender(sender) {
    for (const [appId, entry] of registry.entries()) {
        const win = resolveWindow(entry);
        if (win && !win.isDestroyed() && win.webContents.id === sender.id) {
            return appId;
        }
    }
    return null;
}

function resolveWindow(entry) {
    const explicitWindow = entry.window && !entry.window.isDestroyed() ? entry.window : null;
    const win = explicitWindow || (typeof entry.getWindow === 'function' ? entry.getWindow() : null);
    if (!win || win.isDestroyed()) {
        return null;
    }
    return win;
}

function refreshWindowState(entry) {
    const win = resolveWindow(entry);
    const currentWebContentsId = win ? win.webContents.id : null;

    if (entry.readyWebContentsId && entry.readyWebContentsId !== currentWebContentsId) {
        entry.ready = false;
        entry.readyWebContentsId = null;
        entry.readyPayload = null;
    }

    if (!currentWebContentsId) {
        entry.ready = false;
        entry.readyPayload = null;
    }

    return win;
}

function getEntry(appId) {
    const entry = registry.get(appId);
    if (!entry) {
        throw new Error(`WindowService app "${appId}" is not registered.`);
    }
    return entry;
}

function register(appId, config) {
    initializeLifecycleBridge();

    const previous = registry.get(appId);
    const entry = {
        appId,
        owner: config.owner || previous?.owner || 'unknown',
        open: config.open || previous?.open || null,
        focus: config.focus || previous?.focus || null,
        getWindow: config.getWindow || previous?.getWindow || null,
        payloadChannel: config.payloadChannel || previous?.payloadChannel || null,
        readyTimeoutMs: config.readyTimeoutMs || previous?.readyTimeoutMs || 10000,
        window: previous?.window || null,
        ready: previous?.ready || false,
        readyWebContentsId: previous?.readyWebContentsId || null,
        readyPayload: previous?.readyPayload || null,
        waiters: previous?.waiters || [],
    };

    registry.set(appId, entry);
    return entry;
}

function attachWindow(appId, win) {
    const entry = registry.has(appId)
        ? registry.get(appId)
        : register(appId, { owner: 'unassigned' });
    entry.window = win;
    entry.ready = false;
    entry.readyWebContentsId = null;
    entry.readyPayload = null;

    if (win && !win.isDestroyed()) {
        const webContentsId = win.webContents.id;
        win.once('closed', () => {
            const currentEntry = registry.get(appId);
            if (!currentEntry) {
                return;
            }

            if (currentEntry.readyWebContentsId === webContentsId || currentEntry.window === win) {
                currentEntry.window = null;
                currentEntry.ready = false;
                currentEntry.readyWebContentsId = null;
                currentEntry.readyPayload = null;
            }
        });
    }
}

function markReady(appId, context = {}) {
    const entry = registry.get(appId);
    if (!entry) {
        return false;
    }

    const win = refreshWindowState(entry);
    if (context.sender && win && win.webContents.id !== context.sender.id) {
        return false;
    }

    entry.ready = true;
    entry.readyWebContentsId = context.sender ? context.sender.id : (win ? win.webContents.id : null);
    entry.readyPayload = context.payload || null;

    const waiters = entry.waiters.splice(0, entry.waiters.length);
    for (const waiter of waiters) {
        clearTimeout(waiter.timeoutId);
        waiter.resolve(win);
    }

    return true;
}

function waitForReady(appId, timeoutMs) {
    const entry = getEntry(appId);
    const win = refreshWindowState(entry);

    if (win && entry.ready && entry.readyWebContentsId === win.webContents.id) {
        return Promise.resolve(win);
    }

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            entry.waiters = entry.waiters.filter((waiter) => waiter !== pendingWaiter);
            reject(new Error(`Timed out waiting for "${appId}" window ready.`));
        }, timeoutMs);

        const pendingWaiter = {
            resolve,
            reject,
            timeoutId,
        };

        entry.waiters.push(pendingWaiter);
    });
}

async function open(appId, options = {}) {
    const entry = getEntry(appId);
    if (typeof entry.open !== 'function') {
        throw new Error(`WindowService app "${appId}" does not define open().`);
    }
    return entry.open(options);
}

async function focus(appId, options = {}) {
    const entry = getEntry(appId);
    const win = refreshWindowState(entry);

    if (win) {
        if (!win.isVisible()) {
            win.show();
        }
        if (win.isMinimized && win.isMinimized()) {
            win.restore();
        }
        win.focus();
        return win;
    }

    if (typeof entry.focus === 'function') {
        return entry.focus(options);
    }

    return open(appId, options);
}

async function ensureReady(appId, options = {}) {
    const entry = getEntry(appId);
    let win = refreshWindowState(entry);

    if (!win) {
        await open(appId, options);
        win = refreshWindowState(entry);
    } else if (options.focus !== false) {
        await focus(appId, options);
        win = refreshWindowState(entry);
    }

    if (!win) {
        throw new Error(`WindowService app "${appId}" did not return a BrowserWindow instance.`);
    }

    if (entry.ready && entry.readyWebContentsId === win.webContents.id) {
        return win;
    }

    return waitForReady(appId, options.timeoutMs || entry.readyTimeoutMs || 10000);
}

async function sendPayload(appId, payload, options = {}) {
    const entry = getEntry(appId);
    const channel = options.channel || entry.payloadChannel;
    if (!channel) {
        throw new Error(`WindowService app "${appId}" does not define a payload channel.`);
    }

    const win = await ensureReady(appId, options);
    win.webContents.send(channel, payload);
    return win;
}

function getState(appId) {
    const entry = getEntry(appId);
    const win = refreshWindowState(entry);
    return {
        appId,
        owner: entry.owner,
        ready: !!entry.ready,
        readyWebContentsId: entry.readyWebContentsId || null,
        hasWindow: !!win,
        isDestroyed: !win,
        payloadChannel: entry.payloadChannel || null,
    };
}

module.exports = {
    register,
    attachWindow,
    markReady,
    open,
    focus,
    ensureReady,
    sendPayload,
    getState,
};
