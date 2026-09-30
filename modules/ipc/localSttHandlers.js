'use strict';

// 本地语音识别（SenseVoice）：资源包状态/安装/卸载与转写。
const path = require('path');
const { ipcMain, BrowserWindow } = require('electron');
const { LocalSttModelManager } = require('../voice/localStt/modelManager');
const { LocalSttService } = require('../voice/localStt/localSttService');

let manager = null;
let service = null;
let isInitialized = false;

function broadcast(state) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('local-stt:state', state);
        }
    }
}

// sherpa-onnx-node 提供的五个平台
const SUPPORTED = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'].includes(`${process.platform}-${process.arch}`);
const withSupport = (state) => ({ ...state, supported: SUPPORTED });

function initialize({ appDataRoot } = {}) {
    if (isInitialized) return;
    manager = new LocalSttModelManager({
        dataRoot: path.join(appDataRoot, 'VoiceModels', 'sensevoice'),
        onState: broadcast,
    });
    service = new LocalSttService({ modelManager: manager });

    ipcMain.handle('local-stt:status', () => withSupport(manager.refresh()));
    ipcMain.handle('local-stt:prepare', (_e, options = {}) => {
        if (!SUPPORTED) return withSupport({ phase: 'failed', reason: 'unsupported' });
        manager.prepare({ source: typeof options?.source === 'string' ? options.source : 'auto' });
        return withSupport(manager.getState());
    });
    ipcMain.handle('local-stt:cancel', () => manager.cancel());
    ipcMain.handle('local-stt:remove', async () => {
        service.dispose();
        try {
            return withSupport(await manager.remove());
        } catch (err) {
            return withSupport({ phase: 'failed', reason: 'storage', message: String(err?.message || err) });
        }
    });
    ipcMain.handle('local-stt:transcribe', async (_e, payload = {}) => {
        try {
            const result = await service.transcribe(payload.wav, { language: payload.language });
            return { success: true, ...result };
        } catch (err) {
            return { success: false, error: String(err?.message || err) };
        }
    });
    isInitialized = true;
}

function shutdown() {
    service?.dispose();
}

module.exports = { initialize, shutdown };
