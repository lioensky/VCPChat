'use strict';

// 用虚拟媒体设备验证隐藏窗口采集，不访问用户真实麦克风、不调用外部服务。
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { createWakeCoordinator } = require('../../modules/deskpet/wake/coordinator');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
let coordinator;
let root;
const deadline = setTimeout(() => { console.error('wake Electron smoke timed out'); app.exit(1); }, 25000);
app.whenReady().then(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-electron-'));
    const tokens = path.join(root, 'tokens.txt');
    await fs.writeFile(tokens, 'x 1\niǎo 2\nk 3\nè 4\n');
    let frames = 0;
    let listening = false;
    const store = {
        root, agents: { a: { enabled: true, phrases: '小克小克' } },
        async load() {}, tail: Promise.resolve(),
    };
    const ctx = {
        paths: { projectRoot: path.resolve(__dirname, '../..'), appDataRoot: root },
        electron: { app, BrowserWindow, ipcMain, session, powerMonitor: null },
        fromMain: () => false,
        mainContents: () => ({ send: (_channel, payload) => {
            if (payload.phase === 'listening') listening = true;
            if (payload.phase === 'failed') throw new Error(payload.error);
        } }),
        controls: { get: () => ({}) },
        pets: new Map([['a', { ready: true, win: { isDestroyed: () => false, isVisible: () => true } }]]),
        voice: { anySpeaking: () => false },
    };
    coordinator = createWakeCoordinator(ctx, {
        store, tts: {},
        model: { installed: () => true, status: () => ({ phase: 'ready' }),
            paths: () => ({ tokens }), async cancel() {} },
        worker: { async start() {}, dispose() {}, async request(message) {
            if (message.type === 'audio') frames++;
            return {};
        } },
        stt: { getPaths: () => ({ vad: 'fake' }) },
    });
    await coordinator.ready;
    for (let attempt = 0; attempt < 100 && frames < 3; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    if (!listening || frames < 3) throw new Error(`capture not ready: listening=${listening}, frames=${frames}`);
    await coordinator.dispose();
    const captureWindows = BrowserWindow.getAllWindows();
    if (captureWindows.length) throw new Error('capture window leaked');
    console.log(JSON.stringify({ ok: true, virtualMicrophone: true, listening, frames, remainingWindows: captureWindows.length }));
    await fs.rm(root, { recursive: true, force: true });
    clearTimeout(deadline);
    app.exit(0);
}).catch(async error => {
    console.error(error);
    await coordinator?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
    clearTimeout(deadline);
    app.exit(1);
});