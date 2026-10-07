'use strict';

// 源码侧栏能写文件，来源校验必须和 Git 侧栏一样严：子 frame、webview 自报应用页面 URL 都不能调用。
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
            ipcMain: {
                handle: (channel, fn) => handlers.set(channel, fn),
                removeHandler: (channel) => handlers.delete(channel),
                on: () => {},
            },
            BrowserWindow: class {},
            shell: {},
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const sourceHandlers = require('../modules/ipc/sourceHandlers');
Module._load = originalLoad;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-source-ws-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
test.before(() => sourceHandlers.initialize({ workspaceService: { list: () => [{ id: 'ws', alias: 'ws', path: root, enabled: true }] } }));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const read = event => handlers.get('source:read-file')(event, 'ws', 'a.txt');

test('source handlers accept the real top-level app window', async () => {
    const { event } = createTrustedMainSender();
    const result = await read(event);
    assert.equal(result.success, true, result.error);
});

test('source handlers reject a subframe that reports an app page URL', async () => {
    const { sender } = createTrustedMainSender();
    const subframe = { url: sender.mainFrame.url, detached: false };
    const result = await read({ sender, senderFrame: subframe });
    assert.equal(result.success, false);
});

test('source handlers reject a webview guest that reports an app page URL', async () => {
    const { sender, event } = createTrustedMainSender();
    sender.getType = () => 'webview';
    const result = await read(event);
    assert.equal(result.success, false);
});
