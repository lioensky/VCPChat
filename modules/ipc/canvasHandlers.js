const { ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const windowService = require('../services/windowService');
const WINDOW_APP_IDS = require('../services/windowAppIds');
const { PRELOAD_ROLES, resolveProjectPreload } = require('../services/preloadPaths');

let mainWindow;
let openChildWindows;
let CANVAS_CACHE_DIR = path.join(__dirname, '..', '..', 'AppData', 'Canvas');
let canvasWindow = null;
let initialFilePath = null;
let activeRootDir = CANVAS_CACHE_DIR;
let activeCanvasContext = 'canvas';
let activeCanvasMetadata = {};
let ipcHandlersRegistered = false;
const pendingCanvasEditRequests = new Map();
const CANVAS_EDIT_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const SUPPORTED_EXTENSIONS = [
    '.txt', '.js', '.py', '.css', '.html', '.json', '.md', '.rs', '.ts',
    '.cpp', '.h', '.cs', '.java', '.go', '.rb', '.php', '.swift', '.kt',
    '.sh', '.yml', '.yaml', '.toml', '.xml'
];
 
function normalizeCanvasOpenRequest(eventOrFilePath, maybeFilePath) {
    if (eventOrFilePath && typeof eventOrFilePath === 'object' && 'sender' in eventOrFilePath) {
        return normalizeCanvasOpenRequest(maybeFilePath);
    }

    if (eventOrFilePath && typeof eventOrFilePath === 'object') {
        const rootDir = eventOrFilePath.rootDir || (
            eventOrFilePath.filePath ? path.dirname(eventOrFilePath.filePath) : CANVAS_CACHE_DIR
        );
        return {
            filePath: eventOrFilePath.filePath || null,
            rootDir,
            context: eventOrFilePath.context || 'canvas',
            metadata: eventOrFilePath.metadata || {},
        };
    }

    return {
        filePath: eventOrFilePath || null,
        rootDir: CANVAS_CACHE_DIR,
        context: 'canvas',
        metadata: {},
    };
}

function setCanvasSession(request) {
    activeRootDir = request.rootDir || CANVAS_CACHE_DIR;
    activeCanvasContext = request.context || 'canvas';
    activeCanvasMetadata = request.metadata || {};
    if (request.filePath) {
        initialFilePath = request.filePath;
        activeCanvasPath = request.filePath;
    }
}

function getSessionPayload() {
    return {
        context: activeCanvasContext,
        rootDir: activeRootDir,
        metadata: activeCanvasMetadata,
    };
}

function notifyDesktopWidgetSourceSaved(filePath) {
    if (activeCanvasContext !== 'desktop-widget') return;

    const payload = {
        ...activeCanvasMetadata,
        filePath,
        rootDir: activeRootDir,
        context: activeCanvasContext,
    };

    const desktopHandlers = require('./desktopHandlers');
    const desktopWindow = desktopHandlers.getDesktopWindow?.();
    if (desktopWindow && !desktopWindow.isDestroyed()) {
        desktopWindow.webContents.send('desktop-widget-source-saved', payload);
    }
}

function applyTargetReplacement(content, target, replacement) {
    const index = content.indexOf(target);
    if (index < 0) {
        const error = new Error('当前 Canvas 文档中找不到指定 target，提案未提交。');
        error.code = 'CANVAS_TARGET_NOT_FOUND';
        throw error;
    }
    return content.slice(0, index) + replacement + content.slice(index + target.length);
}

function settleCanvasEditRequest(requestId, result) {
    const pending = pendingCanvasEditRequests.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingCanvasEditRequests.delete(requestId);
    pending.resolve(result);
    return true;
}

function rejectAllPendingCanvasEdits(message, code = 'CANVAS_WINDOW_CLOSED') {
    for (const [requestId, pending] of pendingCanvasEditRequests) {
        clearTimeout(pending.timer);
        pending.resolve({
            success: false,
            approved: false,
            code,
            message,
            requestId,
            path: pending.filePath,
        });
    }
    pendingCanvasEditRequests.clear();
}

async function handleCanvasEditDecision(event, decision = {}) {
    const requestId = String(decision.requestId || '');
    const pending = pendingCanvasEditRequests.get(requestId);
    if (!pending || event.sender.id !== pending.webContentsId) return;

    if (decision.approved !== true) {
        const reason = String(decision.reason || '').trim();
        settleCanvasEditRequest(requestId, {
            success: false,
            approved: false,
            code: 'CANVAS_EDIT_REJECTED',
            message: reason || '用户拒绝了 Canvas 编辑提案。',
            reason,
            requestId,
            path: pending.filePath,
        });
        return;
    }

    try {
        if (activeCanvasPath !== pending.filePath) {
            const error = new Error('Canvas 活跃文档已切换，提案未应用。');
            error.code = 'CANVAS_CONTEXT_CHANGED';
            throw error;
        }

        const currentContent = await fs.readFile(pending.filePath, pending.encoding);
        if (currentContent !== pending.originalContent) {
            const error = new Error('Canvas 文档在审阅期间已发生变化，提案未应用。');
            error.code = 'CANVAS_CONTENT_CONFLICT';
            throw error;
        }

        const temporaryPath = `${pending.filePath}.canvas-edit-${process.pid}-${Date.now()}`;
        try {
            await fs.writeFile(temporaryPath, pending.modifiedContent, pending.encoding);
            await fs.move(temporaryPath, pending.filePath, { overwrite: true });
        } finally {
            await fs.remove(temporaryPath).catch(() => {});
        }

        notifyDesktopWidgetSourceSaved(pending.filePath);
        canvasWindow.webContents.send('canvas-file-changed', {
            path: pending.filePath,
            content: pending.modifiedContent,
        });
        const reason = String(decision.reason || '').trim();
        settleCanvasEditRequest(requestId, {
            success: true,
            approved: true,
            code: 'CANVAS_EDIT_APPROVED',
            message: reason
                ? `用户已允许并应用 Canvas 编辑提案。审阅备注：${reason}`
                : '用户已允许并应用 Canvas 编辑提案。',
            reason,
            requestId,
            path: pending.filePath,
        });
    } catch (error) {
        settleCanvasEditRequest(requestId, {
            success: false,
            approved: true,
            code: error.code || 'CANVAS_EDIT_APPLY_FAILED',
            message: error.message,
            requestId,
            path: pending.filePath,
        });
    }
}

function initialize(config) {
    mainWindow = config.mainWindow;
    openChildWindows = config.openChildWindows;
    if (config.CANVAS_CACHE_DIR) {
        const previousDefault = CANVAS_CACHE_DIR;
        CANVAS_CACHE_DIR = path.resolve(config.CANVAS_CACHE_DIR);
        if (activeRootDir === previousDefault) activeRootDir = CANVAS_CACHE_DIR;
    }
    
    // Ensure the canvas directory exists
    fs.ensureDirSync(CANVAS_CACHE_DIR);

    if (ipcHandlersRegistered) {
        return;
    }

    ipcMain.handle('open-canvas-window', createCanvasWindow);
    ipcMain.on('canvas-ready', handleCanvasReady);
    ipcMain.on('create-new-canvas', handleCreateNewCanvas);
    ipcMain.on('load-canvas-file', handleLoadCanvasFile);
    ipcMain.on('save-canvas-file', handleSaveCanvasFile);
    ipcMain.on('canvas-edit-decision', handleCanvasEditDecision);
    ipcMain.handle('rename-canvas-file', handleRenameCanvasFile);
    ipcMain.on('copy-canvas-file', handleCopyCanvasFile);
    ipcMain.on('delete-canvas-file', handleDeleteCanvasFile);
    ipcMain.handle('get-latest-canvas-content', handleGetLatestCanvasContent);
    // This is a new listener for direct control from the main process
    ipcMain.on('load-canvas-file-by-path', (event, filePath) => {
        if (canvasWindow && !canvasWindow.isDestroyed()) {
            handleLoadCanvasFile({ sender: canvasWindow.webContents }, filePath);
        }
    });

    ipcHandlersRegistered = true;
}

async function createCanvasWindow(eventOrFilePath = null, maybeFilePath = null) {
    const request = normalizeCanvasOpenRequest(eventOrFilePath, maybeFilePath);
    const filePath = request.filePath;
    setCanvasSession(request);
    console.log('[CanvasHandlers] Received request to open canvas window.');
    if (canvasWindow && !canvasWindow.isDestroyed()) {
        if (!canvasWindow.isVisible()) {
            canvasWindow.show();
        }
        canvasWindow.focus();
        if (filePath) {
            handleLoadCanvasFile({ sender: canvasWindow.webContents }, filePath);
        }
        return;
    }

    canvasWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        title: '协同 Canvas',
        frame: false,
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        webPreferences: {
            preload: resolveProjectPreload(path.join(__dirname, '..', '..'), PRELOAD_ROLES.UTILITY),
            contextIsolation: true,
            nodeIntegration: false,
        },
        modal: false,
        show: false,
    });

    await canvasWindow.loadFile(path.join(__dirname, '..', '..', 'Canvasmodules', 'canvas.html'));
    windowService.attachWindow(WINDOW_APP_IDS.CANVAS, canvasWindow);

    openChildWindows.push(canvasWindow);

    canvasWindow.once('ready-to-show', () => {
        canvasWindow.show();
    });

    canvasWindow.on('close', (event) => {
        if (process.platform === 'darwin' && !require('electron').app.isQuitting) {
            event.preventDefault();
            canvasWindow.hide();
        }
    });

    canvasWindow.on('closed', () => {
        openChildWindows = openChildWindows.filter(win => win !== canvasWindow);
        rejectAllPendingCanvasEdits('Canvas 窗口已关闭，编辑提案未应用。');
        canvasWindow = null;
        initialFilePath = null;
        activeCanvasPath = null;
        activeRootDir = CANVAS_CACHE_DIR;
        activeCanvasContext = 'canvas';
        activeCanvasMetadata = {};
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.webContents.send('canvas-window-closed');
            } catch (e) {
                console.log('Could not send canvas-window-closed message, main window likely already destroyed.');
            }
        }
    });

    canvasWindow.on('focus', async () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                const history = await getCanvasHistory();
                let current = null;
                const activeHistory = history.find(h => h.isActive);
                if (activeHistory) {
                    current = await getCanvasFileContent(activeHistory.path);
                } else if (history.length > 0) {
                    current = await getCanvasFileContent(history[0].path);
                }
                
                if (current) {
                    mainWindow.webContents.send('canvas-content-update', {
                        content: current.content,
                        path: current.path,
                        errors: '' // Placeholder for error info
                    });
                }
            } catch (error) {
                console.error('Failed to get canvas content on focus:', error);
            }
        }
    });
}

