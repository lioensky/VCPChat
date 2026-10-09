// 语音输入（桌宠的小胶囊和设置页预览共用）：按下开始录音，再按一下停下，转成 16 kHz 单声道 WAV
// 交给本地 SenseVoice 识别（主进程 local-stt:transcribe，和主窗口的「本地 SenseVoice 转写」同一套）。
// 录音时 onLevel 每帧报一次音量（0–1），给录音按钮的光圈用。
//
//   const d = createDictation({ status, transcribe, onLevel });
//   await d.start();            // 没装语音包时抛 { code: 'no-model' }，拿不到麦克风抛 { code: 'no-mic' }
//   const text = await d.stop(); // 识别出的文字（可能是空串）
//   d.cancel();

const SAMPLE_RATE = 16000;
const MAX_SECONDS = 120;

function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0, offset = 44; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buffer);
}

function dictationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

export function createDictation({ status, transcribe, onLevel = () => {}, language = () => 'auto' }) {
    let session = null;
    // 正在等模型状态、等麦克风授权的那一次：取消时清掉，start 每次 await 回来都对一下
    let starting = null;

    function cleanup(s) {
        cancelAnimationFrame(s.raf);
        clearTimeout(s.limit);
        for (const track of s.stream.getTracks()) track.stop();
        s.context.close().catch(() => {});
        onLevel(0);
    }

    async function start() {
        if (session || starting) return;
        const token = {};
        starting = token;
        try {
            await open(token);
        } finally {
            if (starting === token) starting = null;
        }
    }

    async function open(token) {
        const cancelled = () => dictationError('cancelled', '已取消');
        const state = await status().catch(() => null);
        if (starting !== token) throw cancelled();
        if (state?.phase !== 'ready') throw dictationError('no-model', '本地语音包还没装：全局设置 → 语音设置 → 本地语音资源包');
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        } catch (error) {
            if (starting !== token) throw cancelled();
            throw dictationError('no-mic', `用不了麦克风：${error.message}`);
        }
        // 等授权的时候被取消了：麦克风刚打开就关掉，不留一个没人管的录音
        if (starting !== token) {
            for (const track of stream.getTracks()) track.stop();
            throw cancelled();
        }
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        const recorder = new MediaRecorder(stream);
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
        recorder.start(200);
        const samples = new Float32Array(analyser.fftSize);
        const s = { stream, context, recorder, chunks, raf: 0, limit: 0 };
        const tick = () => {
            analyser.getFloatTimeDomainData(samples);
            let sum = 0;
            for (const v of samples) sum += v * v;
            // 说话的音量大约在 0.02–0.2 之间，拉到 0–1
            onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 6));
            s.raf = requestAnimationFrame(tick);
        };
        tick();
        // 忘了停：两分钟后自己停（stop 由调用方在 onLimit 里接）
        s.limit = setTimeout(() => s.onLimit?.(), MAX_SECONDS * 1000);
        session = s;
    }

    async function stop() {
        const s = session;
        if (!s) return '';
        session = null;
        await new Promise((resolve) => {
            s.recorder.onstop = resolve;
            try { s.recorder.stop(); } catch { resolve(); }
        });
        cleanup(s);
        if (!s.chunks.length) return '';
        const decoder = new AudioContext();
        let audio;
        try {
            audio = await decoder.decodeAudioData(await new Blob(s.chunks, { type: s.recorder.mimeType || 'audio/webm' }).arrayBuffer());
        } finally {
            decoder.close().catch(() => {});
        }
        const seconds = Math.min(audio.duration, MAX_SECONDS);
        const offline = new OfflineAudioContext(1, Math.max(1, Math.floor(seconds * SAMPLE_RATE)), SAMPLE_RATE);
        const source = offline.createBufferSource();
        source.buffer = audio;
        source.connect(offline.destination);
        source.start();
        const rendered = await offline.startRendering();
        const result = await transcribe(encodeWav(rendered.getChannelData(0), SAMPLE_RATE), language());
        if (!result?.success) throw dictationError('failed', `没听清：${result?.error || '识别失败'}`);
        return String(result.text || '').trim();
    }

    function cancel() {
        starting = null;
        const s = session;
        if (!s) return;
        session = null;
        try { s.recorder.stop(); } catch { /* 已经停了 */ }
        cleanup(s);
    }

    return {
        start,
        stop,
        cancel,
        get active() { return Boolean(session); },
        get starting() { return Boolean(starting); },
        onLimit(fn) { if (session) session.onLimit = fn; },
    };
}
