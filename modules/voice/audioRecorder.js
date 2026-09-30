function getEncodeWav() {
    if (typeof window !== 'undefined' && window.VcpVoice?.encodeWav) {
        return window.VcpVoice.encodeWav;
    }
    if (typeof require === 'function') {
        try {
            return require('./wavAudioEncoder').encodeWav;
        } catch (_) {}
    }
    return null;
}

// 80Hz 二阶 Butterworth 高通滤波器：滤除风扇轰鸣、空调及桌面机械震动等次低频杂音
function applyHighpassFilter(samples, sampleRate = 48000, cutoff = 80) {
    if (!samples || samples.length === 0) return samples;
    const nyquist = sampleRate * 0.5;
    if (cutoff >= nyquist) return samples;

    const w0 = (2 * Math.PI * cutoff) / sampleRate;
    const cosw0 = Math.cos(w0);
    const alpha = Math.sin(w0) / Math.SQRT2;

    const b0 = (1 + cosw0) / 2;
    const b1 = -(1 + cosw0);
    const b2 = (1 + cosw0) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosw0;
    const a2 = 1 - alpha;

    const nb0 = b0 / a0;
    const nb1 = b1 / a0;
    const nb2 = b2 / a0;
    const na1 = a1 / a0;
    const na2 = a2 / a0;

    const out = new Float32Array(samples.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;

    for (let i = 0; i < samples.length; i++) {
        const x0 = samples[i];
        const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
        out[i] = y0;
    }
    return out;
}

// 软噪声门：在中间停顿区域平滑衰减底噪，说话时全通放行
function applySoftNoiseGate(samples, sampleRate, noiseFloor, speechPeak) {
    if (!samples || samples.length === 0) return;
    const gateThreshold = noiseFloor + (speechPeak - noiseFloor) * 0.12;
    const frameSize = Math.round(sampleRate * 0.02);
    const numFrames = Math.floor(samples.length / frameSize);
    if (numFrames < 4) return;

    const attackCoeff = Math.exp(-1 / (sampleRate * 0.005));
    const releaseCoeff = Math.exp(-1 / (sampleRate * 0.060));
    const minGain = 0.10;

    let currentGain = 1.0;
    for (let f = 0; f < numFrames; f++) {
        const off = f * frameSize;
        let sum = 0;
        for (let i = 0; i < frameSize; i++) {
            const v = samples[off + i];
            sum += v * v;
        }
        const rms = Math.sqrt(sum / frameSize);

        let targetGain = 1.0;
        if (rms < gateThreshold) {
            const ratio = Math.max(0, rms - noiseFloor * 0.8) / Math.max(0.0001, gateThreshold - noiseFloor * 0.8);
            targetGain = minGain + (1.0 - minGain) * Math.min(1.0, ratio);
        }

        for (let i = 0; i < frameSize; i++) {
            const coeff = targetGain > currentGain ? attackCoeff : releaseCoeff;
            currentGain = targetGain + coeff * (currentGain - targetGain);
            samples[off + i] *= currentGain;
        }
    }
}

// 对音频样本进行静音切除并施加余弦淡入淡出平滑
function trimSilenceAndFade(input, sampleRate = 48000) {
    if (!input || input.length === 0) return input;
    const len = input.length;
    const frameSize = Math.round(sampleRate * 0.02);
    const numFrames = Math.floor(len / frameSize);
    if (numFrames < 8) return input;

    const frameRms = new Float32Array(numFrames);
    for (let f = 0; f < numFrames; f++) {
        const off = f * frameSize;
        let sum = 0;
        for (let i = 0; i < frameSize; i++) {
            const v = input[off + i];
            sum += v * v;
        }
        frameRms[f] = Math.sqrt(sum / frameSize);
    }

    const sorted = frameRms.slice().sort();
    const noiseFloor = sorted[Math.floor(numFrames * 0.15)];
    const speechPeak = sorted[Math.floor(numFrames * 0.9)];

    if (speechPeak < noiseFloor * 1.2 || speechPeak < 0.002) {
        return input;
    }

    const threshold = noiseFloor + (speechPeak - noiseFloor) * 0.2;
    let firstSpeechFrame = -1;
    let lastSpeechFrame = -1;

    for (let f = 0; f < numFrames - 2; f++) {
        if (frameRms[f] >= threshold && frameRms[f + 1] >= threshold) {
            firstSpeechFrame = f;
            break;
        }
    }

    for (let f = numFrames - 1; f >= 2; f--) {
        if (frameRms[f] >= threshold && frameRms[f - 1] >= threshold) {
            lastSpeechFrame = f;
            break;
        }
    }

    if (firstSpeechFrame === -1 || lastSpeechFrame === -1 || firstSpeechFrame >= lastSpeechFrame) {
        return input;
    }

    const preRoll = Math.round(sampleRate * 0.1);
    const postRoll = Math.round(sampleRate * 0.15);

    const startIdx = Math.max(0, firstSpeechFrame * frameSize - preRoll);
    const endIdx = Math.min(len, (lastSpeechFrame + 1) * frameSize + postRoll);

    const trimmed = input.slice(startIdx, endIdx);
    const trimmedLen = trimmed.length;

    // 在语句中间停顿时平滑压制本底白噪与风扇残留
    applySoftNoiseGate(trimmed, sampleRate, noiseFloor, speechPeak);

    const fadeInSamples = Math.min(Math.round(sampleRate * 0.02), Math.floor(trimmedLen / 4));
    for (let i = 0; i < fadeInSamples; i++) {
        const gain = 0.5 * (1 - Math.cos((Math.PI * i) / fadeInSamples));
        trimmed[i] *= gain;
    }

    const fadeOutSamples = Math.min(Math.round(sampleRate * 0.03), Math.floor(trimmedLen / 4));
    for (let i = 0; i < fadeOutSamples; i++) {
        const gain = 0.5 * (1 - Math.cos((Math.PI * i) / fadeOutSamples));
        trimmed[trimmedLen - 1 - i] *= gain;
    }

    return trimmed;
}

class AudioRecorder {
    constructor() {
        this.stream = null;
        this.mediaRecorder = null;
        this.recordedBlobs = [];
        this.isRecording = false;
        this.audioContext = null;
        this.analyser = null;
        this.sourceNode = null;
        this.amplitudeSamples = null;
        this.warmStream = null;
        this.warmTimer = null;
        this.warmPending = null;
    }

    // 冷启动打开麦克风在 Windows 上常要数百毫秒。按下按钮时预热、录完后短暂保留，
    // 让 start() 直接复用已打开的音轨（超时未使用则自动释放，麦克风指示灯随之熄灭）。
    static get WARM_KEEP_MS() { return 20000; }

    static get DEVICE_KEY() { return 'vcpVoiceInputDeviceId'; }

    static getPreferredDeviceId() {
        try { return localStorage.getItem(AudioRecorder.DEVICE_KEY) || ''; } catch (_) { return ''; }
    }

    static setPreferredDeviceId(id) {
        try {
            if (id) localStorage.setItem(AudioRecorder.DEVICE_KEY, id);
            else localStorage.removeItem(AudioRecorder.DEVICE_KEY);
        } catch (_) {}
    }

    async openStream() {
        const base = { echoCancellation: true, noiseSuppression: true };
        const deviceId = AudioRecorder.getPreferredDeviceId();
        if (deviceId) {
            try {
                return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } });
            } catch (error) {
                // 所选麦克风已拔出：回退到系统默认，不让录音失败
                if (error?.name !== 'OverconstrainedError' && error?.name !== 'NotFoundError') throw error;
            }
        }
        return navigator.mediaDevices.getUserMedia({ audio: base });
    }

    scheduleWarmRelease() {
        clearTimeout(this.warmTimer);
        this.warmTimer = setTimeout(() => this.releaseWarm(), AudioRecorder.WARM_KEEP_MS);
    }

    releaseWarm() {
        clearTimeout(this.warmTimer);
        this.warmTimer = null;
        const stream = this.warmStream;
        this.warmStream = null;
        if (stream) {
            try { stream.getTracks().forEach(track => track.stop()); } catch (_) {}
        }
    }

    async prewarm() {
        if (this.isRecording || this.warmStream || this.warmPending) return;
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
        this.warmPending = this.openStream()
            .then(stream => {
                this.warmStream = stream;
                this.scheduleWarmRelease();
            })
            .catch(() => {})
            .finally(() => { this.warmPending = null; });
        await this.warmPending;
    }

    async takeStream() {
        if (this.warmPending) await this.warmPending;
        const warm = this.warmStream;
        if (warm && warm.getTracks().some(track => track.readyState === 'live')) {
            clearTimeout(this.warmTimer);
            this.warmTimer = null;
            this.warmStream = null;
            return warm;
        }
        this.releaseWarm();
        return this.openStream();
    }

    // 录音结束：音轨转入预热保留，而不是立即关闭
    parkStream(stream) {
        if (!stream) return;
        this.releaseWarm();
        this.warmStream = stream;
        this.scheduleWarmRelease();
    }

    async start() {
        if (this.isRecording) return;
        const stream = await this.takeStream();

        this.stream = stream;
        this.recordedBlobs = [];

        const AudioContextClass = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (AudioContextClass) {
            try {
                this.audioContext = new AudioContextClass();
                this.analyser = this.audioContext.createAnalyser();
                this.analyser.fftSize = 256;
                this.sourceNode = this.audioContext.createMediaStreamSource(stream);
                this.sourceNode.connect(this.analyser);
                this.amplitudeSamples = new Float32Array(this.analyser.fftSize);
            } catch (err) {
                console.warn('[AudioRecorder] AnalyserNode setup warning:', err);
            }
        }

        let options = { mimeType: 'audio/webm;codecs=opus' };
        if (typeof MediaRecorder !== 'undefined' && !MediaRecorder.isTypeSupported(options.mimeType)) {
            options = { mimeType: 'audio/webm' };
        }
        if (typeof MediaRecorder !== 'undefined' && !MediaRecorder.isTypeSupported(options.mimeType)) {
            options = {};
        }

        const recorder = new MediaRecorder(stream, options);
        this.mediaRecorder = recorder;

        recorder.ondataavailable = event => {
            if (event.data && event.data.size > 0) {
                this.recordedBlobs.push(event.data);
            }
        };

        recorder.start(100);
        this.isRecording = true;
    }

    amplitude() {
        if (!this.analyser || !this.amplitudeSamples) return 0;
        try {
            this.analyser.getFloatTimeDomainData(this.amplitudeSamples);
            let sum = 0;
            for (let i = 0; i < this.amplitudeSamples.length; i++) {
                const val = this.amplitudeSamples[i];
                sum += val * val;
            }
            return Math.sqrt(sum / this.amplitudeSamples.length);
        } catch (_) {
            return 0;
        }
    }

    cleanupAnalyser() {
        if (this.sourceNode) {
            try { this.sourceNode.disconnect(); } catch (_) {}
            this.sourceNode = null;
        }
        if (this.analyser) {
            try { this.analyser.disconnect(); } catch (_) {}
            this.analyser = null;
        }
        if (this.audioContext) {
            try { this.audioContext.close(); } catch (_) {}
            this.audioContext = null;
        }
        this.amplitudeSamples = null;
    }

    // speech: true 时OfflineAudioContext 原生重采样为 16kHz 单声道 PCM16 WAV，
    // 不做高通/静音裁剪/噪声门（识别模型自带 VAD，预处理反而会改变输入分布）。maxSeconds 截断计时器超时的多余部分。
    async stop({ speech = false, maxSeconds = 0 } = {}) {
        if (!this.isRecording) return null;
        this.isRecording = false;

        const recorder = this.mediaRecorder;
        this.mediaRecorder = null;

        if (recorder && recorder.state !== 'inactive') {
            await new Promise(resolve => {
                recorder.onstop = resolve;
                try {
                    recorder.stop();
                } catch (_) {
                    resolve();
                }
            });
        }

        if (this.stream) {
            this.parkStream(this.stream);
            this.stream = null;
        }
        this.cleanupAnalyser();

        if (!this.recordedBlobs || this.recordedBlobs.length === 0) {
            return null;
        }

        const mimeType = recorder?.mimeType || 'audio/webm';
        const rawBlob = new Blob(this.recordedBlobs, { type: mimeType });
        this.recordedBlobs = [];

        const arrayBuffer = await rawBlob.arrayBuffer();
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const decodeCtx = new AudioContextClass();

        let pcmData = null;
        let sampleRate = 48000;
        let audioBuffer = null;
        try {
            audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
            pcmData = audioBuffer.getChannelData(0);
            sampleRate = audioBuffer.sampleRate;
        } catch (decodeErr) {
            console.warn('[AudioRecorder] 音频解码失败:', decodeErr);
            return null;
        } finally {
            try {
                await decodeCtx.close();
            } catch (_) {}
        }

        if (!pcmData || pcmData.length === 0) return null;

        if (speech) {
            const encodeSpeech = getEncodeWav();
            if (!encodeSpeech) return null;
            const OfflineClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
            const seconds = maxSeconds > 0 ? Math.min(audioBuffer.duration, maxSeconds) : audioBuffer.duration;
            const offline = new OfflineClass(1, Math.max(1, Math.floor(seconds * 16000)), 16000);
            const source = offline.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(offline.destination);
            source.start();
            const rendered = await offline.startRendering();
            return encodeSpeech(rendered.getChannelData(0), 16000, 1);
        }

        const filteredPcm = applyHighpassFilter(pcmData, sampleRate, 80);
        const cleanSamples = trimSilenceAndFade(filteredPcm, sampleRate);
        const encodeWavFn = getEncodeWav();
        if (!encodeWavFn) return null;
        return encodeWavFn(cleanSamples, sampleRate, 1);
    }

    dispose() {
        this.isRecording = false;
        if (this.stream) {
            this.parkStream(this.stream);
            this.stream = null;
        }
        this.releaseWarm();
        this.cleanupAnalyser();
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try {
                this.mediaRecorder.stop();
            } catch (_) {}
            this.mediaRecorder = null;
        }
        this.recordedBlobs = [];
    }
}

if (typeof window !== 'undefined') {
    window.VcpVoice = Object.assign(window.VcpVoice || {}, {
        applyHighpassFilter,
        applySoftNoiseGate,
        trimSilenceAndFade,
        AudioRecorder,
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        applyHighpassFilter,
        applySoftNoiseGate,
        trimSilenceAndFade,
        AudioRecorder,
    };
}