async function handleCanvasReady(event) {
    const sender = event.sender;
    try {
        const history = await getCanvasHistory();
        let current = null;
        if (initialFilePath && (await fs.pathExists(initialFilePath))) {
            current = await getCanvasFileContent(initialFilePath);
            history.forEach(h => h.isActive = (h.path === initialFilePath));
            activeCanvasPath = initialFilePath;
            initialFilePath = null; // Consume it
        } else if (history.length > 0) {
            // Default behavior: load the first file
            current = await getCanvasFileContent(history[0].path);
            history[0].isActive = true;
            activeCanvasPath = history[0].path;
        }
        sender.send('canvas-load-data', { history, current, session: getSessionPayload() });
    } catch (error) {
        console.error('Failed to load canvas data:', error);
    }
}

async function handleCreateNewCanvas(event) {
    const sender = event.sender;
    try {
        const newFileName = activeCanvasContext === 'desktop-widget'
            ? `widget_${Date.now()}.js`
            : `canvas_${Date.now()}.txt`;
        const newFilePath = path.join(activeRootDir, newFileName);
        await fs.writeFile(newFilePath, activeCanvasContext === 'desktop-widget' ? '// New Widget Source File' : '// New Canvas');
        
        const history = await getCanvasHistory();
        const current = await getCanvasFileContent(newFilePath);
        history.forEach(h => h.isActive = (h.path === newFilePath));
        activeCanvasPath = newFilePath; // Set the active path

        sender.send('canvas-load-data', { history, current, session: getSessionPayload() });
    } catch (error) {
        console.error('Failed to create new canvas file:', error);
    }
}

