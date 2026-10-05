'use strict';

// 调用轨迹主进程桥：来源校验、按话题读取 / 清空、实时变更按调用合并推送、页面销毁时取消订阅。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const handlers = new Map();
const opened = [];
const originalLoad = Module._load;
Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') {
        return {
            ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel), on: () => {} },
            BrowserWindow: class {},
            clipboard: { writeText() {}, readText: () => '' },
            shell: { openPath: async (target) => { opened.push(target); return ''; } }
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const trajectoryHandlers = require('../modules/ipc/modelTrajectoryHandlers');
const { beginTrajectoryCall } = require('../modules/modelTrajectory');
Module._load = originalLoad;

const { createTrustedMainSender } = require('./helpers/trusted-main-sender.cjs');
const MAIN_URL = createTrustedMainSender().sender.getURL();

class FakeSender extends EventEmitter {
    constructor(url = MAIN_URL) { super(); this.url = url; this.mainFrame = { url, detached: false }; this.destroyed = false; this.sent = []; }
    getType() { return 'window'; }
    isDestroyed() { return this.destroyed; }
    send(channel, payload) { this.sent.push({ channel, payload }); }
    getURL() { return this.url; }
}
const call = (channel, sender, ...args) => handlers.get(channel)({ sender, senderFrame: sender.mainFrame }, ...args);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('lists, clears and watches trajectory records for the main window only', async () => {
    const rootDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-trajectory-ipc-')), 'ModelTrajectory');
    trajectoryHandlers.initialize({ rootDir });
    try {
        const sender = new FakeSender();
        const stranger = new FakeSender('https://evil.example/x.html');
        assert.equal((await call('model-trajectory:list', stranger, 'a__t')).success, false);
        assert.equal((await call('model-trajectory:list', sender, '')).success, false);
        assert.equal((await call('model-trajectory:list', sender, 'a'.repeat(400))).success, false);

        assert.equal((await call('model-trajectory:watch', sender)).success, true);
        const trace = beginTrajectoryCall({ sessionKey: 'a__t', requestId: 'm1', source: { kind: 'main' }, model: 'm', params: {}, messages: [{ role: 'user', content: 'hi' }] });
        trace.chunk({ choices: [{ delta: { content: 'one' } }] });
        trace.chunk({ choices: [{ delta: { content: ' two' } }] });
        trace.finish();
        await wait(250);
        const changes = sender.sent.filter((entry) => entry.channel === 'model-trajectory:changed').map((entry) => entry.payload);
        assert.ok(changes.length >= 1 && changes.length <= 2, `coalesced, got ${changes.length}`);
        assert.equal(changes.at(-1).status, 'completed');
        assert.equal(changes.at(-1).sessionKey, 'a__t');

        const listed = await call('model-trajectory:list', sender, 'a__t', { limit: 5 });
        assert.equal(listed.success, true);
        assert.equal(listed.data.records.length, 1);
        assert.equal(listed.data.records[0].response.text, 'one two');

        assert.equal((await call('model-trajectory:open-directory', sender)).success, true);
        assert.deepEqual(opened, [rootDir]);

        assert.equal((await call('model-trajectory:clear', sender, 'a__t')).success, true);
        assert.equal((await call('model-trajectory:list', sender, 'a__t')).data.records.length, 0);

        sender.emit('destroyed');
        const before = sender.sent.length;
        beginTrajectoryCall({ sessionKey: 'a__t', requestId: 'm2', source: { kind: 'main' }, model: 'm', params: {}, messages: [] }).finish();
        await wait(200);
        assert.equal(sender.sent.length, before, 'no pushes after the page is destroyed');
    } finally {
        trajectoryHandlers.disposeAll();
        fs.rmSync(path.dirname(rootDir), { recursive: true, force: true });
    }
});
