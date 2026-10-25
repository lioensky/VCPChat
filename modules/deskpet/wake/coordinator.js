'use strict';
const fs = require('fs/promises');
const path = require('path');
const { WakeStore } = require('./store');
const { WakeModelManager } = require('./modelManager');
const { compileKeywords } = require('./keywords');
const { KwsWorkerClient } = require('./workerClient');

function wav(chunks) {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = Buffer.alloc(44 + length * 2);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
    bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
    bytes.writeUInt32LE(length * 2, 40);
    let offset = 44;
    for (const chunk of chunks) for (const sample of chunk) {
        bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), offset); offset += 2;
    }
    return bytes;
}

function createWakeCoordinator(ctx, { tts, stt, worker: injectedWorker, model: injectedModel, store: injectedStore }) {
    const { ipcMain, BrowserWindow, session, dialog, powerMonitor } = ctx.electron;
    const store = injectedStore || new WakeStore({ ...ctx.paths, tts });
    const worker = injectedWorker || new KwsWorkerClient();
    let capture = null;
    let generation = 0;
    let state = { phase: 'off' };
    let routes = {};
    let current = null;
    let timer = null;
    let playbackTimer = null;
    let frameBusy = false;
    let suspended = false;
    let disposed = false;
    const manualCaptures = new Set();
    const observedCaptures = new WeakSet();
    let serial = Promise.resolve();
    const model = injectedModel || new WakeModelManager({ appDataRoot: ctx.paths.appDataRoot, onState: () => publish() });

    function publish(next) {
        if (next) state = next;
        ctx.mainContents()?.send('deskpet-wake:state', { ...state, model: model.status() });
    }
    function notice(agentId, text) {
        const pet = ctx.pets.get(agentId);
        if (pet && !pet.win.isDestroyed()) pet.win.webContents.send('deskpet:wake-status', text);
    }
    function stop() {
        generation++;
        clearTimeout(timer); clearTimeout(playbackTimer);
        current = null;
        worker.dispose();
        const window = capture; capture = null;
        if (window && !window.isDestroyed()) window.destroy();
        publish({ phase: 'off' });
    }
    function fail(error) { stop(); publish({ phase: 'failed', error: error.message || String(error) }); }
    function allowed(event) { return ctx.fromMain(event); }
    function fromCapture(event) { return capture && !capture.isDestroyed() && event.sender === capture.webContents; }
    function enqueue(work) {
        const result = serial.catch(() => {}).then(work);
        serial = result;
        return result;
    }
    async function compiled(agents = store.agents) {
        return compileKeywords(agents, await fs.readFile(model.paths().tokens, 'utf8'));
    }
    async function restart() {
        stop();
        if (disposed || suspended || manualCaptures.size || ctx.shuttingDown || ctx.controls?.get().doNotDisturb) return;
        const activeAgents = Object.fromEntries(Object.entries(store.agents).filter(([id, config]) => {
            const pet = ctx.pets.get(id);
            return config.enabled && pet && !pet.win.isDestroyed() && pet.win.isVisible();
        }));
        if (!Object.keys(activeAgents).length) return;
        if (!model.installed()) return publish({ phase: 'unprepared', error: '请先安装语音唤醒模型' });
        const sttPaths = stt.getPaths();
        if (!sttPaths) return publish({ phase: 'unprepared', error: '请先安装 SenseVoice 识别资源包' });
        const owner = generation;
        publish({ phase: 'loading' });
        try {
            const keywords = await compiled(activeAgents);
            if (owner !== generation) return;
            routes = keywords.routes;
            const keywordsFile = path.join(store.root, 'keywords.txt');
            await fs.mkdir(store.root, { recursive: true });
            await fs.writeFile(keywordsFile, keywords.text);
            await worker.start({ paths: model.paths(), keywordsFile, vadPath: sttPaths.vad });
            if (owner !== generation) return;
            const ses = session.fromPartition('deskpet-wake-capture');
            const valid = contents => capture && contents === capture.webContents;
            ses.setPermissionRequestHandler((contents, permission, callback, details) => {
                callback(valid(contents) && permission === 'media' && Array.isArray(details.mediaTypes)
                    && details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio'));
            });
            ses.setPermissionCheckHandler((contents, permission, _origin, details) => valid(contents)
                && permission === 'media' && details?.mediaType === 'audio');
            capture = new BrowserWindow({
                show: false, width: 64, height: 64, skipTaskbar: true,
                webPreferences: {
                    preload: path.join(ctx.paths.projectRoot, 'DeskPetmodules', 'wake-preload.js'),
                    session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false,
                    backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
                },
            });
            capture.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            capture.webContents.on('will-navigate', event => event.preventDefault());
            capture.webContents.on('render-process-gone', () => fail(new Error('麦克风采集进程退出')));
            timer = setTimeout(() => fail(new Error('麦克风初始化超时')), 20000);
            await capture.loadFile(path.join(ctx.paths.projectRoot, 'DeskPetmodules', 'wake-capture.html'));
        } catch (error) { if (owner === generation) fail(error); }
    }
    async function listenAgain(owner) {
        if (owner !== generation || !capture) return;
        current = null;
        await worker.request({ type: 'reset' });
        if (owner !== generation) return;
        publish({ phase: 'cooldown' });
        clearTimeout(timer);
        timer = setTimeout(() => publish({ phase: 'listening' }), 1000);
    }
    function beginRecording(owner) {
        if (owner !== generation || !current) return;
        clearTimeout(playbackTimer);
        current.chunks = [];
        current.samples = 0;
        current.heard = false;
        publish({ phase: 'recording', agentId: current.agentId });
        notice(current.agentId, '正在听，请说话…');
        clearTimeout(timer);
        timer = setTimeout(() => {
            notice(current?.agentId, '没有听到说话，已恢复唤醒监听');
            listenAgain(owner).catch(fail);
        }, 8000);
    }
    async function wake(agentId) {
        const owner = generation;
        current = { agentId, chunks: [], samples: 0, heard: false };
        publish({ phase: 'responding', agentId });
        notice(agentId, '已唤醒，回应结束后请说话');
        stt.warmup().catch(error => { if (owner === generation) fail(error); });
        try {
            const audio = await store.audio(agentId);
            if (owner !== generation) return;
            await worker.request({ type: 'reset' });
            if (owner !== generation) return;
            if (audio && capture) {
                const token = `${owner}:${Date.now()}`;
                current.token = token;
                capture.webContents.send('deskpet-wake:play', { ...audio, token });
                playbackTimer = setTimeout(() => {
                    if (owner === generation) fail(new Error('回应音频播放超时，请缩短回应文案后重新生成'));
                }, 15000);
            } else beginRecording(owner);
        } catch (error) { if (owner === generation) fail(error); }
    }
    async function finish(owner) {
        if (owner !== generation || !current || state.phase !== 'recording') return;
        clearTimeout(timer);
        const recording = current;
        publish({ phase: 'transcribing', agentId: recording.agentId });
        notice(recording.agentId, '正在识别…');
        try {
            const result = await stt.transcribe(wav(recording.chunks), { language: 'auto' });
            if (owner !== generation) return;
            const text = String(result.text || '').trim();
            if (text) {
                const pet = ctx.pets.get(recording.agentId);
                if (!pet || pet.win.isDestroyed() || !pet.win.isVisible()) throw new Error('目标桌宠已关闭或隐藏，未发送');
                const autoSend = store.get(recording.agentId).autoSend;
                pet.win.webContents.send('deskpet:wake-text', { text, autoSend });
                notice(recording.agentId, autoSend ? '已识别，正在发送' : '已放入输入条，请确认');
            } else notice(recording.agentId, '没有识别到有效内容');
            await listenAgain(owner);
        } catch (error) { if (owner === generation) fail(error); }
    }

    ipcMain.handle('deskpet-wake:frame', async (event, samples) => {
        if (!fromCapture(event) || !(samples instanceof Float32Array) || samples.length < 1 || samples.length > 16000) return;
        if (frameBusy || !['listening', 'recording'].includes(state.phase)) return;
        if (samples.some(sample => !Number.isFinite(sample))) return;
        frameBusy = true;
        const owner = generation;
        try {
            // 桌宠或主窗口正在朗读时不做关键词检测，首版不承诺全双工抢话。
            if (state.phase === 'listening' && (await ctx.voice.anySpeaking?.()
                || BrowserWindow.getAllWindows?.().some(window => window !== capture
                    && !window.isDestroyed() && window.webContents.isCurrentlyAudible?.()))) return;
            const mode = state.phase === 'listening' ? 'listen' : 'record';
            const result = await worker.request({ type: 'audio', samples, mode });
            if (owner !== generation) return;
            if (mode === 'listen') {
                const agentId = routes[result.keyword];
                const pet = ctx.pets.get(agentId);
                if (agentId && pet?.ready && !pet.win.isDestroyed() && pet.win.isVisible()) await wake(agentId);
            } else if (current) {
                current.chunks.push(new Float32Array(samples));
                current.samples += samples.length;
                if (result.speech && !current.heard) {
                    current.heard = true;
                    clearTimeout(timer);
                    timer = setTimeout(() => finish(owner).catch(fail), 60000);
                }
                if (current.heard && (result.endpoint || current.samples >= 16000 * 60)) {
                    finish(owner).catch(error => { if (owner === generation) fail(error); });
                }
            }
        } catch (error) { if (owner === generation) fail(error); }
        finally { frameBusy = false; }
    });
    ipcMain.handle('deskpet-wake:manual-capture', (event, active) => {
        const pet = ctx.petFromEvent(event);
        if (!pet) return false;
        const sender = event.sender;
        if (active === true && !manualCaptures.has(sender)) {
            manualCaptures.add(sender);
            stop();
            if (!observedCaptures.has(sender)) {
                observedCaptures.add(sender);
                const release = () => {
                    if (manualCaptures.delete(sender) && !disposed) enqueue(restart).catch(fail);
                };
                sender.once('destroyed', release);
                sender.on('did-start-loading', release);
            }
        } else if (active !== true && manualCaptures.delete(sender)) {
            enqueue(restart).catch(fail);
        }
        return true;
    });
    ipcMain.on('deskpet-wake:capture-ready', event => {
        if (!fromCapture(event)) return;
        clearTimeout(timer); publish({ phase: 'listening' });
    });
    ipcMain.on('deskpet-wake:capture-error', (event, error) => {
        if (fromCapture(event)) fail(new Error(String(error).slice(0, 500)));
    });
    ipcMain.on('deskpet-wake:playback-ended', (event, token) => {
        if (fromCapture(event) && state.phase === 'responding' && current?.token === token) {
            // 留出扬声器回声尾部，避免回应尾音进入录音。
            clearTimeout(playbackTimer);
            const owner = generation;
            playbackTimer = setTimeout(() => beginRecording(owner), 250);
        }
    });
    function handle(channel, work) {
        ipcMain.handle(channel, async (event, ...args) => {
            if (!allowed(event)) return null;
            try { return await work(...args); }
            catch (error) { return { success: false, error: error.message }; }
        });
    }
    handle('deskpet-wake:status', async id => {
        await store.checkAgent(id);
        let previews = {};
        try { previews = (await compiled()).previews; } catch { /* 未安装 */ }
        return { success: true, config: store.get(id), audio: await store.audioStatus(id), model: model.status(), state, preview: previews[id] || [] };
    });
    handle('deskpet-wake:update', (id, patch) => enqueue(async () => {
        await store.checkAgent(id);
        const next = store.normalize({ ...store.get(id), ...patch });
        if (next.enabled) await compiled({ ...store.agents, [id]: next });
        await store.update(id, next);
        await restart();
        return { success: true };
    }));
    handle('deskpet-wake:install', () => enqueue(async () => {
        stop();
        const result = await model.prepare();
        await restart();
        return { success: result.phase === 'ready', ...result };
    }));
    handle('deskpet-wake:import', () => enqueue(async () => {
        const result = await dialog.showOpenDialog(ctx.mainWindow, { properties: ['openDirectory'], title: '选择 sherpa-onnx 中文 KWS mobile 模型目录' });
        if (result.canceled || !result.filePaths?.[0]) return { success: false, cancelled: true };
        stop();
        const installed = await model.prepare(result.filePaths[0]);
        await restart();
        return { success: installed.phase === 'ready', ...installed };
    }));
    handle('deskpet-wake:cancel-install', () => model.cancel());
    handle('deskpet-wake:generate', id => store.generate(id).then(audio => ({ success: true, audio })));
    handle('deskpet-wake:audio', async id => {
        await store.checkAgent(id);
        return { success: true, audio: await store.audio(id) };
    });
    handle('deskpet-wake:restart', () => enqueue(restart).then(() => ({ success: true })));
    const suspend = () => { suspended = true; stop(); };
    const resume = () => { suspended = false; enqueue(restart).catch(fail); };
    for (const event of ['suspend', 'lock-screen']) powerMonitor?.on?.(event, suspend);
    for (const event of ['resume', 'unlock-screen']) powerMonitor?.on?.(event, resume);
    const ready = store.load().then(() => enqueue(restart)).catch(fail);
    return {
        ready,
        refresh: () => {
            stop();
            return enqueue(restart).catch(fail);
        },
        visibilityChanged: () => {
            // 立即作废正在录音/识别的会话，不等待先前异步重启排队。
            stop();
            return enqueue(restart).catch(fail);
        },
        forget: id => enqueue(async () => { stop(); await store.forget(id); await restart(); }),
        async dispose() {
            disposed = true; stop();
            for (const event of ['suspend', 'lock-screen']) powerMonitor?.removeListener?.(event, suspend);
            for (const event of ['resume', 'unlock-screen']) powerMonitor?.removeListener?.(event, resume);
            await model.cancel();
            await serial.catch(() => {});
            await store.tail.catch(() => {});
        },
    };
}
module.exports = { createWakeCoordinator, wav };