const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs').promises;

// Define the path to the shared AppData directory, which is one level above VchatManager
const sharedAppDataPath = path.join(__dirname, '../AppData');

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    // mainWindow.webContents.openDevTools(); // Uncomment for debugging
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// --- IPC Handlers for File System Access ---

// Security check function to ensure paths don't escape the project directory
function isPathSafe(relativePath) {
    const absolutePath = path.join(__dirname, '..', relativePath);
    const projectRoot = path.join(__dirname, '..');
    return absolutePath.startsWith(projectRoot);
}

// Generic file reader
ipcMain.handle('fs:readFile', async (event, relativePath) => {
    if (!isPathSafe(relativePath)) {
        throw new Error(`Access denied to path: ${relativePath}`);
    }
    try {
        const fullPath = path.join(__dirname, '..', relativePath);
        return await fs.readFile(fullPath, 'utf-8');
    } catch (error) {
        // If the file doesn't exist (ENOENT), we return null silently,
        // as this is expected behavior for optional files (like history.json)
        if (error.code !== 'ENOENT') {
            console.error(`Error reading file ${relativePath}:`, error);
        }
        return null;
    }
});

// Generic file writer
ipcMain.handle('fs:writeFile', async (event, relativePath, content) => {
    if (!isPathSafe(relativePath)) {
        throw new Error(`Access denied to path: ${relativePath}`);
    }
    try {
        const fullPath = path.join(__dirname, '..', relativePath);
        await fs.writeFile(fullPath, content, 'utf-8');
        return { success: true };
    } catch (error) {
        console.error(`Error writing file ${relativePath}:`, error);
        return { success: false, error: error.message };
    }
});

// Generic directory lister
ipcMain.handle('fs:listDir', async (event, relativePath) => {
    if (!isPathSafe(relativePath)) {
        throw new Error(`Access denied to path: ${relativePath}`);
    }
    try {
        const fullPath = path.join(__dirname, '..', relativePath);
        return await fs.readdir(fullPath);
    } catch (error) {
        console.error(`Error listing directory ${relativePath}:`, error);
        return [];
    }
});

// Ensure directory exists (create if missing)
ipcMain.handle('fs:ensureDir', async (event, relativePath) => {
    if (!isPathSafe(relativePath)) {
        throw new Error(`Access denied to path: ${relativePath}`);
    }
    try {
        const fullPath = path.join(__dirname, '..', relativePath);
        await fs.mkdir(fullPath, { recursive: true });
        return { success: true };
    } catch (error) {
        console.error(`Error ensuring directory ${relativePath}:`, error);
        return { success: false, error: error.message };
    }
});