// main.js - Electron 主窗口

// --- 模块加载性能诊断 ---
const originalRequire = require;
require = function (id) {
    const start = Date.now();
    const result = originalRequire(id);
    const duration = Date.now() - start;
    if (duration > 50) { // 只显示超过 50ms 的模块
        console.log(`⏱️ require('${id}') took ${duration}ms`);
    }
    return result;
};

const { app, BrowserWindow, ipcMain, nativeTheme, globalShortcut, screen, clipboard, shell, dialog, protocol, Tray, Menu } = require('electron'); // Added screen, clipboard, and shell
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra'); // Using fs-extra for convenience
const os = require('os');
const { spawn } = require('child_process'); // For executing local python
const { Worker } = require('worker_threads');
const fileManager = require('./modules/fileManager'); // Import the new file manager
const groupChat = require('./Groupmodules/groupchat'); // Import the group chat module
const windowHandlers = require('./modules/ipc/windowHandlers'); // Import window IPC handlers
const settingsHandlers = require('./modules/ipc/settingsHandlers'); // Import settings IPC handlers
const fileDialogHandlers = require('./modules/ipc/fileDialogHandlers'); // Import file dialog handlers
const { getAgentConfigById, ...agentHandlers } = require('./modules/ipc/agentHandlers'); // Import agent handlers
const regexHandlers = require('./modules/ipc/regexHandlers'); // Import regex handlers
const chatHandlers = require('./modules/ipc/chatHandlers'); // Import chat handlers
const groupChatHandlers = require('./modules/ipc/groupChatHandlers'); // Import group chat handlers
const sovitsHandlers = require('./modules/ipc/sovitsHandlers'); // Import SovitsTTS IPC handlers
const promptHandlers = require('./modules/ipc/promptHandlers'); // Import prompt handlers
const notesHandlers = require('./modules/ipc/notesHandlers'); // Import notes handlers
const assistantHandlers = require('./modules/ipc/assistantHandlers'); // Import assistant handlers
const musicHandlers = require('./modules/ipc/musicHandlers'); // Import music handlers
const diceHandlers = require('./modules/ipc/diceHandlers'); // Import dice handlers
const themeHandlers = require('./modules/ipc/themeHandlers'); // Import theme handlers
const emoticonHandlers = require('./modules/ipc/emoticonHandlers'); // Import emoticon handlers
const forumHandlers = require('./modules/ipc/forumHandlers'); // Import forum handlers
const memoHandlers = require('./modules/ipc/memoHandlers'); // Import memo handlers
const ragHandlers = require('./modules/ipc/ragHandlers'); // Import RAG handlers
// speechRecognizer is now lazy-loaded
const canvasHandlers = require('./modules/ipc/canvasHandlers'); // Import canvas handlers
const desktopHandlers = require('./modules/ipc/desktopHandlers'); // Import VCPdesktop handlers
const desktopRemoteHandlers = require('./modules/ipc/desktopRemoteHandlers'); // Import desktop remote control handlers
// chokidar is now lazy-loaded

// --- File Watcher ---
let historyWatcher = null;
let lastInternalSaveTime = 0; // 🔧 改为时间戳记录
let internalSaveTimeout = null; // 🔧 超时保护
let isEditingInProgress = false; // 🔧 编辑状态标识
const INTERNAL_SAVE_WINDOW_MS = 2000; // 🔧 内部保存时间窗口（2秒）

const fileWatcher = {
    watchFile: (filePath, callback) => {
        if (historyWatcher) {
            historyWatcher.close();
        }
        console.log(`[FileWatcher] Watching new file: ${filePath}`);
        const chokidar = require('chokidar'); // Lazy load
        historyWatcher = chokidar.watch(filePath, {
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 300, // 🔧 增加稳定性阈值
                pollInterval: 100
            }
        });
        historyWatcher.on('all', (event, path) => {
            // 🔧 改进：使用时间窗口而非一次性标志
            const now = Date.now();
            const isWithinSaveWindow = (now - lastInternalSaveTime) < INTERNAL_SAVE_WINDOW_MS;

            if (isWithinSaveWindow || isEditingInProgress) {
                console.log(`[FileWatcher] Ignored ${isWithinSaveWindow ? 'internal save' : 'editing'} event '${event}' for: ${path} (time since last save: ${now - lastInternalSaveTime}ms)`);
                return;
            }
            console.log(`[FileWatcher] Detected external event '${event}' for: ${path}`);
            callback(path);
        });
        historyWatcher.on('error', error => console.error(`[FileWatcher] Error: ${error}`));
    },
    stopWatching: () => {
        if (historyWatcher) {
            console.log('[FileWatcher] Stopping file watch.');
            historyWatcher.close();
            historyWatcher = null;
        }
        // 🔧 清理状态
        isEditingInProgress = false;
        lastInternalSaveTime = 0; // 重置时间戳
        if (internalSaveTimeout) {
            clearTimeout(internalSaveTimeout);
            internalSaveTimeout = null;
        }
    },
    signalInternalSave: () => {
        // 🔧 记录内部保存时间戳
        lastInternalSaveTime = Date.now();
        console.log('[FileWatcher] Internal save signaled at:', lastInternalSaveTime);

        // 🔧 设置超时保护，防止时间窗口失效（虽然理论上不需要了）
        if (internalSaveTimeout) clearTimeout(internalSaveTimeout);
        internalSaveTimeout = setTimeout(() => {
            // 这个超时主要是为了调试，正常情况下时间窗口会自然过期
            const timeSinceLastSave = Date.now() - lastInternalSaveTime;
            if (timeSinceLastSave >= INTERNAL_SAVE_WINDOW_MS) {
                console.log('[FileWatcher] Internal save window naturally expired');
            }
        }, INTERNAL_SAVE_WINDOW_MS + 1000);
    },
    // 🔧 新增：编辑状态管理
    setEditingMode: (editing) => {
        isEditingInProgress = editing;
        console.log(`[FileWatcher] Editing mode set to: ${editing}`);
    }
};
// --- Configuration Paths ---
// Data storage will be within the project's 'AppData' directory
const PROJECT_ROOT = __dirname; // __dirname is the directory of main.js
const APP_DATA_ROOT_IN_PROJECT = path.join(PROJECT_ROOT, 'AppData');

