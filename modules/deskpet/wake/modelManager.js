'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
const { spawn } = require('child_process');
const manifest = require('./assets.json');

const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;

class WakeModelManager {
    constructor({ appDataRoot, onState = () => {}, fetchImpl = globalThis.fetch }) {
        this.root = path.join(appDataRoot, 'VoiceModels', 'kws', manifest.id);
        this.onState = onState;
        this.fetch = fetchImpl;
        this.task = null;
        this.controller = null;
        this.state = { phase: 'unprepared' };
    }

    paths() {
        return Object.fromEntries(manifest.files.map(file => [file.key, path.join(this.root, file.name)]));
    }

    installed() {
        return manifest.files.every(file => {
            try { return fs.statSync(path.join(this.root, file.name)).size === file.bytes; }
            catch { return false; }
        });
    }

    status() {
        return this.task ? { ...this.state } : { phase: this.installed() ? 'ready' : 'unprepared' };
    }

    publish(state) {
        this.state = state;
        this.onState({ ...state });
    }

    async verify(directory) {
        for (const file of manifest.files) {
            const target = path.join(directory, file.name);
            const stat = await fs.promises.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes) throw new Error(`模型文件不完整：${file.name}`);
            const hash = crypto.createHash('sha256');
            for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
            if (hash.digest('hex') !== file.sha256) throw new Error(`模型校验失败：${file.name}`);
        }
    }

    async commit(directory) {
        await this.verify(directory);
        const backup = `${this.root}.previous`;
        await fs.promises.rm(backup, { recursive: true, force: true });
        let moved = false;
        try {
            await fs.promises.rename(this.root, backup);
            moved = true;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try {
            await fs.promises.rename(directory, this.root);
        } catch (error) {
            if (moved) await fs.promises.rename(backup, this.root);
            throw error;
        }
        await fs.promises.rm(backup, { recursive: true, force: true });
    }

    prepare(sourceDirectory = null) {
        if (this.task) return this.task;
        this.controller = new AbortController();
        const signal = this.controller.signal;
        this.task = this.run(sourceDirectory, signal).finally(() => {
            this.task = null;
            this.controller = null;
        });
        return this.task;
    }

    async run(sourceDirectory, signal) {
        const parent = path.dirname(this.root);
        await fs.promises.mkdir(parent, { recursive: true });
        const staging = await fs.promises.mkdtemp(path.join(parent, '.kws-install-'));
        try {
            this.publish({ phase: 'checking' });
            const output = path.join(staging, 'model');
            await fs.promises.mkdir(output);
            if (sourceDirectory) {
                await this.verify(sourceDirectory);
                for (const file of manifest.files) {
                    signal.throwIfAborted();
                    await fs.promises.copyFile(path.join(sourceDirectory, file.name), path.join(output, file.name));
                }
            } else {
                const archive = path.join(staging, 'model.tar.bz2');
                let bytes = 0;
                const response = await this.fetch(manifest.archiveUrl, {
                    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
                });
                if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
                const total = Number(response.headers.get('content-length')) || null;
                const manager = this;
                const meter = new Transform({
                    transform(chunk, _encoding, callback) {
                        bytes += chunk.length;
                        if (bytes > MAX_ARCHIVE_BYTES) return callback(new Error('下载文件超出大小限制'));
                        manager.publish({ phase: 'downloading', completedBytes: bytes, totalBytes: total });
                        callback(null, chunk);
                    },
                });
                await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(archive), { signal });
                this.publish({ phase: 'extracting' });
                // 只提取固定白名单成员，不展开归档提供的路径或链接。
                for (const file of manifest.files) {
                    signal.throwIfAborted();
                    await this.extractMember(archive, `${manifest.directory}/${file.name}`, path.join(output, file.name), file.bytes, signal);
                }
            }
            signal.throwIfAborted();
            await this.commit(output);
            this.publish({ phase: 'ready' });
        } catch (error) {
            this.publish({ phase: signal.aborted ? 'cancelled' : 'failed', error: error.message });
        } finally {
            await fs.promises.rm(staging, { recursive: true, force: true });
        }
        return { ...this.state };
    }

    async extractMember(archive, member, destination, expectedBytes, signal) {
        // Windows 11 自带 bsdtar；其他平台使用系统 tar。缺少工具时提示本地导入。
        const child = spawn('tar', ['-xOf', archive, member], { windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
        const exited = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', code => code === 0 ? resolve() : reject(new Error(`模型解压失败，请使用本地导入：${stderr}`)));
        });
        let size = 0;
        const limit = new Transform({
            transform(chunk, _encoding, callback) {
                size += chunk.length;
                callback(size > expectedBytes ? new Error('归档成员超过预期大小') : null, chunk);
            },
        });
        try {
            await Promise.all([exited, pipeline(child.stdout, limit, fs.createWriteStream(destination), { signal })]);
        } finally { if (child.exitCode === null) child.kill(); }
    }

    async cancel() {
        this.controller?.abort();
        await this.task;
        return { ...this.state };
    }
}

module.exports = { WakeModelManager };