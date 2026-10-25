import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compileKeywords } = require('../modules/deskpet/wake/keywords');
const { WakeStore } = require('../modules/deskpet/wake/store');
const { WakeModelManager } = require('../modules/deskpet/wake/modelManager');
const manifest = require('../modules/deskpet/wake/assets.json');
const modelDir = path.resolve('开发文档', manifest.directory);
const hasModel = await fs.access(modelDir).then(() => true, () => false);

test('Chinese and numbered pinyin compile to the same phonetic keyword', async () => {
    const tokens = 'x 1\niǎo 2\nk 3\nè 4\n';
    const compile = phrases => compileKeywords({ agent: { enabled: true, phrases } }, tokens);
    assert.equal(compile('小克小克').text, compile('xiao3 ke4 xiao3 ke4').text);
    assert.deepEqual(compile('小克小克').routes, { wake_0: 'agent' });
    assert.throws(() => compileKeywords({
        a: { enabled: true, phrases: '小克小克' },
        b: { enabled: true, phrases: 'xiao3 ke4 xiao3 ke4' },
    }, tokens), /相同读音/);
    assert.throws(() => compile('hello world'), /不能解析/);
});

test('joined repeated pinyin keeps the same syllables and bounded tone variants', () => {
    const tokens = 'n 1\nuò 2\nuó 3\nw 4\ná 5\nā 6\n';
    const result = compileKeywords({ a: { enabled: true, phrases: 'nuowanuowa' } }, tokens);
    assert.equal(result.previews.a[0].pronunciation, 'nuo wa nuo wa');
    assert.equal(result.previews.a[0].candidates, 4);
    assert.equal(result.text.split('\n').length, 4);
});

test('response generation persists offline audio and invalidates when voice changes', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-store-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const agentDir = path.join(root, 'Agents');
    await fs.mkdir(path.join(agentDir, 'a'), { recursive: true });
    const configFile = path.join(agentDir, 'a', 'config.json');
    await fs.writeFile(configFile, JSON.stringify({ ttsVoicePrimary: 'voice-a', ttsSpeed: 1 }));
    let calls = 0;
    const store = new WakeStore({
        appDataRoot: root, agentDir,
        tts: {
            generationIdentity: async () => ({ voiceMode: 'local', baseUrl: 'http://localhost' }),
            generateAudio: async () => { calls++; return { audioBuffer: Buffer.from('audio'), playbackRate: 1 }; },
        },
    });
    await store.load();
    await store.update('a', { responseText: '我在', enabled: false });
    await store.generate('a');
    assert.equal((await store.audioStatus('a')).ready, true);
    assert.equal(Buffer.from((await store.audio('a')).audioData, 'base64').toString(), 'audio');
    assert.equal(calls, 1, 'reading persisted audio does not call TTS');
    await fs.writeFile(configFile, JSON.stringify({ ttsVoicePrimary: 'voice-b' }));
    assert.equal((await store.audioStatus('a')).stale, true);
    assert.equal(await store.audio('a'), null);
    await assert.rejects(store.update('../escape', {}), /无效/);
});

test('failed response regeneration keeps the last usable audio', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-audio-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const agentDir = path.join(root, 'Agents');
    await fs.mkdir(path.join(agentDir, 'a'), { recursive: true });
    await fs.writeFile(path.join(agentDir, 'a', 'config.json'), JSON.stringify({ ttsVoicePrimary: 'voice' }));
    let fail = false;
    const store = new WakeStore({ appDataRoot: root, agentDir, tts: {
        generationIdentity: async () => ({}),
        generateAudio: async () => { if (fail) throw new Error('offline'); return { audioBuffer: Buffer.from('old') }; },
    } });
    await store.generate('a');
    fail = true;
    await assert.rejects(store.generate('a'), /offline/);
    assert.equal((await store.audioStatus('a')).ready, true);
});

test('local mobile model import checks hashes and does not copy unrelated files', { skip: !hasModel }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-model-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const manager = new WakeModelManager({ appDataRoot: root });
    assert.equal((await manager.prepare(modelDir)).phase, 'ready');
    assert.equal(manager.installed(), true);
    assert.deepEqual((await fs.readdir(manager.root)).sort(), manifest.files.map(file => file.name).sort());
    await fs.writeFile(manager.paths().tokens, 'bad');
    assert.equal(manager.installed(), false);
    await assert.rejects(manager.verify(manager.root), /不完整/);
});

test('WAV encoding preserves 16k mono format and clips samples', async () => {
    // coordinator loads only standard modules and pure wake dependencies; no Electron import.
    const { wav } = require('../modules/deskpet/wake/coordinator');
    const bytes = wav([new Float32Array([-2, 0, 2])]);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.readUInt32LE(24), 16000);
    assert.equal(bytes.readUInt16LE(22), 1);
    assert.equal(bytes.readInt16LE(44), -32767);
    assert.equal(bytes.readInt16LE(48), 32767);
});

test('native KWS worker detects the supplied mobile sample', { skip: !hasModel }, async t => {
    const { KwsWorkerClient } = require('../modules/deskpet/wake/workerClient');
    const sherpa = require('sherpa-onnx-node');
    const worker = new KwsWorkerClient();
    t.after(() => worker.dispose());
    const paths = Object.fromEntries(manifest.files.map(file => [file.key, path.join(modelDir, file.name)]));
    await worker.start({ paths, keywordsFile: path.join(modelDir, 'test_wavs', 'test_keywords.txt') });
    const wave = sherpa.readWave(path.join(modelDir, 'test_wavs', '3.wav'));
    const hits = [];
    const samples = new Float32Array(wave.samples.length + 8000);
    samples.set(wave.samples);
    for (let offset = 0; offset < samples.length; offset += 1024) {
        const result = await worker.request({ type: 'audio', mode: 'listen', samples: samples.slice(offset, offset + 1024) });
        if (result.keyword) hits.push(result.keyword);
    }
    assert.ok(hits.includes('文森特卡索'));
    assert.ok(hits.includes('法国'));
});

