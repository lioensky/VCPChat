const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SOVITS_API_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_MIMO_API_URL = 'https://www.dmxapi.cn/v1/chat/completions';
const DEFAULT_NETWORK_TTS_MODEL = 'mimo-v2.5-tts';
const MIMO_VOICE_DESIGN_MODEL = `${DEFAULT_NETWORK_TTS_MODEL}-voicedesign`;
const MIMO_VOICE_CLONE_MODEL = `${DEFAULT_NETWORK_TTS_MODEL}-voiceclone`;
const MIMO_NATURAL_CONTROL_VOICE = 'mimo:natural-control';
const MIMO_CLONE_VOICE_PREFIX = 'mimo:clone:';
const MIMO_SAMPLE_RATE = 24000;
const MIMO_CLONE_MEMORY_LIMIT = 2;
const MIMO_CLONE_AUDIO_TYPES = Object.freeze({
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.mpeg': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.webm': 'audio/webm'
});
const MIMO_PRESET_VOICES = Object.freeze([
    { id: 'mimo_default', voice: 'mimo_default', displayName: 'mimo_default · 默认音色', type: 'preset' },
    { id: '冰糖', voice: '冰糖', displayName: '冰糖 · 中文女声', type: 'preset' },
    { id: '茉莉', voice: '茉莉', displayName: '茉莉 · 中文女声', type: 'preset' },
    { id: '苏打', voice: '苏打', displayName: '苏打 · 中文男声', type: 'preset' },
    { id: '白桦', voice: '白桦', displayName: '白桦 · 中文男声', type: 'preset' },
    { id: 'Mia', voice: 'Mia', displayName: 'Mia · 英文女声', type: 'preset' },
    { id: 'Chloe', voice: 'Chloe', displayName: 'Chloe · 英文女声', type: 'preset' },
    { id: 'Milo', voice: 'Milo', displayName: 'Milo · 英文男声', type: 'preset' },
    { id: 'Dean', voice: 'Dean', displayName: 'Dean · 英文男声', type: 'preset' }
]);
// 修正路径问题，确保缓存和模型列表都在项目内的AppData目录
const PROJECT_ROOT = path.join(__dirname, '..'); // 更可靠的方式获取项目根目录
const APP_DATA_ROOT_IN_PROJECT = path.join(PROJECT_ROOT, 'AppData');
const LOCAL_MODELS_CACHE_PATH = path.join(APP_DATA_ROOT_IN_PROJECT, 'sovits_local_models.json');
const NETWORK_MODELS_CACHE_PATH = path.join(APP_DATA_ROOT_IN_PROJECT, 'sovits_network_models.json');
const TTS_CACHE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'tts_cache');
const MIMO_CLONE_AUDIO_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'mimotts');

class SovitsTTS {
    constructor(settingsManager = null) {
        this.settingsManager = settingsManager;
        this.isSpeaking = false;
        this.speechQueue = [];
        this.currentSpeechItemId = null; // 用于跟踪当前朗读的气泡ID
        this.sessionId = 0; // 新增：会话ID，用于作废过时的播放事件
        // Map 保持插入顺序，用作最多两个参考音频的进程内 LRU。
        // value 中保存文件签名，用户替换同名文件后不会继续使用旧数据。
        this.cloneAudioMemory = new Map();
        this.initCacheDir();
    }

    async getRuntimeConfig() {
        let settings = null;
        try {
            settings = this.settingsManager?.readSettings
                ? await this.settingsManager.readSettings()
                : null;
        } catch (error) {
            console.warn('[TTS] Failed to read global settings, using defaults:', error.message);
        }

        const voiceMode = settings?.voiceMode === 'network' ? 'network' : 'local';
        const localConfig = settings?.voiceLocalSettings || {};
        const networkConfig = settings?.voiceNetworkSettings || {};
        const configuredUrl = voiceMode === 'network'
            ? String(networkConfig.providerUrl || '').trim()
            : String(localConfig.sovitsUrl || '').trim();

        return {
            voiceMode,
            baseUrl: (configuredUrl || (voiceMode === 'network' ? DEFAULT_MIMO_API_URL : DEFAULT_SOVITS_API_BASE_URL))
                .replace(/\/+$/, ''),
            apiKey: voiceMode === 'network'
                ? String(networkConfig.providerKey || '')
                : String(localConfig.sovitsKey || '')
        };
    }

