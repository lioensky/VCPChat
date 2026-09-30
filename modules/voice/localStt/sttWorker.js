'use strict';

// 本地 SenseVoice 推理子进程（ELECTRON_RUN_AS_NODE）。推理是同步 CPU 计算，不放主进程。
// 流程：
// WAV → 16kHz Float32 → Silero VAD 分段 → SenseVoice 逐段解码。
let recognizer = null;
let vad = null;
let nativeConfig = null;
const LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'];

const SAMPLE_RATE = 16000;
const WINDOW = 512;

function parseWav(buf) {
    if (buf.length < 46 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('不是有效的 WAV 音频');
    }
    let pos = 12;
    let fmt = null;
    let data = null;
    while (pos + 8 <= buf.length) {
        const id = buf.toString('ascii', pos, pos + 4);
        const size = buf.readUInt32LE(pos + 4);
        const start = pos + 8;
        if (id === 'fmt ') {
            fmt = {
                format: buf.readUInt16LE(start),
                channels: buf.readUInt16LE(start + 2),
                sampleRate: buf.readUInt32LE(start + 4),
                bits: buf.readUInt16LE(start + 14),
            };
        } else if (id === 'data') {
            data = buf.subarray(start, Math.min(buf.length, start + size));
            break;
        }
        pos = start + size + (size % 2);
    }
    if (!fmt || !data) throw new Error('WAV 缺少 fmt/data 块');
    if (fmt.bits !== 16 && !(fmt.bits === 32 && fmt.format === 3)) throw new Error('仅支持 16 位 PCM 或 32 位浮点 WAV');

    const bytesPerSample = fmt.bits / 8;
    const frameBytes = bytesPerSample * fmt.channels;
    const frames = Math.floor(data.length / frameBytes);
    const mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
            const off = i * frameBytes + c * bytesPerSample;
            sum += fmt.bits === 16 ? data.readInt16LE(off) / 32768 : data.readFloatLE(off);
        }
        mono[i] = sum / fmt.channels;
    }
    return { samples: mono, sampleRate: fmt.sampleRate };
}

function resample(samples, from, to) {
    if (from === to) return samples;
    const ratio = from / to;
    const length = Math.floor(samples.length / ratio);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, samples.length - 1);
        const frac = pos - i0;
        out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
    }
    return out;
}

function load({ model, tokens, vad: vadModel, threads }) {
    const sherpa = require('sherpa-onnx-node');
    nativeConfig = {
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
            senseVoice: { model, language: 'auto', useInverseTextNormalization: 1 },
            tokens,
            numThreads: threads || 2,
            provider: 'cpu',
            debug: 0,
        },
    };
    recognizer = new sherpa.OfflineRecognizer(nativeConfig);
    vad = new sherpa.Vad({
        sileroVad: {
            model: vadModel,
            threshold: 0.5,
            minSilenceDuration: 0.5,
            minSpeechDuration: 0.25,
            maxSpeechDuration: 30,
            windowSize: WINDOW,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: threads || 2,
        provider: 'cpu',
        debug: 0,
    }, 30 + 0.5 + 1); // segmentSeconds + minSilenceSeconds + 1
}

function drain(texts) {
    while (!vad.isEmpty()) {
        // front(false)：Electron 的 V8 内存笼要求拷贝原生缓冲区
        const segment = vad.front(false);
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: segment.samples });
        recognizer.decode(stream);
        const text = String(recognizer.getResult(stream).text || '').trim();
        if (text) texts.push(text);
        vad.pop();
    }
}

function transcribe({ wav, language }) {
    const started = Date.now();
    const parsed = parseWav(Buffer.from(wav));
    const samples = resample(parsed.samples, parsed.sampleRate, SAMPLE_RATE);
    nativeConfig.modelConfig.senseVoice.language = LANGUAGES.includes(language) ? language : 'auto';
    recognizer.setConfig(nativeConfig);
    vad.reset();
    const texts = [];
    for (let off = 0; off < samples.length; off += WINDOW) {
        // 末尾不足一窗的片段原样送入，由 flush 收尾
        vad.acceptWaveform(samples.subarray(off, Math.min(off + WINDOW, samples.length)));
        drain(texts);
    }
    vad.flush();
    drain(texts);
    return {
        text: texts.join(' ').trim(),
        audioSeconds: samples.length / SAMPLE_RATE,
        inferenceSeconds: (Date.now() - started) / 1000,
    };
}

process.on('message', (msg) => {
    const { id, type } = msg || {};
    try {
        if (type === 'load') {
            load(msg.paths);
            process.send({ id, ok: true });
        } else if (type === 'transcribe') {
            process.send({ id, ok: true, result: transcribe(msg) });
        }
    } catch (err) {
        process.send({ id, ok: false, error: String(err?.message || err) });
    }
});

process.on('disconnect', () => process.exit(0));
