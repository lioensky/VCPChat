'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_ROOT = path.resolve(__dirname, '../../AppData/sovits5cpp');
const LANGUAGES = ['auto', 'auto_yue', 'zh', 'all_zh', 'en', 'ja', 'all_ja', 'ko', 'all_ko', 'yue', 'all_yue'];
const ascii = value => /^[\x20-\x7e]+$/.test(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function validateWav(data) {
    if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('请导入标准 PCM WAV 音频');
    }
    let format, channels, rate, bits, bytes = 0;
    for (let offset = 12; offset + 8 <= data.length;) {
        const size = data.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (start + size > data.length) throw new Error('WAV 数据被截断');
        const tag = data.toString('ascii', offset, offset + 4);
        if (tag === 'fmt ' && size >= 16) {
            format = data.readUInt16LE(start);
            channels = data.readUInt16LE(start + 2);
            rate = data.readUInt32LE(start + 4);
            bits = data.readUInt16LE(start + 14);
        }
        if (tag === 'data') bytes += size;
        offset = start + size + (size % 2);
    }
    if (format !== 1 || !channels || !rate || ![8, 16, 24, 32].includes(bits) || !bytes) {
        throw new Error('仅支持未压缩 PCM WAV（8/16/24/32 bit）');
    }
    const duration = bytes / (channels * rate * bits / 8);
    if (duration < 3 || duration > 10) throw new Error(`参考音频须为 3–10 秒，当前 ${duration.toFixed(2)} 秒`);
    return { duration, channels, rate, bits };
}

function normalizePreset(input) {
    if (!input || typeof input !== 'object') throw new Error('预设格式无效');
    const text = (key, fallback = '') => String(input[key] ?? fallback).trim();
    const p = {
        id: text('id'), name: text('name'), audio: text('audio'),
        promptText: text('promptText'), emotion: text('emotion', '默认'),
        promptLang: text('promptLang', 'all_zh'), textLang: text('textLang', 'auto'),
        speed: Number(input.speed ?? 1), engineVoice: text('engineVoice', 'default'),
        sampleSteps: Number(input.sampleSteps ?? 4)
    };
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(p.id)) throw new Error('预设 ID 必须为 ASCII 字母、数字、下划线或短横线');
    if (!p.name || p.name.length > 120 || !p.promptText || p.promptText.length > 10000) throw new Error('必须填写暴露模型名和准确的参考文本');
    if (!/^[a-f0-9]{64}\.wav$/.test(p.audio)) throw new Error('音频必须先导入托管目录');
    if (![p.promptLang, p.textLang].every(lang => LANGUAGES.includes(lang))) throw new Error('不支持的语言代码');
    if (!Number.isFinite(p.speed) || p.speed < 0.1 || p.speed > 3) throw new Error('语速范围为 0.1–3');
    if (![4, 8, 16, 32].includes(p.sampleSteps)) throw new Error('采样步数须为 4/8/16/32');
    if (!p.engineVoice || p.engineVoice.length > 120) throw new Error('引擎 voice 无效');
    return p;
}

