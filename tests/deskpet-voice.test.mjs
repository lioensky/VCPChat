import test from 'node:test';
import assert from 'node:assert/strict';
import { createLipSync, createSpeech, rmsToLevel, speaksAnything } from '../DeskPetmodules/voice.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 假的 Web Audio：时钟走真实时间，每段音频的时长写在 base64 里（"秒数"），振幅固定 0.2。
function installFakeAudio() {
    const t0 = performance.now();
    class FakeContext {
        constructor() { this.state = 'running'; this.destination = {}; }
        get currentTime() { return (performance.now() - t0) / 1000; }
        createAnalyser() {
            const ctx = this;
            return {
                fftSize: 0,
                connect() {},
                getFloatTimeDomainData(out) {
                    const loud = FakeContext.playing.some((s) => s.startAt <= ctx.currentTime && ctx.currentTime < s.endAt);
                    out.fill(loud ? 0.2 : 0);
                },
            };
        }
        decodeAudioData(buffer) {
            const seconds = Number(new TextDecoder().decode(new Uint8Array(buffer)));
            return Promise.resolve({ duration: seconds });
        }
        createBufferSource() {
            const source = {
                playbackRate: { value: 1 },
                connect() {},
                start(at) {
                    source.startAt = at;
                    source.endAt = at + source.buffer.duration / source.playbackRate.value;
                    FakeContext.playing.push(source);
                    source.timer = setTimeout(() => source.onended?.(), (source.endAt - (performance.now() - t0) / 1000) * 1000);
                },
                stop() {
                    clearTimeout(source.timer);
                    source.endAt = 0;
                },
            };
            return source;
        }
        resume() { return Promise.resolve(); }
        close() { return Promise.resolve(); }
    }
    FakeContext.playing = [];
    globalThis.AudioContext = FakeContext;
    return FakeContext;
}

// 假的主进程：记下送去合成的句子，按需要把「音频」发回来。
function fakeApi({ speaking = true, filter = {} } = {}) {
    const said = [];
    const ended = [];
    return {
        said,
        ended,
        voiceBegin: async () => ({ speaking, ...filter }),
        voiceSay: (payload) => said.push(payload),
        voiceEnd: (payload) => ended.push(payload),
    };
}

const audio = (seconds) => Buffer.from(String(seconds)).toString('base64');

test('loudness mapping and lip sync: silence closes the mouth, speech opens it quickly', () => {
    assert.equal(rmsToLevel(0), 0);
    assert.ok(rmsToLevel(0.2) > 0.8);
    assert.ok(rmsToLevel(0.002) < 0.05);
    const lip = createLipSync();
    let open = 0;
    for (let i = 0; i < 4; i += 1) open = lip.update(0.9, 1 / 30);
    assert.ok(open > 0.7, `张嘴要在 130ms 内跟上：${open}`);
    for (let i = 0; i < 10; i += 1) open = lip.update(0.01, 1 / 30);
    assert.ok(open < 0.1, `安静下来要合上：${open}`);
});

test('a spoken reply: bubble and face follow the sentence being read, then everything is shown', async () => {
    const Ctx = installFakeAudio();
    const api = fakeApi();
    const frames = [];
    let releases = 0;
    const mouths = [];
    const speech = createSpeech({
        api,
        onFrame: (f) => frames.push(f.emotion),
        onRelease: () => { releases += 1; },
        onLevel: (open) => mouths.push(open),
    });
    speech.begin('m1');
    assert.equal(speech.revealEnd(), 0, '还没开口时气泡先不出字');
    await sleep(5);
    const raw1 = '你好呀！今天天气真好。';
    speech.update(`${raw1}可`, { emotion: 'happy' });
    const raw2 = `${raw1}可惜我出不去。`;
    speech.finish(raw2, { emotion: 'sad' });
    assert.deepEqual(api.said.map((s) => s.text), ['你好呀！', '今天天气真好。', '可惜我出不去。']);
    assert.equal(api.said[0].first, true);
    assert.equal(api.said[1].first, false);
    assert.ok(speech.holdsFrames(), '送出句子以后表情由句子控制');

    // 主进程合成好了：三句依次回来
    for (const s of api.said) speech.play({ audioData: audio(0.25), msgId: s.key, sessionId: 7 });
    await sleep(120);
    assert.equal(speech.revealEnd(), '你好呀！'.length, '念第一句时只显示第一句');
    assert.ok(mouths.some((m) => m > 0.3), '有声音时嘴张开');
    await sleep(270);
    assert.equal(speech.revealEnd(), raw1.length);
    await sleep(250);
    assert.equal(speech.revealEnd(), raw2.length);
    assert.deepEqual(frames, ['happy', 'happy', 'sad'], '每句换上切出它时的表情');
    // 念完：全部显示、表情交回导演、通知主进程
    await sleep(900);
    assert.equal(speech.revealEnd(), null);
    assert.equal(speech.active(), false);
    assert.equal(releases, 1);
    assert.deepEqual(api.ended, [{ messageId: 'm1', stop: false }]);
    assert.equal(speech.mouth(), null, '不在朗读时由调用方用自己的假口型');
    Ctx.playing.length = 0;
    speech.dispose();
});

