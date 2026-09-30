'use strict';

// 本地 SenseVoice 资源包管理：下载（带进度/取消/SHA-256 校验/镜像回退）、状态检查。
// 资源与校验值见 assets.json。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform, Readable } = require('stream');
const { pipeline } = require('stream/promises');
const assets = require('./assets.json');

const ORIGINS = ['https://huggingface.co', 'https://hf-mirror.com'];
const PROBE_TIMEOUT_MS = 3000;
const PROGRESS_INTERVAL_MS = 100;
const STALL_TIMEOUT_MS = 20000;

class DownloadError extends Error {
    constructor(reason, message) {
        super(message || reason);
        this.reason = reason;
    }
}

function classifyError(err) {
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.reason === 'cancelled') return 'cancelled';
    if (err instanceof DownloadError) return err.reason;
    const code = err?.cause?.code || err?.code || '';
    if (/ENOSPC|EACCES|EPERM|EROFS/.test(code)) return 'storage';
    if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'dns';
    if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(code)) return 'timeout';
    if (/CERT|SSL/.test(code)) return 'certificate';
    return 'network';
}

function rewriteOrigin(url, origin) {
    const u = new URL(url);
    return new URL(u.pathname + u.search, origin).toString();
}

class LocalSttModelManager {
    constructor({ dataRoot, onState } = {}) {
        this.dataRoot = dataRoot;
        this.onState = typeof onState === 'function' ? onState : () => {};
        this.state = { phase: 'unprepared' };
        this.controller = null;
        this.task = null;
    }

    getPaths() {
        const modelDir = path.join(this.dataRoot, 'models', 'sensevoice-onnx');
        const vadDir = path.join(this.dataRoot, 'models', 'silero');
        return {
            model: path.join(modelDir, assets.models.int8.name),
            tokens: path.join(modelDir, assets.tokens.name),
            vad: path.join(vadDir, assets.vad.name),
        };
    }

    getAssetList() {
        const p = this.getPaths();
        return [
            { key: 'model', asset: assets.models.int8, file: p.model },
            { key: 'tokens', asset: assets.tokens, file: p.tokens },
            { key: 'vad', asset: assets.vad, file: p.vad },
        ];
    }

    getState() {
        return { ...this.state };
    }

    setState(next) {
        this.state = next;
        try { this.onState(this.getState()); } catch (_) {}
    }

    // 只做存在性与大小检查（不算哈希，避免每次读 240MB）；完整校验在下载时完成。
    isInstalled() {
        return this.getAssetList().every(({ asset, file }) => {
            try { return fs.statSync(file).size === asset.bytes; } catch (_) { return false; }
        });
    }

    refresh() {
        if (!this.task) {
            this.state = { phase: this.isInstalled() ? 'ready' : 'unprepared' };
        }
        return this.getState();
    }

    async orderOrigins(signal) {
        const probes = ORIGINS.map(async (origin) => {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
            const onAbort = () => ctl.abort();
            signal?.addEventListener('abort', onAbort, { once: true });
            const started = Date.now();
            try {
                const res = await fetch(rewriteOrigin(assets.models.int8.url, origin), { method: 'HEAD', signal: ctl.signal });
                return { origin, ms: res.ok ? Date.now() - started : Infinity };
            } catch (_) {
                return { origin, ms: Infinity };
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            }
        });
        const results = await Promise.all(probes);
        return results.sort((a, b) => a.ms - b.ms).map((r) => r.origin);
    }