    normalizeMimoEndpoint(url) {
        const normalized = String(url || DEFAULT_MIMO_API_URL).trim().replace(/\/+$/, '');
        return /\/chat\/completions$/i.test(normalized)
            ? normalized
            : `${normalized}/chat/completions`;
    }

    pcm16ToWav(pcmBuffer, sampleRate = MIMO_SAMPLE_RATE) {
        const wav = Buffer.alloc(44 + pcmBuffer.length);
        wav.write('RIFF', 0);
        wav.writeUInt32LE(36 + pcmBuffer.length, 4);
        wav.write('WAVE', 8);
        wav.write('fmt ', 12);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(sampleRate, 24);
        wav.writeUInt32LE(sampleRate * 2, 28);
        wav.writeUInt16LE(2, 32);
        wav.writeUInt16LE(16, 34);
        wav.write('data', 36);
        wav.writeUInt32LE(pcmBuffer.length, 40);
        pcmBuffer.copy(wav, 44);
        return wav;
    }

    _decodeCloneVoiceFilename(voice) {
        if (!String(voice || '').startsWith(MIMO_CLONE_VOICE_PREFIX)) return '';
        try {
            return decodeURIComponent(String(voice).slice(MIMO_CLONE_VOICE_PREFIX.length));
        } catch {
            return '';
        }
    }

