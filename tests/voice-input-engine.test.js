'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const AppSettingsManager = require('../modules/utils/appSettingsManager');
const {
    VoiceInputEngineAdapter,
} = require('../modules/voice/voice-input-engine-adapter');

const projectRoot = path.resolve(__dirname, '..');

function source(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('voice input build target matches the current runtime layout', () => {
    const buildRuntime = require('../rust_voice_input_engine/build-runtime');
    const target = buildRuntime.resolveRuntimeTarget(process.platform, process.arch);

    assert.equal(target.runtimeDirectoryName, `${process.platform}-${process.arch}`);
    assert.equal(
        target.executableName,
        process.platform === 'win32'
            ? 'vcp_voice_input_engine.exe'
            : 'vcp_voice_input_engine',
    );
});

test('voice input adapter resolves the deployed native sidecar', () => {
    const adapter = new VoiceInputEngineAdapter({ projectRoot });
    const executablePath = adapter.resolveExecutablePath();

    assert.ok(executablePath, 'deployed voice input engine should be resolvable');
    assert.equal(fs.existsSync(executablePath), true);
    assert.match(
        executablePath.replace(/\\/g, '/'),
        /rust_voice_input_engine\/(?:runtime|target)\//,
    );
});

test('voice input sidecar starts on demand, answers ping, and shuts down', async t => {
    const adapter = new VoiceInputEngineAdapter({ projectRoot });
    t.after(async () => {
        await adapter.shutdown();
    });

    const initial = adapter.getStatus();
    assert.equal(initial.lifecycleState, 'stopped');
    assert.equal(initial.processAlive, false);

    const started = await adapter.start();
    assert.equal(started.lifecycleState, 'ready');
    assert.equal(started.ready, true);
    assert.equal(started.processAlive, true);
    assert.ok(started.processPid);

    const pong = await adapter.request('ping');
    assert.equal(pong.event, 'pong');
    assert.equal(pong.success, true);
    assert.equal(pong.detail.platform, process.platform === 'win32' ? 'windows' : process.platform);
    assert.equal(pong.detail.active, false);
    assert.equal(pong.detail.rightAltHeld, false);

    await adapter.shutdown();
    const stopped = adapter.getStatus();
    assert.equal(stopped.lifecycleState, 'stopped');
    assert.equal(stopped.ready, false);
    assert.equal(stopped.processAlive, false);
});

test('voice chat native input stays isolated to the auxiliary surface', () => {
    const voiceSource = source('Voicechatmodules/voicechat.js');
    const mainRendererSource = source('renderer.js');
    const voiceHandlersSource = source('modules/ipc/voiceHandlers.js');

    assert.match(voiceSource, /startNativeVoiceInput/);
    assert.match(voiceSource, /stopNativeVoiceInput/);
    assert.match(voiceSource, /cancelNativeVoiceInput/);
    assert.match(voiceSource, /onVoiceInputGlobalToggle/);
    assert.match(voiceSource, /waitForNativeVoiceTextToSettle/);
    assert.match(voiceSource, /NATIVE_VOICE_FINAL_QUIET_MS/);
    assert.doesNotMatch(voiceSource, /startSpeechRecognition\(\)/);
    assert.doesNotMatch(voiceSource, /stopSpeechRecognition\(\)/);
    assert.doesNotMatch(mainRendererSource, /startNativeVoiceInput|voice-input-native/);
    assert.match(voiceHandlersSource, /findVoiceChatWindowBySender/);
    assert.match(voiceHandlersSource, /globalShortcut\.register\(shortcut/);
    assert.match(voiceHandlersSource, /voice-input-global-toggle/);
    assert.match(voiceHandlersSource, /仅语音聊天子窗口可以启动原生语音输入/);
});

test('voice input lifecycle has close and application quit safety cleanup', () => {
    const voiceSource = source('Voicechatmodules/voicechat.js');
    const voiceHandlersSource = source('modules/ipc/voiceHandlers.js');
    const mainSource = source('main.js');

    assert.match(voiceSource, /cancelNativeVoiceInput\?\.\(\)/);
    assert.match(voiceHandlersSource, /releaseNativeVoiceInput\(\{ restoreFocus: true, shutdown: true \}\)/);
    assert.match(voiceHandlersSource, /shutdownVoiceInputEngine/);
    assert.match(mainSource, /await voiceHandlers\.shutdownVoiceInputEngine\(\)/);
});

test('global voice settings expose native mode and shortcut instead of Puppeteer paths', () => {
    const mainHtml = source('main.html');
    const dom = new JSDOM(mainHtml);
    const template = dom.window.document.getElementById('globalSettingsModalTemplate');
    const settingsRoot = template.content;

    assert.ok(settingsRoot.getElementById('voiceInputMode'));
    assert.ok(settingsRoot.getElementById('voiceInputShortcut'));
    assert.equal(settingsRoot.getElementById('voiceInputMode').value, 'windows_voice_typing');
    assert.equal(settingsRoot.getElementById('voiceInputShortcut').value, 'Control+Alt+Space');
    assert.equal(settingsRoot.getElementById('speechRecognizerBrowserPath'), null);
    assert.equal(settingsRoot.getElementById('speechRecognizerPagePath'), null);
    dom.window.close();
});

test('settings persistence migrates legacy Puppeteer STT fields', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-voice-settings-'));
    const settingsPath = path.join(directory, 'settings.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    fs.writeFileSync(settingsPath, JSON.stringify({
        userName: '迁移测试',
        speechRecognizerBrowserPath: 'C:\\legacy\\chrome.exe',
        speechRecognizerPagePath: 'Voicechatmodules/recognizer.html',
    }));

    const manager = new AppSettingsManager(settingsPath);
    const result = await manager.updateSettings({
        voiceInputMode: 'right_alt_hold',
        voiceInputShortcut: 'Control+Shift+Space',
    });
    assert.equal(result.success, true);

    const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(persisted.voiceInputMode, 'right_alt_hold');
    assert.equal(persisted.voiceInputShortcut, 'Control+Shift+Space');
    assert.equal('speechRecognizerBrowserPath' in persisted, false);
    assert.equal('speechRecognizerPagePath' in persisted, false);
});

test('package and runtime closure ship the voice input sidecar unpacked', () => {
    const packageJson = JSON.parse(source('package.json'));
    const files = packageJson.build?.files || [];
    const unpack = packageJson.build?.asarUnpack || [];
    const runtimeClosureSource = source('modules/bootstrap/runtime-closure.js');

    assert.ok(files.includes('rust_voice_input_engine/runtime/**/*'));
    assert.ok(unpack.includes('rust_voice_input_engine/runtime/**/*'));
    assert.match(packageJson.scripts.build, /rust_voice_input_engine\/build-runtime\.js/);
    assert.match(runtimeClosureSource, /voiceInputRuntimeExecutableRelative/);
    assert.match(runtimeClosureSource, /Voice input Rust runtime is not unpacked/);
});