// modules/ipc/assistantHandlers.js

const { ipcMain, BrowserWindow, screen, nativeTheme, globalShortcut } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { getAgentConfigById } = require('./agentHandlers');
const notesHandlers = require('./notesHandlers');
const { createNodeAssistantAdapter } = require('../assistant/assistant-node-adapter');
const { createRustAssistantAdapter } = require('../assistant/assistant-rust-adapter');

let assistantWindow = null;
let assistantBarWindow = null;
let lastProcessedSelection = '';
let selectionListenerActive = false;
let mouseListener = null;
let hideBarTimeout = null;
let SETTINGS_FILE;
let isWindowHidingInProgress = false;
let rustHealthMonitorTimer = null;
let rustHealthCheckRunning = false;
let rustSuspendHotkeyRegistered = false;

let listenerAdapter = null;
let listenerMode = 'node';
let integrationTrace = {
    receivedSelectionCount: 0,
    showAttemptCount: 0,
    lastSelectionText: null,
    lastSelectionTs: 0,
    lastShowAttemptTs: 0,
    lastShowError: null
};
let runtimeFallbackTrace = {
    autoFallbackCount: 0,
    lastAutoFallbackReason: null,
    lastAutoFallbackTs: 0
};

function getRustAssistantConfigPath() {
    return path.join(__dirname, '..', '..', 'AppData', 'rust-assistant-config.json');
}

function processSelectedText(selectionData) {
    // 若窗口隐藏流程已启动，则不再处理新的选区（避免重新定位窗口）
    if (isWindowHidingInProgress) {
        return;
    }

    integrationTrace.receivedSelectionCount += 1;
    integrationTrace.lastSelectionTs = Date.now();

    const selectedText = selectionData?.text;
    if (!selectedText || selectedText.trim() === '') {
        if (assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
            assistantBarWindow.hide();
        }
        lastProcessedSelection = '';
        return;
    }

    if (selectedText === lastProcessedSelection && assistantBarWindow && assistantBarWindow.isVisible()) {
        return;
    }
    lastProcessedSelection = selectedText;
    integrationTrace.lastSelectionText = selectedText.substring(0, 120);
    console.log('[Assistant] New text captured:', selectedText);

    if (!assistantBarWindow || assistantBarWindow.isDestroyed()) {
        integrationTrace.lastShowError = 'assistantBarWindow 不存在或已销毁';
        console.error('[Assistant] Assistant bar window is not available.');
        return;
    }

    let refPoint;
    if (selectionData.mousePosEnd && (selectionData.mousePosEnd.x > 0 || selectionData.mousePosEnd.y > 0)) {
        refPoint = { x: selectionData.mousePosEnd.x, y: selectionData.mousePosEnd.y + 15 };
    } else if (selectionData.endBottom && (selectionData.endBottom.x > 0 || selectionData.endBottom.y > 0)) {
        refPoint = { x: selectionData.endBottom.x, y: selectionData.endBottom.y + 15 };
    } else {
        const cursorPos = screen.getCursorScreenPoint();
        refPoint = { x: cursorPos.x, y: cursorPos.y + 15 };
    }
    
    const dipPoint = screen.screenToDipPoint(refPoint);
    const barWidth = 330;
    const finalX = Math.round(dipPoint.x - (barWidth / 2));
    const finalY = Math.round(dipPoint.y);

    setImmediate(() => {
        integrationTrace.showAttemptCount += 1;
        integrationTrace.lastShowAttemptTs = Date.now();
        integrationTrace.lastShowError = null;
        assistantBarWindow.setPosition(finalX, finalY);
        assistantBarWindow.showInactive();
        startGlobalMouseListener();

        (async () => {
            try {
                const settings = await fs.readJson(SETTINGS_FILE);
                if (settings.assistantEnabled && settings.assistantAgent) {
                    const agentConfig = await getAgentConfigById(settings.assistantAgent);
                    assistantBarWindow.webContents.send('assistant-bar-data', {
                        agentAvatarUrl: agentConfig.avatarUrl,
                        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
                    });
                }
            } catch (error) {
                integrationTrace.lastShowError = `assistant-bar-data 发送失败: ${error.message || error}`;
                console.error('[Assistant] Error sending data to assistant bar:', error);
            }
        })();
    });
}