    async _scanCloneAudioFiles() {
        await fs.mkdir(MIMO_CLONE_AUDIO_DIR, { recursive: true });
        const entries = await fs.readdir(MIMO_CLONE_AUDIO_DIR, { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && MIMO_CLONE_AUDIO_TYPES[path.extname(entry.name).toLowerCase()])
            .map(entry => entry.name)
            .sort((left, right) => left.localeCompare(right, 'zh-CN', {
                numeric: true,
                sensitivity: 'base'
            }));
    }

    async _loadCloneAudioDataUri(filename) {
        const availableFiles = await this._scanCloneAudioFiles();
        if (!availableFiles.includes(filename)) {
            throw new Error(`MiMo 克隆参考音频不存在或格式不受支持：${filename}`);
        }

        const filePath = path.join(MIMO_CLONE_AUDIO_DIR, filename);
        const stats = await fs.stat(filePath);
        const signature = `${stats.size}:${stats.mtimeMs}`;
        const cached = this.cloneAudioMemory.get(filename);
        if (cached?.signature === signature) {
            // 删除后重插，把最近访问项移动到 Map 末尾。
            this.cloneAudioMemory.delete(filename);
            this.cloneAudioMemory.set(filename, cached);
            return cached.dataUri;
        }

        const extension = path.extname(filename).toLowerCase();
        const mimeType = MIMO_CLONE_AUDIO_TYPES[extension];
        const audioBuffer = await fs.readFile(filePath);
        const dataUri = `data:${mimeType};base64,${audioBuffer.toString('base64')}`;
        this.cloneAudioMemory.delete(filename);
        this.cloneAudioMemory.set(filename, { signature, dataUri });

        while (this.cloneAudioMemory.size > MIMO_CLONE_MEMORY_LIMIT) {
            const leastRecentlyUsed = this.cloneAudioMemory.keys().next().value;
            this.cloneAudioMemory.delete(leastRecentlyUsed);
        }
        console.log(`[TTS] MiMo clone reference loaded into memory: ${filename} (${this.cloneAudioMemory.size}/${MIMO_CLONE_MEMORY_LIMIT})`);
        return dataUri;
    }

    async requestMimoSpeech(runtimeConfig, text, voice, directorPrompts = [], onAudioChunk = null) {
        if (!runtimeConfig.apiKey) {
            throw new Error('网络 MiMo TTS 未配置 API Key');
        }

        const prompts = Array.isArray(directorPrompts)
            ? directorPrompts.map(item => String(item || '').trim()).filter(Boolean)
            : [];
        const userPrompt = prompts.join('\n\n');
        const cloneFilename = this._decodeCloneVoiceFilename(voice);
        const mode = cloneFilename
            ? 'voiceclone'
            : voice === MIMO_NATURAL_CONTROL_VOICE
                ? 'voicedesign'
                : 'preset';
        const messages = [];

        // 三种模式都允许一条合并后的自然语言 user 指令：
        // preset 用于配合预置 voice 控制演绎；voiceclone 用于微调克隆音色的
        // 发音风格；voicedesign 则把它作为生成音色的核心描述。
        if (userPrompt) {
            messages.push({ role: 'user', content: userPrompt });
        }
        if (mode === 'voicedesign' && !userPrompt) {
            throw new Error('MiMo 自然语言控制模式需要至少一条导演提示词');
        }
        messages.push({ role: 'assistant', content: text });

        const audio = { format: 'pcm16' };
        let model = DEFAULT_NETWORK_TTS_MODEL;
        if (mode === 'preset') {
            audio.voice = voice || 'mimo_default';
        } else if (mode === 'voicedesign') {
            model = MIMO_VOICE_DESIGN_MODEL;
        } else {
            model = MIMO_VOICE_CLONE_MODEL;
            audio.voice = await this._loadCloneAudioDataUri(cloneFilename);
        }

        const payload = {
            model,
            messages,
            audio,
            stream: true
        };
        console.log('[TTS] MiMo request:', JSON.stringify({
            endpoint: this.normalizeMimoEndpoint(runtimeConfig.baseUrl),
            mode,
            model: payload.model,
            cloneFilename: cloneFilename || undefined,
            messageRoles: payload.messages.map(message => message.role),
            userPromptLength: userPrompt.length,
            assistantTextLength: text.length,
            audio: {
                ...payload.audio,
                voice: mode === 'voiceclone' ? '[reference audio hidden]' : payload.audio.voice
            },
            stream: payload.stream
        }));

        const response = await axios.post(this.normalizeMimoEndpoint(runtimeConfig.baseUrl), payload, {
            responseType: 'stream',
            headers: {
                ...this.buildHeaders(runtimeConfig.apiKey),
                'Content-Type': 'application/json',
                Accept: 'text/event-stream'
            },
            validateStatus: () => true
        });

        if (response.status < 200 || response.status >= 300) {
            const chunks = [];
            for await (const chunk of response.data) chunks.push(Buffer.from(chunk));
            throw new Error(`MiMo API HTTP ${response.status}: ${Buffer.concat(chunks).toString('utf8')}`);
        }

        const pcmChunks = [];
        const processSseLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) return;
            const value = trimmed.slice(5).trim();
            if (!value || value === '[DONE]') return;
            try {
                const audioData = JSON.parse(value)?.choices?.[0]?.delta?.audio?.data;
                if (!audioData) return;
                const pcmChunk = Buffer.from(audioData, 'base64');
                pcmChunks.push(pcmChunk);
                if (typeof onAudioChunk === 'function') {
                    onAudioChunk(this.pcm16ToWav(pcmChunk));
                }
            } catch {
                // 忽略 SSE 心跳或非 JSON 扩展事件。
            }
        };

        let pending = '';
        for await (const chunk of response.data) {
            pending += Buffer.from(chunk).toString('utf8');
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() || '';
            lines.forEach(processSseLine);
        }
        if (pending.trim()) processSseLine(pending);

