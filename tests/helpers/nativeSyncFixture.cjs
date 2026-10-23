'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const realRequire = createRequire(path.join(root, 'package.json'));
const { HistoryMutationQueue } = realRequire('./modules/services/historyMutationQueue');
const quiet = { log() {}, warn() {}, error() {} };
function load(relative, dependencies, globals = {}) {
    const file = path.join(root, relative), mod = { exports: {} };
    const fallback = createRequire(file);
    const require = name => dependencies.has(name) ? dependencies.get(name) : fallback(name);
    vm.runInNewContext('(function(require,module,exports,__dirname){' + fs.readFileSync(file, 'utf8') + '\n})', { console: quiet, Buffer, URL, TextDecoder, TextEncoder, fetch, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, ...globals }, { filename: file })(require, mod, mod.exports, path.dirname(file));
    return mod.exports;
}
function registerNativeIpc(userDataDir, queue, options = {}) {
    const routes = new Map();
    const ipcMain = options.ipcMain || { handle: (name, fn) => routes.set(name, fn), removeHandler() {}, on() {} };
    const electron = options.electron || { ipcMain, dialog: {}, BrowserWindow: {} };
    const chat = load('modules/ipc/chatHandlers.js', new Map([
        ['electron', electron], ['../services/attachmentDialogState', {}], ['../../Groupmodules/topicTitleManager', {}],
        ['./workspaceHandlers', {}], ['./sideChatHandlers', {}], ['../modelTrajectory', { beginTrajectoryCall: () => ({ finish() {}, chunk() {} }), sessionKeyFromContext() {}, sourceFromContext() {} }],
    ]));
    chat.initialize(null, { USER_DATA_DIR: userDataDir, APP_DATA_ROOT_IN_PROJECT: path.dirname(userDataDir), historyMutationQueue: queue });
    realRequire('./modules/ipc/nativeHistoryHandlers').initialize({ ipcMain, historyMutationQueue: queue });
    return { call: (name, ...args) => routes.get(name)({ sender: { id: 1, isDestroyed: () => false } }, ...args), ipcMain, routes };
}
function registerGroupIpc(appDataRoot, queue, ipcMain, fetchResponse, window = null) {
    const electron = { ipcMain };
    const group = load('Groupmodules/groupchat.js', new Map([
        ['electron', electron], ['../modules/fileManager', {}], ['../modules/ipc/canvasHandlers', {}],
        ['../modules/ipc/tavernHandlers', { getActiveRules: () => [] }], ['../modules/tavernRulesEngine', {}],
        ['../modules/modelTrajectory', { beginTrajectoryCall: () => ({ finish() {}, chunk() {} }), sessionKeyFromContext() {}, sourceFromContext() {} }],
        ['./topicTitleManager', { triggerSummarizationIfNeeded: async () => {}, MIN_MESSAGES_FOR_SUMMARY: 1000 }],
    ]), { fetch: fetchResponse, AbortController, Response });
    group.initializePaths({ APP_DATA_ROOT_IN_PROJECT: appDataRoot, USER_DATA_DIR: queue.userDataDir, AGENT_DIR: path.join(appDataRoot, 'Agents'), SETTINGS_FILE: path.join(appDataRoot, 'settings.json') });
    const handlers = load('modules/ipc/groupChatHandlers.js', new Map([
        ['electron', electron], ['../../Groupmodules/groupchat', group], ['../modelTrajectory', { clearTrajectoryOf() {}, clearTrajectoriesOfOwner() {} }],
    ]));
    handlers.initialize(window, { USER_DATA_DIR: queue.userDataDir, AGENT_DIR: path.join(appDataRoot, 'Agents'), historyMutationQueue: queue });
    return group;
}
module.exports = { root, load, quiet, registerNativeIpc, registerGroupIpc, HistoryMutationQueue };