async function loadRustAssistantConfig() {
    const configPath = getRustAssistantConfigPath();
    const defaults = {
        version: 1,
        useRustAssistant: false,
        debugMode: false,
        forceNode: false,
        forceRust: false,
        rollout: {
            enabled: false,
            percentage: 0,
            seed: 'vcp-assistant'
        },
        whitelist: [],
        blacklist: [],
        screenshotApps: [],
        fallback: {
            onError: true,
            onCrash: true,
            onTimeout: true
        },
        metrics: {
            enabled: true,
            sampleRate: 1
        }
    };

    try {
        if (await fs.pathExists(configPath)) {
            const rawConfig = await fs.readJson(configPath);
            return {
                ...defaults,
                ...rawConfig,
                rollout: {
                    ...defaults.rollout,
                    ...(rawConfig.rollout || {})
                },
                fallback: {
                    ...defaults.fallback,
                    ...(rawConfig.fallback || {})
                },
                metrics: {
                    ...defaults.metrics,
                    ...(rawConfig.metrics || {})
                },
                whitelist: Array.isArray(rawConfig.whitelist) ? rawConfig.whitelist : [],
                blacklist: Array.isArray(rawConfig.blacklist) ? rawConfig.blacklist : [],
                debugMode: rawConfig.debugMode === true,
                screenshotApps: Array.isArray(rawConfig.screenshotApps)
                    ? rawConfig.screenshotApps
                    : (Array.isArray(rawConfig.screenshot_apps) ? rawConfig.screenshot_apps : [])
            };
        }
    } catch (error) {
        console.error('[Assistant] Failed to read rust assistant config:', error);
    }
    return defaults;
}

async function saveRustAssistantConfig(partialConfig = {}) {
    const configPath = getRustAssistantConfigPath();
    const current = await loadRustAssistantConfig();

    const merged = {
        ...current,
        ...partialConfig,
        rollout: {
            ...(current.rollout || {}),
            ...((partialConfig && partialConfig.rollout) || {})
        },
        fallback: {
            ...(current.fallback || {}),
            ...((partialConfig && partialConfig.fallback) || {})
        },
        metrics: {
            ...(current.metrics || {}),
            ...((partialConfig && partialConfig.metrics) || {})
        },
        whitelist: Array.isArray(partialConfig.whitelist)
            ? partialConfig.whitelist
            : current.whitelist,
        blacklist: Array.isArray(partialConfig.blacklist)
            ? partialConfig.blacklist
            : current.blacklist,
        screenshotApps: Array.isArray(partialConfig.screenshotApps)
            ? partialConfig.screenshotApps
            : current.screenshotApps,
        debugMode: partialConfig.debugMode === undefined
            ? current.debugMode
            : partialConfig.debugMode === true,
    };

    await fs.ensureDir(path.dirname(configPath));
    await fs.writeJson(configPath, merged, { spaces: 2 });
    return merged;
}

async function applyRustGuardRules(adapter, rustConfig) {
    if (!adapter || typeof adapter.setGuardRules !== 'function') {
        return;
    }

    try {
        await adapter.setGuardRules({
            whitelist: Array.isArray(rustConfig?.whitelist) ? rustConfig.whitelist : [],
            blacklist: Array.isArray(rustConfig?.blacklist) ? rustConfig.blacklist : [],
            screenshot_apps: Array.isArray(rustConfig?.screenshotApps) ? rustConfig.screenshotApps : []
        });
        console.log('[Assistant] Rust guard rules synced from rust-assistant-config.json');
    } catch (error) {
        console.warn('[Assistant] Failed to sync Rust guard rules:', error.message || error);
    }
}

