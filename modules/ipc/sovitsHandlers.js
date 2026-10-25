const { ipcMain } = require('electron');
const { hostHooks } = require('../hostHooks');

let sovitsTTSInstance = null;
let internalMainWindow = null; // 用于在 handler 内部可靠地访问 mainWindow
let internalSettingsManager = null;
// 同一时间只有一个声音：TTS 实例是共用的，新的朗读开始时，上一个出声的窗口（主窗口、语音聊天或功能模块的窗口）里还在放的也停掉。
let lastSpeaker = null;
const streamSpeeches = new WeakMap();

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
        // 挂在 tts:speak 上的功能可以拦下这次朗读（例如这条已经在别的窗口里念着）
        if (!hostHooks.every('tts:speak', event.sender, options)) return;
        if (options?.speechStreamId) {
            const key = String(options.speechStreamId);
            if (options.speechStreamFirst === true) {
                const session = startSpeech(event.sender, options, { notifySender: false });
                streamSpeeches.set(event.sender, { key, session });
            } else {
                const speech = streamSpeeches.get(event.sender);
                if (speech?.key === key) appendSpeech(event.sender, options, speech.session);
            }
            return;
        }
        streamSpeeches.delete(event.sender);
        startSpeech(event.sender, options);
    });

    ipcMain.on('sovits-stop', (event) => {
        streamSpeeches.delete(event.sender);
        // 首先，让 SovitsTTS 实例清理其内部状态（如队列）
        if (sovitsTTSInstance) {
            sovitsTTSInstance.stop();
        }

        // 正在出声的是别的窗口时也让它停下。
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
    isSpeaking: () => Boolean(sovitsTTSInstance?.isSpeaking || sovitsTTSInstance?.speechQueue?.length),
    // 仅生成音频，不改变朗读队列、会话号或当前出声窗口。
    async generateAudio({ text, voice, speed = 1, directorPrompts = [] }) {
        const instance = getSovitsTTS();
        const runtime = await instance.getRuntimeConfig();
        const result = await instance.textToSpeech(text, voice, speed, directorPrompts);
        if (!result?.audioBuffer?.length) throw new Error('语音生成失败，请检查 TTS 服务与音色配置');
        return {
            audioBuffer: result.audioBuffer,
            playbackRate: runtime.voiceMode === 'network' ? Math.min(2, Math.max(0.5, Number(speed) || 1)) : 1,
        };
    },
    async generationIdentity() {
        const runtime = await getSovitsTTS().getRuntimeConfig();
        return { voiceMode: runtime.voiceMode, baseUrl: runtime.baseUrl };
    }
};