async function handleLoadCanvasFile(event, filePath) {
    const sender = event.sender;
    try {
        const history = await getCanvasHistory();
        const current = await getCanvasFileContent(filePath);
        history.forEach(h => h.isActive = (h.path === filePath));
        activeCanvasPath = filePath; // Set the active path

        sender.send('canvas-load-data', { history, current, session: getSessionPayload() });
    } catch (error) {
        console.error(`Failed to load canvas file ${filePath}:`, error);
    }
}

async function handleSaveCanvasFile(event, file) {
    try {
        await fs.writeFile(file.path, file.content);
        console.log(`Canvas save successful for: ${file.path}`);
        notifyDesktopWidgetSourceSaved(file.path);
    } catch (error) {
        console.error(`Failed to save canvas file ${file.path}:`, error);
    }
}

async function handleRenameCanvasFile(event, { oldPath, newTitle }) {
    try {
        const dir = path.dirname(oldPath);
        // Use the new title directly as the new file name
        const newFileName = newTitle;
        const newPath = path.join(dir, newFileName);

        if (await fs.pathExists(newPath)) {
            throw new Error(`File with name ${newFileName} already exists.`);
        }

        await fs.rename(oldPath, newPath);
        
        // After renaming, we need to inform the renderer to refresh its history
        if (canvasWindow && !canvasWindow.isDestroyed()) {
            const history = await getCanvasHistory();
            const current = await getCanvasFileContent(newPath);
            history.forEach(h => h.isActive = (h.path === newPath));
            canvasWindow.webContents.send('canvas-load-data', { history, current, session: getSessionPayload() });
        }

        return newPath; // Return the new path on success
    } catch (error) {
        console.error('Failed to rename canvas file:', error);
        throw error; // Re-throw the error to be caught by the renderer
    }
}