function hashString(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash) + input.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function shouldUseRustAssistant(config) {
    if (config.forceNode === true) {
        return false;
    }

    if (config.forceRust === true) {
        return true;
    }

    if (config.useRustAssistant === true) {
        return true;
    }

    if (config.rollout?.enabled) {
        const percentage = Math.max(0, Math.min(100, Number(config.rollout.percentage) || 0));
        const seed = String(config.rollout.seed || 'vcp-assistant');
        const machineId = `${os.hostname()}|${os.userInfo().username}|${seed}`;
        const bucket = hashString(machineId) % 100;
        return bucket < percentage;
    }

    return false;
}

async function createPreferredAdapter() {
    const rustConfig = await loadRustAssistantConfig();
    const preferRust = process.platform === 'win32' && shouldUseRustAssistant(rustConfig);

    console.log('[Assistant] Effective Rust config:', {
        useRustAssistant: rustConfig.useRustAssistant,
        forceNode: rustConfig.forceNode,
        forceRust: rustConfig.forceRust,
        rollout: rustConfig.rollout,
        preferRust
    });

    if (preferRust) {
        const rustAdapter = createRustAssistantAdapter({
            projectRoot: path.join(__dirname, '..', '..'),
            logger: console,
            debugMode: rustConfig.debugMode === true
        });
        await rustAdapter.initialize();
        rustAdapter.onSelection(processSelectedText);
        listenerMode = 'rust';
        return rustAdapter;
    }

    const nodeAdapter = createNodeAssistantAdapter({ logger: console });
    await nodeAdapter.initialize();
    nodeAdapter.onSelection(processSelectedText);
    listenerMode = 'node';
    return nodeAdapter;
}

async function ensureListenerAdapter() {
    if (listenerAdapter) {
        return listenerAdapter;
    }

    try {
        listenerAdapter = await createPreferredAdapter();
        console.log(`[Assistant] Listener adapter initialized: ${listenerMode}`);
    } catch (error) {
        console.error('[Assistant] Failed to initialize preferred adapter:', error);

        const nodeAdapter = createNodeAssistantAdapter({ logger: console });
        await nodeAdapter.initialize();
        nodeAdapter.onSelection(processSelectedText);
        listenerAdapter = nodeAdapter;
        listenerMode = 'node';
        console.log('[Assistant] Fallback to Node adapter.');
    }

    return listenerAdapter;
}

async function reconcileListenerModeAfterConfig(config) {
    const desiredMode = (process.platform === 'win32' && shouldUseRustAssistant(config)) ? 'rust' : 'node';
    const wasActive = selectionListenerActive || (listenerAdapter ? listenerAdapter.isActive() : false);
    const modeChanged = desiredMode !== listenerMode;

    if (modeChanged) {
        console.log(`[Assistant] Listener mode change detected: ${listenerMode} -> ${desiredMode}`);

        stopSelectionListener();
        listenerAdapter = null;
        listenerMode = desiredMode;

        if (wasActive) {
            await startSelectionListener();
            return {
                modeChanged: true,
                restarted: true,
                mode: listenerMode,
                active: selectionListenerActive
            };
        }

        return {
            modeChanged: true,
            restarted: false,
            mode: listenerMode,
            active: false
        };
    }

    if (desiredMode === 'rust' && listenerAdapter && typeof listenerAdapter.setGuardRules === 'function') {
        await applyRustGuardRules(listenerAdapter, config);
        if (typeof listenerAdapter.setDebugMode === 'function') {
            listenerAdapter.setDebugMode(config.debugMode === true);
        }
    }

    return {
        modeChanged: false,
        restarted: false,
        mode: listenerMode,
        active: wasActive
    };
}

