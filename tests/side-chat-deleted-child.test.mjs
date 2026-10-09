import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const fse = require('fs-extra');
const sideChatHandlers = require('../modules/ipc/sideChatHandlers.js');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue.js');

// 真实的 chatHandlers 与侧聊 IPC，跑在临时数据目录上
function setup() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-sidechat-deleted-'));
    const queue = new HistoryMutationQueue({ userDataDir });
    const handlers = new Map();
    const ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler() {}, on() {} };
    const mainFrame = { url: pathToFileURL(path.resolve('main.html')).href, detached: false };
    const sender = { isDestroyed: () => false, mainFrame, getType: () => 'window', getURL: () => mainFrame.url };
    sideChatHandlers.initialize({ USER_DATA_DIR: userDataDir, historyMutationQueue: queue, ipcMain, mainWindow: { isDestroyed: () => false, webContents: sender } });
    const source = fs.readFileSync(new URL('../modules/ipc/chatHandlers.js', import.meta.url), 'utf8');
    const module = { exports: {} };
    const dependencies = new Map([
        ['electron', { ipcMain, dialog: {}, BrowserWindow: {} }],
        ['fs-extra', fse], ['path', path], ['crypto', require('node:crypto')],
        ['../services/senderTaskRegistry', require('../modules/services/senderTaskRegistry.js')],
        ['../contextSanitizer', require('../modules/contextSanitizer.js')],
        ['../modelTrajectory', require('../modules/modelTrajectory.js')],
        ['../agentMood', require('../modules/agentMood.js')],
        ['../services/attachmentDialogState', {}], ['../../Groupmodules/topicTitleManager', {}],
        ['../services/historyMutationQueue', { HistoryMutationQueue }], ['./workspaceHandlers', {}], ['./sideChatHandlers', sideChatHandlers],
        // 桌宠没打开时这些钩子全是空操作，用真实模块。
        ['./deskPetHandlers', require('../modules/ipc/deskPetHandlers.js')],
    ]);
    vm.runInNewContext('(function(require,module,exports){' + source + '\n})', { console: { log() {}, warn() {}, error() {} }, TextDecoder, URL, fetch, AbortSignal })(
        name => { assert.ok(dependencies.has(name), 'unreviewed fixture dependency: ' + name); return dependencies.get(name); }, module, module.exports);
    module.exports.initialize(null, { USER_DATA_DIR: userDataDir, APP_DATA_ROOT_IN_PROJECT: userDataDir, historyMutationQueue: queue });
    const call = (name, ...args) => handlers.get(name)({ sender, senderFrame: mainFrame }, ...args);
    return { userDataDir, call, cleanup: () => fs.rmSync(userDataDir, { recursive: true, force: true }) };
}

// 父话题被删时侧聊还在流式：流结束的保存是先读再写，读不能把已删的子目录建回来
test('a side chat reply that finishes after its child was deleted leaves no orphan directory', async () => {
    const { userDataDir, call, cleanup } = setup();
    try {
        const created = await call('side-chat:create-child', 'agent_a');
        assert.equal(created.success, true);
        const childDir = path.join(userDataDir, 'agent_a', 'topics', created.topicId);
        assert.deepEqual((await call('side-chat:delete-child', 'agent_a', created.topicId)).removed, true);

        assert.equal(JSON.stringify(await call('get-chat-history', 'agent_a', created.topicId)), '[]');
        const saved = await call('save-chat-history', 'agent_a', created.topicId, [{ id: 'late', role: 'assistant', content: 'late reply' }]);
        assert.equal(saved.success, false);
        assert.equal(fs.existsSync(childDir), false);
    } finally { cleanup(); }
});

test('reading an ordinary topic that has no directory yet still creates it as before', async () => {
    const { userDataDir, call, cleanup } = setup();
    try {
        assert.equal(JSON.stringify(await call('get-chat-history', 'agent_a', 'topic_1')), '[]');
        assert.equal(fs.existsSync(path.join(userDataDir, 'agent_a', 'topics', 'topic_1')), true);
    } finally { cleanup(); }
});
