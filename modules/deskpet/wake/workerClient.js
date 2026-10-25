'use strict';
const path = require('path');
const { fork } = require('child_process');

class KwsWorkerClient {
    constructor() {
        this.child = null;
        this.pending = new Map();
        this.sequence = 0;
    }

    async start(options) {
        this.dispose();
        const filename = path.join(__dirname, 'kwsWorker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
        const child = fork(filename, [], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            serialization: 'advanced', windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        this.child = child;
        let stderr = '';
        child.stderr.on('data', value => { stderr = (stderr + value).slice(-4096); });
        child.on('message', message => {
            const pending = this.pending.get(message?.id);
            if (!pending) return;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.ok) pending.resolve(message.result);
            else pending.reject(new Error(message.error || '唤醒推理失败'));
        });
        child.on('error', error => { if (this.child === child) this.dispose(error); });
        child.on('exit', () => {
            if (this.child === child) this.dispose(new Error(`唤醒进程退出：${stderr}`));
        });
        try { await this.request({ type: 'load', ...options }, 30000); }
        catch (error) { this.dispose(error); throw error; }
    }

    request(message, timeout = 5000) {
        return new Promise((resolve, reject) => {
            if (!this.child?.connected) return reject(new Error('唤醒进程未启动'));
            const id = ++this.sequence;
            const timer = setTimeout(() => this.dispose(new Error('唤醒推理超时')), timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.child.send({ ...message, id }, error => {
                if (error) this.dispose(error);
            });
        });
    }

    dispose(error = new Error('唤醒监听已停止')) {
        const child = this.child;
        this.child = null;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        try { child?.kill(); } catch { /* 已退出 */ }
    }
}
module.exports = { KwsWorkerClient };