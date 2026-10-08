'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { CommandTerminalProjection } = require('../VCPDistributedServer/Plugin/PowerShellExecutor/command-output-parser');

const source = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js'), 'utf8');
function pick(name) {
    const start = source.indexOf(`function ${name}(`);
    return source.slice(start, source.indexOf('\n}', start) + 2);
}

test('terminal targets default per call and never inherit the previous window target', () => {
    const context = vm.createContext({});
    vm.runInContext(pick('terminalTarget'), context);
    assert.equal(context.terminalTarget({}), 'sidebar');
    assert.equal(context.terminalTarget({ terminalTarget: 'window' }), 'window');
    assert.equal(context.terminalTarget({}), 'sidebar');
    assert.throws(() => context.terminalTarget({ terminalTarget: 'other' }), /terminalTarget/);
});

test('closing the independent window does not kill the shared PTY', () => {
    let killed = 0;
    class Window extends EventEmitter {
        constructor() { super(); this.webContents = {}; }
        loadFile() {}
    }
    const context = vm.createContext({
        guiWindow: null, guiReady: true, resolveGuiReady: null,
        createGuiReadyBarrier() {}, BrowserWindow: Window, path, __dirname: '.',
        process, ptyProcess: { kill() { killed++; } }
    });
    vm.runInContext(pick('ensureGuiWindow'), context);
    context.ensureGuiWindow().emit('closed');
    assert.equal(killed, 0);
    assert.equal(context.guiWindow, null);
});

test('projection hides split protocol markers without dropping cursor controls or real blank lines', () => {
    const marker = '__VCP_COMMAND_START_test__';
    const body = '\x1b[2;1H' + marker + '\r\nhello\r\n\r\n\x1b[6;1HPS> ';
    const expected = body.replace(marker, ' '.repeat(marker.length));
    for (let split = 0; split <= body.length; split++) {
        const projection = new CommandTerminalProjection([marker]);
        const output = projection.push(body.slice(0, split)) + projection.push(body.slice(split)) + projection.flush();
        assert.equal(output, expected);
    }
});

test('sidebar bridge authenticates responses, rejects unavailable windows and cleans pending requests', async () => {
    const handlers = new Map();
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'electron') return { ipcMain: {
            handle: (channel, fn) => handlers.set(channel, fn),
            removeHandler: channel => handlers.delete(channel)
        } };
        return original.call(this, request, parent, isMain);
    };
    let bridge;
    try { bridge = require('../modules/ipc/terminalHandlers'); }
    finally { Module._load = original; }
    const sender = Object.assign(new EventEmitter(), {
        ...require('./helpers/trusted-main-sender.cjs').createTrustedMainSender().sender,
        sent: [], isDestroyed: () => false,
        send(channel, payload) { this.sent.push({ channel, payload }); }
    });
    bridge.initialize({ mainWindow: { webContents: sender } });
    const response = payload => handlers.get('terminal:view-response')({ sender, senderFrame: sender.mainFrame }, payload);
    try {
        const opening = bridge.requestTerminalView('open');
        const request = sender.sent.at(-1).payload;
        const foreign = require('./helpers/trusted-main-sender.cjs').createTrustedMainSender().sender;
        assert.equal(handlers.get('terminal:view-response')({ sender: foreign, senderFrame: foreign.mainFrame }, {
            requestId: request.requestId, success: true
        }).success, false);
        assert.equal(response({ requestId: request.requestId, success: true, data: 'ready' }).success, true);
        assert.equal(await opening, 'ready');
        const pending = bridge.requestTerminalView('query');
        const rejected = assert.rejects(pending, /关闭|导航/);
        sender.emit('did-navigate');
        await rejected;
        bridge.initialize();
        await assert.rejects(bridge.requestTerminalView('open'), /主窗口不可用/);
    } finally { bridge.disposeAll(); }
});