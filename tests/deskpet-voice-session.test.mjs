import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVoiceChatSessions, voiceChatSessions } = require('../modules/voice/voiceChatSessions');
const { createPetMainBridge } = require('../modules/deskpet/petMainBridge');

function windowStub() {
    const win = new EventEmitter();
    win.destroyed = false;
    win.sent = [];
    win.actions = [];
    win.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => win.destroyed,
        send: (channel, payload) => win.sent.push({ channel, payload }),
    });
    Object.assign(win, {
        isDestroyed: () => win.destroyed,
        isMinimized: () => true,
        restore: () => win.actions.push('restore'),
        show: () => win.actions.push('show'),
        focus: () => win.actions.push('focus'),
        close() { win.destroyed = true; win.emit('closed'); },
    });
    return win;
}

test('only matching ready voice sessions accept text, files and new topics are rejected', async () => {
    const sessions = createVoiceChatSessions();
    const win = windowStub();
    assert.equal(sessions.send('Nova', 'hi'), null);
    sessions.register('Nova', win);
    assert.deepEqual(sessions.status('Nova'), { mode: 'voice', ready: false });
    assert.equal((await sessions.send('Nova', 'hi')).success, false);
    assert.equal(sessions.setReady({}, true), false);
    sessions.setReady(win.webContents, true);
    assert.equal(sessions.send('Coco', 'hi'), null);
    assert.match((await sessions.send('Nova', 'hi', { files: [{}] })).error, /附件/);
    assert.match((await sessions.send('Nova', 'hi', { newTopic: true })).error, /新建/);
    assert.equal(win.sent.length, 0);
    const pending = sessions.send('Nova', 'hello');
    const { payload } = win.sent.at(-1);
    assert.equal(payload.text, 'hello');
    assert.equal(sessions.acknowledge({}, { requestId: payload.requestId, success: true }), false);
    sessions.acknowledge(win.webContents, { requestId: payload.requestId, success: true });
    assert.deepEqual(await pending, { success: true, route: 'voice' });
    win.close();
    assert.equal(sessions.send('Nova', 'hi'), null);
});

test('close, reload and timeout settle pending sends without fallback or accepting forged results', async () => {
    const sessions = createVoiceChatSessions({ timeoutMs: 10 });
    const win = windowStub();
    const changes = [];
    const off = sessions.subscribe((id, route) => changes.push([id, route]));
    sessions.register('Nova', win);
    sessions.setReady(win.webContents, true);
    let pending = sessions.send('Nova', 'first');
    win.webContents.emit('did-start-loading');
    assert.match((await pending).error, /重新加载/);
    sessions.setReady(win.webContents, true);
    assert.match((await sessions.send('Nova', 'timeout')).error, /未确认接收/);
    pending = sessions.send('Nova', 'closing');
    win.close();
    assert.match((await pending).error, /关闭/);
    assert.deepEqual(changes.at(-1), ['Nova', { mode: 'main', ready: false }]);
    off();
});

test('voice busy response propagates, and focus/interrupt target the same window', async () => {
    const sessions = createVoiceChatSessions();
    const win = windowStub();
    sessions.register('Nova', win);
    sessions.setReady(win.webContents, true);
    const pending = sessions.send('Nova', 'hi');
    sessions.acknowledge(win.webContents, {
        requestId: win.sent.at(-1).payload.requestId, success: false, error: '上一条还在回复中',
    });
    assert.match((await pending).error, /回复中/);
    assert.equal(sessions.focus('Nova'), true);
    assert.deepEqual(win.actions, ['restore', 'show', 'focus']);
    assert.equal(sessions.interrupt('Nova', 'm1'), true);
    assert.deepEqual(win.sent.at(-1), { channel: 'voice-chat:deskpet-interrupt', payload: { messageId: 'm1' } });
    win.close();
    assert.equal(sessions.focus('Nova'), false);
});

test('pet bridge prioritizes voice and restores ordinary routing after close', async () => {
    const mainWindow = windowStub();
    const voice = windowStub();
    const bridge = createPetMainBridge({ mainWindow });
    voiceChatSessions.register('RouteTest', voice);
    voiceChatSessions.setReady(voice.webContents, true);
    try {
        const pending = bridge.sendFromPet('RouteTest', 'voice');
        assert.equal(mainWindow.sent.length, 0);
        voiceChatSessions.acknowledge(voice.webContents, {
            requestId: voice.sent.at(-1).payload.requestId, success: true,
        });
        assert.equal((await pending).route, 'voice');
        assert.equal(await bridge.openTopic('RouteTest', 'voicechat_RouteTest'), true);
        assert.equal(mainWindow.actions.length, 0);
        voice.close();
        const normal = bridge.sendFromPet('RouteTest', 'normal');
        const request = mainWindow.sent.at(-1);
        assert.equal(request.channel, 'deskpet:send-request');
        bridge.resolveSend({ requestId: request.payload.requestId, result: { success: true } });
        assert.deepEqual(await normal, { success: true });
    } finally {
        if (!voice.destroyed) voice.close();
        bridge.settleAllPending();
    }
});