const AGENT_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'Agents');
const USER_DATA_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'UserData'); // For chat histories and attachments
const SETTINGS_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'settings.json');
const USER_AVATAR_FILE = path.join(USER_DATA_DIR, 'user_avatar.png'); // Standardized user avatar file
const MUSIC_PLAYLIST_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'songlist.json');
const MUSIC_COVER_CACHE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'MusicCoverCache');
const NETWORK_NOTES_CACHE_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'network-notes-cache.json'); // Cache for network notes
const WALLPAPER_THUMBNAIL_CACHE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'WallpaperThumbnailCache');
const RESAMPLE_CACHE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'ResampleCache');
const CANVAS_CACHE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'canvas'); // Canvas cache directory

// Define a specific agent ID for notes attachments
const NOTES_AGENT_ID = 'notes_attachments_agent';

let audioEngineProcess = null; // To hold the python audio engine process
let mainWindow;
let tray = null;
let vcpLogWebSocket;
let vcpLogReconnectInterval;
let openChildWindows = [];
let distributedServer = null; // To hold the distributed server instance
let translatorWindow = null; // To hold the single instance of the translator window
let appSettingsManager = null;
let networkNotesTreeCache = null; // In-memory cache for the network notes
let cachedModels = []; // Cache for models fetched from VCP server
const NOTES_MODULE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'Notemodules');
const isRagObserverOnlyMode = process.argv.includes('--rag-observer-only');
const isAutoOpenDesktop = process.argv.includes('--desktop-only');

// --- Audio Engine Management ---
// Now uses the Rust native audio engine instead of Python
function startAudioEngine() {
    return new Promise((resolve, reject) => {
        // --- Uniqueness Check ---
        if (audioEngineProcess && !audioEngineProcess.killed) {
            console.log('[Main] Audio Engine process is already running.');
            resolve(); // Already running, so we can consider it "ready"
            return;
        }

        // Use the Rust audio server binary (moved to audio_engine directory)
        const binaryName = process.platform === 'win32' ? 'audio_server.exe' : 'audio_server';
        const rustBinaryPath = path.join(__dirname, 'audio_engine', binaryName);
        console.log(`[Main] Starting Rust Audio Engine from: ${rustBinaryPath}`);

        // Check if the binary exists
        if (!fs.existsSync(rustBinaryPath)) {
            const errorMsg = `Rust audio engine binary not found at: ${rustBinaryPath}. Please run 'cargo build --release' in rust_audio_engine directory.`;
            console.error(`[Main] ${errorMsg}`);
            reject(new Error(errorMsg));
            return;
        }

        const args = ['--port', '63789'];
        audioEngineProcess = spawn(rustBinaryPath, args);

        const readyTimeout = setTimeout(() => {
            console.error('[Main] Audio Engine failed to start within 10 seconds.');
            reject(new Error('Audio Engine timed out.'));
        }, 10000); // 10-second timeout (Rust starts faster)

        audioEngineProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            console.log(`[AudioEngine STDOUT]: ${output}`);
            // Check for our ready signal from Rust server
            if (output.includes('RUST_AUDIO_ENGINE_READY')) {
                console.log('[Main] Rust Audio Engine is ready.');
                clearTimeout(readyTimeout);
                resolve();
            }
        });

        audioEngineProcess.stderr.on('data', (data) => {
            const logLine = data.toString().trim();
            if (logLine && !logLine.includes('GET /state HTTP/1.1')) {
                console.error(`[AudioEngine STDERR]: ${logLine}`);
            }
        });

        audioEngineProcess.on('close', (code) => {
            console.log(`[Main] Audio Engine process exited with code ${code}`);
            audioEngineProcess = null;
        });

        audioEngineProcess.on('error', (err) => {
            console.error('[Main] Failed to start Audio Engine process.', err);
            clearTimeout(readyTimeout);
            reject(err);
        });
    });
}

function stopAudioEngine() {
    if (audioEngineProcess && !audioEngineProcess.killed) {
        console.log('[Main] Stopping Rust Audio Engine...');
        // Send a termination signal. The 'close' event handler on the process
        // will handle setting audioEngineProcess to null. This prevents a race condition.
        audioEngineProcess.kill();
    }
}


// --- Main Window Creation ---
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1300,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        frame: false, // 移除原生窗口框架
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,    // 恢复: 开启上下文隔离
            nodeIntegration: false,  // 恢复: 关闭Node.js集成在渲染进程
            spellcheck: true, // Enable spellcheck for input fields
        },
        icon: path.join(__dirname, 'assets', 'icon.png'), // Add an icon
        title: 'VCP AI 聊天客户端',
        show: false, // Don't show until ready
    });

    mainWindow.loadFile('main.html');

    // 拦截主窗口内的直接导航（防止在应用内打开外部网页）
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url !== mainWindow.webContents.getURL() && (url.startsWith('http:') || url.startsWith('https:'))) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    // 当主窗口关闭时的处理逻辑：
    // 1. macOS 上始终隐藏而非关闭
    // 2. 当桌面窗口存在时，隐藏到托盘而非退出（偷天换日！）
    // 3. 其他情况正常退出
    mainWindow.on('close', (event) => {
        if (app.isQuitting) {
            // 应用正在退出，允许关闭
            return;
        }

        // macOS 始终隐藏
        if (process.platform === 'darwin') {
            event.preventDefault();
            mainWindow.hide();
            return;
        }

        // Windows/Linux：如果桌面窗口存在，隐藏到托盘
        const dw = desktopHandlers.getDesktopWindow();
        if (dw && !dw.isDestroyed()) {
            event.preventDefault();
            mainWindow.hide();
            console.log('[Main] Desktop window active — main window hidden to tray instead of closing.');
        }
        // 否则允许正常关闭（触发 closed 事件）
    });

    // This will be triggered when the app is quitting, after the window is closed.
    mainWindow.on('closed', () => {
        // When the main window is closed, we should only quit on non-macOS
        // when there are no remaining windows (e.g. RAG Observer may still be open).
        mainWindow = null;
        if (process.platform !== 'darwin' && BrowserWindow.getAllWindows().length === 0) {
            app.quit();
        }
    });

    mainWindow.once('ready-to-show', () => {
        // Signal the native splash screen to close by creating the ready file.
        const readyFile = path.join(__dirname, '.vcp_ready');
        fs.ensureFileSync(readyFile);

        // Clean up the file after a few seconds to prevent it from lingering.
        setTimeout(() => {
            if (fs.existsSync(readyFile)) {
                fs.unlinkSync(readyFile);
            }
        }, 3000); // 3-second delay

        mainWindow.show();
    });

    // mainWindow.setMenu(null); // 移除应用程序菜单栏 - 注释掉以启用macOS的标准菜单

    // Set theme source to 'system' by default. The renderer will send the saved preference on launch.
    nativeTheme.themeSource = 'system';

    // Listen for window events to notify renderer
    mainWindow.on('maximize', () => {
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('window-maximized');
        }
    });
    mainWindow.on('unmaximize', () => {
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('window-unmaximized');
        }
    });

    // Listen for theme changes and notify all relevant windows
}

