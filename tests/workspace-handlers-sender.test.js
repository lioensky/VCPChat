'use strict';

// 工作区决定 Git、代码查看、终端能碰哪些目录，也会展开进系统提示、解析文件引用：
// 增删改只认主窗口。语音、助手窗口同样带 chat preload，只能读。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createTrustedMainSender } = require('./helpers/trusted-main-sender.cjs');

const handlers = new Map();
const originalLoad = Module._load;
Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') {
        return {
            ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel), on: () => {} },
            dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/picked'] }) },
            BrowserWindow: { fromWebContents: () => null },
        };
    }
    // fileManager 会加载 sharp（可选依赖，CI 用 --omit=optional 安装）；这里只用到解析器登记
    if (request === '../fileManager') return { setWorkspaceReferenceResolver() {} };
    if (request === 'sharp') throw new Error('sharp must not be loaded by this test');
    return originalLoad.call(this, request, parent, isMain);
};
const workspaceHandlers = require('../modules/ipc/workspaceHandlers');
const { createSidePaneSenderGuard, guardIpcMain } = require('../modules/ipc/sidePaneIpcPolicy');
Module._load = originalLoad;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-ws-sender-'));
const main = createTrustedMainSender();
const voice = createTrustedMainSender('Voicechatmodules/voicechat.html');
let settings = { workspaces: [] };
test.before(() => workspaceHandlers.initialize({
    logger: { warn() {}, log() {}, error() {} },
    // 和 main.js 一样经策略表包装
    ipcMain: guardIpcMain({ handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) },
        createSidePaneSenderGuard('workspaces', () => main.mainWindow)),
    settingsManager: {
        readSettings: async () => settings,
        updateSettings: async update => { settings = update(settings); return { settings }; },
        on() {}, off() {},
    },
}));
test.after(() => { workspaceHandlers.dispose?.(); fs.rmSync(dir, { recursive: true, force: true }); });

test('another chat-preload window cannot add, change or remove workspaces', async () => {
    const calls = [
        ['workspaces:add', dir], ['workspaces:remove', 'ws'], ['workspaces:update', 'ws', { enabled: false }],
        ['workspaces:set-active', null], ['workspaces:rebuild', null], ['workspaces:set-prompt-settings', {}],
        ['workspaces:select-directory'],
    ];
    for (const [channel, ...args] of calls) {
        const result = await handlers.get(channel)(voice.event, ...args);
        assert.equal(result.success, false, channel);
    }
    assert.deepEqual(settings.workspaces, []);
    assert.equal((await handlers.get('workspaces:list')(voice.event)).success, true, 'reading stays open');
});

test('the main window can still add a workspace', async () => {
    const result = await handlers.get('workspaces:add')(main.event, dir);
    assert.equal(result.success, true, result.error);
    assert.equal(settings.workspaces.length, 1);
});