test('tapping (stop) silences the pet at once and shows the whole reply', async () => {
    installFakeAudio();
    const api = fakeApi();
    const speech = createSpeech({ api });
    speech.begin('m2');
    await sleep(5);
    speech.update('第一句话在这里。第二句话也来了。还有', { emotion: 'neutral' });
    for (const s of api.said) speech.play({ audioData: audio(1), msgId: s.key, sessionId: 1 });
    await sleep(80);
    assert.ok(speech.speaking());
    speech.stop();
    assert.equal(speech.speaking(), false);
    assert.equal(speech.revealEnd(), null);
    assert.deepEqual(api.ended, [{ messageId: 'm2', stop: true }]);
    // 后面再流进来的句子不再送去念
    speech.update('第一句话在这里。第二句话也来了。还有第三句。然后', { emotion: 'neutral' });
    assert.equal(api.said.length, 2);
    speech.dispose();
});

test('no voice configured (or muted): nothing is sent and the bubble shows text as it streams', async () => {
    installFakeAudio();
    const api = fakeApi({ speaking: false });
    const speech = createSpeech({ api });
    speech.begin('m3');
    await sleep(5);
    speech.update('你好。这是一句话。', { emotion: 'neutral' });
    speech.finish('你好。这是一句话。', { emotion: 'neutral' });
    assert.equal(api.said.length, 0);
    assert.equal(speech.revealEnd(), null);
    assert.equal(speech.mouth(), null);
    assert.equal(speech.active(), false);
    speech.dispose();
});

test('stale audio from an older session is ignored; a new reply interrupts the old one', async () => {
    installFakeAudio();
    const api = fakeApi();
    const speech = createSpeech({ api });
    speech.begin('a');
    await sleep(5);
    speech.update('第一条回复的句子。后面', { emotion: 'neutral' });
    speech.play({ audioData: audio(1), msgId: api.said[0].key, sessionId: 5 });
    await sleep(60);
    assert.ok(speech.speaking());
    speech.begin('b');
    assert.equal(speech.speaking(), false, '新回复开始，旧的不念了');
    assert.deepEqual(api.ended.at(-1), { messageId: 'a', stop: true });
    await sleep(5);
    speech.update('第二条回复。后面', { emotion: 'neutral' });
    speech.play({ audioData: audio(1), msgId: api.said.at(-1).key, sessionId: 6 });
    speech.play({ audioData: audio(1), msgId: api.said[0].key, sessionId: 5 });
    await sleep(60);
    assert.equal(speech.revealEnd(), '第二条回复。'.length);
    speech.dispose();
});

test('do-not-disturb (silent) replies are not read, but still stop the one being read', async () => {
    installFakeAudio();
    const api = fakeApi();
    let asked = 0;
    api.voiceBegin = async () => { asked += 1; return { speaking: true }; };
    const speech = createSpeech({ api });
    speech.begin('a');
    await sleep(5);
    speech.update('正在念的这一句。后面', { emotion: 'neutral' });
    speech.play({ audioData: audio(1), msgId: api.said[0].key, sessionId: 1 });
    await sleep(60);
    speech.begin('b', { silent: true });
    assert.equal(speech.speaking(), false);
    speech.update('免打扰时的回复。也不念。', { emotion: 'neutral' });
    speech.finish('免打扰时的回复。也不念。', { emotion: 'neutral' });
    assert.equal(asked, 1, '静音的回复不去问主进程');
    assert.equal(api.said.length, 1);
    assert.equal(speech.revealEnd(), null);
    speech.dispose();
});

test('when the first audio is slow, the bubble stops waiting on it and shows the text', async (t) => {
    installFakeAudio();
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const api = fakeApi();
    let changes = 0;
    const speech = createSpeech({ api, onChange: () => { changes += 1; } });
    speech.begin('slow');
    await sleep(5);
    speech.update('先说一句。还在写', { emotion: 'happy' });
    await sleep(50);
    assert.equal(speech.revealEnd(), 0, '刚送出去时还在等声音');
    const before = changes;
    t.mock.timers.tick(4100);
    await sleep(80);
    assert.equal(speech.revealEnd(), null, '等了几秒没声音就先把字放出来');
    assert.ok(changes > before, '放出来时要重画气泡');
    assert.equal(speech.active(), true, '声音来了照常念');
    speech.stop();
    speech.dispose();
});

