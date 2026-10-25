'use strict';

(async () => {
    const api = window.wakeCapture;
    let context;
    let stream;
    let source;
    let processor;
    let playing = null;
    let stopped = false;
    let busy = false;
    let queued = [];
    let queueLength = 0;
    function cleanup() {
        stopped = true;
        playing?.stop();
        processor?.disconnect();
        source?.disconnect();
        stream?.getTracks().forEach(track => track.stop());
        context?.close().catch(() => {});
    }
    window.addEventListener('pagehide', cleanup, { once: true });
    api.onPlay(async ({ audioData, playbackRate, token }) => {
        try {
            playing?.stop();
            const bytes = Uint8Array.from(atob(audioData), char => char.charCodeAt(0));
            const buffer = await context.decodeAudioData(bytes.buffer);
            if (stopped) return;
            const audio = context.createBufferSource();
            audio.buffer = buffer;
            audio.playbackRate.value = playbackRate || 1;
            audio.connect(context.destination);
            playing = audio;
            audio.onended = () => {
                if (playing === audio) playing = null;
                api.playbackEnded(token);
            };
            audio.start();
        } catch (error) {
            api.playbackEnded(token);
            console.warn('[Wake] 回应播放失败', error);
        }
    });
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (stopped) { stream.getTracks().forEach(track => track.stop()); return; }
        context = new AudioContext({ sampleRate: 16000 });
        await context.resume();
        if (context.sampleRate !== 16000) throw new Error('当前音频设备无法提供 16kHz 采集');
        source = context.createMediaStreamSource(stream);
        // 回调仅负责聚合音频，所有推理在子进程；有界队列避免后台积压。
        processor = context.createScriptProcessor(1024, 1, 1);
        processor.onaudioprocess = event => {
            event.outputBuffer.getChannelData(0).fill(0);
            if (stopped) return;
            queued.push(new Float32Array(event.inputBuffer.getChannelData(0)));
            queueLength += 1024;
            if (queueLength > 16000) {
                api.error('语音推理落后超过一秒，监听已停止');
                cleanup();
                return;
            }
            if (busy) return;
            const flush = async () => {
                if (busy || !queueLength || stopped) return;
                busy = true;
                const samples = new Float32Array(queueLength);
                let offset = 0;
                for (const chunk of queued) { samples.set(chunk, offset); offset += chunk.length; }
                queued = [];
                queueLength = 0;
                try { await api.frame(samples); }
                catch (error) { api.error(error.message); cleanup(); }
                finally { busy = false; if (queueLength) flush(); }
            };
            flush();
        };
        source.connect(processor);
        processor.connect(context.destination);
        stream.getTracks().forEach(track => track.addEventListener('ended', () => {
            if (!stopped) { api.error('麦克风已断开'); cleanup(); }
        }));
        api.ready();
    } catch (error) {
        api.error(error.message);
        cleanup();
    }
})();