function createTray() {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');

    // 修复图标体积问题：在 macOS 上，使用 nativeImage 调整图标大小
    const { nativeImage } = require('electron');
    let icon = nativeImage.createFromPath(iconPath);

    // 假设 macOS 菜单栏图标的理想尺寸是 16x16 或 20x20
    if (process.platform === 'darwin') {
        // 尝试使用模板图像，并调整大小以适应菜单栏
        icon = icon.resize({ width: 16, height: 16 });
        icon.setTemplateImage(true); // 告诉 macOS 这是一个模板图像，用于深色/浅色模式切换
    }

    tray = new Tray(icon);

    const toggleMainWindowVisibility = () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isVisible()) {
                mainWindow.hide();
            } else {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
            return true;
        }
        return false;
    };

    const toggleRagObserverVisibility = async () => {
        const ragObserverWindow = ragHandlers.getRagObserverWindow();
        const ragOverlayWindow = ragHandlers.getRagOverlayWindow();
        if (ragObserverWindow && !ragObserverWindow.isDestroyed()) {
            if (ragObserverWindow.isVisible()) {
                ragObserverWindow.hide();
                if (ragOverlayWindow && !ragOverlayWindow.isDestroyed()) {
                    ragOverlayWindow.hide();
                }
            } else {
                if (ragObserverWindow.isMinimized()) ragObserverWindow.restore();
                ragObserverWindow.show();
                ragObserverWindow.focus();
            }
            return true;
        }

        await ragHandlers.openRagObserverWindow();
        return true;
    };

    const handleTrayPrimaryAction = async () => {
        if (toggleMainWindowVisibility()) return;
        await toggleRagObserverVisibility();
    };

    const contextMenu = Menu.buildFromTemplate([
        {
            label: '显示/隐藏主窗口',
            click: () => {
                toggleMainWindowVisibility();
            }
        },
        {
            label: '显示/隐藏信息流监听器',
            click: () => {
                void toggleRagObserverVisibility();
            }
        },
        { type: 'separator' },
        {
            label: '退出',
            click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setToolTip('VCP AI 聊天客户端');
    // 平台特定行为调整：macOS 左键点击只显示/隐藏，右键点击才显示菜单
    if (process.platform === 'darwin') {
        // macOS: 左键点击 (tray.on('click')) 负责显示/隐藏窗口
        tray.on('click', () => {
            void handleTrayPrimaryAction();
        });

        // macOS: 右键点击 (tray.on('right-click')) 负责显示菜单
        tray.on('right-click', () => {
            tray.popUpContextMenu(contextMenu);
        });

        // 注意：在 macOS 上，不调用 tray.setContextMenu()，以确保左键点击不弹出菜单。
    } else {
        // Windows/Linux: 默认行为。
        tray.setContextMenu(contextMenu);
        tray.on('click', () => {
            void handleTrayPrimaryAction();
        });
    }
}


// --- App Lifecycle ---
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', async (event, commandLine, workingDirectory) => {
        const wantsRagOnly = commandLine.includes('--rag-observer-only');
        const wantsDesktop = commandLine.includes('--desktop-only');

        // 如果第二实例请求的是 RAG 独立模式，则直接打开/聚焦 RAG 窗口
        if (wantsRagOnly) {
            await ragHandlers.openRagObserverWindow();
            return;
        }

        // 如果第二实例带 --desktop-only 参数，打开/聚焦桌面窗口
        if (wantsDesktop) {
            await desktopHandlers.openDesktopWindow();
            // 同时确保主窗口也显示出来
            if (mainWindow && !mainWindow.isDestroyed()) {
                if (!mainWindow.isVisible()) mainWindow.show();
                mainWindow.focus();
            }
            return;
        }

        // 默认聚焦主窗口
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
            return;
        }

        const ragObserverWindow = ragHandlers.getRagObserverWindow();
        if (ragObserverWindow && !ragObserverWindow.isDestroyed()) {
            if (ragObserverWindow.isMinimized()) ragObserverWindow.restore();
            if (!ragObserverWindow.isVisible()) ragObserverWindow.show();
            ragObserverWindow.focus();
        }
    });





    app.whenReady().then(async () => { // Make the function async
        // 全局处理所有窗口的新窗口打开请求，确保外部链接在系统浏览器中打开
        app.on('web-contents-created', (event, contents) => {
            contents.setWindowOpenHandler(({ url }) => {
                if (url.startsWith('http:') || url.startsWith('https:')) {
                    shell.openExternal(url);
                    return { action: 'deny' };
                }
                return { action: 'allow' };
            });
        });

        // Handle the emergency close request from the splash screen
        ipcMain.on('close-app', () => {
            console.log('[Main] Received close-app request from splash screen. Quitting.');
            app.quit();
        });

        // The native splash screen is started by the batch file, so no action is needed here.

        // Pre-warm the audio engine in the background. This doesn't block the main window.
        startAudioEngine().catch(err => {
            console.error('[Main] Failed to pre-warm audio engine on startup:', err);
            // We don't need to show a dialog here, as it will be handled when the
            // music window is actually opened.
        });
        // Register a custom protocol to handle loading local app files securely.
        fs.ensureDirSync(APP_DATA_ROOT_IN_PROJECT); // Ensure the main AppData directory in project exists
        fs.ensureDirSync(AGENT_DIR);
        fs.ensureDirSync(USER_DATA_DIR);
        fs.ensureDirSync(MUSIC_COVER_CACHE_DIR);
        fs.ensureDirSync(WALLPAPER_THUMBNAIL_CACHE_DIR); // Ensure the thumbnail cache directory exists
        fs.ensureDirSync(RESAMPLE_CACHE_DIR); // Ensure the resample cache directory exists
        fs.ensureDirSync(CANVAS_CACHE_DIR); // Ensure the canvas cache directory exists
        fileManager.initializeFileManager(USER_DATA_DIR, AGENT_DIR); // Initialize FileManager
        groupChat.initializePaths({ APP_DATA_ROOT_IN_PROJECT, AGENT_DIR, USER_DATA_DIR, SETTINGS_FILE }); // Initialize GroupChat paths

        const AppSettingsManager = require('./modules/utils/appSettingsManager');
        const AgentConfigManager = require('./modules/utils/agentConfigManager');
        appSettingsManager = new AppSettingsManager(SETTINGS_FILE);
        const agentConfigManager = new AgentConfigManager(AGENT_DIR);

        appSettingsManager.startCleanupTimer();
        appSettingsManager.startAutoBackup(USER_DATA_DIR); // Start auto backup
        agentConfigManager.startCleanupTimer(); // Start agent config cleanup

        settingsHandlers.initialize({ SETTINGS_FILE, USER_AVATAR_FILE, AGENT_DIR, settingsManager: appSettingsManager, agentConfigManager }); // Initialize settings handlers
        ragHandlers.initialize({ mainWindow, openChildWindows, settingsManager: appSettingsManager, SETTINGS_FILE });

        // RAG 独立模式：不创建主窗口，仅初始化 RAG 所需 IPC 并直接打开 RAG 窗口
        if (isRagObserverOnlyMode) {
            console.log('[Main] Starting in RAG observer only mode.');
            windowHandlers.initialize(mainWindow, openChildWindows);
            themeHandlers.initialize({ mainWindow, openChildWindows, projectRoot: PROJECT_ROOT, APP_DATA_ROOT_IN_PROJECT, settingsManager: appSettingsManager });
            ipcMain.handle('get-platform', () => process.platform);

            // 关键：独立模式也必须创建系统托盘，否则"最小化到托盘"后无法召回窗口。
            createTray();

            await ragHandlers.openRagObserverWindow();
            return;
        }

        // 注意：原 desktop-only 模式已移除。--desktop-only 参数现在仅作为
        // "启动后自动打开桌面窗口"的标志，所有 IPC 始终完整初始化。

        // Function to fetch and cache models from the VCP server
        async function fetchAndCacheModels() {
            console.log('[Main] fetchAndCacheModels called');
            try {
                const settings = await appSettingsManager.readSettings();
                const vcpServerUrl = settings.vcpServerUrl;
                const vcpApiKey = settings.vcpApiKey; // Get the API key

                if (!vcpServerUrl) {
                    console.warn('[Main] VCP Server URL is not configured. Cannot fetch models.');
                    cachedModels = []; // Clear cache if URL is not set
                    return;
                }
                // Correctly construct the base URL by removing known API paths.
                const urlObject = new URL(vcpServerUrl);
                const baseUrl = `${urlObject.protocol}//${urlObject.host}`;
                const modelsUrl = new URL('/v1/models', baseUrl).toString();

                console.log(`[Main] Fetching models from: ${modelsUrl}`);
                const response = await fetch(modelsUrl, {
                    headers: {
                        'Authorization': `Bearer ${vcpApiKey}` // Add the Authorization header
                    }
                });
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                cachedModels = data.data || []; // Assuming the response has a 'data' field containing the models array
                console.log('[Main] Models fetched and cached successfully:', cachedModels.map(m => m.id));
            } catch (error) {
                console.error('[Main] Failed to fetch and cache models:', error);
                cachedModels = []; // Clear cache on error
            }
        }

        // Create the main window first to give immediate feedback to the user.
        createWindow();
        createTray();
        // --- Application Menu ---
        const isMac = process.platform === 'darwin';
        const menuTemplate = [
            ...(isMac ? [{
                label: app.name,
                submenu: [
                    { role: 'about' },
                    { type: 'separator' },
                    { role: 'services' },
                    { type: 'separator' },
                    { role: 'hide' },
                    { role: 'hideothers' },
                    { role: 'unhide' },
                    { type: 'separator' },
                    {
                        label: '退出 VCPChat',
                        accelerator: 'Command+Q',
                        click: () => {
                            app.isQuitting = true;
                            app.quit();
                        }
                    }
                ]
            }] : []),
            {
                label: '文件',
                submenu: [
                    {
                        label: '新建无锁话题',
                        accelerator: 'CommandOrControl+Shift+N',
                        click: () => {
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send('create-unlocked-topic');
                            }
                        }
                    }
                ]
            },
            {
                label: '编辑',
                submenu: [
                    { role: 'undo' },
                    { role: 'redo' },
                    { type: 'separator' },
                    { role: 'cut' },
                    { role: 'copy' },
                    { role: 'paste' },
                    ...(isMac ? [
                        { role: 'pasteAndMatchStyle' },
                        { role: 'delete' },
                        { role: 'selectAll' },
                        { type: 'separator' },
                        {
                            label: '语音',
                            submenu: [
                                { role: 'startSpeaking' },
                                { role: 'stopSpeaking' }
                            ]
                        }
                    ] : [
                        { role: 'delete' },
                        { type: 'separator' },
                        { role: 'selectAll' }
                    ])
                ]
            },
            {
                label: '视图',
                submenu: [
                    { role: 'reload' },
                    { role: 'forceReload' },
                    { type: 'separator' },
                    { role: 'resetZoom' },
                    { role: 'zoomIn' },
                    { role: 'zoomOut' },
                    { type: 'separator' },
                    { role: 'togglefullscreen' }
                ]
            },
            {
                label: '窗口',
                submenu: [
                    { role: 'minimize' },
                    { role: 'zoom' },
                    ...(isMac ? [
                        { role: 'close' },
                        { type: 'separator' },
                        { role: 'front' },
                        { type: 'separator' },
                        { role: 'window' }
                    ] : [
                        { role: 'close' }
                    ])
                ]
            },
            {
                label: '开发者',
                submenu: [
                    {
                        label: '切换开发者工具',
                        accelerator: 'Ctrl+Shift+I',
                        click: (item, focusedWindow) => {
                            if (focusedWindow) {
                                focusedWindow.webContents.toggleDevTools();
                            }
                        }
                    }
                ]
            }
        ];
        const menu = Menu.buildFromTemplate(menuTemplate);
        Menu.setApplicationMenu(menu);

        // Fetch models in the background and notify the renderer when done.
        console.log('[Main] Fetching models in the background...');
        fetchAndCacheModels().then(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                console.log('[Main] Background model fetch complete. Notifying renderer.');
                mainWindow.webContents.send('models-updated', cachedModels);
            }
        }).catch(error => {
            console.error('[Main] Background model fetch failed:', error);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('models-update-failed', error.message);
            }
        });

        // IPC handler to provide cached models to the renderer process
        ipcMain.handle('get-cached-models', () => {
            return cachedModels;
        });

        // IPC handler to get hot models (top N most used models)
        ipcMain.handle('get-hot-models', async () => {
            try {
                const modelUsageTracker = require('./modules/modelUsageTracker');
                return await modelUsageTracker.getHotModels(10);
            } catch (error) {
                console.error('[Main] Failed to get hot models:', error);
                return [];
            }
        });

        // IPC handler to get favorite models
        ipcMain.handle('get-favorite-models', async () => {
            try {
                const modelUsageTracker = require('./modules/modelUsageTracker');
                return await modelUsageTracker.getFavoriteModels();
            } catch (error) {
                console.error('[Main] Failed to get favorite models:', error);
                return [];
            }
        });

        // IPC handler to toggle a model's favorite status
        ipcMain.handle('toggle-favorite-model', async (event, modelId) => {
            try {
                const modelUsageTracker = require('./modules/modelUsageTracker');
                return await modelUsageTracker.toggleFavoriteModel(modelId);
            } catch (error) {
                console.error('[Main] Failed to toggle favorite model:', error);
                return { favorited: false };
            }
        });

        // IPC handler to trigger a refresh of the model list
        ipcMain.on('refresh-models', async () => {
            console.log('[Main] Received refresh-models request. Re-fetching models...');
            await fetchAndCacheModels();
            // Optionally, notify the renderer that models have been updated
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('models-updated', cachedModels);
            }
        });


        // Add IPC handler for path operations
        ipcMain.handle('path:dirname', (event, p) => {
            return path.dirname(p);
        });
        // Add IPC handler for getting the extension name of a path
        ipcMain.handle('path:extname', (event, p) => {
            return path.extname(p);
        });
        ipcMain.handle('path:basename', (event, p) => {
            return path.basename(p);
        });


        // Group Chat IPC Handlers are now in modules/ipc/groupChatHandlers.js
        notesHandlers.initialize({
            openChildWindows,
            APP_DATA_ROOT_IN_PROJECT,
            SETTINGS_FILE
        });

        // Translator IPC Handlers
        const TRANSLATOR_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'Translatormodules');
        fs.ensureDirSync(TRANSLATOR_DIR); // Ensure the Translator directory exists

        ipcMain.handle('open-translator-window', async (event) => {
            if (translatorWindow && !translatorWindow.isDestroyed()) {
                if (!translatorWindow.isVisible()) {
                    translatorWindow.show();
                }
                translatorWindow.focus();
                return;
            }
            translatorWindow = new BrowserWindow({
                width: 1000,
                height: 700,
                minWidth: 800,
                minHeight: 600,
                title: '翻译',
                frame: false, // 移除原生窗口框架
                ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
                modal: false,
                webPreferences: {
                    preload: path.join(__dirname, 'preload.js'),
                    contextIsolation: true,
                    nodeIntegration: false,
                    devTools: true
                },
                icon: path.join(__dirname, 'assets', 'icon.png'),
                show: false
            });

            let settings = {};
            try {
                if (await fs.pathExists(SETTINGS_FILE)) {
                    settings = await fs.readJson(SETTINGS_FILE);
                }
            } catch (readError) {
                console.error('Failed to read settings file for translator window:', readError);
            }

            const vcpServerUrl = settings.vcpServerUrl || '';
            const vcpApiKey = settings.vcpApiKey || '';

            const translatorUrl = `file://${path.join(__dirname, 'Translatormodules', 'translator.html')}?vcpServerUrl=${encodeURIComponent(vcpServerUrl)}&vcpApiKey=${encodeURIComponent(vcpApiKey)}`;
            console.log(`[Main Process] Attempting to load URL in translator window: ${translatorUrl.substring(0, 200)}...`);

            translatorWindow.webContents.on('did-start-loading', () => {
                console.log(`[Main Process] translatorWindow webContents did-start-loading for URL: ${translatorUrl.substring(0, 200)}`);
            });

            translatorWindow.webContents.on('dom-ready', () => {
                console.log(`[Main Process] translatorWindow webContents dom-ready for URL: ${translatorWindow.webContents.getURL()}`);
            });

            translatorWindow.webContents.on('did-finish-load', () => {
                console.log(`[Main Process] translatorWindow webContents did-finish-load for URL: ${translatorWindow.webContents.getURL()}`);
            });

            translatorWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
                console.error(`[Main Process] translatorWindow webContents did-fail-load: Code ${errorCode}, Desc: ${errorDescription}, URL: ${validatedURL}`);
            });

            translatorWindow.loadURL(translatorUrl)
                .then(() => {
                    console.log(`[Main Process] translatorWindow successfully initiated URL loading (loadURL resolved): ${translatorUrl.substring(0, 200)}`);
                })
                .catch((err) => {
                    console.error(`[Main Process] translatorWindow FAILED to initiate URL loading (loadURL rejected): ${translatorUrl.substring(0, 200)}`, err);
                });

            openChildWindows.push(translatorWindow);
            translatorWindow.setMenu(null);

            translatorWindow.once('ready-to-show', () => {
                console.log(`[Main Process] translatorWindow is ready-to-show. Window Title: "${translatorWindow.getTitle()}". Calling show().`);
                translatorWindow.show();
                console.log('[Main Process] translatorWindow show() called.');
            });

            translatorWindow.on('close', (event) => {
                if (process.platform === 'darwin' && !app.isQuitting) {
                    event.preventDefault();
                    translatorWindow.hide();
                }
            });

            translatorWindow.on('closed', () => {
                console.log('[Main Process] translatorWindow has been closed.');
                openChildWindows = openChildWindows.filter(win => win !== translatorWindow);
                translatorWindow = null;
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.focus(); // 聚焦主窗口
                }
            });
        });

        // open-rag-observer-window handler is registered once above and reuses openRagObserverWindow()

        windowHandlers.initialize(mainWindow, openChildWindows);
        forumHandlers.initialize({ USER_DATA_DIR }); // Initialize forum handlers
        memoHandlers.initialize({ USER_DATA_DIR }); // Initialize memo handlers
        
        // ⚠️ agentHandlers 必须在 assistantHandlers 之前初始化
        // 因为 assistantHandlers 依赖 getAgentConfigById 函数，该函数需要 AGENT_DIR_CACHE 已被初始化
        agentHandlers.initialize({
            AGENT_DIR,
            USER_DATA_DIR,
            SETTINGS_FILE,
            USER_AVATAR_FILE,
            getSelectionListenerStatus: assistantHandlers.getSelectionListenerStatus,
            stopSelectionListener: assistantHandlers.stopSelectionListener,
            startSelectionListener: assistantHandlers.startSelectionListener,
            settingsManager: appSettingsManager,
            agentConfigManager
        });
        
        await assistantHandlers.initialize({ SETTINGS_FILE });
        fileDialogHandlers.initialize(mainWindow, {
            getSelectionListenerStatus: assistantHandlers.getSelectionListenerStatus,
            stopSelectionListener: assistantHandlers.stopSelectionListener,
            startSelectionListener: assistantHandlers.startSelectionListener,
            openChildWindows
        });
        groupChatHandlers.initialize(mainWindow, {
            AGENT_DIR,
            USER_DATA_DIR,
            getSelectionListenerStatus: assistantHandlers.getSelectionListenerStatus,
            stopSelectionListener: assistantHandlers.stopSelectionListener,
            startSelectionListener: assistantHandlers.startSelectionListener,
            fileWatcher // Inject fileWatcher here as well
        });
        regexHandlers.initialize({ AGENT_DIR });
        chatHandlers.initialize(mainWindow, {
            AGENT_DIR,
            USER_DATA_DIR,
            APP_DATA_ROOT_IN_PROJECT,
            NOTES_AGENT_ID,
            getSelectionListenerStatus: assistantHandlers.getSelectionListenerStatus,
            stopSelectionListener: assistantHandlers.stopSelectionListener,
            startSelectionListener: assistantHandlers.startSelectionListener,
            getMusicState: musicHandlers.getMusicState,
            fileWatcher, // 注入文件监控器
            agentConfigManager
        });

        // New dedicated watcher IPC handlers
        ipcMain.handle('watcher:start', (event, filePath, agentId, topicId) => {
            if (fileWatcher) {
                fileWatcher.watchFile(filePath, (changedPath) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        // Pass back the agentId and topicId to the renderer for context
                        mainWindow.webContents.send('history-file-updated', { path: changedPath, agentId, topicId });
                    }
                });
                return { success: true, watching: filePath };
            }
            return { success: false, error: 'File watcher not initialized.' };
        });

        ipcMain.handle('watcher:stop', () => {
            if (fileWatcher) {
                fileWatcher.stopWatching();
                return { success: true };
            }
            return { success: false, error: 'File watcher not initialized.' };
        });
        sovitsHandlers.initialize(mainWindow); // Initialize SovitsTTS handlers
        musicHandlers.initialize({ mainWindow, openChildWindows, APP_DATA_ROOT_IN_PROJECT, startAudioEngine, stopAudioEngine });
        diceHandlers.initialize({ projectRoot: PROJECT_ROOT });
        themeHandlers.initialize({ mainWindow, openChildWindows, projectRoot: PROJECT_ROOT, APP_DATA_ROOT_IN_PROJECT, settingsManager: appSettingsManager });
        emoticonHandlers.initialize({ SETTINGS_FILE, APP_DATA_ROOT_IN_PROJECT });
        emoticonHandlers.setupEmoticonHandlers();
        canvasHandlers.initialize({ mainWindow, openChildWindows, CANVAS_CACHE_DIR });
        desktopHandlers.initialize({ mainWindow, openChildWindows, settingsManager: appSettingsManager });
        desktopRemoteHandlers.initialize({ mainWindow });
        promptHandlers.initialize({ AGENT_DIR, APP_DATA_ROOT_IN_PROJECT });

        ipcMain.on('minimize-to-tray', () => {
            if (mainWindow) {
                mainWindow.hide();
            }
        });

        // --- Distributed Server Initialization ---
        (async () => {
            try {
                const settings = await appSettingsManager.readSettings();
                if (settings.enableDistributedServer) {
                    console.log('[Main] Distributed server is enabled. Initializing...');
                    const DistributedServer = require('./VCPDistributedServer/VCPDistributedServer.js');
                    const config = {
                        mainServerUrl: settings.vcpLogUrl, // Assuming the distributed server connects to the same base URL as VCPLog
                        vcpKey: settings.vcpLogKey,
                        serverName: 'VCP-Desktop-Client-Distributed-Server',
                        debugMode: true, // Or read from settings if you add this option
                        rendererProcess: mainWindow.webContents, // Pass the renderer process object
                        handleMusicControl: musicHandlers.handleMusicControl, // Inject the music control handler
                        handleDiceControl: diceHandlers.handleDiceControl, // Inject the dice control handler
                        handleCanvasControl: desktopRemoteHandlers.handleCanvasControl, // Inject the canvas control handler
                        handleFlowlockControl: desktopRemoteHandlers.handleFlowlockControl, // Inject the flowlock control handler
                        handleDesktopRemoteControl: desktopRemoteHandlers.handleDesktopRemoteControl // Inject the desktop remote control handler
                    };
                    distributedServer = new DistributedServer(config);
                    distributedServer.initialize();
                } else {
                    console.log('[Main] Distributed server is disabled in settings.');
                }
            } catch (error) {
                console.error('[Main] Failed to read settings or initialize distributed server:', error);
            }
        })();
        // --- End of Distributed Server Initialization ---

        app.on('activate', () => {
            // On macOS, re-show the main window when the dock icon is clicked.
            if (mainWindow && !mainWindow.isDestroyed()) {
                if (!mainWindow.isVisible()) {
                    mainWindow.show();
                }
                mainWindow.focus();
            }
            // If the main window has been closed (mainWindow is null), create a new one.
            else if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });

        globalShortcut.register('Control+Shift+I', () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (focusedWindow && focusedWindow.webContents && !focusedWindow.webContents.isDestroyed()) {
                focusedWindow.webContents.toggleDevTools();
            }
        });

        // 移除全局 Command+Q 快捷键，改用标准的应用程序菜单

        // 全局快捷键 'CommandOrControl+Shift+N' 已通过菜单栏实现

        // --- Music Player IPC Handlers are now in modules/ipc/musicHandlers.js ---


        // --- Assistant IPC Handlers are now in modules/ipc/assistantHandlers.js ---

        // --- Theme IPC Handlers are now in modules/ipc/themeHandlers.js ---

        // --- Platform Info IPC Handler ---
        ipcMain.handle('get-platform', () => {
            return process.platform;
        });

        // --- 自动打开桌面窗口 ---
        // 当使用 --desktop-only 参数启动时，在所有 IPC 初始化完成后自动打开桌面窗口
        if (isAutoOpenDesktop) {
            console.log('[Main] --desktop-only flag detected. Auto-opening desktop window after full initialization.');
            // 延迟打开，确保主窗口已完全就绪
            setTimeout(async () => {
                await desktopHandlers.openDesktopWindow();
                console.log('[Main] Desktop window auto-opened.');
            }, 1000);
        }
    });

    // --- Python Execution IPC Handler ---
    ipcMain.handle('execute-python-code', (event, code) => {
        return new Promise((resolve) => {
            // Use '-u' for unbuffered output and set PYTHONIOENCODING for proper UTF-8 handling
            const pythonProcess = spawn('python', ['-u'], {
                env: { ...process.env, PYTHONIOENCODING: 'UTF-8' },
                maxBuffer: 10 * 1024 * 1024 // Increase buffer to 10MB
            });

            let stdout = '';
            let stderr = '';

            pythonProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            pythonProcess.on('close', (exitCode) => {
                console.log(`Python process exited with code ${exitCode}`);
                console.log('Python stdout:', stdout); // Log full stdout
                console.log('Python stderr:', stderr); // Log full stderr
                resolve({ stdout, stderr });
            });

            pythonProcess.on('error', (err) => {
                console.error('Failed to start Python process:', err);
                // Resolve with an error message in stderr, so the frontend can display it
                resolve({ stdout: '', stderr: `Failed to start python process. Please ensure Python is installed and accessible in your system's PATH. Error: ${err.message}` });
            });

            // Write the code to the process's standard input and close it
            pythonProcess.stdin.write(code);
            pythonProcess.stdin.end();
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('will-quit', () => {
        // 0. Clean up the ready signal file for the native splash screen
        const readyFile = path.join(__dirname, '.vcp_ready');
        if (fs.existsSync(readyFile)) {
            fs.unlinkSync(readyFile);
        }

        // 1. 停止所有底层监听器
        console.log('[Main] App is quitting. Stopping all listeners...');
        assistantHandlers.stopSelectionListener();
        assistantHandlers.stopMouseListener();

        // 2. 注销所有全局快捷键
        globalShortcut.unregisterAll();
        console.log('[Main] All global shortcuts unregistered.');

        // 3. Stop the speech recognizer
        const speechRecognizer = require('./modules/speechRecognizer');
        speechRecognizer.shutdown(); // Use the new shutdown function to close the browser

        // 4. 关闭WebSocket连接
        if (vcpLogWebSocket) {
            vcpLogWebSocket.close();
        }
        if (vcpLogReconnectInterval) {
            clearTimeout(vcpLogReconnectInterval);
        }

        // 5. Stop the distributed server
        if (distributedServer) {
            console.log('[Main] Stopping distributed server...');
            distributedServer.stop();
            distributedServer = null;
        }

        // 6. Stop the dice server
        diceHandlers.stopDiceServer();

        // 7. Stop the Python Audio Engine
        stopAudioEngine();

        // 8. 强制销毁所有窗口
        console.log('[Main] Destroying all open windows...');
        BrowserWindow.getAllWindows().forEach(win => {
            if (win && !win.isDestroyed()) {
                win.destroy();
            }
        });
    });

    // --- Helper Functions ---

    function formatTimestampForFilename(timestamp) {
        const date = new Date(timestamp);
        const year = date.getFullYear();
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const day = date.getDate().toString().padStart(2, '0');
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const seconds = date.getSeconds().toString().padStart(2, '0');
        return `${year}${month}${day}_${hours}${minutes}${seconds}`;
    }

    // --- IPC Handlers ---
    // open-external-link handler is now in modules/ipc/fileDialogHandlers.js

    // The getAgentConfigById helper function has been moved to agentHandlers.js

    // VCP Server Communication is now handled in modules/ipc/chatHandlers.js

    // VCPLog WebSocket Connection
    function connectVcpLog(wsUrl, wsKey) {
        const WebSocket = require('ws'); // Lazy load
        if (!wsUrl || !wsKey) {
            if (mainWindow) mainWindow.webContents.send('vcp-log-status', { source: 'VCPLog', status: 'error', message: 'URL或KEY未配置。' });
            return;
        }

        const fullWsUrl = `${wsUrl}/VCPlog/VCP_Key=${wsKey}`;

        if (vcpLogWebSocket && (vcpLogWebSocket.readyState === WebSocket.OPEN || vcpLogWebSocket.readyState === WebSocket.CONNECTING)) {
            console.log('VCPLog WebSocket 已连接或正在连接。');
            return;
        }

        console.log(`尝试连接 VCPLog WebSocket: ${fullWsUrl}`);
        if (mainWindow) mainWindow.webContents.send('vcp-log-status', { source: 'VCPLog', status: 'connecting', message: '连接中...' });

        vcpLogWebSocket = new WebSocket(fullWsUrl);

        vcpLogWebSocket.onopen = () => {
            console.log('[MAIN_VCP_LOG] WebSocket onopen event triggered.');
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                console.log('[MAIN_VCP_LOG] Attempting to send vcp-log-status "open" to renderer.');
                mainWindow.webContents.send('vcp-log-status', { source: 'VCPLog', status: 'open', message: '已连接' });
                console.log('[MAIN_VCP_LOG] vcp-log-status "open" sent.');
                mainWindow.webContents.send('vcp-log-message', { type: 'connection_ack', message: 'VCPLog 连接成功！' });
            } else {
                console.error('[MAIN_VCP_LOG] mainWindow or webContents not available in onopen. Cannot send status.');
            }
            if (vcpLogReconnectInterval) {
                clearTimeout(vcpLogReconnectInterval); // Corrected: Use clearTimeout for setTimeout
                vcpLogReconnectInterval = null;
            }
        };

        vcpLogWebSocket.onmessage = (event) => {
            console.log('VCPLog 收到消息:', event.data);
            try {
                const data = JSON.parse(event.data.toString());
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vcp-log-message', data);
            } catch (e) {
                console.error('VCPLog 解析消息失败:', e);
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vcp-log-message', { type: 'error', data: `收到无法解析的消息: ${event.data.toString().substring(0, 100)}...` });
            }
        };

        vcpLogWebSocket.onclose = (event) => {
            console.log('VCPLog WebSocket 连接已关闭:', event.code, event.reason);
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vcp-log-status', { source: 'VCPLog', status: 'closed', message: `连接已断开 (${event.code})` });
            if (!vcpLogReconnectInterval && wsUrl && wsKey) {
                console.log('将在5秒后尝试重连 VCPLog...');
                vcpLogReconnectInterval = setTimeout(() => {
                    vcpLogReconnectInterval = null;
                    connectVcpLog(wsUrl, wsKey);
                }, 5000);
            }
        };

        vcpLogWebSocket.onerror = (error) => {
            console.error('[MAIN_VCP_LOG] WebSocket onerror event:', error.message);
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('vcp-log-status', { source: 'VCPLog', status: 'error', message: '连接错误' });
            } else {
                console.error('[MAIN_VCP_LOG] mainWindow or webContents not available in onerror.');
            }
        };
    }

    ipcMain.on('connect-vcplog', (event, { url, key }) => {
        if (vcpLogWebSocket) {
            vcpLogWebSocket.close();
        }
        if (vcpLogReconnectInterval) {
            clearTimeout(vcpLogReconnectInterval);
            vcpLogReconnectInterval = null;
        }
        connectVcpLog(url, key);
    });

    ipcMain.on('disconnect-vcplog', () => {
        if (vcpLogWebSocket) {
            vcpLogWebSocket.close();
        }
        if (vcpLogReconnectInterval) {
            clearTimeout(vcpLogReconnectInterval);
            vcpLogReconnectInterval = null;
        }
        if (mainWindow) mainWindow.webContents.send('vcp-log-status', { source: 'VCPLog', status: 'closed', message: '已手动断开' });
        console.log('VCPLog 已手动断开');
    });

    ipcMain.on('send-vcplog-message', (event, data) => {
        if (vcpLogWebSocket && vcpLogWebSocket.readyState === 1) { // 1 is WebSocket.OPEN
            console.log('VCPLog 发送消息:', data);
            vcpLogWebSocket.send(JSON.stringify(data));
        } else {
            console.warn('VCPLog WebSocket 未连接或未就绪，无法发送消息:', data);
        }
    });

}
// --- Voice Chat IPC Handler ---
ipcMain.on('open-voice-chat-window', (event, { agentId }) => {
    const voiceChatWindow = new BrowserWindow({
        width: 500,
        height: 700,
        minWidth: 400,
        minHeight: 500,
        frame: false,
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        title: '语音聊天',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        parent: mainWindow,
        modal: false, // Set to false to allow interaction with main window
        show: false,
    });

    voiceChatWindow.loadFile(path.join(__dirname, 'Voicechatmodules/voicechat.html'));

    voiceChatWindow.once('ready-to-show', () => {
        const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
        voiceChatWindow.show();
        voiceChatWindow.webContents.send('voice-chat-data', { agentId, theme });
    });

    openChildWindows.push(voiceChatWindow);

    voiceChatWindow.on('closed', () => {
        openChildWindows = openChildWindows.filter(win => win !== voiceChatWindow);
        // Ensure speech recognition is stopped when the window is closed
        const speechRecognizer = require('./modules/speechRecognizer');
        speechRecognizer.stop();
    });
});

// --- Speech Recognition IPC Handlers ---
ipcMain.on('start-speech-recognition', (event) => {
    const voiceChatWindow = openChildWindows.find(win => win.webContents === event.sender);
    if (!voiceChatWindow) return;

    const speechRecognizer = require('./modules/speechRecognizer');
    speechRecognizer.start((text) => {
        if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
            voiceChatWindow.webContents.send('speech-recognition-result', text);
        }
    });
});