async function handleCopyCanvasFile(event, filePath) {
   try {
       const dir = path.dirname(filePath);
       const ext = path.extname(filePath);
       const baseName = path.basename(filePath, ext);
       const newFileName = `${baseName}_copy_${Date.now()}${ext}`;
       const newPath = path.join(dir, newFileName);
       
       await fs.copy(filePath, newPath);
       
       // Inform the renderer to refresh its history
       if (canvasWindow && !canvasWindow.isDestroyed()) {
           const history = await getCanvasHistory();
           // Find the currently active file to keep it active
           const activeItem = history.find(h => h.isActive);
           const current = activeItem ? await getCanvasFileContent(activeItem.path) : null;
           canvasWindow.webContents.send('canvas-load-data', { history, current, session: getSessionPayload() });
       }
   } catch (error) {
       console.error('Failed to copy canvas file:', error);
   }
}

async function handleDeleteCanvasFile(event, filePath) {
   try {
       await fs.remove(filePath);
       
       // Inform the renderer to refresh its history and load a new file if the deleted one was active
       if (canvasWindow && !canvasWindow.isDestroyed()) {
           const history = await getCanvasHistory();
           let current = null;
           if (history.length > 0) {
               // Load the first file in the list as the new current file
               current = await getCanvasFileContent(history[0].path);
               history[0].isActive = true;
               activeCanvasPath = current ? current.path : null; // Set active path
           } else {
               activeCanvasPath = null; // No files left
           }
           canvasWindow.webContents.send('canvas-load-data', { history, current, session: getSessionPayload() });
       }
   } catch (error) {
       console.error('Failed to delete canvas file:', error);
   }
}

