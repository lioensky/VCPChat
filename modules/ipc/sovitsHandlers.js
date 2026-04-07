const { ipcMain } = require('electron');

let sovitsTTSInstance = null;
let internalMainWindow = null; // 用于在 handler 内部可靠地访问 mainWindow
let internalSettingsManager = null;

function getSovitsTTS() {
    if (!sovitsTTSInstance) {
        const SovitsTTS = require('../SovitsTTS');
        sovitsTTSInstance = new SovitsTTS(internalSettingsManager);
    }
    return sovitsTTSInstance;
}

function initialize(mainWindow, settingsManager) {
    if (!mainWindow) {
        console.error("SovitsTTS needs the main window to initialize."); // Translated for clarity
        return;
    }
    internalMainWindow = mainWindow; // Save reference to mainWindow
    internalSettingsManager = settingsManager || null;

    ipcMain.handle('sovits-get-models', async (event, forceRefresh) => {
        const instance = getSovitsTTS();
        if (!instance) return null;
        return await instance.getModels(forceRefresh);
    });

    ipcMain.on('sovits-speak', (event, options) => {
        const instance = getSovitsTTS();
        if (!instance) return;
        // The speak method now expects a single options object.
        instance.stop(); // Ensure any previous speech is stopped.
        // Pass the event sender to the speak method to reply to the correct window
        instance.speak(options, event.sender);
    });

    ipcMain.on('sovits-stop', () => {
        // 首先，让 SovitsTTS 实例清理其内部状态（如队列）
        if (sovitsTTSInstance) {
            sovitsTTSInstance.stop();
        }
        
        // 关键修复：直接从 IPC handler 发送停止事件到渲染器，
        // 确保无论 SovitsTTS 实例的状态如何，停止命令都能被发送。
        if (internalMainWindow && !internalMainWindow.isDestroyed()) {
            console.log("[IPC Handler] Directly sending 'stop-tts-audio' to renderer.");
            internalMainWindow.webContents.send('stop-tts-audio');
        } else {
            console.error("[IPC Handler] Cannot send 'stop-tts-audio', mainWindow reference is invalid.");
        }
    });


    console.log('SovitsTTS IPC handlers initialisés.');
}

module.exports = {
    initialize
};