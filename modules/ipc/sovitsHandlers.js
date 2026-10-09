const { ipcMain } = require('electron');

let sovitsTTSInstance = null;
let internalMainWindow = null; // 用于在 handler 内部可靠地访问 mainWindow
let internalSettingsManager = null;
// 同一时间只有一个声音：TTS 实例是共用的，新的朗读开始时，上一个出声的窗口（主窗口、语音聊天、桌宠）里还在放的也停掉。
let lastSpeaker = null;
// 可选的过滤：返回 false 的朗读请求直接忽略（桌宠正在念的那条，主窗口的自动朗读不再念一遍）。
let speakGate = null;

function getSovitsTTS() {
    if (!sovitsTTSInstance) {
        const SovitsTTS = require('../SovitsTTS');
        sovitsTTSInstance = new SovitsTTS(internalSettingsManager);
    }
    return sovitsTTSInstance;
}

function isLive(contents) {
    return Boolean(contents) && !contents.isDestroyed();
}

function stopOtherSpeaker(sender) {
    if (lastSpeaker && lastSpeaker !== sender && isLive(lastSpeaker)) {
        lastSpeaker.send('stop-tts-audio');
    }
}

/**
 * 开始一次新的朗读：停掉之前所有的（包括别的窗口里正在放的），再合成这段。
 * notifySender 为 false 时由调用方自己清空发起窗口里的播放。返回这次朗读的会话号。
 */
function startSpeech(sender, options, { notifySender = true } = {}) {
    const instance = getSovitsTTS();
    // 新朗读必须在发起合成前立即停止当前窗口中的旧播放。
    // 如果只依赖下一批音频携带的新 sessionId，旧语音会一直播放到
    // MiMo 首个 SSE 音频块返回，造成切换导演提示词后短暂叠音。
    instance.stop();
    stopOtherSpeaker(sender);
    if (notifySender && isLive(sender)) {
        sender.send('stop-tts-audio');
    }
    lastSpeaker = sender;
    // Pass the event sender to the speak method to reply to the correct window
    instance.speak(options, sender);
    return instance.sessionId;
}

/** 接着上一段念（边生成边朗读）；期间别的窗口开始了新的朗读就不再接，返回 false。 */
function appendSpeech(sender, options, session) {
    const instance = getSovitsTTS();
    if (instance.sessionId !== session || lastSpeaker !== sender) return false;
    instance.speak(options, sender);
    return true;
}

/** 停掉 sender 发起的朗读；它已经不是最后出声的窗口时什么也不做。 */
function stopSpeechFrom(sender) {
    if (lastSpeaker !== sender) return;
    sovitsTTSInstance?.stop();
    lastSpeaker = null;
}

function setSpeakGate(gate) {
    speakGate = typeof gate === 'function' ? gate : null;
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
        try {
            if (speakGate && speakGate(event.sender, options) === false) return;
        } catch (error) {
            console.warn('[TTS] speak gate failed:', error.message);
        }
        startSpeech(event.sender, options);
    });

    ipcMain.on('sovits-stop', (event) => {
        // 首先，让 SovitsTTS 实例清理其内部状态（如队列）
        if (sovitsTTSInstance) {
            sovitsTTSInstance.stop();
        }

        // 正在出声的是别的窗口（例如桌宠）时也让它停下。
        stopOtherSpeaker(event.sender);
        lastSpeaker = null;

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
    initialize,
    startSpeech,
    appendSpeech,
    stopSpeechFrom,
    setSpeakGate
};