async function getCanvasHistory() {
    await fs.ensureDir(activeRootDir);
    const files = await fs.readdir(activeRootDir);
    const historyPromises = files
        .filter(file => SUPPORTED_EXTENSIONS.includes(path.extname(file).toLowerCase()))
        .map(async (file) => {
            const filePath = path.join(activeRootDir, file);
            const stats = await fs.stat(filePath);
            return {
                path: filePath,
                title: file,
                isActive: false,
                mtime: stats.mtimeMs,
            };
        });
    
    const history = await Promise.all(historyPromises);
    // Sort by modification time, newest first
    history.sort((a, b) => b.mtime - a.mtime);
    return history;
}

async function getCanvasFileContent(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    return { path: filePath, content };
}

let activeCanvasPath = null; // Keep track of the currently active canvas file

async function requestCanvasEdit(payload = {}) {
    const target = payload.target;
    const replacement = payload.replace;
    const encoding = payload.encoding || 'utf8';

    if (typeof target !== 'string' || target.length === 0) {
        throw new Error('Canvas 编辑提案必须提供非空 target。');
    }
    if (typeof replacement !== 'string') {
        throw new Error('Canvas 编辑提案必须提供 replace 字符串。');
    }
    if (pendingCanvasEditRequests.size > 0) {
        const error = new Error('已有 Canvas 编辑提案正在等待用户审阅。');
        error.code = 'CANVAS_EDIT_ALREADY_PENDING';
        throw error;
    }

    await createCanvasWindow();
    if (!canvasWindow || canvasWindow.isDestroyed()) {
        throw new Error('Canvas 窗口无法打开。');
    }
    if (!activeCanvasPath) {
        const history = await getCanvasHistory();
        if (!history.length) {
            throw new Error('Canvas 中没有可编辑的活跃文档。');
        }
        activeCanvasPath = history[0].path;
        await handleLoadCanvasFile({ sender: canvasWindow.webContents }, activeCanvasPath);
    }

    const originalContent = await fs.readFile(activeCanvasPath, encoding);
    const modifiedContent = applyTargetReplacement(originalContent, target, replacement);
    const requestId = crypto.randomUUID();
    const filePath = activeCanvasPath;

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            settleCanvasEditRequest(requestId, {
                success: false,
                approved: false,
                code: 'CANVAS_EDIT_REVIEW_TIMEOUT',
                message: '等待用户审阅 Canvas 编辑提案超时，文件未发生变化。',
                requestId,
                path: filePath,
            });
        }, CANVAS_EDIT_REVIEW_TIMEOUT_MS);

        pendingCanvasEditRequests.set(requestId, {
            resolve,
            timer,
            webContentsId: canvasWindow.webContents.id,
            filePath,
            encoding,
            originalContent,
            modifiedContent,
        });

        canvasWindow.webContents.send('canvas-edit-proposal', {
            requestId,
            path: filePath,
            originalContent,
            modifiedContent,
            target,
            replace: replacement,
        });
        if (canvasWindow.isMinimized()) canvasWindow.restore();
        if (!canvasWindow.isVisible()) canvasWindow.show();
        canvasWindow.focus();
    });
}

async function handleGetLatestCanvasContent() {
    if (!canvasWindow || canvasWindow.isDestroyed()) {
        return { error: 'Canvas window is not open.' };
    }
    if (!activeCanvasPath) {
        // If no path is active, try to get the first one from history
        const history = await getCanvasHistory();
        if (history.length > 0) {
            activeCanvasPath = history[0].path;
        } else {
            return { error: 'No active canvas or history available.' };
        }
    }
    try {
        const content = await getCanvasFileContent(activeCanvasPath);
        return { ...content, errors: '' }; // Added errors placeholder
    } catch (error) {
        console.error('Failed to get latest canvas content:', error);
        return { error: error.message };
    }
}

function getCanvasWindow() {
    return canvasWindow;
}

module.exports = {
    initialize,
    createCanvasWindow, // Export for direct calling
    getCanvasWindow,    // Export for direct access
    requestCanvasEdit,
    handleGetLatestCanvasContent,
};
