// modules/ipc/voiceHandlers.js

const { BrowserWindow, globalShortcut, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const { PRELOAD_ROLES, resolveProjectPreload } = require('../services/preloadPaths');
const { VoiceInputEngineAdapter } = require('../voice/voice-input-engine-adapter');

let mainWindow = null;
let openChildWindows = [];
let settingsManager = null;
let PROJECT_ROOT = null;
let isInitialized = false;
let voiceInputEngine = null;
let nativeVoiceInputOwnerId = null;
let registeredVoiceInputShortcut = null;
let settingsUpdatedListener = null;

function getNativeWindowHandleString(win) {
    if (!win || win.isDestroyed() || typeof win.getNativeWindowHandle !== 'function') {
        return null;
    }

    const buffer = win.getNativeWindowHandle();
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    if (buffer.length >= 8) return buffer.readBigUInt64LE(0).toString();
    if (buffer.length >= 4) return String(buffer.readUInt32LE(0));
    return null;
}

function findVoiceChatWindowBySender(sender) {
    return openChildWindows.find(win => (
        win
        && !win.isDestroyed()
        && win.webContents === sender
        && win.webContents.getURL().replace(/\\/g, '/').includes('/Voicechatmodules/voicechat.html')
    )) || null;
}

function getOpenVoiceChatWindows() {
    return openChildWindows.filter(win => (
        win
        && !win.isDestroyed()
        && !win.webContents.isDestroyed()
        && win.webContents.getURL().replace(/\\/g, '/').includes('/Voicechatmodules/voicechat.html')
    ));
}

function unregisterVoiceInputShortcut() {
    if (!registeredVoiceInputShortcut) return;
    try {
        globalShortcut.unregister(registeredVoiceInputShortcut);
    } catch (error) {
        console.warn('[VoiceHandlers] Failed to unregister voice input shortcut:', error.message);
    } finally {
        registeredVoiceInputShortcut = null;
    }
}

async function registerVoiceInputShortcut() {
    const voiceWindows = getOpenVoiceChatWindows();
    if (!voiceWindows.length) {
        unregisterVoiceInputShortcut();
        return { success: true, registered: false, reason: 'no-voice-window' };
    }

    const settings = settingsManager ? await settingsManager.readSettings() : {};
    const shortcut = String(settings?.voiceInputShortcut || 'Control+Alt+Space').trim();
    if (!shortcut) {
        unregisterVoiceInputShortcut();
        return { success: false, registered: false, error: '语音输入快捷键为空' };
    }

    if (registeredVoiceInputShortcut === shortcut && globalShortcut.isRegistered(shortcut)) {
        return { success: true, registered: true, shortcut };
    }

    unregisterVoiceInputShortcut();
    let accepted = false;
    try {
        accepted = globalShortcut.register(shortcut, () => {
            const candidates = getOpenVoiceChatWindows();
            const target = candidates.find(win => win.isFocused()) || candidates.at(-1);
            if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
            target.webContents.send('voice-input-global-toggle', {
                shortcut,
                triggeredAt: Date.now(),
            });
        });
    } catch (error) {
        console.warn(`[VoiceHandlers] Invalid voice input shortcut "${shortcut}":`, error.message);
        return { success: false, registered: false, shortcut, error: error.message };
    }

    if (!accepted) {
        console.warn(`[VoiceHandlers] Voice input shortcut is unavailable: ${shortcut}`);
        return {
            success: false,
            registered: false,
            shortcut,
            error: '快捷键被其他程序占用或不受当前系统支持',
        };
    }

    registeredVoiceInputShortcut = shortcut;
    console.log(`[VoiceHandlers] Registered voice input shortcut: ${shortcut}`);
    return { success: true, registered: true, shortcut };
}

function getVoiceInputEngine() {
    if (!voiceInputEngine) {
        voiceInputEngine = new VoiceInputEngineAdapter({
            projectRoot: PROJECT_ROOT,
            logger: console,
        });
    }
    return voiceInputEngine;
}

async function releaseNativeVoiceInput({ restoreFocus = true, shutdown = true } = {}) {
    if (!voiceInputEngine) {
        nativeVoiceInputOwnerId = null;
        return;
    }

    try {
        await voiceInputEngine.stopSession();
    } catch (error) {
        console.warn('[VoiceHandlers] Failed to stop native voice input:', error.message);
        try {
            await voiceInputEngine.releaseAll();
        } catch (releaseError) {
            console.warn('[VoiceHandlers] Failed to release native input keys:', releaseError.message);
        }
    }

    if (restoreFocus) {
        try {
            await voiceInputEngine.restoreFocus();
        } catch (error) {
            console.warn('[VoiceHandlers] Failed to restore native voice input focus:', error.message);
        }
    }

    if (restoreFocus || shutdown) {
        nativeVoiceInputOwnerId = null;
    }
    if (shutdown) {
        await voiceInputEngine.shutdown();
        voiceInputEngine = null;
    }
}

async function handleStartNativeVoiceInput(event, options = {}) {
    const voiceChatWindow = findVoiceChatWindowBySender(event.sender);
    if (!voiceChatWindow) {
        return { success: false, error: '仅语音聊天子窗口可以启动原生语音输入' };
    }
    if (process.platform !== 'win32') {
        return { success: false, error: `当前平台 ${process.platform} 尚未实现模拟语音输入` };
    }

    const mode = options.mode === 'right_alt_hold'
        ? 'right_alt_hold'
        : 'windows_voice_typing';
    const ownerId = voiceChatWindow.webContents.id;

    if (nativeVoiceInputOwnerId !== null && nativeVoiceInputOwnerId !== ownerId) {
        return { success: false, error: '另一个语音窗口正在使用原生语音输入' };
    }

    const targetWindowHandle = getNativeWindowHandleString(voiceChatWindow);
    if (!targetWindowHandle) {
        return { success: false, error: '无法获取语音窗口的原生句柄' };
    }

    try {
        const result = await getVoiceInputEngine().startSession({
            mode,
            targetWindowHandle,
        });
        nativeVoiceInputOwnerId = ownerId;
        return {
            success: true,
            mode,
            engine: voiceInputEngine.getStatus(),
            detail: result.detail || null,
        };
    } catch (error) {
        nativeVoiceInputOwnerId = null;
        await releaseNativeVoiceInput({ restoreFocus: true, shutdown: true });
        return { success: false, error: error.message || String(error) };
    }
}

async function handleStopNativeVoiceInput(event, options = {}) {
    const voiceChatWindow = findVoiceChatWindowBySender(event.sender);
    if (!voiceChatWindow) {
        return { success: false, error: '仅语音聊天子窗口可以停止原生语音输入' };
    }
    if (nativeVoiceInputOwnerId !== null && nativeVoiceInputOwnerId !== voiceChatWindow.webContents.id) {
        return { success: false, error: '当前窗口不是原生语音输入会话所有者' };
    }

    try {
        await releaseNativeVoiceInput({
            restoreFocus: options.restoreFocus !== false,
            shutdown: options.shutdown !== false,
        });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message || String(error) };
    }
}

