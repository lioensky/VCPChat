const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const SettingsManager = require('../modules/utils/appSettingsManager');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function loadMusic(manager) {
    const handles = new Map();
    const sent = [];
    const mainWindow = { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } };
    const context = vm.createContext({
        module: { exports: {} }, __dirname: path.join(__dirname, '../modules/ipc'),
        console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout,
        require(name) {
            if (name === 'electron') return {
                ipcMain: { handle: (name, handler) => handles.set(name, handler), on() {} }
            };
            if (name.startsWith('../')) return {};
            return require(name);
        }
    });
    // node-fetch initialization is unrelated to these local IPC tests.
    const source = read('modules/ipc/musicHandlers.js').replace(
        "import('node-fetch')", 'Promise.resolve({ default: () => {} })');
    vm.runInContext(source, context);
    context.module.exports.initialize({
        mainWindow, openChildWindows: [], APP_DATA_ROOT_IN_PROJECT: os.tmpdir(), settingsManager: manager
    });
    return { handles, mainWindow, sent };
}

test('main IPC persists toggles, defaults on, rejects other senders and preserves unrelated settings', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-music-injection-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ agentMusicControl: true, userName: '音乐测试' }));
    const manager = new SettingsManager(file);
    const { handles, mainWindow } = loadMusic(manager);
    const snapshot = handles.get('music-capsule-get-state');
    const toggle = handles.get('music-info-injection-toggle');
    assert.equal((await snapshot()).musicInfoInjectionEnabled, true);
    await assert.rejects(toggle({ sender: {} }), /仅主聊天窗口/);
    assert.equal((await toggle({ sender: mainWindow.webContents })).musicInfoInjectionEnabled, false);
    assert.equal((await new SettingsManager(file).readSettings()).musicInfoInjectionEnabled, false);
    const saved = await manager.readSettings();
    assert.equal(saved.agentMusicControl, true);
    assert.equal(saved.userName, '音乐测试');
    const restarted = loadMusic(new SettingsManager(file));
    assert.equal((await restarted.handles.get('music-capsule-get-state')()).musicInfoInjectionEnabled, false);
    assert.equal((await toggle({ sender: mainWindow.webContents })).musicInfoInjectionEnabled, true);
    await Promise.all([toggle({ sender: mainWindow.webContents }), toggle({ sender: mainWindow.webContents })]);
    assert.equal((await manager.readSettings()).musicInfoInjectionEnabled, true);
});

test('failed persistence does not falsely publish a disabled state', async () => {
    const manager = new EventEmitter();
    manager.readSettings = async () => ({});
    manager.updateSettings = async () => { throw new Error('disk unavailable'); };
    const { handles, mainWindow } = loadMusic(manager);
    await assert.rejects(handles.get('music-info-injection-toggle')({ sender: mainWindow.webContents }), /disk unavailable/);
    assert.equal((await handles.get('music-capsule-get-state')()).musicInfoInjectionEnabled, true);
});

test('actual request injection block gates current music but preserves system prompt and AI controls', async () => {
    const source = read('modules/ipc/chatHandlers.js');
    const block = source.slice(source.indexOf('            // --- Agent Music Control Injection ---'),
        source.indexOf('            // --- VCP Thought Chain Stripping ---'));
    assert.ok(block.length > 100);
    for (const enabled of [undefined, true, false]) {
        for (const control of [true, false]) {
            const messages = [{ role: 'system', content: '专心工作' }, { role: 'user', content: '继续' }];
            const context = vm.createContext({
                messages, settings: { musicInfoInjectionEnabled: enabled, agentMusicControl: control },
                getMusicState: () => ({ currentSongInfo: { title: '歌曲', artist: '艺术家', album: '专辑' } }),
                fs: { pathExists: async () => true, readJson: async () => [{ title: '列表曲目' }] },
                path, APP_DATA_ROOT_IN_PROJECT: os.tmpdir(), console
            });
            await vm.runInContext(`(async () => { ${block} })()`, context);
            assert.equal(messages[0].content.includes('当前播放音乐'), enabled !== false);
            assert.equal(messages[0].content.includes('VCPMusicController'), control);
            assert.equal(messages[0].content.includes('播放列表'), control);
            assert.ok(messages[0].content.includes('专心工作'));
            assert.equal(messages[1].content, '继续');
        }
    }
});

function capsule(t, api) {
    const dom = new JSDOM(`<div class="music-capsule" hidden><div class="music-capsule-surface">
        <div class="music-capsule-details"><span class="music-capsule-title"></span>
        <button data-music-command="toggle"><span class="music-capsule-play"></span><span class="music-capsule-pause"></span></button>
        <button data-music-command="next"></button></div><button class="music-capsule-trigger"></button>
        </div></div>`, { runScripts: 'outside-only' });
    t.after(() => { dom.window.dispatchEvent(new dom.window.Event('beforeunload')); dom.window.close(); });
    let receive;
    dom.window.electronAPI = {
        onMusicCapsuleState: callback => { receive = callback; return () => {}; },
        getMusicCapsuleState: async () => ({ open: true, playing: true }),
        ...api
    };
    dom.window.eval(read('modules/ui-system/music-capsule.js'));
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    const trigger = dom.window.document.querySelector('.music-capsule-trigger');
    return { dom, trigger, root: dom.window.document.querySelector('.music-capsule'), publish: next => receive(next) };
}

test('right click toggles only injection, guards repeated clicks and retains playback commands', async t => {
    let resolve, calls = 0;
    const commands = [];
    const { dom, trigger, root, publish } = capsule(t, {
        toggleMusicInfoInjection: () => { calls++; return new Promise(done => { resolve = done; }); },
        sendMusicCapsuleCommand: command => commands.push(command)
    });
    await flush();
    const rightClick = () => trigger.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    assert.equal(rightClick(), false);
    rightClick();
    assert.equal(calls, 1);
    assert.equal(trigger.getAttribute('aria-busy'), 'true');
    resolve({ open: true, playing: true, musicInfoInjectionEnabled: false });
    await flush();
    assert.ok(root.classList.contains('is-injection-disabled'));
    assert.match(trigger.title, /已关闭/);
    assert.ok(root.classList.contains('is-playing'));
    root.querySelector('[data-music-command="next"]').click();
    root.querySelector('[data-music-command="toggle"]').click();
    assert.deepEqual(commands, ['next', 'pause']);
    publish({ open: true, title: '下一首', playing: true, musicInfoInjectionEnabled: false });
    assert.ok(root.classList.contains('is-injection-disabled'));
});

test('UI preserves enabled appearance and gives retry hint when persistence fails', async t => {
    const { trigger, root } = capsule(t, {
        toggleMusicInfoInjection: async () => { throw new Error('save failed'); }
    });
    await flush();
    trigger.dispatchEvent(new trigger.ownerDocument.defaultView.MouseEvent('contextmenu', { cancelable: true }));
    await flush();
    assert.equal(root.classList.contains('is-injection-disabled'), false);
    assert.match(trigger.title, /保存失败/);
    assert.equal(trigger.getAttribute('aria-busy'), 'false');
});