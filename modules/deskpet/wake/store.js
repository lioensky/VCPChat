'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const defaults = () => ({ enabled: false, phrases: '', responseText: '嗯，我在，你说。', autoSend: true });

class WakeStore {
    constructor({ appDataRoot, agentDir, tts }) {
        this.root = path.join(appDataRoot, 'deskpet', 'wake');
        this.agentDir = agentDir;
        this.tts = tts;
        this.agents = {};
        this.tail = Promise.resolve();
        this.generating = new Set();
        this.forgotten = new Set();
    }

    validId(id) {
        return typeof id === 'string' && id.length > 0 && id.length < 200 && !/[\\/:\0]/.test(id) && id !== '.' && id !== '..';
    }

    async checkAgent(id) {
        if (!this.validId(id)) throw new Error('无效的助手');
        await fs.access(path.join(this.agentDir, id, 'config.json'));
    }

    async load() {
        try {
            const data = JSON.parse(await fs.readFile(path.join(this.root, 'settings.json'), 'utf8'));
            for (const [id, value] of Object.entries(data.agents || {})) {
                if (this.validId(id)) this.agents[id] = this.normalize(value);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') console.warn('[Wake] 配置读取失败，保持关闭', error.message);
        }
    }

    normalize(value = {}) {
        return {
            enabled: value.enabled === true,
            phrases: String(value.phrases || '').slice(0, 300),
            responseText: typeof value.responseText === 'string' ? value.responseText.slice(0, 100) : defaults().responseText,
            autoSend: value.autoSend !== false,
        };
    }

    get(id) { return { ...defaults(), ...this.agents[id] }; }

    save() {
        const content = JSON.stringify({ version: 1, agents: this.agents }, null, 2);
        const work = this.tail.catch(() => {}).then(async () => {
            await fs.mkdir(this.root, { recursive: true });
            const temporary = path.join(this.root, 'settings.json.tmp');
            await fs.writeFile(temporary, content);
            await fs.rename(temporary, path.join(this.root, 'settings.json'));
        });
        this.tail = work;
        return work;
    }

    async update(id, patch) {
        await this.checkAgent(id);
        const before = this.agents[id];
        this.agents[id] = this.normalize({ ...this.get(id), ...patch });
        try { await this.save(); }
        catch (error) {
            if (before) this.agents[id] = before;
            else delete this.agents[id];
            throw error;
        }
        return this.get(id);
    }

    async identity(id) {
        const config = JSON.parse(await fs.readFile(path.join(this.agentDir, id, 'config.json'), 'utf8'));
        const text = this.get(id).responseText.trim();
        const options = {
            text,
            voice: config.ttsVoicePrimary || '',
            speed: Number(config.ttsSpeed) || 1,
            directorPrompts: Array.isArray(config.ttsDirectorPrompts) ? config.ttsDirectorPrompts : [],
        };
        const provider = await this.tts.generationIdentity();
        const signature = crypto.createHash('sha256').update(JSON.stringify({ options, provider })).digest('hex');
        return { options, signature };
    }

    directory(id) {
        return path.join(this.root, crypto.createHash('sha256').update(id).digest('hex'));
    }

    async audioStatus(id) {
        try {
            const identity = await this.identity(id);
            const metadata = JSON.parse(await fs.readFile(path.join(this.directory(id), 'audio.json'), 'utf8'));
            if (!/^[a-f0-9]{64}$/.test(metadata.signature)) return { ready: false, stale: false };
            const stat = await fs.stat(path.join(this.directory(id), `${metadata.signature}.audio`));
            return { ready: stat.size > 0 && metadata.signature === identity.signature, stale: metadata.signature !== identity.signature };
        } catch { return { ready: false, stale: false }; }
    }

    async generate(id) {
        await this.checkAgent(id);
        if (this.generating.has(id)) throw new Error('正在生成，请稍候');
        this.generating.add(id);
        try {
            const { options, signature } = await this.identity(id);
            if (!options.text) throw new Error('请填写回应文案');
            if (!options.voice) throw new Error('请先在助手设置中选择 TTS 音色');
            const result = await this.tts.generateAudio(options);
            if (!result.audioBuffer?.length || result.audioBuffer.length > 8 * 1024 * 1024) throw new Error('回应音频为空或过大');
            if (this.forgotten.has(id) || (await this.identity(id)).signature !== signature) throw new Error('生成期间配置已变更或助手已删除，请重新生成');
            const dir = this.directory(id);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(path.join(dir, `${signature}.audio.tmp`), result.audioBuffer);
            if (this.forgotten.has(id)) {
                await fs.rm(dir, { recursive: true, force: true });
                throw new Error('助手已删除');
            }
            await fs.rename(path.join(dir, `${signature}.audio.tmp`), path.join(dir, `${signature}.audio`));
            await fs.writeFile(path.join(dir, 'audio.json.tmp'), JSON.stringify({ signature, playbackRate: result.playbackRate, generatedAt: Date.now() }));
            await fs.rename(path.join(dir, 'audio.json.tmp'), path.join(dir, 'audio.json'));
            for (const name of await fs.readdir(dir)) {
                if (/^[a-f0-9]{64}\.audio$/.test(name) && name !== `${signature}.audio`) await fs.rm(path.join(dir, name), { force: true });
            }
            return { ready: true, stale: false };
        } finally { this.generating.delete(id); }
    }

    async audio(id) {
        if (!(await this.audioStatus(id)).ready) return null;
        const metadata = JSON.parse(await fs.readFile(path.join(this.directory(id), 'audio.json'), 'utf8'));
        if (!/^[a-f0-9]{64}$/.test(metadata.signature)) return null;
        const bytes = await fs.readFile(path.join(this.directory(id), `${metadata.signature}.audio`));
        return { audioData: bytes.toString('base64'), playbackRate: metadata.playbackRate || 1 };
    }

    async forget(id) {
        this.forgotten.add(id);
        delete this.agents[id];
        await this.save();
        await fs.rm(this.directory(id), { recursive: true, force: true });
    }
}

module.exports = { WakeStore, defaults };