async function fallbackToNodeRuntime(reason = '未知原因') {
    try {
        console.warn(`[Assistant] Auto fallback to Node triggered: ${reason}`);

        runtimeFallbackTrace.autoFallbackCount += 1;
        runtimeFallbackTrace.lastAutoFallbackReason = reason;
        runtimeFallbackTrace.lastAutoFallbackTs = Date.now();

        if (listenerAdapter) {
            try {
                listenerAdapter.stop();
            } catch (stopError) {
                console.warn('[Assistant] Failed to stop current adapter during fallback:', stopError);
            }
        }

        const nodeAdapter = createNodeAssistantAdapter({ logger: console });
        await nodeAdapter.initialize();
        nodeAdapter.onSelection(processSelectedText);

        listenerAdapter = nodeAdapter;
        listenerMode = 'node';
        selectionListenerActive = nodeAdapter.start();

        if (selectionListenerActive) {
            console.log('[Assistant] Auto fallback listener started (node).');
        } else {
            console.error('[Assistant] Auto fallback to node failed to start listener.');
        }
    } catch (error) {
        console.error('[Assistant] Auto fallback to node failed:', error);
        selectionListenerActive = false;
    }
}

function startRustHealthMonitor() {
    if (rustHealthMonitorTimer) {
        return;
    }

    rustHealthMonitorTimer = setInterval(async () => {
        if (rustHealthCheckRunning) {
            return;
        }

        if (listenerMode !== 'rust' || !listenerAdapter || !selectionListenerActive) {
            return;
        }

        rustHealthCheckRunning = true;

        try {
            const rustConfig = await loadRustAssistantConfig();
            const fallbackConfig = rustConfig?.fallback || {};
            const diagnostics = (typeof listenerAdapter.getDiagnostics === 'function')
                ? listenerAdapter.getDiagnostics()
                : {};

            const debugReason = String(diagnostics?.lastDebugReason || '').toLowerCase();
            const rustPanicDetected = debugReason.includes('panic') || debugReason.includes('panicked');

            if (fallbackConfig.onError !== false && rustPanicDetected) {
                await fallbackToNodeRuntime('Rust 监听线程异常（panic）');
                return;
            }

            if (fallbackConfig.onCrash !== false && diagnostics.processAlive === false) {
                await fallbackToNodeRuntime('Rust sidecar 进程已退出');
                return;
            }

            if (fallbackConfig.onTimeout !== false && typeof listenerAdapter.getStatus === 'function') {
                let unhealthy = false;
                try {
                    const statusResp = await listenerAdapter.getStatus();
                    const listenerActive = statusResp?.status === 200 && statusResp?.data?.listener_active === true;
                    if (!listenerActive) {
                        unhealthy = true;
                    }
                } catch (statusError) {
                    unhealthy = true;
                }

                if (unhealthy) {
                    await fallbackToNodeRuntime('Rust /status 不健康或超时');
                }
            }
        } catch (monitorError) {
            console.warn('[Assistant] Rust health monitor check failed:', monitorError.message || monitorError);
        } finally {
            rustHealthCheckRunning = false;
        }
    }, 5000);
}

function stopRustHealthMonitor() {
    if (rustHealthMonitorTimer) {
        clearInterval(rustHealthMonitorTimer);
        rustHealthMonitorTimer = null;
    }
    rustHealthCheckRunning = false;
}

function registerRustSuspendHotkey() {
    if (rustSuspendHotkeyRegistered) {
        return;
    }

    try {
        const ok = globalShortcut.register('CommandOrControl+Shift+P', async () => {
            try {
                if (listenerMode !== 'rust' || !listenerAdapter || typeof listenerAdapter.suspend !== 'function') {
                    return;
                }
                await listenerAdapter.suspend(10000);
                console.log('[Assistant] Rust listener manually suspended for 10s by hotkey.');
            } catch (error) {
                console.warn('[Assistant] Failed to suspend Rust listener by hotkey:', error.message || error);
            }
        });

        rustSuspendHotkeyRegistered = ok === true;
        if (!rustSuspendHotkeyRegistered) {
            console.warn('[Assistant] Failed to register Rust suspend hotkey CommandOrControl+Shift+P');
        }
    } catch (error) {
        rustSuspendHotkeyRegistered = false;
        console.warn('[Assistant] Error registering Rust suspend hotkey:', error.message || error);
    }
}

function unregisterRustSuspendHotkey() {
    if (!rustSuspendHotkeyRegistered) {
        return;
    }

    try {
        globalShortcut.unregister('CommandOrControl+Shift+P');
    } catch (error) {
        console.warn('[Assistant] Error unregistering Rust suspend hotkey:', error.message || error);
    } finally {
        rustSuspendHotkeyRegistered = false;
    }
}

