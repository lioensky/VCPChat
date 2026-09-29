'use strict';

// 本地 SenseVoice 识别服务：按需拉起推理子进程，空闲一段时间后自动回收。
const path = require('path');
const { fork } = require('child_process');

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120 * 1000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

class LocalSttService {
    constructor({ modelManager, workerPath } = {}) {
        this.modelManager = modelManager;
        this.workerPath = workerPath || path.join(__dirname, 'sttWorker.js');
        this.child = null;
        this.loading = null;
        this.pending = new Map();
        this.seq = 0;
        this.idleTimer = null;
    }

    request(msg) {
        return new Promise((resolve, reject) => {
            if (!this.child?.connected) return reject(new Error('识别进程不可用'));
            const id = ++this.seq;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.killWorker();
                reject(new Error('本地识别超时'));
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.child.send({ ...msg, id });
            return undefined;
        });
    }

    killWorker() {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
        const child = this.child;
        this.child = null;
        this.loading = null;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('识别进程已退出'));
        }
        this.pending.clear();
        try { child?.kill(); } catch (_) {}
    }

    async ensureWorker() {
        if (this.loading) return this.loading;
        if (this.child?.connected) return undefined;
        if (!this.modelManager.isInstalled()) throw new Error('本地语音模型尚未安装，请先在设置页安装');

        const child = fork(this.workerPath, [], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            serialization: 'advanced',
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            windowsHide: true,
        });
        this.child = child;
        let stderr = '';
        child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-4096); });
        child.on('message', (msg) => {
            const p = this.pending.get(msg?.id);
            if (!p) return;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) p.resolve(msg.result);
            else p.reject(new Error(msg.error || '识别失败'));
        });
        child.on('exit', (code) => {
            if (this.child !== child) return;
            this.killWorker();
            if (code) console.warn('[LocalStt] worker exited', code, stderr.trim());
        });

        this.loading = this.request({ type: 'load', paths: { ...this.modelManager.getPaths(), threads: 2 } })
            .then(() => { this.loading = null; })
            .catch((err) => { this.killWorker(); throw err; });
        return this.loading;
    }

    async transcribe(wavBytes, { language = 'auto' } = {}) {
        const wav = Buffer.isBuffer(wavBytes) ? wavBytes : Buffer.from(wavBytes || []);
        if (!wav.length) throw new Error('音频为空');
        if (wav.length > MAX_AUDIO_BYTES) throw new Error('录音过长，请缩短后重试');
        await this.ensureWorker();
        clearTimeout(this.idleTimer);
        try {
            return await this.request({ type: 'transcribe', wav, language });
        } finally {
            if (this.child) {
                this.idleTimer = setTimeout(() => this.killWorker(), IDLE_TIMEOUT_MS);
                this.idleTimer.unref?.();
            }
        }
    }

    dispose() {
        this.killWorker();
    }
}

module.exports = { LocalSttService };
