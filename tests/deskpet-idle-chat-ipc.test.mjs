import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

// 假的 electron：只记录主进程对窗口和 IPC 做了什么。
function fakeElectron() {
    const handlers = new Map();
    const listeners = new Map();
    const windows = [];
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.sent = [];
            this.visible = false;
            this.destroyed = false;
            this.webContents = Object.assign(new EventEmitter(), { send: (channel, payload) => this.sent.push({ channel, payload }) });
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        showInactive() { this.visible = true; }
        hide() { this.visible = false; }
        close() { this.destroyed = true; this.emit('closed'); }
        setAlwaysOnTop() {} moveTop() {} setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents() {} isMinimized() { return false; } restore() {} show() { this.visible = true; }
        setFocusable(value) { this.focusable = value; } focus() {} loadURL() {} getPosition() { return [0, 0]; } setPosition() {}
        // Windows 上主进程每隔一会儿用这些判断光标在不在窗口里
        getBounds() { return { x: 0, y: 0, width: 360, height: 580 }; } setBounds() {} getContentSize() { return [360, 580]; }
    }
    const electron = {
        BrowserWindow,
        ipcMain: {
            handle: (channel, fn) => handlers.set(channel, fn),
            on: (channel, fn) => listeners.set(channel, fn),
        },
        protocol: { handle() {}, registerSchemesAsPrivileged() {} },
        net: {},
        Menu: {},
        screen: {
            getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }),
            getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }],
            getCursorScreenPoint: () => ({ x: 0, y: 0 }),
            on() {},
        },
    };
    return { electron, handlers, listeners, windows };
}


async function loadHandlers(services) {
    const fake = fakeElectron();
    const originalLoad = Module._load;
    Module._load = function load(request, ...rest) {
        if (request === 'electron') return fake.electron;
        return originalLoad.call(this, request, ...rest);
    };
    const file = require.resolve('../modules/ipc/deskPetHandlers.js');
    delete require.cache[file];
    let handlers;
    try {
        handlers = require(file);
    } finally {
        Module._load = originalLoad;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-idle-'));
    const agentDir = path.join(root, 'Agents');
    fs.mkdirSync(path.join(agentDir, 'Nova'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'Nova', 'config.json'), JSON.stringify({ name: 'Nova', topics: [{ id: 'topic_Nova', name: '默认' }] }));
    const mainWindow = new fake.electron.BrowserWindow({});
    handlers.initialize({ mainWindow, projectRoot: path.resolve('.'), appDataRoot: root, agentDir, ...services });
    for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (handlers._promptReady?.()) break;
    }
    return { handlers, fake, mainWindow };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeServices({ topics = [{ id: 'topic_Nova', name: '默认' }] } = {}) {
    let config = { name: 'Nova', model: 'test-model', systemPrompt: '你是Nova', topics };
    const histories = new Map();
    const services = {
        readSettings: async () => ({ vcpServerUrl: 'http://vcp.test/v1/chat/completions', vcpApiKey: 'k', userName: 'Roxy' }),
        agentOps: () => ({
            readAgent: async (id) => ({ ...structuredClone(config), id }),
            updateAgent: async (_id, updater) => { const next = updater(structuredClone(config)); config = next.config; return next; },
        }),
        historyQueue: () => ({
            getHistoryPath: (agent, topic) => path.join(os.tmpdir(), 'no-such-dir', agent, topic, 'history.json'),
            read: async ({ topicId }) => histories.get(topicId) || [],
            mutate: async ({ topicId }, fn) => { histories.set(topicId, await fn(histories.get(topicId) || [])); },
        }),
    };
    return { services, histories, config: () => config };
}

// 主窗口回答「现在开着哪个话题」
function answerWhere(fake, mainWindow, where) {
    const timer = setInterval(() => {
        const request = mainWindow.sent.find((s) => s.channel === 'deskpet:where-request' && !s.answered);
        if (!request) return;
        request.answered = true;
        fake.listeners.get('deskpet:where-result')({ sender: mainWindow.webContents }, { requestId: request.payload.requestId, where });
    }, 5);
    return () => clearInterval(timer);
}

async function openNova(fake) {
    await fake.handlers.get('deskpet:toggle')({}, 'Nova');
    const pet = fake.windows.at(-1);
    pet.emit('ready-to-show');
    return pet;
}

test('an idle line is generated with the persona, saved to the idle topic and said on the pet', async () => {
    const realFetch = globalThis.fetch;
    let body;
    globalThis.fetch = async (_url, init) => {
        body = JSON.parse(init.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: '<!--emo:curious 0.6-->在忙什么呀？' } }] }) };
    };
    const { services, histories, config } = fakeServices();
    const { handlers, fake, mainWindow } = await loadHandlers(services);
    const stop = answerWhere(fake, mainWindow, { itemId: 'Nova', topicId: 'topic_Nova' });
    try {
        const pet = await openNova(fake);
        const result = await handlers._idleTick({ force: true });
        assert.equal(result.spoke, true);
        assert.equal(body.model, 'test-model');
        assert.equal(body.messages[0].role, 'system');
        assert.match(body.messages[0].content, /你是Nova/);
        const idleTopic = config().topics.find((t) => t.creatorSource === 'deskpet:idle-chat');
        assert.ok(idleTopic);
        assert.deepEqual(histories.get(idleTopic.id).map((m) => m.content), ['<!--emo:curious 0.6-->在忙什么呀？']);
        const said = pet.sent.filter((s) => s.channel === 'deskpet:proactive').map((s) => s.payload);
        assert.equal(said.length, 1);
        assert.equal(said[0].text, '在忙什么呀？');
        assert.equal(said[0].topicId, idleTopic.id);
        assert.equal(said[0].emotion, 'curious');
    } finally {
        stop();
        globalThis.fetch = realFetch;
        handlers.closeAll();
    }
});