async function handleCancelNativeVoiceInput(event) {
    const voiceChatWindow = findVoiceChatWindowBySender(event.sender);
    if (!voiceChatWindow) {
        return { success: false, error: '仅语音聊天子窗口可以取消原生语音输入' };
    }

    try {
        if (voiceInputEngine) await voiceInputEngine.cancel();
        nativeVoiceInputOwnerId = null;
        if (voiceInputEngine) await voiceInputEngine.shutdown();
        voiceInputEngine = null;
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message || String(error) };
    }
}

function createVoiceChatWindow(agentId) {
    const voiceChatWindow = new BrowserWindow({
        width: 500,
        height: 700,
        minWidth: 400,
        minHeight: 500,
        frame: false,
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        title: '语音聊天',
        webPreferences: {
            preload: resolveProjectPreload(PROJECT_ROOT, PRELOAD_ROLES.CHAT),
            contextIsolation: true,
            nodeIntegration: false,
        },
        parent: mainWindow,
        modal: false,
        show: false,
    });

    const voiceWebContentsId = voiceChatWindow.webContents.id;
    const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    voiceChatWindow.webContents.once('did-finish-load', () => {
        voiceChatWindow.webContents.send('voice-chat-data', { agentId, theme });
    });

    voiceChatWindow.loadFile(path.join(PROJECT_ROOT, 'Voicechatmodules', 'voicechat.html'));

    voiceChatWindow.once('ready-to-show', () => {
        voiceChatWindow.show();
        registerVoiceInputShortcut().then(result => {
            if (!result.success) {
                voiceChatWindow.webContents.send('voice-input-shortcut-status', result);
            }
        }).catch(error => {
            console.warn('[VoiceHandlers] Failed to register voice input shortcut:', error.message);
        });
    });

    openChildWindows.push(voiceChatWindow);

    voiceChatWindow.webContents.on('render-process-gone', (_event, details) => {
        console.warn('[VoiceHandlers] voice renderer exited; releasing window owner:', details?.reason || 'unknown');
        const index = openChildWindows.indexOf(voiceChatWindow);
        if (index > -1) openChildWindows.splice(index, 1);
        if (!voiceChatWindow.isDestroyed()) voiceChatWindow.destroy();
    });

    voiceChatWindow.on('closed', () => {
        const index = openChildWindows.indexOf(voiceChatWindow);
        if (index > -1) {
            openChildWindows.splice(index, 1);
        }

        if (nativeVoiceInputOwnerId === voiceWebContentsId) {
            releaseNativeVoiceInput({ restoreFocus: true, shutdown: true }).catch(error => {
                console.warn('[VoiceHandlers] Native voice input close cleanup failed:', error.message);
            });
        }

        if (!getOpenVoiceChatWindows().length) {
            unregisterVoiceInputShortcut();
        }
    });

    return voiceChatWindow;
}

