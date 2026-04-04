// modules/ipc/assistantHandlers.js

const { ipcMain, BrowserWindow, screen, nativeTheme, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { getAgentConfigById } = require('./agentHandlers');
const { createRustAssistantAdapter } = require('../assistant/assistant-rust-adapter');
const windowService = require('../services/windowService');
const WINDOW_APP_IDS = require('../services/windowAppIds');
const { PRELOAD_ROLES, resolveProjectPreload } = require('../services/preloadPaths');

let assistantWindow = null;
let assistantBarWindow = null;
let assistantBarWindowReady = false;  // ⏱️ 标记悬浮条窗口是否已准备好
let assistantBarWindowReadyPromises = [];  // ⏱️ 等待 ready 的 resolve 函数列表
let selectionUpdateToken = 0;
let assistantBarHideRequestId = 0;
let lastAssistantBarShownAt = 0;
const ASSISTANT_BAR_HIDE_GRACE_MS = 280;
const ASSISTANT_BAR_GLOBAL_HIDE_DELAY_MS = 260;
const ASSISTANT_BAR_ANIMATION_MS = 200;
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
let listenerMode = 'rust';
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

const ASSISTANT_RUNTIME_CACHE_TTL_MS = 1500;
let assistantRuntimeCache = {
    settings: null,
    settingsLoadedAt: 0,
    settingsMtimeMs: 0,
    agentId: null,
    agentConfig: null,
    agentConfigLoadedAt: 0
};

function buildAssistantNotePayload(selectionText, isDarkTheme) {
    return {
        title: `来自划词笔记：${selectionText.substring(0, 20)}...`,
        content: selectionText,
        theme: isDarkTheme ? 'dark' : 'light'
    };
}

async function sendAssistantNoteToNotesWindow(selectionText, isDarkTheme, sendPayload = windowService.sendPayload) {
    const data = buildAssistantNotePayload(selectionText, isDarkTheme);
    await sendPayload(WINDOW_APP_IDS.NOTES, data, { timeoutMs: 10000 });
    return data;
}

function getRustAssistantConfigPath() {
    return path.join(__dirname, '..', '..', 'AppData', 'rust-assistant-config.json');
}

function invalidateAssistantRuntimeCache({ settings = false, agent = false, all = false } = {}) {
    if (all || settings) {
        assistantRuntimeCache.settings = null;
        assistantRuntimeCache.settingsLoadedAt = 0;
        assistantRuntimeCache.settingsMtimeMs = 0;
    }

    if (all || agent || settings) {
        assistantRuntimeCache.agentId = null;
        assistantRuntimeCache.agentConfig = null;
        assistantRuntimeCache.agentConfigLoadedAt = 0;
    }
}

async function loadAssistantSettingsCached() {
    if (!SETTINGS_FILE) {
        return null;
    }

    const now = Date.now();
    if (assistantRuntimeCache.settings && (now - assistantRuntimeCache.settingsLoadedAt) < ASSISTANT_RUNTIME_CACHE_TTL_MS) {
        return assistantRuntimeCache.settings;
    }

    const stat = await fs.stat(SETTINGS_FILE);
    if (
        assistantRuntimeCache.settings &&
        assistantRuntimeCache.settingsMtimeMs === stat.mtimeMs
    ) {
        assistantRuntimeCache.settingsLoadedAt = now;
        return assistantRuntimeCache.settings;
    }

    const previousAgentId = assistantRuntimeCache.settings?.assistantAgent || null;
    const settings = await fs.readJson(SETTINGS_FILE);
    const nextAgentId = settings?.assistantAgent || null;

    assistantRuntimeCache.settings = settings;
    assistantRuntimeCache.settingsLoadedAt = now;
    assistantRuntimeCache.settingsMtimeMs = stat.mtimeMs;

    if (previousAgentId !== nextAgentId) {
        invalidateAssistantRuntimeCache({ agent: true });
    }

    return settings;
}

async function loadAssistantAgentConfigCached(agentId) {
    if (!agentId) {
        return null;
    }

    const now = Date.now();
    if (
        assistantRuntimeCache.agentConfig &&
        assistantRuntimeCache.agentId === agentId &&
        (now - assistantRuntimeCache.agentConfigLoadedAt) < ASSISTANT_RUNTIME_CACHE_TTL_MS
    ) {
        return assistantRuntimeCache.agentConfig;
    }

    const agentConfig = await getAgentConfigById(agentId);
    if (agentConfig && !agentConfig.error) {
        assistantRuntimeCache.agentId = agentId;
        assistantRuntimeCache.agentConfig = agentConfig;
        assistantRuntimeCache.agentConfigLoadedAt = now;
    } else {
        invalidateAssistantRuntimeCache({ agent: true });
    }

    return agentConfig;
}

function getBrowserWindowHandleString(win) {
    if (!win || win.isDestroyed() || typeof win.getNativeWindowHandle !== 'function') {
        return null;
    }

    try {
        const handleBuffer = win.getNativeWindowHandle();
        if (!Buffer.isBuffer(handleBuffer) || handleBuffer.length === 0) {
            return null;
        }

        if (handleBuffer.length >= 8) {
            return handleBuffer.readBigUInt64LE(0).toString();
        }

        if (handleBuffer.length >= 4) {
            return String(handleBuffer.readUInt32LE(0));
        }
    } catch (error) {
        console.warn('[Assistant] Failed to get native window handle:', error.message || error);
    }

    return null;
}

function collectOwnWindowIdentities() {
    const handles = [];
    const processIds = [];

    const barHandle = assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()
        ? getBrowserWindowHandleString(assistantBarWindow)
        : null;
    const mainHandle = assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.isVisible()
        ? getBrowserWindowHandleString(assistantWindow)
        : null;

    if (barHandle) {
        handles.push(barHandle);
    }
    if (mainHandle) {
        handles.push(mainHandle);
    }

    const pid = Number(process.pid);
    if (Number.isFinite(pid) && pid > 0) {
        processIds.push(pid);
    }

    return {
        ownWindowHandles: Array.from(new Set(handles)),
        ownProcessIds: Array.from(new Set(processIds)),
    };
}

function normalizeRuntimeThresholds(runtimeThresholds = {}) {
    return {
        minEventIntervalMs: Math.max(0, Number(runtimeThresholds.minEventIntervalMs) || 80),
        minDistance: Math.max(0, Number(runtimeThresholds.minDistance) || 0),
        screenshotSuspendMs: Math.max(0, Number(runtimeThresholds.screenshotSuspendMs) || 3000),
        clipboardConflictSuspendMs: Math.max(0, Number(runtimeThresholds.clipboardConflictSuspendMs) || 1000),
        clipboardCheckIntervalMs: Math.max(50, Number(runtimeThresholds.clipboardCheckIntervalMs) || 500)
    };
}

function processSelectedText(selectionData) {
    // 若窗口隐藏流程已启动，则不再处理新的选区（避免重新定位窗口）
    if (isWindowHidingInProgress) {
        return;
    }

    integrationTrace.receivedSelectionCount += 1;
    integrationTrace.lastSelectionTs = Date.now();

    if (hideBarTimeout) {
        clearTimeout(hideBarTimeout);
        hideBarTimeout = null;
    }

    const selectedText = selectionData?.text;

    // 优化：在 Rust 模式下，如果收到空文本（通常意味着点击了非文本区域或取消了选区），立即隐藏悬浮条
    if (!selectedText || selectedText.trim() === '') {
        const now = Date.now();
        const shouldHide = (now - lastAssistantBarShownAt) >= ASSISTANT_BAR_HIDE_GRACE_MS;
        
        if (shouldHide && assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
            // 如果是 Rust 模式，我们更积极地响应“空选区”信号来隐藏窗口
            const reason = listenerMode === 'rust' ? 'rust-empty-selection' : 'empty-selection';
            hideAssistantBarWithAnimation(reason);
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
    const currentToken = ++selectionUpdateToken;

    setImmediate(async () => {
        integrationTrace.showAttemptCount += 1;
        integrationTrace.lastShowAttemptTs = Date.now();
        integrationTrace.lastShowError = null;
        
        // ⏱️ 改进：按正确的顺序处理
        try {
            // 1. 检查窗口状态
            if (!assistantBarWindow || assistantBarWindow.isDestroyed()) {
                integrationTrace.lastShowError = 'assistantBarWindow 不存在或已销毁';
                console.error('[Assistant] Assistant bar window destroyed during show.');
                return;
            }
            
            // 2. 等待窗口准备就绪（最多等待 3 秒）
            await waitForAssistantBarReady(3000);

            if (currentToken !== selectionUpdateToken) {
                return;
            }
            
            // 3. 读取配置并发送数据
            const settings = await loadAssistantSettingsCached();
            if (settings.assistantEnabled && settings.assistantAgent) {
                const agentConfig = await loadAssistantAgentConfigCached(settings.assistantAgent);

                // ⚠️ 检查 agentConfig 是否返回错误
                if (agentConfig.error) {
                    integrationTrace.lastShowError = `获取 Agent 配置失败: ${agentConfig.error}`;
                    console.error('[Assistant] Failed to get agent config:', agentConfig.error);
                    return;
                }

                if (currentToken !== selectionUpdateToken) {
                    return;
                }
                
                // 再次检查窗口（防止在等待期间被销毁）
                if (assistantBarWindow && !assistantBarWindow.isDestroyed()) {
                    // 4. 发送初始数据到渲染进程
                    assistantBarWindow.webContents.send('assistant-bar-data', {
                        agentAvatarUrl: agentConfig.avatarUrl,
                        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
                    });

                    prepareAssistantBarForShow();
                    
                    // 5. 设置位置
                    assistantBarWindow.setPosition(finalX, finalY);
                    
                    // 6. 最后显示窗口（此时内容已加载）
                    assistantBarWindow.showInactive();
                    lastAssistantBarShownAt = Date.now();
                    console.log('[Assistant] Assistant bar shown at', finalX, finalY);
                } else {
                    integrationTrace.lastShowError = 'assistantBarWindow 在发送数据前被销毁';
                }
            } else {
                integrationTrace.lastShowError = '助手未启用或未配置';
                console.error('[Assistant] Assistant not enabled or not configured.');
            }
        } catch (error) {
            integrationTrace.lastShowError = `显示助手窗口失败: ${error.message || error}`;
            console.error('[Assistant] Error showing assistant bar:', error);
        }
        
        // 启动全局鼠标监听器作为备选方案
        // Rust 模式下虽然 sidecar 会发送空选区事件，但添加双重保障
        startGlobalMouseListener();
    });
}

async function loadRustAssistantConfig() {
    const configPath = getRustAssistantConfigPath();
    const defaults = {
        version: 2,
        useRustAssistant: true,
        debugMode: false,
        whitelist: [],
        blacklist: [],
        screenshotApps: [],
        fallback: {
            onError: true,
            onCrash: true,
            onTimeout: true,
            mode: 'rust-restart-or-stop'
        },
        runtimeThresholds: {
            minEventIntervalMs: 80,
            minDistance: 0,
            screenshotSuspendMs: 3000,
            clipboardConflictSuspendMs: 1000,
            clipboardCheckIntervalMs: 500
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
                fallback: {
                    ...defaults.fallback,
                    ...(rawConfig.fallback || {})
                },
                runtimeThresholds: normalizeRuntimeThresholds({
                    ...defaults.runtimeThresholds,
                    ...(rawConfig.runtimeThresholds || {})
                }),
                metrics: {
                    ...defaults.metrics,
                    ...(rawConfig.metrics || {})
                },
                version: 2,
                useRustAssistant: rawConfig.useRustAssistant !== false,
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
        version: 2,
        useRustAssistant: partialConfig.useRustAssistant === undefined
            ? current.useRustAssistant
            : partialConfig.useRustAssistant === true,
        fallback: {
            ...(current.fallback || {}),
            ...((partialConfig && partialConfig.fallback) || {})
        },
        runtimeThresholds: normalizeRuntimeThresholds({
            ...(current.runtimeThresholds || {}),
            ...((partialConfig && partialConfig.runtimeThresholds) || {})
        }),
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

    delete merged.forceNode;
    delete merged.forceRust;

    await fs.ensureDir(path.dirname(configPath));
    await fs.writeJson(configPath, merged, { spaces: 2 });
    return merged;
}

async function applyRustGuardRules(adapter, rustConfig) {
    if (!adapter || typeof adapter.setGuardRules !== 'function') {
        return;
    }

    try {
        const identity = collectOwnWindowIdentities();
        const thresholds = normalizeRuntimeThresholds(rustConfig?.runtimeThresholds || {});

        await adapter.setGuardRules({
            whitelist: Array.isArray(rustConfig?.whitelist) ? rustConfig.whitelist : [],
            blacklist: Array.isArray(rustConfig?.blacklist) ? rustConfig.blacklist : [],
            screenshot_apps: Array.isArray(rustConfig?.screenshotApps) ? rustConfig.screenshotApps : [],
            min_event_interval_ms: thresholds.minEventIntervalMs,
            min_distance: thresholds.minDistance,
            screenshot_suspend_ms: thresholds.screenshotSuspendMs,
            clipboard_conflict_suspend_ms: thresholds.clipboardConflictSuspendMs,
            clipboard_check_interval_ms: thresholds.clipboardCheckIntervalMs,
            own_window_handles: identity.ownWindowHandles,
            own_process_ids: identity.ownProcessIds
        });
        console.log('[Assistant] Rust guard rules synced from rust-assistant-config.json', {
            ownWindowHandles: identity.ownWindowHandles.length,
            ownProcessIds: identity.ownProcessIds,
            runtimeThresholds: thresholds
        });
    } catch (error) {
        console.warn('[Assistant] Failed to sync Rust guard rules:', error.message || error);
    }
}

function shouldUseRustAssistant(config) {
    return config?.useRustAssistant === true;
}

async function createPreferredAdapter() {
    const rustConfig = await loadRustAssistantConfig();
    const rustEnabled = shouldUseRustAssistant(rustConfig);

    console.log('[Assistant] Effective Rust config:', {
        useRustAssistant: rustConfig.useRustAssistant,
        rustEnabled
    });

    if (!rustEnabled) {
        listenerMode = 'disabled';
        return null;
    }

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

async function ensureListenerAdapter() {
    if (listenerAdapter) {
        return listenerAdapter;
    }

    try {
        listenerAdapter = await createPreferredAdapter();
        if (listenerAdapter) {
            console.log(`[Assistant] Listener adapter initialized: ${listenerMode}`);
        } else {
            console.warn('[Assistant] Rust assistant is disabled by config.');
        }
    } catch (error) {
        console.error('[Assistant] Failed to initialize preferred adapter:', error);
        listenerAdapter = null;
        listenerMode = 'rust';
    }

    return listenerAdapter;
}

async function reconcileListenerModeAfterConfig(config) {
    const desiredMode = shouldUseRustAssistant(config) ? 'rust' : 'disabled';
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

async function recoverRustRuntime(reason = 'unknown') {
    try {
        console.warn(`[Assistant] Rust runtime recovery triggered: ${reason}`);

        runtimeFallbackTrace.autoFallbackCount += 1;
        runtimeFallbackTrace.lastAutoFallbackReason = reason;
        runtimeFallbackTrace.lastAutoFallbackTs = Date.now();

        if (listenerAdapter) {
            try {
                listenerAdapter.stop();
            } catch (stopError) {
                console.warn('[Assistant] Failed to stop current adapter during recovery:', stopError);
            }
        }

        const rustConfig = await loadRustAssistantConfig();
        if (!shouldUseRustAssistant(rustConfig)) {
            listenerAdapter = null;
            listenerMode = 'disabled';
            selectionListenerActive = false;
            console.warn('[Assistant] Rust assistant disabled by config, stop recovery.');
            return;
        }

        const rustAdapter = createRustAssistantAdapter({
            projectRoot: path.join(__dirname, '..', '..'),
            logger: console,
            debugMode: rustConfig.debugMode === true
        });

        await rustAdapter.initialize();
        rustAdapter.onSelection(processSelectedText);
        listenerAdapter = rustAdapter;
        listenerMode = 'rust';

        const started = rustAdapter.start();
        if (!started) {
            throw new Error('Rust adapter start returned false during recovery');
        }

        const ready = typeof rustAdapter.waitUntilReady === 'function'
            ? await rustAdapter.waitUntilReady(10000)
            : rustAdapter.isActive();
        if (!ready) {
            throw new Error('Rust adapter did not become ready during recovery');
        }

        await applyRustGuardRules(rustAdapter, rustConfig);
        selectionListenerActive = rustAdapter.isActive();

        if (selectionListenerActive) {
            console.log('[Assistant] Rust runtime recovered and listener restarted.');
        } else {
            console.error('[Assistant] Rust recovery finished but listener is not active.');
        }
    } catch (error) {
        console.error('[Assistant] Rust runtime recovery failed:', error);
        listenerAdapter = null;
        listenerMode = 'rust';
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
            const lifecycleState = diagnostics?.lifecycleState || 'unknown';

            if (fallbackConfig.onError !== false && rustPanicDetected) {
                await recoverRustRuntime('Rust listener panic');
                return;
            }

            if (fallbackConfig.onError !== false && lifecycleState === 'degraded') {
                await recoverRustRuntime('Rust sidecar lifecycle degraded');
                return;
            }

            if (fallbackConfig.onCrash !== false && diagnostics.processAlive === false) {
                await recoverRustRuntime('Rust sidecar process exited');
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
                    await recoverRustRuntime('Rust /status unhealthy or timeout');
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
    try {
        const { GlobalKeyboardListener } = require('node-global-key-listener');
        mouseListener = new GlobalKeyboardListener();
        
        // 监听鼠标按键事件（左键、右键、中键）
        // 注意：node-global-key-listener 虽然名字是 Keyboard，但实际上也可以捕获鼠标事件
        mouseListener.addListener((e) => {
            // 检查是否是鼠标按键按下事件
            const isMouseDown = e.state === 'DOWN' && (
                e.name === 'MOUSE LEFT' || 
                e.name === 'MOUSE RIGHT' || 
                e.name === 'MOUSE MIDDLE' ||
                e.name?.includes('MOUSE')
            );
            
            if (isMouseDown) {
                if (hideBarTimeout) clearTimeout(hideBarTimeout);
                hideBarTimeout = setTimeout(() => {
                    const shouldHide = (Date.now() - lastAssistantBarShownAt) >= ASSISTANT_BAR_HIDE_GRACE_MS;
                    if (shouldHide && assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
                        // 检查鼠标点击位置是否在助手栏窗口内
                        try {
                            const cursorPos = screen.getCursorScreenPoint();
                            const barBounds = assistantBarWindow.getBounds();
                            const isInBarBounds = 
                                cursorPos.x >= barBounds.x && 
                                cursorPos.x <= barBounds.x + barBounds.width &&
                                cursorPos.y >= barBounds.y && 
                                cursorPos.y <= barBounds.y + barBounds.height;
                            
                            if (!isInBarBounds) {
                                console.log('[Assistant] Hiding bar due to global mouse click outside');
                                hideAssistantBarWithAnimation('global-mouse-down');
                            }
                        } catch (boundsError) {
                            // 如果无法获取边界，直接隐藏
                            console.log('[Assistant] Hiding bar (bounds check failed)');
                            hideAssistantBarWithAnimation('global-mouse-down');
                        }
                    }
                }, ASSISTANT_BAR_GLOBAL_HIDE_DELAY_MS);
            }
        });
        console.log('[Assistant] Global mouse listener started');
    } catch (error) {
        console.error('[Assistant] Failed to start global mouse listener:', error);
    }
}

function prepareAssistantBarForShow() {
    if (!assistantBarWindow || assistantBarWindow.isDestroyed()) {
        return;
    }

    assistantBarHideRequestId += 1;
    assistantBarWindow.webContents.executeJavaScript(`
        (() => {
            const bar = document.getElementById('selection-assistant-bar');
            if (!bar) return;
            bar.style.transition = 'opacity 0.2s ease-in-out, transform 0.2s ease-in-out';
            bar.style.opacity = '1';
            bar.style.transform = 'none';
        })();
    `, true).catch(() => {});
}

function hideAssistantBarWithAnimation(reason = 'unknown') {
    if (!assistantBarWindow || assistantBarWindow.isDestroyed() || !assistantBarWindow.isVisible()) {
        return;
    }

    const targetWindow = assistantBarWindow;
    const requestId = ++assistantBarHideRequestId;

    const hideNow = () => {
        if (!targetWindow || targetWindow.isDestroyed() || !targetWindow.isVisible()) {
            return;
        }
        if (requestId !== assistantBarHideRequestId) {
            return;
        }
        targetWindow.hide();
    };

    targetWindow.webContents.executeJavaScript(`
        (() => {
            const bar = document.getElementById('selection-assistant-bar');
            if (!bar) return false;
            bar.style.transition = 'opacity 0.2s ease-in-out, transform 0.2s ease-in-out';
            bar.style.opacity = '0';
            bar.style.transform = 'translateY(10px)';
            return true;
        })();
    `, true).then((animated) => {
        setTimeout(hideNow, animated ? ASSISTANT_BAR_ANIMATION_MS : 0);
    }).catch((error) => {
        console.warn('[Assistant] Hide animation fallback:', reason, error.message || error);
        hideNow();
    });
}

// ⏱️ 等待助手悬浮条窗口准备就绪的辅助函数
async function waitForAssistantBarReady(timeoutMs = 3000) {
    // 如果已经准备好，立即返回
    if (assistantBarWindowReady) {
        return true;
    }
    
    // 如果窗口不存在或已销毁，无法等待
    if (!assistantBarWindow || assistantBarWindow.isDestroyed()) {
        return false;
    }
    
    // 创建 Promise 来等待 ready 事件
    return new Promise((resolve) => {
        // 添加 resolve 函数到等待列表
        assistantBarWindowReadyPromises.push(resolve);
        
        // 设置超时：如果超时时间内 ready 事件未触发，仍然继续（降级处理）
        const timeoutId = setTimeout(() => {
            console.warn('[Assistant] Timeout waiting for assistant bar window to be ready. Proceeding anyway.');
            resolve(false);
        }, timeoutMs);
        
        // 当 resolve 被调用时，清除超时
        const originalResolve = resolve;
        const wrappedResolve = (result) => {
            clearTimeout(timeoutId);
            originalResolve(result);
        };
        
        // 替换列表中的 resolve
        assistantBarWindowReadyPromises[assistantBarWindowReadyPromises.length - 1] = wrappedResolve;
    });
}

function hideAssistantBarAndStopListener() {
    isWindowHidingInProgress = true;

    if (hideBarTimeout) {
        clearTimeout(hideBarTimeout);
        hideBarTimeout = null;
    }
    if (assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
        hideAssistantBarWithAnimation('hide-and-stop-listener');
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
            await recoverRustRuntime('Rust adapter did not become active after start');
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
        selectionListenerActive = false;
        stopRustHealthMonitor();
        unregisterRustSuspendHotkey();
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
        width: 460,
        height: 44,
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
                preload: resolveProjectPreload(path.join(__dirname, '..', '..'), PRELOAD_ROLES.CHAT),
            contextIsolation: true,
        }
    });
    assistantBarWindow.loadFile(path.join(__dirname, '..', '..', 'rust_assistant_engine', 'ui', 'assistant-bar.html'));
    
    // ⏱️ 改进：ready-to-show 事件触发时，标记窗口已准备好，并唤醒所有等待的 Promise
    assistantBarWindow.once('ready-to-show', () => {
        if (assistantBarWindow && !assistantBarWindow.isDestroyed()) {
            console.log('[Assistant] Assistant bar window ready for display.');
            assistantBarWindowReady = true;
            
            // 唤醒所有等待的 Promise
            const promises = assistantBarWindowReadyPromises.splice(0);
            promises.forEach(resolve => resolve());
        }
    });
    
    assistantBarWindow.on('blur', () => {
        const shouldHide = (Date.now() - lastAssistantBarShownAt) >= ASSISTANT_BAR_HIDE_GRACE_MS;
        if (shouldHide && assistantBarWindow && !assistantBarWindow.isDestroyed() && assistantBarWindow.isVisible()) {
            hideAssistantBarWithAnimation('blur');
        }
    });
    
    assistantBarWindow.on('closed', () => {
        assistantBarWindow = null;
        assistantBarWindowReady = false;  // 重置 ready 状态
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
                preload: resolveProjectPreload(path.join(__dirname, '..', '..'), PRELOAD_ROLES.CHAT),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
        show: false,
        resizable: true,
        alwaysOnTop: false,
    });
    assistantWindow.loadFile(path.join(__dirname, '..', '..', 'rust_assistant_engine', 'ui', 'assistant.html'));
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
    invalidateAssistantRuntimeCache({ all: true });

    await ensureListenerAdapter();
    createAssistantBarWindow();

    ipcMain.handle('get-assistant-bar-initial-data', async () => {
        try {
            const settings = await loadAssistantSettingsCached();
            if (settings.assistantEnabled && settings.assistantAgent) {
                const agentConfig = await loadAssistantAgentConfigCached(settings.assistantAgent);
                
                // ⚠️ 检查 agentConfig 是否返回错误
                if (agentConfig.error) {
                    console.error('[Assistant] Failed to get agent config for initial data:', agentConfig.error);
                    return {
                        agentAvatarUrl: null,
                        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
                        error: agentConfig.error
                    };
                }
                
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
        if (assistantRuntimeCache.settings) {
            assistantRuntimeCache.settings = {
                ...assistantRuntimeCache.settings,
                assistantEnabled: enable === true
            };
            assistantRuntimeCache.settingsLoadedAt = Date.now();
        }

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
            const desiredMode = shouldUseRustAssistant(rustConfig) ? 'rust' : 'disabled';
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
                    lastDebugReason = 'Rust assistant disabled by config';
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
                lifecycleState: diagnostics?.lifecycleState || 'unknown',
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
                await sendAssistantNoteToNotesWindow(
                    lastProcessedSelection,
                    nativeTheme.shouldUseDarkColors
                );
            } catch (error) {
                console.error('[Assistant] Error creating note from assistant action:', error);
            }
            return;
        }
        
        try {
            const settings = await loadAssistantSettingsCached();
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
    },
    __test: {
        buildAssistantNotePayload,
        sendAssistantNoteToNotesWindow
    }
};
