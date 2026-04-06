const { ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const chokidar = require('chokidar');
const windowService = require('../services/windowService');
const WINDOW_APP_IDS = require('../services/windowAppIds');
const { PRELOAD_ROLES, resolveProjectPreload } = require('../services/preloadPaths');

let mainWindow;
let openChildWindows;
const CANVAS_CACHE_DIR = path.join(__dirname, '..', '..', 'AppData', 'Canvas');
let canvasWindow = null;
let fileWatcher = null;
const internalSaveInProgress = new Set(); // Track internal saves
let initialFilePath = null;
let ipcHandlersRegistered = false;
const SUPPORTED_EXTENSIONS = [
    '.txt', '.js', '.py', '.css', '.html', '.json', '.md', '.rs', '.ts',
    '.cpp', '.h', '.cs', '.java', '.go', '.rb', '.php', '.swift', '.kt',
    '.sh', '.yml', '.yaml', '.toml', '.xml'
];
 
function initialize(config) {
    mainWindow = config.mainWindow;
    openChildWindows = config.openChildWindows;
    
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
    const filePath = eventOrFilePath && typeof eventOrFilePath === 'object' && 'sender' in eventOrFilePath
        ? maybeFilePath
        : eventOrFilePath;
    console.log('[CanvasHandlers] Received request to open canvas window.');
    if (canvasWindow && !canvasWindow.isDestroyed()) {
        if (!canvasWindow.isVisible()) {
            canvasWindow.show();
        }
        canvasWindow.focus();
        if (filePath) {
            canvasWindow.webContents.send('load-canvas-file-by-path', filePath);
        }
        return;
    }

    if (filePath) {
        initialFilePath = filePath;
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
        canvasWindow = null;
        initialFilePath = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.webContents.send('canvas-window-closed');
            } catch (e) {
                console.log('Could not send canvas-window-closed message, main window likely already destroyed.');
            }
        }
        if (fileWatcher) {
            fileWatcher.close();
            fileWatcher = null;
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

    // Start watching the directory for changes
    // Start watching the directory for changes
    if (!fileWatcher) {
        fileWatcher = chokidar.watch(CANVAS_CACHE_DIR, {
            persistent: true,
            ignoreInitial: true,
        }).on('change', (filePath) => {
            if (internalSaveInProgress.has(filePath)) {
                console.log(`Internal save detected for ${filePath}. Ignoring watch event.`);
                return; // It's an internal save, do nothing.
            }

            if (canvasWindow && !canvasWindow.isDestroyed()) {
                console.log(`External file change detected: ${filePath}`);
                getCanvasFileContent(filePath).then(fileContent => {
                    // Send a specific event for external changes
                    canvasWindow.webContents.send('external-file-changed', fileContent);
                }).catch(err => console.error(`Error reading changed file ${filePath}:`, err));
            }
        });
    }
}

async function handleCanvasReady(event) {
    const sender = event.sender;
    try {
        const history = await getCanvasHistory();
        let current = null;
        if (initialFilePath && (await fs.pathExists(initialFilePath))) {
            current = await getCanvasFileContent(initialFilePath);
            history.forEach(h => h.isActive = (h.path === initialFilePath));
            initialFilePath = null; // Consume it
        } else if (history.length > 0) {
            // Default behavior: load the first file
            current = await getCanvasFileContent(history[0].path);
            history[0].isActive = true;
        }
        sender.send('canvas-load-data', { history, current });
    } catch (error) {
        console.error('Failed to load canvas data:', error);
    }
}

async function handleCreateNewCanvas(event) {
    const sender = event.sender;
    try {
        const newFileName = `canvas_${Date.now()}.txt`;
        const newFilePath = path.join(CANVAS_CACHE_DIR, newFileName);
        await fs.writeFile(newFilePath, '// New Canvas');
        
        const history = await getCanvasHistory();
        const current = await getCanvasFileContent(newFilePath);
        history.forEach(h => h.isActive = (h.path === newFilePath));
        activeCanvasPath = newFilePath; // Set the active path

        sender.send('canvas-load-data', { history, current });
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

        sender.send('canvas-load-data', { history, current });
    } catch (error) {
        console.error(`Failed to load canvas file ${filePath}:`, error);
    }
}

async function handleSaveCanvasFile(event, file) {
    try {
        // Flag this path as an internal save before writing
        internalSaveInProgress.add(file.path);
        await fs.writeFile(file.path, file.content);
        console.log(`Internal save successful for: ${file.path}`);
    } catch (error) {
        console.error(`Failed to save canvas file ${file.path}:`, error);
    } finally {
        // After a short delay, remove the flag.
        // This gives chokidar time to fire its event, which we will then ignore.
        setTimeout(() => {
            internalSaveInProgress.delete(file.path);
        }, 100);
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
            canvasWindow.webContents.send('canvas-load-data', { history, current });
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
           canvasWindow.webContents.send('canvas-load-data', { history, current });
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
           canvasWindow.webContents.send('canvas-load-data', { history, current });
       }
   } catch (error) {
       console.error('Failed to delete canvas file:', error);
   }
}

async function getCanvasHistory() {
    const files = await fs.readdir(CANVAS_CACHE_DIR);
    const historyPromises = files
        .filter(file => SUPPORTED_EXTENSIONS.includes(path.extname(file).toLowerCase()))
        .map(async (file) => {
            const filePath = path.join(CANVAS_CACHE_DIR, file);
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
    handleGetLatestCanvasContent,
};
