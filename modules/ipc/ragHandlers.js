const { BrowserWindow, ipcMain, screen, app } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { PRELOAD_ROLES, resolveAppPreload } = require('../services/preloadPaths');

let ragObserverWindow = null;
let ragOverlayWindow = null;
let ragOverlayReady = false;
let ragOverlayPersistTimer = null;
let ragOverlayAutoPositioning = false;

const DEFAULT_RAG_OVERLAY_STATE = {
    enabled: true,
    passThrough: true,
    opacity: 0.92,
    bounds: null,
    useCustomBounds: false
};

let ragOverlayState = { ...DEFAULT_RAG_OVERLAY_STATE };
let appSettingsManager = null;
let mainWindow = null;
let openChildWindows = [];
let SETTINGS_FILE = '';

function normalizeRagOverlayState(rawState = {}) {
    const state = rawState && typeof rawState === 'object' ? rawState : {};
    const opacityRaw = Number(state.opacity);
    const opacity = Number.isFinite(opacityRaw) ? Math.min(1, Math.max(0.15, opacityRaw)) : DEFAULT_RAG_OVERLAY_STATE.opacity;

    let bounds = null;
    if (state.bounds && typeof state.bounds === 'object') {
        const x = Number(state.bounds.x);
        const y = Number(state.bounds.y);
        const width = Number(state.bounds.width);
        const height = Number(state.bounds.height);
        if ([x, y, width, height].every(Number.isFinite)) {
            bounds = {
                x: Math.round(x),
                y: Math.round(y),
                width: Math.max(300, Math.round(width)),
                height: Math.max(140, Math.round(height))
            };
        }
    }

    return {
        enabled: state.enabled !== undefined ? !!state.enabled : DEFAULT_RAG_OVERLAY_STATE.enabled,
        passThrough: state.passThrough !== undefined ? !!state.passThrough : DEFAULT_RAG_OVERLAY_STATE.passThrough,
        opacity,
        bounds,
        useCustomBounds: state.useCustomBounds !== undefined ? !!state.useCustomBounds : !!bounds
    };
}

function schedulePersistRagOverlayState(immediate = false) {
    if (!appSettingsManager) return;

    const persist = async () => {
        try {
            await appSettingsManager.updateSettings(prevSettings => ({
                ...prevSettings,
                ragOverlaySettings: {
                    enabled: ragOverlayState.enabled !== undefined ? !!ragOverlayState.enabled : DEFAULT_RAG_OVERLAY_STATE.enabled,
                    passThrough: !!ragOverlayState.passThrough,
                    opacity: Math.min(1, Math.max(0.15, Number(ragOverlayState.opacity) || DEFAULT_RAG_OVERLAY_STATE.opacity)),
                    bounds: ragOverlayState.bounds ? {
                        x: Math.round(ragOverlayState.bounds.x),
                        y: Math.round(ragOverlayState.bounds.y),
                        width: Math.max(300, Math.round(ragOverlayState.bounds.width)),
                        height: Math.max(140, Math.round(ragOverlayState.bounds.height))
                    } : null,
                    useCustomBounds: !!ragOverlayState.useCustomBounds
                }
            }));
        } catch (error) {
            console.error('[RAG Overlay] Failed to persist overlay settings:', error);
        }
    };

    if (immediate) {
        if (ragOverlayPersistTimer) {
            clearTimeout(ragOverlayPersistTimer);
            ragOverlayPersistTimer = null;
        }
        void persist();
        return;
    }

    if (ragOverlayPersistTimer) {
        clearTimeout(ragOverlayPersistTimer);
    }
    ragOverlayPersistTimer = setTimeout(() => {
        ragOverlayPersistTimer = null;
        void persist();
    }, 220);
}

function captureOverlayBoundsAndPersist(windowInstance) {
    if (!windowInstance || windowInstance.isDestroyed()) return;
    const bounds = windowInstance.getBounds();
    ragOverlayState.bounds = {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.max(300, Math.round(bounds.width)),
        height: Math.max(140, Math.round(bounds.height))
    };
    ragOverlayState.useCustomBounds = true;
    schedulePersistRagOverlayState();
}

