import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

// 假的 electron + 假的 SovitsTTS：只记录谁在什么会话里要念什么。
function setup() {
    const handlers = new Map();
    const listeners = new Map();
    const windows = [];
    class BrowserWindow extends EventEmitter {
        constructor(options = {}) {
            super();
            this.options = options;
            this.bounds = { x: 0, y: 0, width: options.width ?? 0, height: options.height ?? 0 };
            this.visible = false;
            this.destroyed = false;
            this.sent = [];
            this.contents = Object.assign(new EventEmitter(), {
                send: (channel, payload) => this.sent.push({ channel, payload }),
                isDestroyed: () => this.destroyed,
            });
            windows.push(this);
        }
        // 和 Electron 一样：窗口销毁以后再读 webContents 会抛异常
        get webContents() {
            if (this.destroyed) throw new TypeError('Object has been destroyed');
            return this.contents;
        }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        showInactive() { this.visible = true; }
        close() { this.destroyed = true; this.emit('closed'); }
        setAlwaysOnTop() {} moveTop() {} setVisibleOnAllWorkspaces() {} focus() {} loadURL() {} reload() {}
        setIgnoreMouseEvents() {} setFocusable() {}
        getPosition() { return [this.bounds.x, this.bounds.y]; }
        getBounds() { return { ...this.bounds }; }
        setBounds(b) { this.bounds = { ...this.bounds, ...b }; }
    }
    const screen = Object.assign(new EventEmitter(), {
        getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }),
        getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }],
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    });
    const electron = {
        BrowserWindow,
        ipcMain: { handle: (c, fn) => handlers.set(c, fn), on: (c, fn) => listeners.set(c, fn) },
        protocol: { handle() {}, registerSchemesAsPrivileged() {} },
        net: {},
        Menu: { buildFromTemplate: (template) => { menus.push(template); return { popup() {} }; } },
        screen,
    };
    const menus = [];
    const spoken = [];
    class FakeTTS {
        constructor() { this.sessionId = 0; }
        stop() { this.sessionId += 1; }
        speak(options, sender) { spoken.push({ options, sender, session: this.sessionId }); }
    }
    const files = ['../modules/ipc/deskPetHandlers.js', '../modules/ipc/deskPetVoice.js', '../modules/ipc/sovitsHandlers.js'].map((f) => require.resolve(f));
    for (const f of files) delete require.cache[f];
    const ttsFile = require.resolve('../modules/SovitsTTS.js');
    require.cache[ttsFile] = { id: ttsFile, filename: ttsFile, loaded: true, exports: FakeTTS };
    const originalLoad = Module._load;
    Module._load = function load(request, ...rest) {
        if (request === 'electron') return electron;
        return originalLoad.call(this, request, ...rest);
    };
    let deskPet;
    let sovits;
    try {
        deskPet = require(files[0]);
        sovits = require(files[2]);
    } finally {
        Module._load = originalLoad;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-voice-'));
    const agentDir = path.join(root, 'Agents');
    const agents = { Nova: { name: 'Nova', ttsVoicePrimary: 'nova-voice', ttsSpeed: 1.2 }, Coco: { name: 'Coco' } };
    for (const [id, config] of Object.entries(agents)) {
        fs.mkdirSync(path.join(agentDir, id), { recursive: true });
        fs.writeFileSync(path.join(agentDir, id, 'config.json'), JSON.stringify(config));
    }
    const mainWindow = new BrowserWindow({});
    sovits.initialize(mainWindow, null);
    deskPet.initialize({ mainWindow, projectRoot: path.resolve('.'), appDataRoot: root, agentDir });
    const open = async (agentId) => {
        await handlers.get('deskpet:toggle')({}, agentId);
        return windows.at(-1);
    };
    const cleanup = () => {
        deskPet.closeAll();
        delete require.cache[ttsFile];
    };
    return { handlers, listeners, mainWindow, open, spoken, root, menus, cleanup };
}

const from = (win) => ({ sender: win.webContents });

test('the pet speaks with the agent\'s own voice settings; agents without a voice stay silent', async () => {
    const { handlers, listeners, open, spoken, cleanup } = setup();
    const nova = await open('Nova');
    const coco = await open('Coco');
    assert.deepEqual(await handlers.get('deskpet:voice-begin')(from(coco), 'c1'), { speaking: false });
    assert.deepEqual(await handlers.get('deskpet:voice-begin')(from(nova), 'n1'), { speaking: true, ttsRegex: '', ttsRegexSecondary: '' });
    listeners.get('deskpet:voice-say')(from(nova), { messageId: 'n1', key: 'n1#deskpet-0', text: '你好呀！', first: true });
    listeners.get('deskpet:voice-say')(from(nova), { messageId: 'n1', key: 'n1#deskpet-1', text: '今天怎么样？', first: false });
    assert.equal(spoken.length, 2);
    assert.equal(spoken[0].sender, nova.webContents, '音频回到桌宠窗口');
    assert.deepEqual(
        { voice: spoken[0].options.voice, speed: spoken[0].options.speed, text: spoken[0].options.text, msgId: spoken[0].options.msgId },
        { voice: 'nova-voice', speed: 1.2, text: '你好呀！', msgId: 'n1#deskpet-0' },
    );
    assert.equal(spoken[1].session, spoken[0].session, '后面的句子接着念，不重新开始');
    // 别的回复、别的窗口的话不接
    listeners.get('deskpet:voice-say')(from(nova), { messageId: 'other', key: 'x', text: '不该念', first: false });
    assert.equal(spoken.length, 2);
    cleanup();
});

