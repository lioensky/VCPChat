// modules/ipc/voiceHandlers.js

const { BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const { PRELOAD_ROLES, resolveProjectPreload } = require('../services/preloadPaths');

let mainWindow = null;
let openChildWindows = [];
let settingsManager = null;
let PROJECT_ROOT = null;
let isInitialized = false;

function createVoiceChatWindow(agentId) {
    const voiceChatWindow = new BrowserWindow({
        width: 500,
        height: 700,
        minWidth: 400,
        minHeight: 500,
        frame: false,
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        title: '语音聊天',
        webPreferences: {
            preload: resolveProjectPreload(PROJECT_ROOT, PRELOAD_ROLES.CHAT),
            contextIsolation: true,
            nodeIntegration: false,
        },
        parent: mainWindow,
        modal: false,
        show: false,
    });

    const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    voiceChatWindow.webContents.once('did-finish-load', () => {
        voiceChatWindow.webContents.send('voice-chat-data', { agentId, theme });
    });

    voiceChatWindow.loadFile(path.join(PROJECT_ROOT, 'Voicechatmodules', 'voicechat.html'));

    voiceChatWindow.once('ready-to-show', () => {
        voiceChatWindow.show();
    });

    openChildWindows.push(voiceChatWindow);

    voiceChatWindow.on('closed', () => {
        const index = openChildWindows.indexOf(voiceChatWindow);
        if (index > -1) {
            openChildWindows.splice(index, 1);
        }

        const speechRecognizer = require('../speechRecognizer');
        speechRecognizer.stop();
    });

    return voiceChatWindow;
}

function handleOpenVoiceChatWindow(event, { agentId } = {}) {
    return createVoiceChatWindow(agentId);
}

async function handleStartSpeechRecognition(event) {
    const voiceChatWindow = openChildWindows.find(win => win.webContents === event.sender);
    if (!voiceChatWindow) return;

    let speechConfig = {};
    try {
        const settings = settingsManager ? await settingsManager.readSettings() : {};
        speechConfig = {
            browserPath: settings?.speechRecognizerBrowserPath || '',
            recognizerPagePath: settings?.speechRecognizerPagePath || 'Voicechatmodules/recognizer.html'
        };
    } catch (error) {
        console.warn('[VoiceHandlers] Failed to read speech recognition settings, using defaults:', error.message);
    }

    const speechRecognizer = require('../speechRecognizer');
    speechRecognizer.start((text) => {
        if (voiceChatWindow && !voiceChatWindow.isDestroyed()) {
            voiceChatWindow.webContents.send('speech-recognition-result', text);
        }
    }, speechConfig);
}

function handleStopSpeechRecognition() {
    const speechRecognizer = require('../speechRecognizer');
    speechRecognizer.stop();
}

function initialize(options) {
    mainWindow = options.mainWindow;
    openChildWindows = options.openChildWindows;
    settingsManager = options.settingsManager;
    PROJECT_ROOT = options.projectRoot;

    if (isInitialized) {
        return;
    }

    ipcMain.on('open-voice-chat-window', handleOpenVoiceChatWindow);
    ipcMain.on('start-speech-recognition', handleStartSpeechRecognition);
    ipcMain.on('stop-speech-recognition', handleStopSpeechRecognition);

    isInitialized = true;
}

module.exports = {
    initialize,
    createVoiceChatWindow
};