test('sentences the read-only-matching regex drops are not sent, so the bubble does not wait for them', async () => {
    assert.equal(speaksAnything('她笑了笑。', { ttsRegex: '「[^」]+」' }), false);
    assert.equal(speaksAnything('「你好」她说。', { ttsRegex: '「[^」]+」' }), true);
    assert.equal(speaksAnything('(sigh)', { ttsRegex: '「[^」]+」', ttsRegexSecondary: '\\(([^)]+)\\)' }), true);
    assert.equal(speaksAnything('随便什么', { ttsRegex: '[' }), true, '正则写坏了交给 TTS');
    installFakeAudio();
    const api = fakeApi({ filter: { ttsRegex: '「[^」]+」' } });
    const speech = createSpeech({ api });
    speech.begin('m9');
    await sleep(5);
    const raw = '「早上好！」她伸了个懒腰。';
    speech.finish(raw, { emotion: 'happy' });
    assert.deepEqual(api.said.map((s) => s.text), ['「早上好！」'], '只有旁白的那句不送');
    speech.play({ audioData: audio(0.2), msgId: api.said[0].key, sessionId: 3 });
    await sleep(1200);
    assert.equal(speech.active(), false, '念完能念的那句就结束，不等旁白的声音');
    assert.equal(speech.revealEnd(), null);
    speech.dispose();
});

// ---- 元音口形 ----

// 合成元音：脉冲串（基频 f0）→ 声门低通、口唇差分 → 三个共振峰串联，取最后 1024 个采样（48kHz）
const SR = 48000;
const FORMANTS = { a: [850, 1400, 2800], i: [320, 2800, 3300], u: [350, 1450, 2600], e: [550, 2300, 2900], o: [520, 950, 2600] };
function resonator(x, f, bw) {
    const r = Math.exp(-Math.PI * bw / SR);
    const c = -r * r;
    const b = 2 * r * Math.cos(2 * Math.PI * f / SR);
    const a = 1 - b - c;
    const y = new Float64Array(x.length);
    for (let n = 0; n < x.length; n++) y[n] = a * x[n] + b * (y[n - 1] || 0) + c * (y[n - 2] || 0);
    return y;
}
function synthVowel(vowel, f0, amp = 0.2) {
    const len = 4096;
    let x = new Float64Array(len);
    for (let n = 0; n < len; n++) x[n] = n % Math.round(SR / f0) === 0 ? 1 : 0;
    for (let pass = 0; pass < 2; pass++) {
        const k = Math.exp(-2 * Math.PI * 150 / SR);
        for (let n = 1; n < len; n++) x[n] = (1 - k) * x[n] + k * x[n - 1];
    }
    for (let n = len - 1; n > 0; n--) x[n] -= x[n - 1];
    let y = x;
    FORMANTS[vowel].forEach((f, j) => { y = resonator(y, f, 60 + 30 * j); });
    const tail = y.slice(len - 1024);
    const peak = Math.max(...tail.map(Math.abs)) || 1;
    return Float32Array.from(tail, (v) => (v / peak) * amp);
}

const top = (w) => Object.entries(w).sort((a, b) => b[1] - a[1])[0][0];

test('vowels are told apart by their first two formants at any pitch', async () => {
    const { vowelWeights } = await import('../DeskPetmodules/voice.js');
    for (const f0 of [120, 200, 300]) {
        for (const vowel of Object.keys(FORMANTS)) {
            const w = vowelWeights(synthVowel(vowel, f0), SR);
            assert.ok(w, `${vowel}@${f0}Hz 没认出来`);
            assert.equal(top(w), vowel, `${vowel}@${f0}Hz 认成了 ${top(w)}`);
            const sum = Object.values(w).reduce((a, b) => a + b, 0);
            assert.ok(Math.abs(sum - 1) < 1e-6);
        }
    }
    // 静音、太短、没有采样率
    assert.equal(vowelWeights(new Float32Array(1024), SR), null);
    assert.equal(vowelWeights(synthVowel('a', 200, 0.001), SR), null);
    assert.equal(vowelWeights(new Float32Array(16).fill(0.1), SR), null);
    assert.equal(vowelWeights(synthVowel('a', 200), 0), null);
});

test('vowel weights move smoothly and fall back to zero in pauses', async () => {
    const { createVowelTracker } = await import('../DeskPetmodules/voice.js');
    const tracker = createVowelTracker();
    const a = { a: 1, i: 0, u: 0, e: 0, o: 0 };
    const first = tracker.update(a, 0.033);
    assert.ok(first.a > 0 && first.a < 1, '不会一下跳满');
    let w = first;
    for (let k = 0; k < 20; k += 1) w = tracker.update(a, 0.033);
    assert.ok(w.a > 0.95);
    for (let k = 0; k < 20; k += 1) w = tracker.update(null, 0.033);
    assert.equal(w.a, 0);
});
