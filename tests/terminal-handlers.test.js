'use strict';

// 侧栏终端主进程桥：镜像 VCPChat 自带终端（PowerShellExecutor 的真实 PTY 会话），
// 校验来源、工作区跳转、多视图共用同一会话，以及页面销毁时只取消镜像而不结束会话。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

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
            clipboard: { writeText() {}, readText: () => '' },
            shell: {},
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const terminalHandlers = require('../modules/ipc/terminalHandlers');
const executor = require('../VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js');
Module._load = originalLoad;

class FakeSender extends EventEmitter {
    constructor() {
        super();
        this.mainFrame = { url: this.getURL() };
        this.destroyed = false;
        this.sent = [];
    }
    getType() { return 'window'; }
    isDestroyed() { return this.destroyed; }
    send(channel, payload) { this.sent.push({ channel, payload }); }
    getURL() { return require('./helpers/trusted-main-sender.cjs').createTrustedMainSender().sender.getURL(); }
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-term-ws-'));
const workspaces = [
    { id: 'ws-on', alias: 'on', path: workspaceRoot, enabled: true },
    { id: 'ws-off', alias: 'off', path: workspaceRoot, enabled: false },
];

function call(channel, sender, ...args) {
    const event = { sender, senderFrame: sender.mainFrame };
    return handlers.get(channel)(event, ...args);
}

async function waitFor(predicate, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('waitFor timed out');
}

const viewOutput = (sender, id) => sender.sent
    .filter((m) => m.channel === 'terminal:data' && m.payload.id === id)
    .map((m) => m.payload.data)
    .join('');

test.before(() => {
    terminalHandlers.initialize({ workspaceService: { list: () => workspaces } });
});
test.after(() => {
    terminalHandlers.disposeAll();
    executor.cleanup();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('rejects callers that are not the main window page', async () => {
    const sender = new FakeSender();
    sender.getURL = () => 'file:///C:/app/other-window.html';
    assert.equal((await call('terminal:create', sender, {})).success, false);
    assert.equal((await call('terminal:write', sender, 'x', 'echo')).success, false);
    assert.equal(executor.getSessionState().running, false, 'a rejected caller must not start the shell');
});

test('mirrors the shared terminal session: input, output, resize, workspace jump', async () => {
    const sender = new FakeSender();
    const res = await call('terminal:create', sender, { cols: 100, rows: 30 });
    assert.equal(res.success, true, res.error);
    const { id } = res.data;
    assert.equal(executor.getSessionState().running, true);
    assert.equal(executor.getSessionState().cols, 100);

    const marker = `vcp-terminal-${Date.now()}`;
    assert.equal((await call('terminal:write', sender, id, `echo ${marker}\r`)).success, true);
    await waitFor(() => viewOutput(sender, id).split(marker).length > 2); // typed echo + command output
    assert.equal(viewOutput(sender, id).includes('__VCP_PTY_READY_'), false, 'the startup handshake stays out of the side pane');
    assert.equal((await call('terminal:resize', sender, id, 120, 40)).success, true);
    assert.equal(executor.getSessionState().cols, 120);

    // unknown / disabled workspaces are refused; an enabled one is entered
    assert.equal((await call('terminal:cd', sender, id, 'ws-off')).success, false);
    assert.equal((await call('terminal:cd', sender, id, 'nope')).success, false);
    assert.equal((await call('terminal:cd', sender, id, 42)).success, false);
    const cd = await call('terminal:cd', sender, id, 'ws-on');
    assert.equal(cd.success, true, cd.error);
    await waitFor(() => viewOutput(sender, id).includes(path.basename(workspaceRoot)));

    await call('terminal:kill', sender, id);
});

test('several views share one session; closing a view leaves the session running', async () => {
    const a = new FakeSender();
    const b = new FakeSender();
    const ra = await call('terminal:create', a, {});
    assert.equal(ra.success, true, ra.error);
    const marker = `vcp-shared-${Date.now()}`;
    await call('terminal:write', a, ra.data.id, `echo ${marker}\r`);
    await waitFor(() => viewOutput(a, ra.data.id).split(marker).length > 2);

    // a late view gets the existing output replayed, and sees new output too
    const rb = await call('terminal:create', b, {});
    assert.equal(rb.success, true, rb.error);
    assert.equal(rb.data.pid, ra.data.pid, 'both views attach to the same shell');
    await waitFor(() => viewOutput(b, rb.data.id).includes(marker));

    // one view cannot drive another window's view
    assert.equal((await call('terminal:write', b, ra.data.id, 'x')).success, false);
    assert.equal((await call('terminal:resize', b, ra.data.id, 80, 24)).success, false);

    const second = `vcp-second-${Date.now()}`;
    await call('terminal:write', b, rb.data.id, `echo ${second}\r`);
    await waitFor(() => viewOutput(a, ra.data.id).includes(second) && viewOutput(b, rb.data.id).includes(second));

    // closing a view only detaches it
    await call('terminal:kill', a, ra.data.id);
    assert.equal(executor.getSessionState().running, true);
    assert.equal((await call('terminal:write', a, ra.data.id, 'x')).success, false);
    const third = `vcp-third-${Date.now()}`;
    await call('terminal:write', b, rb.data.id, `echo ${third}\r`);
    await waitFor(() => viewOutput(b, rb.data.id).includes(third));
    assert.equal(viewOutput(a, ra.data.id).includes(third), false, 'a detached view stops receiving output');

    await call('terminal:kill', b, rb.data.id);
});

test('a page that navigates away or is destroyed only drops its views', async () => {
    const sender = new FakeSender();
    const r = await call('terminal:create', sender, {});
    assert.equal(r.success, true, r.error);

    sender.emit('did-start-navigation', {}, 'file:///x', false, true);
    assert.equal((await call('terminal:write', sender, r.data.id, 'x')).success, false);
    assert.equal(executor.getSessionState().running, true, 'the shared session keeps running');

    const r2 = await call('terminal:create', sender, {});
    assert.equal(r2.success, true, r2.error);
    sender.destroyed = true;
    sender.emit('destroyed');
    assert.equal((await call('terminal:write', sender, r2.data.id, 'x')).success, false);
    assert.equal(executor.getSessionState().running, true);
});

test('reports the shell exiting and can restart it, clearing the views', async () => {
    const sender = new FakeSender();
    const r = await call('terminal:create', sender, {});
    assert.equal(r.success, true, r.error);
    const { id } = r.data;

    await call('terminal:write', sender, id, 'exit\r');
    await waitFor(() => sender.sent.some((m) => m.channel === 'terminal:exit' && m.payload.id === id));
    assert.equal(executor.getSessionState().running, false);
    assert.equal((await call('terminal:write', sender, id, 'x')).success, false);
    assert.equal((await call('terminal:cd', sender, id, 'ws-on')).success, false);

    const restarted = await call('terminal:restart', sender, id);
    assert.equal(restarted.success, true, restarted.error);
    assert.ok(sender.sent.some((m) => m.channel === 'terminal:clear' && m.payload.id === id));
    const marker = `vcp-restart-${Date.now()}`;
    assert.equal((await call('terminal:write', sender, id, `echo ${marker}\r`)).success, true);
    await waitFor(() => viewOutput(sender, id).split(marker).length > 2);

    await call('terminal:kill', sender, id);
});

test('records AI commands as runs: listed, readable and pushed to watching pages', async () => {
    const sender = new FakeSender();
    const foreign = new FakeSender();
    foreign.getURL = () => 'https://example.com/';
    assert.equal((await call('terminal:command-runs', foreign)).success, false);
    assert.equal((await call('terminal:watch-command-runs', foreign)).success, false);

    assert.equal((await call('terminal:watch-command-runs', sender)).success, true);
    assert.equal((await call('terminal:watch-command-runs', sender)).success, true, 'watching twice is harmless');

    const marker = `vcp-run-${Date.now()}`;
    executor.ensureMirrorSession();
    const ran = await executor._runCommandForTest(`echo ${marker}`);
    assert.match(ran, new RegExp(marker));

    const listed = await call('terminal:command-runs', sender);
    assert.equal(listed.success, true, listed.error);
    const run = listed.data.find((item) => item.command === `echo ${marker}`);
    assert.ok(run, 'the command shows up in the list');
    assert.equal(run.status, 'completed');
    assert.equal(run.output, undefined, 'list entries carry no output body');

    const read = await call('terminal:command-run', sender, run.id);
    assert.equal(read.success, true, read.error);
    assert.match(read.data.output, new RegExp(marker));
    assert.doesNotMatch(read.data.output, /__VCP_COMMAND_/, 'boundary markers are not shown');
    assert.equal(read.data.truncated, false);
    const tail = await call('terminal:command-run', sender, run.id, { maxChars: 4 });
    assert.equal(tail.data.output.length <= 4, true);
    assert.equal(tail.data.truncated, true);
    assert.equal((await call('terminal:command-run', sender, 'run-missing')).success, false);
    assert.equal((await call('terminal:command-run', sender, 7)).success, false);

    await waitFor(() => sender.sent.some((m) => m.channel === 'terminal:command-run-changed' && m.payload.id === run.id && m.payload.status === 'completed'));

    // 脚本语法错误时仍会收到结束标记，错误文本进入输出；终端里只回显一行短的脚本调用
    const broken = await executor._runCommandForTest('Write-Output (');
    assert.match(broken, /Missing|缺少|ParserError|expression/i);
    const echoed = await call('terminal:create', sender, {});
    await waitFor(() => viewOutput(sender, echoed.data.id).includes('vcp-run-'));
    assert.equal(viewOutput(sender, echoed.data.id).includes('FromBase64String'), false, 'the wrapper code is not typed into the shell');
    await call('terminal:kill', sender, echoed.data.id);

    // 页面刷新后不再推送
    const before = sender.sent.length;
    sender.emit('did-start-navigation', {}, 'file:///x', false, true);
    await executor._runCommandForTest(`echo ${marker}-2`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(sender.sent.length, before);
});