function handleOpenVoiceChatWindow(event, { agentId } = {}) {
    return createVoiceChatWindow(agentId);
}

function initialize(options) {
    mainWindow = options.mainWindow;
    openChildWindows = options.openChildWindows;
    settingsManager = options.settingsManager;
    PROJECT_ROOT = options.projectRoot;

    if (isInitialized) {
        return;
    }

    ipcMain.on('open-voice-chat-window', handleOpenVoiceChatWindow);
    ipcMain.handle('voice-input-native:start', handleStartNativeVoiceInput);
    ipcMain.handle('voice-input-native:stop', handleStopNativeVoiceInput);
    ipcMain.handle('voice-input-native:cancel', handleCancelNativeVoiceInput);
    ipcMain.handle('voice-input-native:status', event => {
        const voiceChatWindow = findVoiceChatWindowBySender(event.sender);
        if (!voiceChatWindow) return { success: false, error: '调用者不是语音聊天子窗口' };
        return {
            success: true,
            owner: nativeVoiceInputOwnerId === voiceChatWindow.webContents.id,
            engine: voiceInputEngine?.getStatus() || {
                lifecycleState: 'stopped',
                ready: false,
                processAlive: false,
            },
        };
    });

    if (settingsManager?.on && !settingsUpdatedListener) {
        settingsUpdatedListener = () => {
            if (!getOpenVoiceChatWindows().length) return;
            registerVoiceInputShortcut().then(result => {
                getOpenVoiceChatWindows().forEach(win => {
                    win.webContents.send('voice-input-shortcut-status', result);
                });
            }).catch(error => {
                console.warn('[VoiceHandlers] Failed to refresh voice input shortcut:', error.message);
            });
        };
        settingsManager.on('settings-updated', settingsUpdatedListener);
    }

    isInitialized = true;
}

module.exports = {
    initialize,
    createVoiceChatWindow,
    shutdownVoiceInputEngine: async () => {
        unregisterVoiceInputShortcut();
        await releaseNativeVoiceInput({
            restoreFocus: true,
            shutdown: true,
        });
    },
    __test: {
        getNativeWindowHandleString,
    },
};
