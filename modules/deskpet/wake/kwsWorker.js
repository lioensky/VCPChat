'use strict';

// 与 SenseVoice 共用 sherpa-onnx-node，但使用独立进程，避免离线转写阻塞实时唤醒。
let spotter = null;
let stream = null;
let vad = null;
let rate = 16000;

process.on('message', message => {
    const { id, type } = message || {};
    try {
        if (type === 'load') {
            const sherpa = require('sherpa-onnx-node');
            rate = 16000;
            spotter = new sherpa.KeywordSpotter({
                featConfig: { sampleRate: rate, featureDim: 80 },
                modelConfig: {
                    transducer: {
                        encoder: message.paths.encoder,
                        decoder: message.paths.decoder,
                        joiner: message.paths.joiner,
                    },
                    tokens: message.paths.tokens,
                    numThreads: 1,
                    provider: 'cpu',
                    debug: 0,
                },
                keywordsFile: message.keywordsFile,
                maxActivePaths: 4,
                numTrailingBlanks: 1,
                keywordsScore: 1.5,
                keywordsThreshold: 0.35,
            });
            stream = spotter.createStream();
            if (message.vadPath) {
                vad = new sherpa.Vad({
                    sileroVad: {
                        model: message.vadPath,
                        threshold: 0.5,
                        minSilenceDuration: 1.2,
                        minSpeechDuration: 0.25,
                        maxSpeechDuration: 60,
                        windowSize: 512,
                    },
                    sampleRate: rate, numThreads: 1, provider: 'cpu', debug: 0,
                }, 65);
            }
            process.send({ id, ok: true });
        } else if (type === 'reset') {
            if (spotter && stream) spotter.reset(stream);
            vad?.reset();
            process.send({ id, ok: true });
        } else if (type === 'audio') {
            if (!spotter || !stream) throw new Error('唤醒模型尚未加载');
            const samples = new Float32Array(message.samples);
            if (samples.length > 16000) throw new Error('音频块过大');
            let keyword = '';
            let speech = false;
            let endpoint = false;
            if (message.mode === 'listen') {
                stream.acceptWaveform({ sampleRate: rate, samples });
                while (spotter.isReady(stream)) {
                    spotter.decode(stream);
                    const result = spotter.getResult(stream);
                    if (result.keyword) {
                        keyword = result.keyword;
                        spotter.reset(stream);
                        break;
                    }
                }
            } else if (message.mode === 'record' && vad) {
                vad.acceptWaveform(samples);
                speech = vad.isDetected();
                while (!vad.isEmpty()) {
                    endpoint = true;
                    vad.pop();
                }
            }
            process.send({ id, ok: true, result: { keyword, speech, endpoint } });
        }
    } catch (error) {
        process.send({ id, ok: false, error: String(error.message || error) });
    }
});
process.on('disconnect', () => process.exit(0));