function startGlobalMouseListener() {
    if (mouseListener) return;
    const { GlobalKeyboardListener } = require('node-global-key-listener');
    mouseListener = new GlobalKeyboardListener();
    mouseListener.addListener((e) => {
        if (e.state === 'DOWN') {
            if (hideBarTimeout) clearTimeout(hideBarTimeout);
            hideBarTimeout = setTimeout(() => {
                hideAssistantBarAndStopListener();
            }, 150);
        }
    });
}

function hideAssistantBarAndStopListener() {
    isWindowHidingInProgress = true;

    if (hideBarTimeout) {
        clearTimeout(hideBarTimeout);
        hideBarTimeout = null;
    }
    if (assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
        assistantBarWindow.hide();
    }
    if (mouseListener) {
        mouseListener.kill();
        mouseListener = null;
    }

    // 下一微任务时重置标志，允许再次处理新的选区
    setImmediate(() => {
        isWindowHidingInProgress = false;
    });
}

async function startSelectionListener() {
    const adapter = await ensureListenerAdapter();
    if (!adapter) {
        selectionListenerActive = false;
        return;
    }

    try {
        const started = adapter.start();
        if (!started && listenerMode === 'rust') {
            throw new Error('Rust adapter start returned false');
        }

        if (listenerMode === 'rust') {
            const ready = typeof adapter.waitUntilReady === 'function'
                ? await adapter.waitUntilReady(10000)
                : adapter.isActive();

            if (ready) {
                const rustConfig = await loadRustAssistantConfig();
                await applyRustGuardRules(adapter, rustConfig);
            }
        }

        selectionListenerActive = adapter.isActive();

        if (!selectionListenerActive && listenerMode === 'rust') {
            console.warn('[Assistant] Rust adapter did not become active, switching to Node adapter.');
            listenerAdapter = createNodeAssistantAdapter({ logger: console });
            await listenerAdapter.initialize();
            listenerAdapter.onSelection(processSelectedText);
            listenerMode = 'node';
            selectionListenerActive = listenerAdapter.start();
        }

        if (selectionListenerActive) {
            console.log(`[Assistant] Listener started (${listenerMode}).`);
        }

        if (selectionListenerActive && listenerMode === 'rust') {
            startRustHealthMonitor();
            registerRustSuspendHotkey();
        } else {
            stopRustHealthMonitor();
            unregisterRustSuspendHotkey();
        }
    } catch (error) {
        console.error('[Assistant] Failed to start listener adapter:', error);

        if (listenerMode !== 'node') {
            try {
                listenerAdapter = createNodeAssistantAdapter({ logger: console });
                await listenerAdapter.initialize();
                listenerAdapter.onSelection(processSelectedText);
                listenerMode = 'node';
                selectionListenerActive = listenerAdapter.start();
                if (selectionListenerActive) {
                    console.log('[Assistant] Fallback listener started (node).');
                }
                stopRustHealthMonitor();
                unregisterRustSuspendHotkey();
            } catch (fallbackError) {
                console.error('[Assistant] Node fallback start failed:', fallbackError);
                selectionListenerActive = false;
            }
        }
    }
}

function stopSelectionListener() {
    if (listenerAdapter) {
        try {
            listenerAdapter.stop();
        } catch (error) {
            console.error('[Assistant] Failed to stop listener adapter:', error);
        }
    }
    selectionListenerActive = false;
    stopRustHealthMonitor();
    unregisterRustSuspendHotkey();
}

function createAssistantBarWindow() {
    assistantBarWindow = new BrowserWindow({
        width: 410,
        height: 40,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        alwaysOnTop: true,
        resizable: false,
        movable: true,
        skipTaskbar: true,
        focusable: false,
        webPreferences: {
            preload: path.join(__dirname, '..', '..', 'preload.js'),
            contextIsolation: true,
        }
    });
    assistantBarWindow.loadFile(path.join(__dirname, '..', '..', 'Assistantmodules/assistant-bar.html'));
    assistantBarWindow.on('blur', () => {
        if (assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
            assistantBarWindow.hide();
        }
    });
    assistantBarWindow.on('closed', () => {
        assistantBarWindow = null;
    });
    return assistantBarWindow;
}