function positionRagOverlayNearObserver() {
    if (!ragOverlayWindow || ragOverlayWindow.isDestroyed()) return;
    if (ragOverlayState.useCustomBounds) return;

    const overlayBounds = ragOverlayWindow.getBounds();

    if (ragObserverWindow && !ragObserverWindow.isDestroyed()) {
        const observerBounds = ragObserverWindow.getBounds();
        const observerCenterPoint = {
            x: Math.round(observerBounds.x + observerBounds.width / 2),
            y: Math.round(observerBounds.y + observerBounds.height / 2)
        };
        const display = screen.getDisplayNearestPoint(observerCenterPoint);
        const workArea = display?.workArea || { x: 0, y: 0, width: 1920, height: 1080 };
        const x = Math.min(
            Math.max(workArea.x, observerBounds.x + observerBounds.width + 14),
            workArea.x + workArea.width - overlayBounds.width
        );
        const y = Math.min(
            Math.max(workArea.y, observerBounds.y + 54),
            workArea.y + workArea.height - overlayBounds.height
        );
        ragOverlayAutoPositioning = true;
        ragOverlayWindow.setPosition(x, y);
        ragOverlayAutoPositioning = false;
        return;
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const workArea = display?.workArea || { x: 0, y: 0, width: 1920, height: 1080 };
    const fallbackX = workArea.x + workArea.width - overlayBounds.width - 18;
    const fallbackY = workArea.y + 18;
    ragOverlayAutoPositioning = true;
    ragOverlayWindow.setPosition(fallbackX, fallbackY);
    ragOverlayAutoPositioning = false;
}

function ensureRagOverlayWindow() {
    if (ragOverlayState.enabled === false) {
        return null;
    }

    if (ragOverlayWindow && !ragOverlayWindow.isDestroyed()) {
        return ragOverlayWindow;
    }

    const initialBounds = ragOverlayState.bounds;
    const windowConfig = {
        width: initialBounds?.width || 420,
        height: initialBounds?.height || 220,
        minWidth: 300,
        minHeight: 140,
        frame: false,
        transparent: true,
        resizable: true,
        skipTaskbar: true,
        show: false,
        alwaysOnTop: true,
        hasShadow: true,
        webPreferences: {
            preload: resolveAppPreload(app.getAppPath(), PRELOAD_ROLES.UTILITY),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(app.getAppPath(), 'assets', 'icon.png')
    };

    if (ragOverlayState.useCustomBounds && initialBounds) {
        windowConfig.x = initialBounds.x;
        windowConfig.y = initialBounds.y;
    }

    ragOverlayWindow = new BrowserWindow(windowConfig);

    const overlayUrl = `file://${path.join(app.getAppPath(), 'RAGmodules', 'RAG_Overlay.html')}`;
    ragOverlayReady = false;
    ragOverlayWindow.loadURL(overlayUrl);
    ragOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
    ragOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    ragOverlayWindow.setMenu(null);
    ragOverlayWindow.setOpacity(ragOverlayState.opacity);
    ragOverlayWindow.setIgnoreMouseEvents(ragOverlayState.passThrough, { forward: true });

    if (!ragOverlayState.useCustomBounds) {
        positionRagOverlayNearObserver();
    }

    ragOverlayWindow.webContents.once('did-finish-load', () => {
        ragOverlayReady = true;
        if (!ragOverlayWindow || ragOverlayWindow.isDestroyed()) return;
        ragOverlayWindow.webContents.send('rag-overlay-pass-through-changed', { passThrough: ragOverlayState.passThrough });
    });

    ragOverlayWindow.on('move', () => {
        if (ragOverlayAutoPositioning) return;
        captureOverlayBoundsAndPersist(ragOverlayWindow);
    });

    ragOverlayWindow.on('resize', () => {
        if (ragOverlayAutoPositioning) return;
        captureOverlayBoundsAndPersist(ragOverlayWindow);
    });

    ragOverlayWindow.on('closed', () => {
        ragOverlayReady = false;
        ragOverlayWindow = null;
    });

    return ragOverlayWindow;
}

async function openRagObserverWindow() {
    if (ragObserverWindow && !ragObserverWindow.isDestroyed()) {
        if (!ragObserverWindow.isVisible()) {
            ragObserverWindow.show();
        }
        ragObserverWindow.focus();
        return;
    }

    ragObserverWindow = new BrowserWindow({
        width: 500,
        height: 900,
        minWidth: 300,
        minHeight: 600,
        title: 'VCP - 信息流监听器',
        frame: false,
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        webPreferences: {
            preload: resolveAppPreload(app.getAppPath(), PRELOAD_ROLES.UTILITY),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
        show: false
    });

    let settings = {};
    try {
        if (appSettingsManager) {
            settings = await appSettingsManager.readSettings();
        } else {
            const AppSettingsManager = require('../utils/appSettingsManager');
            const sm = new AppSettingsManager(SETTINGS_FILE);
            settings = await sm.readSettings();
        }
    } catch (readError) {
        console.error('Failed to read settings file for RAG observer window:', readError);
    }

    ragOverlayState = normalizeRagOverlayState(settings.ragOverlaySettings || {});

    const vcpLogUrl = settings.vcpLogUrl || '';
    const vcpLogKey = settings.vcpLogKey || '';
    const currentThemeMode = settings.currentThemeMode || 'dark';

    const observerUrl = `file://${path.join(app.getAppPath(), 'RAGmodules', 'RAG_Observer.html')}?vcpLogUrl=${encodeURIComponent(vcpLogUrl)}&vcpLogKey=${encodeURIComponent(vcpLogKey)}&currentThemeMode=${encodeURIComponent(currentThemeMode)}`;

    ragObserverWindow.loadURL(observerUrl);
    ragObserverWindow.setMenu(null);

    ragObserverWindow.once('ready-to-show', () => {
        ragObserverWindow.show();
    });

    if (openChildWindows) {
        openChildWindows.push(ragObserverWindow);
    }

    if (ragObserverWindow && !ragObserverWindow.isDestroyed()) {
        ragObserverWindow.on('move', () => {
            if (!ragOverlayState.useCustomBounds) {
                positionRagOverlayNearObserver();
            }
        });
        ragObserverWindow.on('resize', () => {
            if (!ragOverlayState.useCustomBounds) {
                positionRagOverlayNearObserver();
            }
        });
    }

    ragObserverWindow.on('close', (event) => {
        if (process.platform === 'darwin' && !app.isQuitting) {
            event.preventDefault();
            ragObserverWindow.hide();
        }
    });

    ragObserverWindow.on('closed', () => {
        if (openChildWindows) {
            const index = openChildWindows.indexOf(ragObserverWindow);
            if (index > -1) openChildWindows.splice(index, 1);
        }
        ragObserverWindow = null;

        if (ragOverlayWindow && !ragOverlayWindow.isDestroyed()) {
            ragOverlayWindow.close();
            ragOverlayReady = false;
            ragOverlayWindow = null;
        }
    });
}

function initialize(params) {
    mainWindow = params.mainWindow;
    openChildWindows = params.openChildWindows;
    appSettingsManager = params.settingsManager;
    SETTINGS_FILE = params.SETTINGS_FILE;

    ipcMain.handle('open-rag-observer-window', openRagObserverWindow);

    ipcMain.on('rag-overlay-show', (event, payload = {}) => {
        if (ragOverlayState.enabled === false) return;

        const overlayWin = ensureRagOverlayWindow();
        if (!overlayWin || overlayWin.isDestroyed()) return;

        if (typeof payload.passThrough === 'boolean') {
            ragOverlayState.passThrough = !!payload.passThrough;
        }
        if (typeof payload.opacity === 'number' && Number.isFinite(payload.opacity)) {
            ragOverlayState.opacity = Math.min(1, Math.max(0.15, Number(payload.opacity)));
        }

        const renderPayload = () => {
            if (!overlayWin || overlayWin.isDestroyed()) return;

            const isPassThrough = ragOverlayState.passThrough === true;
            overlayWin.setOpacity(ragOverlayState.opacity);
            overlayWin.setIgnoreMouseEvents(isPassThrough, { forward: true });
            overlayWin.webContents.send('rag-overlay-pass-through-changed', { passThrough: isPassThrough });
            overlayWin.webContents.send('rag-overlay-payload', {
                ...payload,
                passThrough: isPassThrough,
                opacity: ragOverlayState.opacity
            });

            positionRagOverlayNearObserver();
            if (!overlayWin.isVisible()) {
                overlayWin.show();
            } else {
                overlayWin.moveTop();
            }
        };

        if (!ragOverlayReady || overlayWin.webContents.isLoadingMainFrame()) {
            overlayWin.webContents.once('did-finish-load', () => {
                ragOverlayReady = true;
                renderPayload();
            });
            return;
        }

        renderPayload();
    });

    ipcMain.on('rag-overlay-hide', () => {
        if (ragOverlayWindow && !ragOverlayWindow.isDestroyed()) {
            ragOverlayWindow.hide();
        }
    });

    ipcMain.on('rag-overlay-set-enabled', (event, enabled) => {
        ragOverlayState.enabled = !!enabled;

        if (!ragOverlayState.enabled) {
            if (ragOverlayWindow && !ragOverlayWindow.isDestroyed()) {
                ragOverlayReady = false;
                ragOverlayWindow.destroy();
                ragOverlayWindow = null;
            }
        }

        schedulePersistRagOverlayState();
    });

    ipcMain.on('rag-overlay-set-opacity', (event, opacity) => {
        const nextOpacity = Number(opacity);
        if (!Number.isFinite(nextOpacity)) return;
        ragOverlayState.opacity = Math.min(1, Math.max(0.15, nextOpacity));

        if (ragOverlayWindow && !ragOverlayWindow.isDestroyed()) {
            ragOverlayWindow.setOpacity(ragOverlayState.opacity);
        }

        schedulePersistRagOverlayState();
    });

    ipcMain.on('rag-overlay-set-pass-through', (event, passThrough) => {
        const value = !!passThrough;
        ragOverlayState.passThrough = value;

        if (ragOverlayWindow && !ragOverlayWindow.isDestroyed()) {
            ragOverlayWindow.setIgnoreMouseEvents(value, { forward: true });
            ragOverlayWindow.webContents.send('rag-overlay-pass-through-changed', { passThrough: value });
        }

        schedulePersistRagOverlayState();
    });

    ipcMain.handle('rag-overlay-get-bounds', (event) => {
        const senderWin = BrowserWindow.fromWebContents(event.sender);
        if (!senderWin || senderWin.isDestroyed()) return null;
        return senderWin.getBounds();
    });

    ipcMain.handle('rag-overlay-get-state', () => {
        return {
            enabled: ragOverlayState.enabled !== undefined ? !!ragOverlayState.enabled : DEFAULT_RAG_OVERLAY_STATE.enabled,
            passThrough: !!ragOverlayState.passThrough,
            opacity: Math.min(1, Math.max(0.15, Number(ragOverlayState.opacity) || DEFAULT_RAG_OVERLAY_STATE.opacity)),
            bounds: ragOverlayState.bounds ? { ...ragOverlayState.bounds } : null,
            useCustomBounds: !!ragOverlayState.useCustomBounds
        };
    });

    ipcMain.on('rag-overlay-resize', (event, payload = {}) => {
        const senderWin = BrowserWindow.fromWebContents(event.sender);
        if (!senderWin || senderWin.isDestroyed()) return;

        const edge = String(payload.edge || '').toLowerCase();
        const dx = Number(payload.dx) || 0;
        const dy = Number(payload.dy) || 0;
        const bounds = senderWin.getBounds();

        let { x, y, width, height } = bounds;

        if (edge.includes('e')) width += dx;
        if (edge.includes('s')) height += dy;
        if (edge.includes('w')) {
            width -= dx;
            x += dx;
        }
        if (edge.includes('n')) {
            height -= dy;
            y += dy;
        }

        const minWidth = 300;
        const minHeight = 140;
        width = Math.max(minWidth, Math.round(width));
        height = Math.max(minHeight, Math.round(height));

        senderWin.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
        captureOverlayBoundsAndPersist(senderWin);
    });

    ipcMain.on('rag-overlay-approval-action', (event, payload = {}) => {
        if (ragObserverWindow && !ragObserverWindow.isDestroyed()) {
            ragObserverWindow.webContents.send('rag-overlay-approval-action', {
                requestId: payload.requestId,
                approved: !!payload.approved
            });
        }
    });
}

module.exports = {
    initialize,
    openRagObserverWindow,
    getRagObserverWindow: () => ragObserverWindow,
    getRagOverlayWindow: () => ragOverlayWindow
};