ipcMain.on('stop-speech-recognition', () => {
    const speechRecognizer = require('./modules/speechRecognizer');
    speechRecognizer.stop();
});

ipcMain.handle('export-topic-as-markdown', async (event, exportData) => {
    const { topicName, markdownContent } = exportData;

    if (!topicName || !markdownContent) {
        return { success: false, error: '缺少导出所需的必要信息（话题名称或内容）。' };
    }

    // 1. Show Save Dialog
    const safeTopicName = topicName.replace(/[/\\?%*:|"<>]/g, '-');
    const defaultFileName = `${safeTopicName}-${formatTimestampForFilename(Date.now())}.md`;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: '导出话题为 Markdown',
        defaultPath: defaultFileName,
        filters: [
            { name: 'Markdown 文件', extensions: ['md'] },
            { name: '所有文件', extensions: ['*'] }
        ]
    });

    if (canceled || !filePath) {
        return { success: false, error: '用户取消了导出操作。' };
    }

    // 2. Write to File
    try {
        await fs.writeFile(filePath, markdownContent, 'utf8');
        shell.showItemInFolder(filePath); // Open the folder containing the file
        return { success: true, path: filePath };
    } catch (e) {
        console.error(`[Export] 写入Markdown文件失败:`, e);
        return { success: false, error: `写入文件失败: ${e.message}` };
    }
});

// --- Group Chat Interrupt Handler ---
ipcMain.handle('interrupt-group-request', (event, messageId) => {
    console.log(`[Main] Received interrupt-group-request for messageId: ${messageId}`);
    if (groupChat && typeof groupChat.interruptGroupRequest === 'function') {
        return groupChat.interruptGroupRequest(messageId);
    } else {
        console.error('[Main] groupChat module or interruptGroupRequest function is not available.');
        return { success: false, error: 'Group chat module not initialized correctly.' };
    }
});

// --- Desktop Remote Control, Canvas Control, and Flowlock Control handlers ---
// These have been modularized into modules/ipc/desktopRemoteHandlers.js
// They are injected into the DistributedServer via desktopRemoteHandlers.handleDesktopRemoteControl, etc.