test('nothing is written while the main window shows the idle topic, or when the pet is in do-not-disturb', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '嗨' } }] }) });
    const { services, histories } = fakeServices({ topics: [{ id: 'topic_idle', name: '桌宠闲聊', creatorSource: 'deskpet:idle-chat' }] });
    const { handlers, fake, mainWindow } = await loadHandlers(services);
    const stop = answerWhere(fake, mainWindow, { itemId: 'Nova', topicId: 'topic_idle' });
    try {
        const pet = await openNova(fake);
        assert.equal((await handlers._idleTick({ force: true })).reason, 'topic-open');
        assert.equal(histories.size, 0);
        handlers._controls().update({ doNotDisturb: true });
        assert.equal((await handlers._idleTick({ force: true })).reason, 'changed');
        assert.equal(pet.sent.some((s) => s.channel === 'deskpet:proactive'), false);
    } finally {
        stop();
        globalThis.fetch = realFetch;
        handlers.closeAll();
    }
});

test('a failed request is not retried right away and says nothing', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 502 });
    const { services } = fakeServices();
    const { handlers, fake } = await loadHandlers(services);
    try {
        const pet = await openNova(fake);
        handlers._controls().update({ idleChat: true, idleChatMinutes: 10 });
        assert.equal((await handlers._idleTick({ force: true })).reason, 'generate');
        assert.ok(handlers._idleState().get('Nova').lastFailedAt > 0);
        assert.equal(pet.sent.some((s) => s.channel === 'deskpet:proactive'), false);
    } finally {
        globalThis.fetch = realFetch;
        handlers.closeAll();
    }
});

test('sending to an agent counts as activity, and a freshly opened pet waits a full interval', async () => {
    const { services } = fakeServices();
    const { handlers, fake } = await loadHandlers(services);
    try {
        await openNova(fake);
        handlers._controls().update({ idleChat: true, idleChatMinutes: 10 });
        const first = await handlers._idleTick();
        assert.ok(['recent', 'night', 'away'].includes(first.reason));
        const before = handlers._idleState().get('Nova').lastActivityAt;
        await sleep(5);
        handlers.onRequestStart('m1', { agentId: 'Nova' });
        assert.ok(handlers._idleState().get('Nova').lastActivityAt > before);
    } finally {
        handlers.closeAll();
    }
});

test('a message sent while the line is being generated cancels it', async () => {
    const realFetch = globalThis.fetch;
    let handlersRef;
    globalThis.fetch = async () => {
        handlersRef.onRequestStart('m2', { agentId: 'Nova' });
        return { ok: true, json: async () => ({ choices: [{ message: { content: '嗨' } }] }) };
    };
    const { services, histories } = fakeServices();
    const { handlers, fake, mainWindow } = await loadHandlers(services);
    handlersRef = handlers;
    const stop = answerWhere(fake, mainWindow, { itemId: 'Nova', topicId: 'topic_Nova' });
    try {
        await openNova(fake);
        assert.equal((await handlers._idleTick({ force: true })).reason, 'changed');
        assert.equal(histories.size, 0);
    } finally {
        stop();
        globalThis.fetch = realFetch;
        handlers.closeAll();
    }
});
