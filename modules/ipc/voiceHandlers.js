// modules/ipc/voiceHandlers.js

const { BrowserWindow, ipcMain, nativeTheme, screen } = require('electron');
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
let configuredVoiceInputShortcut = null;
let configuredVoiceInputMode = null;
let settingsUpdatedListener = null;
let voiceCaptureWindow = null;
let voiceCaptureReady = false;
let voiceCaptureReadyPromise = null;
let voiceCaptureSession = null;
let voiceCaptureSequence = 0;
let releaseVoiceEngineEvents = null;

const CAPTURE_QUIET_MS = 800;
const CAPTURE_MAX_SETTLE_MS = 5000;

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

function getVoiceCaptureWindowHandle() {
    return getNativeWindowHandleString(voiceCaptureWindow);
}

function createVoiceCaptureWindow() {
    if (voiceCaptureWindow && !voiceCaptureWindow.isDestroyed()) {
        return voiceCaptureWindow;
    }

    voiceCaptureReady = false;
    voiceCaptureReadyPromise = new Promise((resolve, reject) => {
        voiceCaptureWindow = new BrowserWindow({
            width: 320,
            height: 42,
            frame: false,
            transparent: true,
            show: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            focusable: true,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            hasShadow: false,
            backgroundColor: '#00000000',
            webPreferences: {
                preload: path.join(PROJECT_ROOT, 'preloads', 'voice-input-capture.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });

        voiceCaptureWindow.setAlwaysOnTop(true, 'screen-saver');
        voiceCaptureWindow.webContents.once('did-finish-load', () => {
            voiceCaptureReady = true;
            resolve(voiceCaptureWindow);
        });
        voiceCaptureWindow.webContents.once('did-fail-load', (_event, code, description) => {
            reject(new Error(`语音捕获窗加载失败 (${code}): ${description}`));
        });
        voiceCaptureWindow.on('closed', () => {
            voiceCaptureWindow = null;
            voiceCaptureReady = false;
            voiceCaptureReadyPromise = null;
        });
        voiceCaptureWindow.loadFile(
            path.join(PROJECT_ROOT, 'Voicechatmodules', 'voice-input-capture.html')
        );
    });

    return voiceCaptureWindow;
}

async function ensureVoiceCaptureWindowReady() {
    createVoiceCaptureWindow();
    if (voiceCaptureReady) return voiceCaptureWindow;
    return voiceCaptureReadyPromise;
}

function positionVoiceCaptureWindow() {
    if (!voiceCaptureWindow || voiceCaptureWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const bounds = display.workArea;
    const windowBounds = voiceCaptureWindow.getBounds();
    voiceCaptureWindow.setPosition(
        Math.round(bounds.x + bounds.width - windowBounds.width - 18),
        Math.round(bounds.y + bounds.height - windowBounds.height - 18),
        false
    );
}

function getVoiceCaptureTarget() {
    const candidates = getOpenVoiceChatWindows();
    return candidates.find(win => win.isFocused()) || candidates.at(-1) || null;
}

async function beginVoiceCaptureFromHotkey(eventData = {}) {
    if (voiceCaptureSession) return;
    const target = getVoiceCaptureTarget();
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) {
        await voiceInputEngine?.releaseAll().catch(() => {});
        return;
    }

    await ensureVoiceCaptureWindowReady();
    const sessionId = `voice-capture-${Date.now()}-${++voiceCaptureSequence}`;
    voiceCaptureSession = {
        id: sessionId,
        targetWebContentsId: target.webContents.id,
        target,
        text: '',
        composing: false,
        updatedAt: Date.now(),
        stopping: false,
        focusReadySent: false,
        hotkey: configuredVoiceInputShortcut,
        mode: configuredVoiceInputMode,
        originalWindowHandle: eventData?.detail?.originalWindowHandle || null,
    };

    positionVoiceCaptureWindow();
    // The native window must be visible and foreground before the renderer
    // focuses its editable control. A hidden Chromium document can report
    // document.activeElement correctly while Windows TSF still has no input
    // target, which makes Win+H report that no text field is available.
    voiceCaptureWindow.show();
    voiceCaptureWindow.focus();
    voiceCaptureWindow.webContents.focus();
    setImmediate(() => {
        if (
            voiceCaptureSession?.id === sessionId
            && voiceCaptureWindow
            && !voiceCaptureWindow.isDestroyed()
        ) {
            voiceCaptureWindow.webContents.send('voice-input-capture:prepare', { sessionId });
        }
    });
    broadcastVoiceInputShortcutStatus({
        success: true,
        registered: true,
        active: true,
        shortcut: configuredVoiceInputShortcut,
        mode: configuredVoiceInputMode,
    });
}

function waitForCaptureTextToSettle(session) {
    const startedAt = Date.now();
    return new Promise(resolve => {
        const check = () => {
            if (!voiceCaptureSession || voiceCaptureSession !== session) {
                resolve('');
                return;
            }
            const quietFor = Date.now() - session.updatedAt;
            if (
                (!session.composing && quietFor >= CAPTURE_QUIET_MS)
                || Date.now() - startedAt >= CAPTURE_MAX_SETTLE_MS
            ) {
                resolve(session.text.trim());
                return;
            }
            setTimeout(check, 80);
        };
        check();
    });
}

async function finishVoiceCaptureFromHotkey() {
    const session = voiceCaptureSession;
    if (!session || session.stopping) return;
    session.stopping = true;

    // Rust has already released Right Alt synchronously before emitting
    // hotkey_up. stopSession is still needed to close Win+H mode.
    await voiceInputEngine?.stopSession().catch(error => {
        console.warn('[VoiceHandlers] Failed to stop dictation:', error.message);
    });
    if (voiceCaptureWindow && !voiceCaptureWindow.isDestroyed()) {
        voiceCaptureWindow.webContents.send('voice-input-capture:stop', { sessionId: session.id });
    }

    const text = await waitForCaptureTextToSettle(session);
    await voiceInputEngine?.restoreFocus().catch(error => {
        console.warn('[VoiceHandlers] Failed to restore pre-capture focus:', error.message);
    });

    if (voiceCaptureWindow && !voiceCaptureWindow.isDestroyed()) {
        voiceCaptureWindow.hide();
    }
    voiceCaptureSession = null;

    if (text && session.target && !session.target.isDestroyed() && !session.target.webContents.isDestroyed()) {
        session.target.webContents.send('voice-input-captured-text', {
            text,
            sessionId: session.id,
            source: session.mode,
        });
    }
    broadcastVoiceInputShortcutStatus({
        success: true,
        registered: true,
        active: false,
        shortcut: configuredVoiceInputShortcut,
        mode: configuredVoiceInputMode,
    });
}

function handleVoiceEngineEvent(eventData) {
    if (!eventData?.event) return;
    if (eventData.event === 'hotkey_down') {
        beginVoiceCaptureFromHotkey(eventData).catch(async error => {
            console.error('[VoiceHandlers] Failed to begin voice capture:', error);
            await voiceInputEngine?.releaseAll().catch(() => {});
            broadcastVoiceInputShortcutStatus({
                success: false,
                registered: true,
                shortcut: configuredVoiceInputShortcut,
                error: error.message || String(error),
            });
        });
        return;
    }
    if (eventData.event === 'hotkey_up') {
        finishVoiceCaptureFromHotkey().catch(error => {
            console.error('[VoiceHandlers] Failed to finish voice capture:', error);
        });
        return;
    }
    if (eventData.event === 'watchdog_release') {
        finishVoiceCaptureFromHotkey().catch(() => {});
    }
}

function broadcastVoiceInputShortcutStatus(status) {
    getOpenVoiceChatWindows().forEach(win => {
        if (!win.webContents.isDestroyed()) {
            win.webContents.send('voice-input-shortcut-status', status);
        }
    });
}

async function configureNativeVoiceHotkey() {
    if (!getOpenVoiceChatWindows().length) {
        return { success: true, registered: false, reason: 'no-voice-window' };
    }

    const settings = settingsManager ? await settingsManager.readSettings() : {};
    const shortcut = String(settings?.voiceInputShortcut || 'F7').trim();
    const mode = settings?.voiceInputMode === 'right_alt_hold'
        ? 'right_alt_hold'
        : 'windows_voice_typing';

    try {
        await ensureVoiceCaptureWindowReady();
        const engine = getVoiceInputEngine();
        await engine.start();
        if (!releaseVoiceEngineEvents) {
            releaseVoiceEngineEvents = engine.onEvent(handleVoiceEngineEvent);
        }
        const result = await engine.configureHotkey({ shortcut, mode });
        configuredVoiceInputShortcut = shortcut;
        configuredVoiceInputMode = mode;
        const status = {
            success: true,
            registered: true,
            shortcut,
            mode,
            engine: 'rust-native',
            detail: result.detail || null,
        };
        broadcastVoiceInputShortcutStatus(status);
        return status;
    } catch (error) {
        configuredVoiceInputShortcut = null;
        configuredVoiceInputMode = null;
        const status = {
            success: false,
            registered: false,
            shortcut,
            mode,
            error: error.message || String(error),
        };
        broadcastVoiceInputShortcutStatus(status);
        return status;
    }
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
    voiceChatWindow.webContents.once('did-finish-load', async () => {
        if (voiceChatWindow.isDestroyed() || voiceChatWindow.webContents.isDestroyed()) return;
        voiceChatWindow.webContents.send('voice-chat-data', { agentId, theme });

        try {
            const shortcutStatus = await configureNativeVoiceHotkey();
            if (!voiceChatWindow.isDestroyed() && !voiceChatWindow.webContents.isDestroyed()) {
                voiceChatWindow.webContents.send('voice-input-shortcut-status', shortcutStatus);
            }
        } catch (error) {
            console.warn('[VoiceHandlers] Failed to register voice input shortcut:', error.message);
            if (!voiceChatWindow.isDestroyed() && !voiceChatWindow.webContents.isDestroyed()) {
                voiceChatWindow.webContents.send('voice-input-shortcut-status', {
                    success: false,
                    registered: false,
                    error: error.message,
                });
            }
        }
    });

    voiceChatWindow.loadFile(path.join(PROJECT_ROOT, 'Voicechatmodules', 'voicechat.html'));

    voiceChatWindow.once('ready-to-show', () => {
        voiceChatWindow.show();
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
            configuredVoiceInputShortcut = null;
            configuredVoiceInputMode = null;
            voiceInputEngine?.releaseAll().catch(() => {});
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
    ipcMain.on('voice-input-capture:ready', event => {
        if (voiceCaptureWindow?.webContents === event.sender) {
            voiceCaptureReady = true;
        }
    });
    ipcMain.on('voice-input-capture:update', (event, payload = {}) => {
        if (voiceCaptureWindow?.webContents !== event.sender || !voiceCaptureSession) return;
        voiceCaptureSession.text = String(payload.text || '');
        voiceCaptureSession.composing = payload.composing === true;
        voiceCaptureSession.updatedAt = Number(payload.updatedAt) || Date.now();
    });
    ipcMain.on('voice-input-capture:focus-ready', async (event, payload = {}) => {
        if (
            voiceCaptureWindow?.webContents !== event.sender
            || !voiceCaptureSession
            || voiceCaptureSession.focusReadySent
            || !voiceInputEngine
            || payload.sessionId !== voiceCaptureSession.id
            || payload.editable !== true
            || !Number.isInteger(payload.selectionStart)
            || !Number.isInteger(payload.selectionEnd)
        ) return;

        // DOM focus alone is insufficient: Windows voice typing requires the
        // containing native BrowserWindow to be the foreground input target.
        if (!voiceCaptureWindow.isFocused()) {
            voiceCaptureWindow.show();
            voiceCaptureWindow.focus();
            voiceCaptureWindow.webContents.focus();
            voiceCaptureWindow.webContents.send('voice-input-capture:prepare', {
                sessionId: voiceCaptureSession.id,
            });
            return;
        }

        const targetWindowHandle = getVoiceCaptureWindowHandle();
        if (!targetWindowHandle) {
            await voiceInputEngine.releaseAll().catch(() => {});
            return;
        }
        voiceCaptureSession.focusReadySent = true;
        try {
            await voiceInputEngine.focusReady({ targetWindowHandle });
        } catch (error) {
            voiceCaptureSession.focusReadySent = false;
            await voiceInputEngine.releaseAll().catch(() => {});
            broadcastVoiceInputShortcutStatus({
                success: false,
                registered: true,
                shortcut: configuredVoiceInputShortcut,
                error: error.message || String(error),
            });
        }
    });
    ipcMain.handle('voice-input-native:status', event => {
        const voiceChatWindow = findVoiceChatWindowBySender(event.sender);
        if (!voiceChatWindow) return { success: false, error: '调用者不是语音聊天子窗口' };
        return {
            success: true,
            owner: nativeVoiceInputOwnerId === voiceChatWindow.webContents.id,
            shortcut: {
                value: configuredVoiceInputShortcut,
                registered: Boolean(
                    configuredVoiceInputShortcut
                    && voiceInputEngine?.getStatus().ready
                    && voiceInputEngine?.getStatus().processAlive
                ),
                mode: configuredVoiceInputMode,
            },
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
            configureNativeVoiceHotkey().then(result => {
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
        configuredVoiceInputShortcut = null;
        configuredVoiceInputMode = null;
        releaseVoiceEngineEvents?.();
        releaseVoiceEngineEvents = null;
        await releaseNativeVoiceInput({
            restoreFocus: true,
            shutdown: true,
        });
    },
    __test: {
        getNativeWindowHandleString,
    },
};