test('one voice at a time, and the main window does not read the reply the pet is reading', async () => {
    const { handlers, listeners, mainWindow, open, spoken, cleanup } = setup();
    const nova = await open('Nova');
    await handlers.get('deskpet:voice-begin')(from(nova), 'n1');
    listeners.get('deskpet:voice-say')(from(nova), { messageId: 'n1', key: 'n1#deskpet-0', text: '第一句。', first: true });
    // 主窗口的自动朗读要念同一条：跳过
    listeners.get('sovits-speak')(from(mainWindow), { text: '第一句。第二句。', voice: 'nova-voice', msgId: 'n1' });
    assert.equal(spoken.length, 1);
    assert.equal(nova.sent.filter((m) => m.channel === 'stop-tts-audio').length, 0);
    // 主窗口念另一条：桌宠停下，后面的句子也不再接
    listeners.get('sovits-speak')(from(mainWindow), { text: '别的消息', voice: 'nova-voice', msgId: 'older' });
    assert.equal(spoken.at(-1).sender, mainWindow.webContents);
    assert.equal(nova.sent.filter((m) => m.channel === 'stop-tts-audio').length, 1, '桌宠收到停止');
    listeners.get('deskpet:voice-say')(from(nova), { messageId: 'n1', key: 'n1#deskpet-1', text: '第二句。', first: false });
    assert.equal(spoken.length, 2, '被打断以后不再往主窗口的朗读里插句子');
    // 桌宠再开口：主窗口里正在放的停掉
    await handlers.get('deskpet:voice-begin')(from(nova), 'n2');
    listeners.get('deskpet:voice-say')(from(nova), { messageId: 'n2', key: 'n2#deskpet-0', text: '新回复。', first: true });
    assert.ok(mainWindow.sent.some((m) => m.channel === 'stop-tts-audio'));
    // 主窗口点了停止朗读：桌宠也停
    const before = nova.sent.filter((m) => m.channel === 'stop-tts-audio').length;
    listeners.get('sovits-stop')(from(mainWindow));
    assert.equal(nova.sent.filter((m) => m.channel === 'stop-tts-audio').length, before + 1);
    cleanup();
});

test('turning reading off in the menu silences the pet and is remembered per agent', async () => {
    const { handlers, listeners, open, root, menus, cleanup } = setup();
    const nova = await open('Nova');
    const coco = await open('Coco');
    const voiceItem = async (win) => {
        await listeners.get('deskpet:context-menu')(from(win));
        return menus.at(-1).find((item) => item.label?.startsWith('朗读回复'));
    };
    const cocoItem = await voiceItem(coco);
    assert.equal(cocoItem.enabled, false, '没设音色的助手开关是灰的');
    const item = await voiceItem(nova);
    assert.equal(item.checked, true);
    await handlers.get('deskpet:voice-begin')(from(nova), 'n1');
    listeners.get('deskpet:voice-say')(from(nova), { messageId: 'n1', key: 'n1#deskpet-0', text: '正在说话。', first: true });
    item.click({ checked: false });
    assert.ok(nova.sent.some((m) => m.channel === 'stop-tts-audio'), '关掉时正在念的马上停');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(await handlers.get('deskpet:voice-begin')(from(nova), 'n2'), { speaking: false });
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'deskpet', 'voice.json'), 'utf8'));
    assert.deepEqual(saved, { muted: { Nova: true } });
    assert.equal((await voiceItem(nova)).checked, false);
    cleanup();
});

test('a reply given up while its voice settings are still loading does not stay claimed', async () => {
    const { handlers, listeners, open, cleanup } = setup();
    const claims = require('../modules/ipc/deskPetVoice.js')._claims;
    const nova = await open('Nova');
    // 用户在读配置的那一下点了停：end 先到，begin 读完以后不能再占
    const pending = handlers.get('deskpet:voice-begin')(from(nova), 'n1');
    listeners.get('deskpet:voice-end')(from(nova), { messageId: 'n1', stop: true });
    assert.deepEqual(await pending, { speaking: false });
    assert.equal(claims.has('n1'), false);
    // 新回复紧跟着开始：只有新的那条占着
    const older = handlers.get('deskpet:voice-begin')(from(nova), 'n2');
    const newer = handlers.get('deskpet:voice-begin')(from(nova), 'n3');
    assert.deepEqual(await older, { speaking: false });
    assert.deepEqual(await newer, { speaking: true, ttsRegex: '', ttsRegexSecondary: '' });
    assert.deepEqual([...claims.keys()], ['n3']);
    cleanup();
});