        if (!pcmChunks.length) {
            throw new Error('MiMo API 流结束，但没有返回音频数据');
        }
        return this.pcm16ToWav(Buffer.concat(pcmChunks));
    }

    buildHeaders(apiKey = '') {
        const headers = {};
        if (apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
        }
        return headers;
    }

    async initCacheDir() {
        try {
            await Promise.all([
                fs.mkdir(TTS_CACHE_DIR, { recursive: true }),
                fs.mkdir(MIMO_CLONE_AUDIO_DIR, { recursive: true })
            ]);
        } catch (error) {
            console.error("无法创建TTS缓存目录:", error);
        }
    }

    /**
     * 获取模型列表，优先从缓存读取
     * @param {boolean} forceRefresh 是否强制刷新缓存
     * @returns {Promise<Object>} 模型列表
     */
    _normalizeNetworkVoiceItems(items) {
        if (!Array.isArray(items)) {
            return [];
        }

        return items.map(item => ({
            id: item?.id || item?.uri || item?.voice,
            voice: item?.voice || item?.uri || item?.id,
            displayName: item?.displayName || item?.customName || item?.name || item?.voice || item?.uri || item?.id,
            uri: item?.uri || item?.voice || item?.id || '',
            type: item?.type || 'remote',
            raw: item?.raw || item
        })).filter(item => item.voice);
    }

    _extractNetworkModelsFromCache(payload) {
        if (Array.isArray(payload)) {
            return this._normalizeNetworkVoiceItems(payload);
        }

        if (Array.isArray(payload?.mergedVoiceOptions)) {
            return this._normalizeNetworkVoiceItems(payload.mergedVoiceOptions);
        }

        if (Array.isArray(payload?.models)) {
            const flattened = payload.models.flatMap(model => {
                if (Array.isArray(model?.mergedVoiceOptions) && model.mergedVoiceOptions.length) {
                    return model.mergedVoiceOptions;
                }
                const defaults = Array.isArray(model?.defaults) ? model.defaults : [];
                const remoteVoices = Array.isArray(model?.remoteVoices) ? model.remoteVoices : [];
                return [...defaults, ...remoteVoices];
            });
            return this._normalizeNetworkVoiceItems(flattened);
        }

        const defaults = Array.isArray(payload?.defaults) ? payload.defaults : [];
        const remoteVoices = Array.isArray(payload?.remoteVoices) ? payload.remoteVoices : [];
        return this._normalizeNetworkVoiceItems([...defaults, ...remoteVoices]);
    }

    /**
     * 获取模型列表，优先从缓存读取
     * @param {boolean} forceRefresh 是否强制刷新缓存
     * @returns {Promise<Object>} 模型列表
     */
    async getModels(forceRefresh = false) {
        const runtimeConfig = await this.getRuntimeConfig();
        const isNetwork = runtimeConfig.voiceMode === 'network';
        const cachePath = isNetwork ? NETWORK_MODELS_CACHE_PATH : LOCAL_MODELS_CACHE_PATH;

        // 网络模式同时提供 MiMo 预置音色、独立的自然语言控制模式，以及
        // AppData/mimotts 中扫描到的本地参考音频。克隆文件只暴露编码后的
        // 逻辑 ID，后续加载仍通过扫描结果校验，避免任意路径读取。
        if (isNetwork) {
            const cloneFiles = await this._scanCloneAudioFiles();
            const mergedVoiceOptions = [
                ...MIMO_PRESET_VOICES.map(item => ({ ...item })),
                {
                    id: MIMO_NATURAL_CONTROL_VOICE,
                    voice: MIMO_NATURAL_CONTROL_VOICE,
                    displayName: '自然语言控制 · 不发送预置 voice',
                    type: 'voicedesign'
                },
                ...cloneFiles.map(filename => ({
                    id: `${MIMO_CLONE_VOICE_PREFIX}${encodeURIComponent(filename)}`,
                    voice: `${MIMO_CLONE_VOICE_PREFIX}${encodeURIComponent(filename)}`,
                    displayName: `${filename} · 克隆音色`,
                    filename,
                    type: 'voiceclone'
                }))
            ];
            if (forceRefresh) {
                await fs.writeFile(NETWORK_MODELS_CACHE_PATH, JSON.stringify({
                    providerUrl: this.normalizeMimoEndpoint(runtimeConfig.baseUrl),
                    modelId: DEFAULT_NETWORK_TTS_MODEL,
                    defaults: MIMO_PRESET_VOICES,
                    cloneDirectory: MIMO_CLONE_AUDIO_DIR,
                    cloneFiles,
                    remoteVoices: [],
                    mergedVoiceOptions,
                    updatedAt: new Date().toISOString()
                }, null, 2));
            }
            return mergedVoiceOptions;
        }

        if (!forceRefresh) {
            try {
                const cachedModels = await fs.readFile(cachePath, 'utf-8');
                console.log('从缓存加载本地 SoVITS 模型列表。');
                return JSON.parse(cachedModels);
            } catch (error) {
                console.log('本地 SoVITS 模型缓存不存在或读取失败，将从 API 获取。');
            }
        }

        try {
            console.log(`正在从 ${runtimeConfig.baseUrl}/models 获取本地模型列表...`);
            const response = await axios.post(`${runtimeConfig.baseUrl}/models`, { version: "v2ProPlus" }, {
                headers: this.buildHeaders(runtimeConfig.apiKey)
            });

            if (response.data && response.data.msg === "获取成功" && response.data.models) {
                await fs.writeFile(LOCAL_MODELS_CACHE_PATH, JSON.stringify(response.data.models, null, 2));
                console.log('本地 SoVITS 模型列表已获取并缓存。');
                return response.data.models;
            } else {
                console.error("获取本地 SoVITS 模型列表失败: ", response.data);
                return null;
            }
        } catch (error) {
            console.error('请求本地 SoVITS 模型列表 API 时出错: ', error.message);
            try {
                const cachedModels = await fs.readFile(cachePath, 'utf-8');
                const parsedCache = JSON.parse(cachedModels);
                return parsedCache;
            } catch (e) {
                return null;
            }
        }
    }

    /**
     * 将文本转换为语音并返回音频数据
     * @param {string} text 要转换的文本
     * @param {string} voice 使用的模型名称
     * @param {number} speed 语速
     * @param {string[]} directorPrompts MiMo 自然语言导演提示词
     * @param {Function|null} onAudioChunk 网络模式收到 PCM 块后的即时回调
     * @returns {Promise<{audioBuffer: Buffer, streamed: boolean}|null>} 音频结果
     */
    async textToSpeech(text, voice, speed, directorPrompts = [], onAudioChunk = null) {
        const runtimeConfig = await this.getRuntimeConfig();
        const promptSignature = Array.isArray(directorPrompts) ? directorPrompts.join('\n') : '';
        const cacheKey = crypto.createHash('md5')
            .update([runtimeConfig.voiceMode, runtimeConfig.baseUrl, text, voice, speed, promptSignature].join('\0'))
            .digest('hex');
        const cacheExtension = runtimeConfig.voiceMode === 'network' ? 'wav' : 'mp3';
        const cacheFilePath = path.join(TTS_CACHE_DIR, `${cacheKey}.${cacheExtension}`);
        console.log(`[TTS] 尝试缓存路径: ${cacheFilePath}`);

        // 1. 检查缓存
        try {
            const cachedAudio = await fs.readFile(cacheFilePath);
            console.log(`[TTS] 成功从缓存加载音频: ${cacheKey}`);
            return { audioBuffer: cachedAudio, streamed: false };
        } catch (error) {
            console.log(`[TTS] 缓存未命中或读取失败: ${error.message}`);
        }

        // 2. 如果没有缓存，请求API
        try {
            if (runtimeConfig.voiceMode === 'network') {
                const audioBuffer = await this.requestMimoSpeech(
                    runtimeConfig,
                    text,
                    voice,
                    directorPrompts,
                    onAudioChunk
                );
                await fs.writeFile(cacheFilePath, audioBuffer);
                return { audioBuffer, streamed: typeof onAudioChunk === 'function' };
            }

            let payload;
            let endpoint;
            {
                let promptLang = "中文";
                if (voice.includes('日语')) {
                    promptLang = "日语";
                }

                payload = {
                    model: "tts-v2ProPlus",
                    input: text,
                    voice: voice,
                    response_format: "mp3",
                    speed: speed,
                    other_params: {
                        text_lang: promptLang === "日语" ? "日语" : "中英混合",
                        prompt_lang: promptLang,
                        emotion: "默认",
                        text_split_method: "按标点符号切",
                    }
                };
                endpoint = '/v1/audio/speech';
            }

            console.log('[TTS] 发送本地 SoVITS API 请求:', JSON.stringify({
                baseUrl: runtimeConfig.baseUrl,
                payload
            }));

            const response = await axios.post(`${runtimeConfig.baseUrl}${endpoint}`, payload, {
                responseType: 'arraybuffer',
                headers: this.buildHeaders(runtimeConfig.apiKey),
                validateStatus: () => true
            });

            if (response.status < 200 || response.status >= 300) {
                const errorBody = Buffer.from(response.data || []).toString('utf8');
                console.error("[TTS] 请求语音合成API时出错:", `status=${response.status}`, errorBody);
                return null;
            }

            console.log(`[TTS]收到API响应: 状态 ${response.status}, 类型 ${response.headers['content-type']}`);

            if ((response.headers['content-type'] || '').includes('audio/')) {
                const audioBuffer = Buffer.from(response.data);
                try {
                    await fs.writeFile(cacheFilePath, audioBuffer);
                    console.log(`[TTS] 音频已成功缓存: ${cacheKey}`);
                } catch (cacheError) {
                    console.error("[TTS] 保存音频缓存失败:", cacheError);
                }
                return { audioBuffer, streamed: false };
            } else {
                const nonAudioBody = Buffer.from(response.data || []).toString('utf8');
                console.error("[TTS] API没有返回正确的音频文件类型。", nonAudioBody);
                return null;
            }
        } catch (error) {
            console.error("[TTS] 请求语音合成API时出错: ", error.message);
            return null;
        }
    }

    /**
     * 将长文本分割成更小的块以进行流式TTS。
     * 策略：
     * 1. 将第一段分割为“第一句”和“段落的其余部分”。
     * 2. 如果第一句以感叹号结尾且后面还有内容，则会尝试将下一句也合并进来，以避免过短的语气词片段。
     * 3. 后续段落保持原样。
     * 这样做可以尽快发送第一个音频块，以减少可感知的延迟。
     * @param {string} text 要分割的原始文本。
     * @returns {string[]} 文本块的数组。
     */
    splitText(text) {
        const trimmedText = text.trim();
        if (!trimmedText) {
            return [];
        }

        // 1. 找到第一个换行符的位置，以此划分第一段和其余段落
        const firstNewlineIndex = trimmedText.indexOf('\n');
        const firstParagraph = (firstNewlineIndex === -1) ? trimmedText : trimmedText.substring(0, firstNewlineIndex);
        const otherParagraphs = (firstNewlineIndex === -1) ? '' : trimmedText.substring(firstNewlineIndex + 1);

        const chunks = [];

        // 2. 处理第一段：分离出第一句
        // 正则表达式：匹配直到第一个中/英文句号、问号或感叹号。非贪婪匹配。
        const sentenceEndRegex = /.+?[。！？.!?]/;
        const match = firstParagraph.match(sentenceEndRegex);

        if (match) {
            let firstChunk = match[0];
            let restOfFirstParagraph = firstParagraph.substring(firstChunk.length).trim();

            // 新增逻辑：如果第一句以感叹号结尾，并且后面还有内容，则尝试合并下一句
            if (/[!！]$/.test(firstChunk) && restOfFirstParagraph) {
                const nextSentenceMatch = restOfFirstParagraph.match(sentenceEndRegex);
                if (nextSentenceMatch) {
                    const nextSentence = nextSentenceMatch[0];
                    firstChunk += nextSentence; // 合并
                    restOfFirstParagraph = restOfFirstParagraph.substring(nextSentence.length).trim();
                }
            }

            chunks.push(firstChunk);

            if (restOfFirstParagraph) {
                chunks.push(restOfFirstParagraph);
            }
        } else {
            // 如果第一段没有标点，则将整个第一段作为一个块
            if (firstParagraph.trim()) {
                chunks.push(firstParagraph.trim());
            }
        }

        // 3. 处理其余段落
        if (otherParagraphs.trim()) {
            const restChunks = otherParagraphs.split('\n').filter(line => line.trim() !== '');
            chunks.push(...restChunks);
        }

        return chunks.filter(c => c.length > 0);
    }

    /**
     * 新的双语文本切片算法
     * @param {string} text 原始文本
     * @param {string} primaryRegexStr 主语言正则
     * @param {string} secondaryRegexStr 副语言正则
     * @returns {Array<{text: string, lang: 'primary' | 'secondary'}>}
     */
    _segmentTextForBilingualTTS(text, primaryRegexStr, secondaryRegexStr) {
        // Case 1: No secondary model/regex provided. Use primary regex or treat whole text as primary.
        if (!secondaryRegexStr) {
            const regex = primaryRegexStr ? new RegExp(primaryRegexStr, 'g') : null;
            if (regex) {
                const matches = text.match(regex);
                return matches ? [{ text: matches.join('\n'), lang: 'primary' }] : [];
            }
            return [{ text, lang: 'primary' }];
        }

        // Case 2: Secondary regex provided. Segment text into primary and secondary parts.
        try {
            const secondaryRegex = new RegExp(secondaryRegexStr, 'g');
            const segments = [];
            let lastIndex = 0;
            let match;

            while ((match = secondaryRegex.exec(text)) !== null) {
                // Part before the match is primary language
                if (match.index > lastIndex) {
                    segments.push({ text: text.substring(lastIndex, match.index), lang: 'primary' });
                }
                // The matched part (group 1 if exists, otherwise full match) is secondary
                segments.push({ text: match[1] || match[0], lang: 'secondary' });
                lastIndex = match.index + match[0].length;
            }

            // Part after the last match is primary language
            if (lastIndex < text.length) {
                segments.push({ text: text.substring(lastIndex), lang: 'primary' });
            }
            
            // If a primary regex is also provided, filter the primary segments further
            if (primaryRegexStr) {
                const primaryRegex = new RegExp(primaryRegexStr, 'g');
                return segments.map(seg => {
                    if (seg.lang === 'primary') {
                        const matches = seg.text.match(primaryRegex);
                        seg.text = matches ? matches.join('\n') : '';
                    }
                    return seg;
                }).filter(seg => seg.text.trim() !== '');
            }

            return segments.filter(seg => seg.text.trim() !== '');

        } catch (e) {
            console.error(`[TTS Bilingual] Invalid regex provided. Error: ${e.message}`);
            // Fallback to treating the whole text as primary
            return [{ text, lang: 'primary' }];
        }
    }

    /**
     * 开始双语朗读任务
     * @param {object} options 包含所有朗读参数
     */
    speak(options, sender) { // Add sender parameter
        const {
            text,
            voice, // Primary voice
            speed,
            msgId,
            ttsRegex, // Primary regex
            voiceSecondary,
            ttsRegexSecondary
        } = options;

        // 如果没有选择任何主语言模型，则不执行任何操作
        if (!voice) {
            console.log("[TTS] No primary voice model selected. Aborting speak.");
            return;
        }

        const segments = this._segmentTextForBilingualTTS(text, ttsRegex, ttsRegexSecondary);

        if (segments.length === 0) {
            console.log("[TTS] Text is empty after segmentation. Nothing to speak.");
            return;
        }

        const directorPrompts = Array.isArray(options.directorPrompts)
            ? options.directorPrompts.map(item => String(item || '').trim()).filter(Boolean)
            : [];
        const tasks = segments.map(seg => {
            const taskVoice = seg.lang === 'secondary' && voiceSecondary ? voiceSecondary : voice;
            // 将每个片段再按换行符分割，以保持原有的分段逻辑
            return this.splitText(seg.text).map(chunk => ({
                text: chunk,
                voice: taskVoice,
                speed,
                directorPrompts,
                msgId,
                sender // Pass sender to each task
            }));
        }).flat(); // Flatten the array of arrays

        this.speechQueue.push(...tasks);
        
        this.processQueue();
    }

    /**
     * 处理语音队列
     */
    async processQueue() {
        if (this.isSpeaking) return; // 防止重入
        this.isSpeaking = true;
        
        const loopSessionId = this.sessionId; // 捕获当前循环的会话ID

        while (this.speechQueue.length > 0) {
            // 在每次循环开始时检查会话ID是否已改变
            if (this.sessionId !== loopSessionId) {
                console.log(`[TTS] Session ID changed (${loopSessionId} -> ${this.sessionId}). Stopping current processing loop.`);
                break;
            }

            const currentTask = this.speechQueue.shift();
            this.currentSpeechItemId = currentTask.msgId;

            const taskRuntimeConfig = await this.getRuntimeConfig();
            const playbackRate = taskRuntimeConfig.voiceMode === 'network'
                ? Math.min(2, Math.max(0.5, Number(currentTask.speed) || 1))
                : 1;
            let streamedChunkCount = 0;
            const speechResult = await this.textToSpeech(
                currentTask.text,
                currentTask.voice,
                currentTask.speed,
                currentTask.directorPrompts,
                (audioChunk) => {
                    if (this.sessionId !== loopSessionId) return;
                    if (!currentTask.sender || currentTask.sender.isDestroyed()) return;
                    streamedChunkCount += 1;
                    currentTask.sender.send('play-tts-audio', {
                        audioData: audioChunk.toString('base64'),
                        msgId: currentTask.msgId,
                        sessionId: loopSessionId,
                        streaming: true,
                        chunkIndex: streamedChunkCount,
                        audioFormat: 'wav',
                        playbackRate
                    });
                }
            );
            const audioBuffer = speechResult?.audioBuffer || null;

            // 在异步操作后，再次检查会话ID
            if (this.sessionId !== loopSessionId) {
                console.log(`[TTS] Session ID changed during TTS synthesis. Discarding audio.`);
                break;
            }

            if (audioBuffer) {
                // 网络 MiMo 请求已经把 SSE PCM 块逐块推送给渲染器；
                // 这里只对缓存命中和本地 SoVITS 的完整音频发送一次，避免重复播放。
                if (!speechResult.streamed) {
                    const audioBase64 = audioBuffer.toString('base64');
                    if (currentTask.sender && !currentTask.sender.isDestroyed()) {
                        currentTask.sender.send('play-tts-audio', {
                            audioData: audioBase64,
                            msgId: currentTask.msgId,
                            sessionId: loopSessionId,
                            streaming: false,
                            audioFormat: audioBuffer.subarray(0, 4).toString('ascii') === 'RIFF' ? 'wav' : 'mp3',
                            playbackRate
                        });
                    } else {
                        console.error(`[TTS] 无法发送音频，因为发送方窗口已被销毁。`);
                    }
                }
            } else {
                console.error(`合成失败: "${currentTask.text.substring(0, 20)}..."`);
            }
        }

        // 队列处理完毕或被中断
        this.isSpeaking = false;
        // 只有当会话未被更新时，才清除 currentSpeechItemId
        if (this.sessionId === loopSessionId) {
            this.currentSpeechItemId = null;
        }
        console.log(`TTS processing loop for session ${loopSessionId} finished.`);
    }

    /**
     * 停止当前所有朗读
     */
    stop() {
        this.speechQueue = [];
        this.isSpeaking = false;
        this.sessionId++; // 关键：使当前所有操作和事件失效
        console.log(`[TTS] Stop called. New session ID: ${this.sessionId}`);
        // 停止事件的发送逻辑已移至 ipc/sovitsHandlers.js，以确保可靠性。
        // 这里只负责清理内部状态。
        this.currentSpeechItemId = null;
        // console.log('TTS朗读已停止。'); // 日志由上方的 sessionId 变化日志替代
    }
}

module.exports = SovitsTTS;