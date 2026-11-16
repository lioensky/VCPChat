const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SovitsTTS = require('../modules/SovitsTTS');

test('SovitsTTS: stop 后立即重读不会并发启动双消费协程或发送过期音频', async () => {
    const tts = Object.create(SovitsTTS.prototype);
    tts.settingsManager = null;
    tts.isSpeaking = false;
    tts._isProcessingQueue = false;
    tts.speechQueue = [];
    tts.currentSpeechItemId = null;
    tts.sessionId = 0;
    tts._activeAbortController = null;
    tts._processingPromise = null;
    tts._loopGeneration = 0;
    tts.getRuntimeConfig = async () => ({ voiceMode: 'local', baseUrl: 'http[http://127.0.0.1:9880](http://127.0.0.1:9880)' });
    let activeSynthesisCount = 0;
    let maxConcurrentSynthesis = 0;
    const sentPayloads = [];
    const deferredList = [];

    tts.textToSpeech = async (text, _voice, _speed, _prompts, _onChunk, options = {}) => {
        activeSynthesisCount += 1;
        maxConcurrentSynthesis = Math.max(maxConcurrentSynthesis, activeSynthesisCount);
        return await new Promise((resolve) => {
            const finish = (buf) => {
                activeSynthesisCount -= 1;
                resolve(buf ? { audioBuffer: buf, streamed: false } : null);
            };
            options?.signal?.addEventListener('abort', () => finish(null), { once: true });
            deferredList.push({ text, finish });
        });
    };

    const sender = {
        isDestroyed: () => false,
        send: (_channel, payload) => sentPayloads.push(payload),
    };

    // 1. 第一次朗读两段文本，第一段挂起在合成中
    tts.speak({ text: '第一轮第一句。\n第一轮第二句。', voice: 'gsv:demo', speed: 1, msgId: 'msg-1' }, sender);
    await new Promise((r) => setImmediate(r));
    assert.equal(deferredList.length, 1);
    assert.equal(activeSynthesisCount, 1);

    // 2. 中途停止，并立刻在同一事件循环内重新朗读
    tts.stop();
    assert.equal(tts.isSpeaking, false);
    const restartedSession = tts.sessionId;
    tts.speak({ text: '第二轮重读。', voice: 'gsv:demo', speed: 1, msgId: 'msg-1' }, sender);
    await new Promise((r) => setImmediate(r));
    // 不允许出现两个 textToSpeech 同时并发执行
    assert.equal(maxConcurrentSynthesis, 1);

    // 让所有挂起任务完成（第一轮已被 abort，第二轮正常产出 RIFF wav）
    for (const item of deferredList) {
        item.finish(Buffer.from('RIFFfakewav'));
    }
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(maxConcurrentSynthesis, 1);
    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0].sessionId, restartedSession);
});

test('createTtsSurfaceOwner: stopPlayback 后再收到新会话音频不会错位丢包也不会双源同播', async () => {
    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../modules/renderer/ttsSurfaceOwner.js')).href;
    const { createTtsSurfaceOwner } = await import(moduleUrl);

    let playHandler = null;
    let stopHandler = null;
    const createdSources = [];

    const owner = createTtsSurfaceOwner({
        subscribePlay: (cb) => { playHandler = cb; return () => {}; },
        subscribeStop: (cb) => { stopHandler = cb; return () => {}; },
        createAudioContext: () => ({
            currentTime: 0,
            destination: {},
            decodeAudioData: async () => ({ duration: 1.0 }),
            createBufferSource: () => {
                const src = {
                    buffer: null,
                    playbackRate: { value: 1 },
                    stopped: false,
                    started: false,
                    onended: null,
                    connect() {},
                    start() { this.started = true; },
                    stop() { this.stopped = true; },
                };
                createdSources.push(src);
                return src;
            },
        }),
        decodeBase64: () => new ArrayBuffer(8),
    });

    owner.mount();

    // 会话 1 正在播放
    playHandler({ audioData: 'AA==', msgId: 'm1', sessionId: 1, streaming: false });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(createdSources.length, 1);
    assert.equal(createdSources[0].started, true);

    // 用户多次触发停止（例如连续点击）
    stopHandler();
    stopHandler();
    assert.equal(createdSources[0].stopped, true);

    // 同会话（sessionId=1）在途延迟分片必须被拦截，不能漏播
    playHandler({ audioData: 'AA==', msgId: 'm1', sessionId: 1, streaming: false });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(createdSources.length, 1);

    // 主进程进入新会话 sessionId=2 后正常播放，不因连点停止而超前丢包
    playHandler({ audioData: 'AA==', msgId: 'm1', sessionId: 2, streaming: false });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(createdSources.length, 2);
    assert.equal(createdSources[1].started, true);

    await owner.dispose();
});