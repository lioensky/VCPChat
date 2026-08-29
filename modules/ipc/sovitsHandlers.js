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

        // 新朗读必须在发起合成前立即停止当前窗口中的旧播放。
        // 如果只依赖下一批音频携带的新 sessionId，旧语音会一直播放到
        // MiMo 首个 SSE 音频块返回，造成切换导演提示词后短暂叠音。
        instance.stop();
        if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send('stop-tts-audio');
        }

        // Pass the event sender to the speak method to reply to the correct window
        instance.speak(options, event.sender);
    });

    ipcMain.on('sovits-stop', (event) => {
        // 首先，让 SovitsTTS 实例清理其内部状态（如队列）
        if (sovitsTTSInstance) {
            sovitsTTSInstance.stop();
        }

        // 优先通知实际发出停止命令的窗口，兼容主聊天和独立语音聊天窗口。
        if (event.sender && !event.sender.isDestroyed()) {
            console.log("[IPC Handler] Sending 'stop-tts-audio' to requesting renderer.");
            event.sender.send('stop-tts-audio');
        } else if (internalMainWindow && !internalMainWindow.isDestroyed()) {
            console.log("[IPC Handler] Falling back to main window for 'stop-tts-audio'.");
            internalMainWindow.webContents.send('stop-tts-audio');
        } else {
            console.error("[IPC Handler] Cannot send 'stop-tts-audio'; no valid renderer.");
        }
    });


    console.log('SovitsTTS IPC handlers initialisés.');
}

module.exports = {
    initialize
};