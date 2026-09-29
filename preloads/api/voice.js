'use strict';

// 语音：Sovits TTS 播放、语音聊天窗口、浏览器语音识别、原生语音输入引擎、主聊天语音输入会话。
// 主进程：modules/ipc/sovitsHandlers.js、modules/ipc/voiceHandlers.js、modules/ipc/mainChatVoiceCoordinator.js
const { invoke, send, on, onSignal } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/sovitsHandlers.js', 'modules/ipc/voiceHandlers.js', 'modules/ipc/mainChatVoiceCoordinator.js'],
    roles: ['chat'],
    api: {
        // Sovits TTS
        sovitsGetModels: invoke('sovits-get-models', (forceRefresh = false) => [forceRefresh]),
        sovitsSpeak: send('sovits-speak', 'options'),
        sovitsStop: send('sovits-stop'),
        onPlayTtsAudio: on('play-tts-audio'),
        onStopTtsAudio: onSignal('stop-tts-audio'),

        // 语音聊天窗口与识别
        openVoiceChatWindow: send('open-voice-chat-window', 'data').roles('chat', 'utility'),
        onVoiceChatData: on('voice-chat-data'),
        startSpeechRecognition: send('start-speech-recognition'),
        stopSpeechRecognition: send('stop-speech-recognition'),
        onSpeechRecognitionResult: on('speech-recognition-result'),

        // 原生语音输入引擎（rust_voice_input_engine）与全局快捷键
        startNativeVoiceInput: invoke('voice-input-native:start', (options = {}) => [options]),
        stopNativeVoiceInput: invoke('voice-input-native:stop', (options = {}) => [options]),
        cancelNativeVoiceInput: invoke('voice-input-native:cancel'),
        getNativeVoiceInputStatus: invoke('voice-input-native:status'),
        onVoiceInputGlobalToggle: on('voice-input-global-toggle'),
        onVoiceInputShortcutStatus: on('voice-input-shortcut-status'),
        onVoiceInputCapturedText: on('voice-input-captured-text'),

        // 主聊天输入框的语音会话；录音附件复用 chat.handleFileDrop，不另开存盘通道
        startMainChatVoiceInput: invoke('main-chat-voice:start', (options = {}) => [options]),
        stopMainChatVoiceInput: invoke('main-chat-voice:stop'),
        cancelMainChatVoiceInput: invoke('main-chat-voice:cancel'),
        getMainChatVoiceStatus: invoke('main-chat-voice:status'),
        onMainChatVoiceCapturedText: on('main-chat-voice:captured-text'),
        onMainChatVoiceSessionEnded: on('main-chat-voice:session-ended'),
    },
};