class GsvPresetStore {
    constructor(root = DEFAULT_ROOT) {
        this.root = root;
        this.file = path.join(root, 'presets.json');
        this.writes = Promise.resolve();
    }
    async read() {
        let raw;
        try { raw = JSON.parse(await fs.readFile(this.file, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return { version: 1, presets: [] }; throw error; }
        if (raw.version !== 1 || !Array.isArray(raw.presets)) throw new Error('不支持的预设 JSON 版本');
        const presets = raw.presets.map(normalizePreset);
        if (new Set(presets.map(p => p.id)).size !== presets.length ||
            new Set(presets.map(p => p.name)).size !== presets.length) throw new Error('预设 ID 或暴露模型名重复');
        return { version: 1, presets };
    }
    async importAudio(data) {
        if (data.length > 20 * 1024 * 1024) throw new Error('参考音频不能超过 20 MB');
        const info = validateWav(data);
        const audio = `${digest(data)}.wav`;
        await fs.mkdir(path.join(this.root, 'refs'), { recursive: true });
        await fs.writeFile(path.join(this.root, 'refs', audio), data);
        return { audio, ...info };
    }
    mutate(fn) {
        const task = this.writes.catch(() => {}).then(async () => {
            const doc = await this.read();
            await fn(doc.presets);
            await fs.mkdir(this.root, { recursive: true });
            const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
            try {
                await fs.writeFile(tmp, JSON.stringify(doc, null, 2), { flag: 'wx' });
                await fs.rename(tmp, this.file);
            } finally { await fs.rm(tmp, { force: true }); }
            return doc;
        });
        this.writes = task;
        return task;
    }
    save(input) {
        const preset = normalizePreset(input);
        return this.mutate(async presets => {
            await this.audio(preset);
            if (presets.some(p => p.name === preset.name && p.id !== preset.id)) throw new Error('暴露模型名重复');
            const i = presets.findIndex(p => p.id === preset.id);
            if (i < 0) presets.push(preset); else presets[i] = preset;
        });
    }
    remove(id) {
        return this.mutate(presets => {
            const i = presets.findIndex(p => p.id === id);
            if (i < 0) throw new Error('预设不存在');
            presets.splice(i, 1);
        });
    }
    async resolve(voice) {
        const id = String(voice || '').replace(/^gsv:/, '');
        const p = (await this.read()).presets.find(p => p.id === id);
        if (!p) throw new Error('GSV 音色不存在，请在 sovits5cppmanager 创建并刷新音色列表');
        return p;
    }
    async audio(preset) {
        const p = normalizePreset(preset);
        const file = path.join(this.root, 'refs', p.audio);
        const stat = await fs.stat(file);
        if (stat.size > 20 * 1024 * 1024) throw new Error('参考音频不能超过 20 MB');
        const data = await fs.readFile(file);
        validateWav(data);
        if (`${digest(data)}.wav` !== p.audio) throw new Error('参考音频内容发生变化，请重新导入');
        return data;
    }
}

function endpoint(baseUrl) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('GSV URL 无效');
    return url.href.replace(/\/+$/, '');
}

async function synthesize({ store, preset, baseUrl, apiKey = '', text, speed = 1, signal }) {
    const base = endpoint(baseUrl);
    const audio = await store.audio(preset);
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const request = async (url, options) => {
        const response = await fetch(url, {
            ...options, redirect: 'error',
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)
        });
        if (!response.ok) throw new Error(`GSV HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
        return response;
    };
    const upload = await request(`${base}/reference?name=${preset.audio}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav' }, body: audio
    });
    const reference = (await upload.json()).path;
    if (typeof reference !== 'string' || !ascii(reference)) {
        throw new Error('GSV 返回了非 ASCII 参考路径：请将引擎及其 TEMP/TMP 目录设置为纯英文路径后重启引擎');
    }
    const factor = Number(speed) * preset.speed;
    if (!Number.isFinite(factor) || factor < 0.1 || factor > 3) throw new Error('预设语速 × Agent 语速必须在 0.1–3 之间');
    const response = await request(`${base}/tts`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text, text_lang: preset.textLang, ref_audio_path: reference,
            prompt_text: preset.promptText, prompt_lang: preset.promptLang,
            voice: preset.engineVoice, speed_factor: factor,
            text_split_method: 'cut1', sample_steps: preset.sampleSteps,
            top_k: 5, top_p: 1, temperature: 1, repetition_penalty: 1.35,
            seed: -1, dbcache: 'off', skip_first_step: 0
        })
    });
    if (!(response.headers.get('content-type') || '').includes('audio/')) throw new Error('GSV 未返回音频');
    const result = Buffer.from(await response.arrayBuffer());
    if (result.length < 44 || result.toString('ascii', 0, 4) !== 'RIFF' || result.toString('ascii', 8, 12) !== 'WAVE') throw new Error('GSV 返回了无效 WAV');
    return result;
}

module.exports = { GsvPresetStore, normalizePreset, validateWav, synthesize, endpoint, LANGUAGES, DEFAULT_ROOT, digest };