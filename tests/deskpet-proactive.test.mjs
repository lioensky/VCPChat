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

async function loadHandlers() {
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-'));
    const agentDir = path.join(root, 'Agents');
    fs.mkdirSync(path.join(agentDir, 'Nova'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'Nova', 'config.json'), JSON.stringify({ name: 'Nova', topics: [{ id: 'topic_Nova', name: '默认' }, { id: 'topic_1', name: '关于昨晚的梦' }] }));
    const mainWindow = new fake.electron.BrowserWindow({});
    handlers.initialize({ mainWindow, projectRoot: path.resolve('.'), appDataRoot: root, agentDir });
    // 等情绪提示词模块异步载入
    for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (handlers.getSystemPromptAppend('none', '') === '' && handlers._promptReady?.()) break;
    }
    return { handlers, fake, mainWindow, agentDir };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openNova(handlers, fake) {
    await fake.handlers.get('deskpet:toggle')({}, 'Nova');
    const pet = fake.windows.at(-1);
    pet.emit('ready-to-show');
    return pet;
}

const proactiveOf = (pet) => pet.sent.filter((s) => s.channel === 'deskpet:proactive').map((s) => s.payload);

test('a topic the agent opens by itself is said once on its open pet', async () => {
    const { handlers, fake } = await loadHandlers();
    const pet = await openNova(handlers, fake);
    const result = { message: 'ok', topic_id: 'topic_1', topic_name: '关于昨晚的梦', agent_id: 'Nova', initial_message: '我梦到会飞的鱼！' };
    handlers.onDistributedToolResult('TopicSponsor', { command: 'CreateTopic', maid: 'Nova' }, result);
    // 同一请求重放时结果会再回来一次，不能说两遍
    handlers.onDistributedToolResult('TopicSponsor', { command: 'CreateTopic', maid: 'Nova' }, result);
    // 别的命令、别的 agent 不说
    handlers.onDistributedToolResult('TopicSponsor', { command: 'ReadUnlockedTopics', maid: 'Nova' }, { agent_id: 'Nova' });
    handlers.onDistributedToolResult('TopicSponsor', { command: 'CreateTopic' }, { ...result, topic_id: 'topic_2', agent_id: 'Other' });
    assert.deepEqual(proactiveOf(pet), [{ kind: 'topic', title: '关于昨晚的梦', text: '我梦到会飞的鱼！', topicId: 'topic_1' }]);
    // 点气泡：主窗口切到这个话题
    fake.listeners.get('deskpet:open-topic')({ sender: pet.webContents }, 'topic_1');
    await sleep(50);
    const mainWindow = fake.windows[0];
    assert.deepEqual(mainWindow.sent.find((s) => s.channel === 'deskpet:open-topic').payload, { agentId: 'Nova', topicId: 'topic_1' });
    handlers.closeAll();
});

test('a topic deleted before its bubble is clicked is not selected in the main window', async () => {
    const { handlers, fake } = await loadHandlers();
    const pet = await openNova(handlers, fake);
    fake.listeners.get('deskpet:open-topic')({ sender: pet.webContents }, 'topic_gone');
    await sleep(50);
    const mainWindow = fake.windows[0];
    // 选中一个不存在的话题，接着说的话会存进话题列表里看不到的历史
    assert.equal(mainWindow.sent.some((s) => s.channel === 'deskpet:open-topic'), false);
    assert.equal(pet.sent.some((s) => s.channel === 'deskpet:topic-missing'), true);
    handlers.closeAll();
});

test('emotion tags and control markers in the first line are not spoken', async () => {
    const { handlers, fake } = await loadHandlers();
    const pet = await openNova(handlers, fake);
    handlers.onDistributedToolResult('TopicSponsor', { command: 'CreateFlowlockTopic' }, {
        topic_id: 'topic_f', topic_name: '自主工作', agent_id: 'Nova', initial_message: '<!--emo:happy 0.8-->开始干活啦！[[Flowlock::Start]]',
    });
    assert.equal(proactiveOf(pet)[0].text, '开始干活啦！');
    handlers.closeAll();
});

test('the same alarm reported twice rings once', async () => {
    const { handlers, fake } = await loadHandlers();
    const pet = await openNova(handlers, fake);
    const dueAt = Date.now() + 60;
    handlers.onDistributedToolResult('VCPAlarm', { maid: 'Nova' }, { status: 'success', due_at: dueAt, reminder_text: '喝水' });
    handlers.onDistributedToolResult('VCPAlarm', { maid: 'Nova' }, { status: 'success', due_at: dueAt + 20, reminder_text: '喝水' });
    // 别的提醒照常排
    handlers.onDistributedToolResult('VCPAlarm', { maid: 'Nova' }, { status: 'success', due_at: dueAt, reminder_text: '吃药' });
    await sleep(200);
    assert.deepEqual(proactiveOf(pet).map((p) => p.text).sort(), ['吃药', '喝水']);
    handlers.closeAll();
});

test('a hidden pet is not woken for a new topic', async () => {
    const { handlers, fake } = await loadHandlers();
    const pet = await openNova(handlers, fake);
    pet.hide();
    handlers.onDistributedToolResult('TopicSponsor', { command: 'CreateTopic' }, { topic_id: 't', topic_name: 'x', agent_id: 'Nova', initial_message: 'hi' });
    assert.deepEqual(proactiveOf(pet), []);
    assert.equal(pet.isVisible(), false);
    handlers.closeAll();
});

test('an alarm rings on the pet of the agent that set it, even if that pet was hidden', async () => {
    const { handlers, fake } = await loadHandlers();
    const pet = await openNova(handlers, fake);
    handlers.onRequestStart('m1', { agentId: 'Nova' });
    pet.hide();
    const dueAt = Date.now() + 60;
    const raw = `debug line\n${JSON.stringify({ status: 'success', result: '好的', due_at: dueAt, reminder_text: '看烤箱' })}`;
    handlers.onDistributedToolResult('VCPAlarm', { time_description: '1分钟后', reminder_text: '看烤箱' }, raw);
    // 失败的、算不出时间的、已经过去的都不排
    handlers.onDistributedToolResult('VCPAlarm', {}, JSON.stringify({ status: 'error', error: 'x' }));
    handlers.onDistributedToolResult('VCPAlarm', {}, JSON.stringify({ status: 'success', result: '好的' }));
    handlers.onDistributedToolResult('VCPAlarm', {}, JSON.stringify({ status: 'success', due_at: Date.now() - 1000 }));
    assert.deepEqual(proactiveOf(pet), []);
    await sleep(150);
    assert.deepEqual(proactiveOf(pet), [{ kind: 'alarm', text: '看烤箱', at: dueAt }]);
    assert.equal(pet.isVisible(), true);
    handlers.closeAll();
});

test('closing everything cancels alarms that have not rung yet', async () => {
    const { handlers, fake } = await loadHandlers();
    const pet = await openNova(handlers, fake);
    handlers.onDistributedToolResult('VCPAlarm', {}, JSON.stringify({ status: 'success', due_at: Date.now() + 50 }));
    handlers.closeAll();
    await sleep(120);
    assert.deepEqual(proactiveOf(pet), []);
});

test('a broken tool result never throws into the distributed server', async () => {
    const { handlers } = await loadHandlers();
    assert.doesNotThrow(() => handlers.onDistributedToolResult('VCPAlarm', null, '{not json'));
    assert.doesNotThrow(() => handlers.onDistributedToolResult('TopicSponsor', undefined, undefined));
    handlers.closeAll();
});