function createAssistantWindow(data) {
    if (assistantWindow && !assistantWindow.isDestroyed()) {
        assistantWindow.focus();
        assistantWindow.webContents.send('assistant-data', data);
        return;
    }
    assistantWindow = new BrowserWindow({
        width: 450,
        height: 600,
        minWidth: 350,
        minHeight: 400,
        title: '划词助手',
        modal: false,
        frame: false,
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        webPreferences: {
            preload: path.join(__dirname, '..', '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
        show: false,
        resizable: true,
        alwaysOnTop: false,
    });
    assistantWindow.loadFile(path.join(__dirname, '..', '..', 'Assistantmodules/assistant.html'));
    assistantWindow.once('ready-to-show', () => {
        assistantWindow.show();
        assistantWindow.webContents.send('assistant-data', data);
    });
    assistantWindow.on('closed', () => {
        assistantWindow = null;
    });
}

async function initialize(options) {
    SETTINGS_FILE = options.SETTINGS_FILE;

    await ensureListenerAdapter();
    createAssistantBarWindow();

    ipcMain.handle('get-assistant-bar-initial-data', async () => {
        try {
            const settings = await fs.readJson(SETTINGS_FILE);
            if (settings.assistantEnabled && settings.assistantAgent) {
                const agentConfig = await getAgentConfigById(settings.assistantAgent);
                return {
                    agentAvatarUrl: agentConfig.avatarUrl,
                    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
                };
            }
        } catch (error) {
            console.error('[Assistant] Error getting initial data for assistant bar:', error);
            return { error: error.message };
        }
        return {
            agentAvatarUrl: null,
            theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
        };
    });

    ipcMain.on('toggle-selection-listener', async (_event, enable) => {
        if (enable) {
            await startSelectionListener();
        } else {
            stopSelectionListener();
        }
    });

    ipcMain.on('close-assistant-bar', () => {
        hideAssistantBarAndStopListener();
    });

    ipcMain.handle('get-selection-listener-status', () => {
        return selectionListenerActive || (listenerAdapter ? listenerAdapter.isActive() : false);
    });

    ipcMain.handle('assistant-suspend-listener', async (_event, durationMs) => {
        try {
            const ms = Math.max(0, Number(durationMs) || 0);
            const adapter = await ensureListenerAdapter();
            if (!adapter || typeof adapter.suspend !== 'function') {
                return { success: false, error: '当前监听实现不支持 suspend' };
            }

            await adapter.suspend(ms);
            return { success: true, durationMs: ms, mode: listenerMode };
        } catch (error) {
            return { success: false, error: error.message || String(error) };
        }
    });

    ipcMain.handle('get-assistant-runtime-status', async () => {
        try {
            const rustConfig = await loadRustAssistantConfig();
            const active = selectionListenerActive || (listenerAdapter ? listenerAdapter.isActive() : false);
            const desiredMode = (process.platform === 'win32' && shouldUseRustAssistant(rustConfig)) ? 'rust' : 'node';
            const diagnostics = (listenerAdapter && typeof listenerAdapter.getDiagnostics === 'function')
                ? listenerAdapter.getDiagnostics()
                : null;
            let rustSidecarListenerActive = null;

            if (listenerMode === 'rust' && listenerAdapter && typeof listenerAdapter.getStatus === 'function') {
                try {
                    const statusResp = await listenerAdapter.getStatus();
                    if (statusResp && statusResp.status === 200 && statusResp.data && typeof statusResp.data.listener_active === 'boolean') {
                        rustSidecarListenerActive = statusResp.data.listener_active;
                    }
                } catch (statusError) {
                    rustSidecarListenerActive = null;
                    console.warn('[Assistant] Failed to query Rust sidecar /status:', statusError.message || statusError);
                }
            }

            let lastDebugReason = diagnostics?.lastDebugReason || null;
            if (!lastDebugReason) {
                if (!listenerAdapter) {
                    lastDebugReason = '监听器适配器尚未初始化';
                } else if (listenerMode !== 'rust') {
                    lastDebugReason = '当前为 Node 实现，Rust 诊断不可用';
                } else if (!active) {
                    lastDebugReason = 'Rust 监听器未运行';
                } else {
                    lastDebugReason = '尚未收到可诊断事件';
                }
            }

            return {
                success: true,
                mode: listenerMode,
                desiredMode,
                active,
                rustConfigured: desiredMode === 'rust',
                adapterReady: !!listenerAdapter,
                debugMode: rustConfig.debugMode === true,
                lastDebugReason,
                lastDebugTimestamp: diagnostics?.lastDebugTimestamp || 0,
                forwardedEventCount: diagnostics?.forwardedEventCount || 0,
                rustSidecarListenerActive,
                adapterProcessAlive: diagnostics?.processAlive === true,
                adapterProcessPid: diagnostics?.processPid || null,
                adapterPending: diagnostics?.pending === true,
                runtimeFallbackTrace,
                integrationTrace: {
                    ...integrationTrace,
                    assistantBarWindowExists: !!assistantBarWindow,
                    assistantBarWindowVisible: !!(assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible())
                }
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-rust-assistant-config', async () => {
        try {
            return await loadRustAssistantConfig();
        } catch (error) {
            console.error('[Assistant] Failed to load rust assistant config via IPC:', error);
            return { error: error.message };
        }
    });

    ipcMain.handle('save-rust-assistant-config', async (_event, configPatch) => {
        try {
            const saved = await saveRustAssistantConfig(configPatch || {});

            const reconcileResult = await reconcileListenerModeAfterConfig(saved);

            return {
                success: true,
                config: saved,
                reconcile: reconcileResult
            };
        } catch (error) {
            console.error('[Assistant] Failed to save rust assistant config via IPC:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.on('assistant-action', async (event, action) => {
        if (hideBarTimeout) {
            clearTimeout(hideBarTimeout);
            hideBarTimeout = null;
        }
        hideAssistantBarAndStopListener();
        
        if (action === 'note') {
            try {
                const noteTitle = `来自划词笔记：${lastProcessedSelection.substring(0, 20)}...`;
                const noteContent = lastProcessedSelection;
                const data = {
                    title: noteTitle,
                    content: noteContent,
                    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
                };
                // Use the imported handler
                const targetWindow = notesHandlers.createOrFocusNotesWindow();
                const wc = targetWindow.webContents;
                if (!wc.isLoading()) {
                    wc.send('shared-note-data', data);
                } else {
                    ipcMain.once('notes-window-ready', (e) => {
                        if (e.sender === wc) {
                            wc.send('shared-note-data', data);
                        }
                    });
                }
            } catch (error) {
                console.error('[Assistant] Error creating note from assistant action:', error);
            }
            return;
        }
        
        try {
            const settings = await fs.readJson(SETTINGS_FILE);
            createAssistantWindow({
                selectedText: action === 'open' ? '' : lastProcessedSelection,
                action: action,
                agentId: settings.assistantAgent,
            });
        } catch (error) {
            console.error('[Assistant] Error creating assistant window from action:', error);
        }
    });
}

module.exports = {
    initialize,
    startSelectionListener,
    stopSelectionListener,
    getSelectionListenerStatus: () => selectionListenerActive || (listenerAdapter ? listenerAdapter.isActive() : false),
    getAssistantWindows: () => ({ assistantWindow, assistantBarWindow }),
    hideAssistantBarAndStopListener,
    stopMouseListener: () => {
        if (mouseListener) {
            try {
                mouseListener.kill();
                console.log('[Assistant] Global mouse listener killed.');
            } catch (e) {
                console.error('[Assistant] Error killing mouse listener on quit:', e);
            } finally {
                mouseListener = null;
            }
        }
    }
};