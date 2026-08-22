const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadThemeHandlers() {
    const originalLoad = Module._load;
    const ipcMain = { on() {}, handle() {} };
    const nativeTheme = { shouldUseDarkColors: false, themeSource: 'light', on() {} };
    class BrowserWindow {}
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'electron') return { ipcMain, BrowserWindow, nativeTheme };
        if (request.endsWith('../services/preloadPaths')) {
            return { PRELOAD_ROLES: { UTILITY: 'utility' }, resolveProjectPreload: () => '/tmp/utility-preload.js' };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const modulePath = require.resolve('../modules/ipc/themeHandlers.js');
        delete require.cache[modulePath];
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
    }
}

function makeContents(name, { destroyed = false, crashed = false, throwOnSend = false } = {}) {
    const sent = [];
    return {
        name, sent,
        isDestroyed: () => destroyed,
        isCrashed: () => crashed,
        send(channel, value) {
            if (throwOnSend) throw new Error(`${name} send failed`);
            sent.push({ channel, value });
        },
    };
}

function makeWindow(contents, { destroyed = false } = {}) {
    return { webContents: contents, isDestroyed: () => destroyed };
}

test('theme broadcast reaches windows and embedded views exactly once', () => {
    const handlers = loadThemeHandlers();
    const main = makeContents('main');
    const child = makeContents('child');
    const embedded = makeContents('embedded');
    const destroyed = makeContents('destroyed', { destroyed: true });
    const mainWindow = makeWindow(main);
    mainWindow.contentView = { children: [{ webContents: embedded }, { webContents: embedded }, { webContents: destroyed }] };
    handlers.initialize({ mainWindow, openChildWindows: [makeWindow(child), makeWindow(embedded), makeWindow(destroyed)], projectRoot: '/tmp/vcpchat', APP_DATA_ROOT_IN_PROJECT: '/tmp/vcpchat-data', settingsManager: null });
    handlers.broadcastThemeUpdate('dark');
    for (const contents of [main, child, embedded]) assert.deepEqual(contents.sent, [{ channel: 'theme-updated', value: 'dark' }], contents.name);
    assert.deepEqual(destroyed.sent, []);
});

test('theme broadcast tolerates destroyed windows and send failures', () => {
    const handlers = loadThemeHandlers();
    const main = makeContents('main', { throwOnSend: true });
    const crashed = makeContents('crashed', { crashed: true });
    const destroyed = makeContents('destroyed-window');
    const mainWindow = makeWindow(main);
    mainWindow.contentView = { children: [{ webContents: crashed }] };
    assert.doesNotThrow(() => {
        handlers.initialize({ mainWindow, openChildWindows: [makeWindow(crashed), makeWindow(destroyed, { destroyed: true })], projectRoot: '/tmp/vcpchat', APP_DATA_ROOT_IN_PROJECT: '/tmp/vcpchat-data', settingsManager: null });
        handlers.broadcastThemeUpdate('light');
    });
    assert.deepEqual(crashed.sent, []);
    assert.deepEqual(destroyed.sent, []);
});