    // 断点续传：固定的 .part 文件 + Range 请求；已下载部分先补算哈希再续写。
    // 单次尝试带停滞看门狗——长时间没有数据就中断并换下一个下载源（仍从断点继续）。
    async downloadOne({ key, asset, file }, origin, signal, report) {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const part = `${file}.part`;
        const hash = crypto.createHash('sha256');
        let received = 0;
        try {
            const size = (await fs.promises.stat(part)).size;
            if (size > 0 && size < asset.bytes) {
                await pipeline(fs.createReadStream(part), new Transform({
                    transform(chunk, _enc, cb) { hash.update(chunk); cb(); },
                }));
                received = size;
            } else if (size !== 0) {
                await fs.promises.rm(part, { force: true });
            }
        } catch (_) { received = 0; }

        const attempt = new AbortController();
        const abortAll = () => attempt.abort();
        signal?.addEventListener('abort', abortAll, { once: true });
        let stalled = false;
        let watchdog = null;
        const arm = () => {
            clearTimeout(watchdog);
            watchdog = setTimeout(() => { stalled = true; attempt.abort(); }, STALL_TIMEOUT_MS);
        };
        try {
            arm();
            const res = await fetch(rewriteOrigin(asset.url, origin), {
                signal: attempt.signal,
                headers: received > 0 ? { Range: `bytes=${received}-` } : {},
            });
            if (received > 0 && res.status !== 206) {
                // 服务器不支持续传：丢弃已下载部分，从头开始
                throw new DownloadError('restart', '服务器不支持断点续传');
            }
            if (!res.ok || !res.body) throw new DownloadError('http', `HTTP ${res.status}`);
            let lastReport = 0;
            const meter = new Transform({
                transform(chunk, _enc, cb) {
                    arm();
                    received += chunk.length;
                    if (received > asset.bytes) return cb(new DownloadError('integrity', '文件大小超出预期'));
                    hash.update(chunk);
                    const now = Date.now();
                    if (now - lastReport >= PROGRESS_INTERVAL_MS) {
                        lastReport = now;
                        report(key, received);
                    }
                    return cb(null, chunk);
                },
            });
            await pipeline(Readable.fromWeb(res.body), meter,
                fs.createWriteStream(part, { flags: 'a', mode: 0o600 }), { signal: attempt.signal });
            report(key, received);
            if (received !== asset.bytes || hash.digest('hex') !== asset.sha256) {
                await fs.promises.rm(part, { force: true }).catch(() => {});
                throw new DownloadError('integrity', `${asset.name} 校验失败`);
            }
            await fs.promises.rename(part, file);
        } catch (err) {
            if (err instanceof DownloadError && err.reason === 'restart') {
                await fs.promises.rm(part, { force: true }).catch(() => {});
            }
            if (stalled && !signal?.aborted) throw new DownloadError('timeout', '下载长时间无响应');
            throw err;
        } finally {
            clearTimeout(watchdog);
            signal?.removeEventListener('abort', abortAll);
        }
    }

    prepare({ source } = {}) {
        if (this.task) return this.task;
        if (this.isInstalled()) {
            this.setState({ phase: 'ready' });
            return Promise.resolve(this.getState());
        }
        const controller = new AbortController();
        this.controller = controller;
        this.task = this.run(controller, source).finally(() => {
            this.task = null;
            this.controller = null;
        });
        return this.task;
    }

    async run(controller, source) {
        const { signal } = controller;
        const list = this.getAssetList();
        const total = list.reduce((sum, item) => sum + item.asset.bytes, 0);
        const done = {};
        const report = (key, bytes) => {
            done[key] = bytes;
            const completedBytes = Object.values(done).reduce((a, b) => a + b, 0);
            this.setState({ phase: 'downloading', resource: key, completedBytes, totalBytes: total });
        };
        try {
            this.setState({ phase: 'checking' });
            const origins = source && source !== 'auto' ? [source] : await this.orderOrigins(signal);
            for (const item of list) {
                try {
                    if (fs.statSync(item.file).size === item.asset.bytes) {
                        done[item.key] = item.asset.bytes;
                        continue;
                    }
                } catch (_) {}
                let lastErr = null;
                for (const origin of origins) {
                    try {
                        // 网络中断/超时/服务器不支持续传：同一下载源从断点（或从头）重试，最多 3 次
                        for (let attempt = 1; ; attempt++) {
                            try {
                                await this.downloadOne(item, origin, signal, report);
                                break;
                            } catch (err) {
                                const r = err?.reason === 'restart' ? 'restart' : classifyError(err);
                                if (attempt >= 3 || !['restart', 'network', 'timeout'].includes(r)) throw err;
                            }
                        }
                        lastErr = null;
                        break;
                    } catch (err) {
                        const reason = classifyError(err);
                        if (reason === 'cancelled' || reason === 'storage') throw err;
                        lastErr = err;
                        done[item.key] = 0;
                    }
                }
                if (lastErr) throw lastErr;
            }
            this.setState({ phase: 'ready' });
        } catch (err) {
            const reason = classifyError(err);
            if (reason === 'cancelled') {
                this.setState({ phase: 'cancelled' });
            } else {
                this.setState({ phase: 'failed', reason, message: String(err?.message || err) });
            }
        }
        return this.getState();
    }

    async cancel() {
        if (!this.controller) return this.getState();
        this.controller.abort();
        try { await this.task; } catch (_) {}
        return this.getState();
    }

    async remove() {
        await this.cancel();
        // Windows 上刚结束的识别进程可能还占着模型文件，带重试删除
        await fs.promises.rm(path.join(this.dataRoot, 'models'), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
        this.setState({ phase: 'unprepared' });
        return this.getState();
    }
}

module.exports = { LocalSttModelManager, ORIGINS };