test('coordinator routes one utterance and cancels late transcription after hiding', async t => {
    const { EventEmitter } = await import('node:events');
    const { createWakeCoordinator } = require('../modules/deskpet/wake/coordinator');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-coordinator-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const tokensFile = path.join(root, 'tokens.txt');
    await fs.writeFile(tokensFile, 'x 1\niǎo 2\nk 3\nè 4\n');
    const handlers = new Map();
    const listeners = new Map();
    const main = {};
    const sent = [];
    let visible = true;
    let captured;
    class Capture extends EventEmitter {
        constructor() {
            super();
            captured = this;
            this.destroyed = false;
            this.webContents = Object.assign(new EventEmitter(), { send() {}, setWindowOpenHandler() {} });
        }
        async loadFile() {}
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; }
    }
    const powerMonitor = new EventEmitter();
    const states = [];
    let resolveTranscript;
    let warmups = 0;
    let speech = false;
    let endpoint = false;
    let keyword = '';
    const worker = {
        async start() {},
        dispose() {},
        async request(message) {
            return message.type === 'audio' ? { keyword, speech, endpoint } : {};
        },
    };
    const store = {
        root,
        agents: { a: { enabled: true, phrases: '小克小克', autoSend: true } },
        async load() {}, async checkAgent() {},
        async audio() { return null; },
        get() { return this.agents.a; },
        tail: Promise.resolve(),
    };
    const model = { installed: () => true, status: () => ({ phase: 'ready' }),
        paths: () => ({ tokens: tokensFile }), async cancel() {} };
    const ctx = {
        paths: { projectRoot: path.resolve('.'), appDataRoot: root },
        electron: {
            BrowserWindow: Capture, powerMonitor,
            session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
            ipcMain: { handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => listeners.set(key, fn) },
        },
        mainContents: () => ({ send: (_key, value) => states.push(value) }),
        fromMain: event => event.sender === main,
        controls: { get: () => ({ doNotDisturb: false }) },
        voice: { anySpeaking: () => false },
        pets: new Map([['a', { ready: true, win: {
            isDestroyed: () => false, isVisible: () => visible,
            webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
        } }]]),
    };
    const coordinator = createWakeCoordinator(ctx, {
        worker, store, model, tts: {},
        stt: {
            getPaths: () => ({ vad: 'vad.onnx' }),
            async warmup() { warmups++; },
            transcribe: () => new Promise(resolve => { resolveTranscript = resolve; }),
        },
    });
    t.after(() => coordinator.dispose());
    await coordinator.ready;
    const frame = () => handlers.get('deskpet-wake:frame')({ sender: captured.webContents }, new Float32Array(1024));
    listeners.get('deskpet-wake:capture-ready')({ sender: captured.webContents });
    keyword = 'wake_0';
    await frame();
    assert.equal(warmups, 1);
    assert.equal(states.at(-1).phase, 'recording');
    keyword = '';
    speech = true;
    await frame();
    endpoint = true;
    await frame();
    assert.equal(states.at(-1).phase, 'transcribing');
    assert.equal(typeof resolveTranscript, 'function');
    resolveTranscript({ text: '第一句' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.filter(row => row.channel === 'deskpet:wake-text').length, 1);
    assert.equal(sent.find(row => row.channel === 'deskpet:wake-text').payload.text, '第一句');
    await coordinator.refresh();
    listeners.get('deskpet-wake:capture-ready')({ sender: captured.webContents });
    keyword = 'wake_0'; speech = false; endpoint = false;
    await frame();
    keyword = ''; speech = true; endpoint = true;
    await frame();
    visible = false;
    await coordinator.visibilityChanged();
    resolveTranscript({ text: '不能迟到发送' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.filter(row => row.channel === 'deskpet:wake-text').length, 1);
    assert.equal(captured.destroyed, true);
    await coordinator.dispose();
    assert.equal(powerMonitor.listenerCount('resume'), 0);
});

test('wake settings save current agent and generate without synthesizing during preview', async () => {
    const { JSDOM } = require('jsdom');
    const { buildWake, wireWake } = await import('../DeskPetmodules/mainWindow/settings/wake.js');
    const dom = new JSDOM('<body></body>');
    const parts = buildWake(dom.window.document);
    dom.window.document.body.append(parts.root);
    const calls = [];
    const ctx = {
        doc: dom.window.document, win: dom.window, state: { agentId: 'a' }, note() {},
        api: {
            getDeskPetWakeStatus: async () => ({ success: true,
                config: { enabled: false, autoSend: true, phrases: '', responseText: '我在' },
                audio: { ready: false }, model: { phase: 'ready' }, state: { phase: 'off' } }),
            updateDeskPetWake: async (id, patch) => { calls.push(['save', id, patch]); return { success: true }; },
            generateDeskPetWakeAudio: async id => { calls.push(['generate', id]); return { success: true }; },
            onDeskPetWakeState: () => () => {},
        },
    };
    const ui = wireWake(ctx, parts);
    await ui.refresh();
    parts.phrases.value = '小克小克';
    parts.enabled.checked = true;
    parts.phrases.dispatchEvent(new dom.window.Event('input'));
    parts.generate.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls[0][0], 'save');
    assert.equal(calls[0][1], 'a');
    assert.equal(calls[0][2].phrases, '小克小克');
    assert.deepEqual(calls[1], ['generate', 'a']);
    assert.equal(parts.preview.disabled, true);
    ui.dispose();
    dom.window.close();
});