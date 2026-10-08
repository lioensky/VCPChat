'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SideBrowserService, webUrl } = require('../modules/loom/sideBrowserService');
const protocol = require('../modules/loom/webcore/web-agent-protocol');

function fixture() {
    const sender = new EventEmitter();
    sender.isDestroyed = () => false;
    sender.send = () => {};
    const win = { webContents: sender, isDestroyed: () => false,
        isMinimized: () => false, isVisible: () => true };
    const calls = [];
    const manager = {
        normalizeLoomActionId: id => protocol.resolveCommand(id).canonical,
        ensureWebAgentRuntime: async i => { i.webAgentReady = true; return i; },
        executeIsolatedPageOperation: async (i, action, params) => {
            calls.push([i.tabId, action, params]);
            return { status: 'success', result: { verified: true } };
        },
    };
    const service = new SideBrowserService({ manager, getMainWindow: () => win, timeoutMs: 20 });
    function guest(id) {
        const wc = new EventEmitter();
        const debuggerApi = new EventEmitter();
        debuggerApi.isAttached = () => false;
        return Object.assign(wc, { id, debugger: debuggerApi, isDestroyed: () => false,
            getTitle: () => `Page ${id}`, getURL: () => `https://example.com/${id}`,
            isLoadingMainFrame: () => false,
            executeJavaScriptInIsolatedWorld: async () => ({ markdown: 'page', snapshotId: 1 }) });
    }
    service.register(sender, 'browser:1', guest(1));
    service.register(sender, 'browser:2', guest(2));
    service.activeId = 'browser:2';
    return { service, sender, calls, guest };
}

test('explicit target is isolated from the user-selected active page', async () => {
    const h = fixture();
    await h.service.execute('click', { targetId: 'browser:1', target: '#button' });
    assert.equal(h.calls[0][0], 'browser:1');
    assert.equal((await h.service.execute('list_tabs')).response.result.result.count, 2);
    await assert.rejects(h.service.execute('click', { targetId: 'browser:missing' }), { code: 'TARGET_NOT_FOUND' });
});

test('assistance pauses writes, cancellation stays paused, only matching user completion resumes', async () => {
    const h = fixture();
    h.service.request = async () => ({});
    const result = await h.service.requestAssistance('browser:1', '请手动完成验证');
    await assert.rejects(h.service.execute('type', { targetId: 'browser:1' }), { code: 'USER_ASSISTANCE_PENDING' });
    await h.service.pageInfo('browser:1');
    assert.throws(() => h.service.completeAssistance({}, 'browser:1', result.assistance.requestId), { code: 'INVALID_REQUEST' });
    h.service.completeAssistance(h.sender, 'browser:1', result.assistance.requestId, true);
    await assert.rejects(h.service.execute('click', { targetId: 'browser:1' }), { code: 'USER_ASSISTANCE_PENDING' });
    const retry = await h.service.requestAssistance('browser:1', '请确认继续');
    h.service.completeAssistance(h.sender, 'browser:1', retry.assistance.requestId);
    await h.service.execute('click', { targetId: 'browser:1' });
    assert.equal(h.calls.length, 1);
});

test('old disposal cannot unregister a replacement page with the same tab ID', () => {
    const h = fixture();
    h.service.register(h.sender, 'browser:1', h.guest(3));
    assert.equal(h.service.unregister(h.sender, 'browser:1', 1), false);
    assert.equal(h.service.resolve('browser:1').view.webContents.id, 3);
});

test('navigation invalidates runtime and stale document identity', async () => {
    const h = fixture();
    const i = h.service.resolve('browser:1');
    i.webAgentReady = true;
    i.view.webContents.emit('did-start-navigation', {}, 'https://example.com/next', false, true);
    assert.equal(i.webAgentReady, false);
    assert.equal(i.documentGeneration, 2);
    i.view.webContents.emit('dom-ready');
    await i.documentReadyPromise;
    assert.equal(i.loading, false);
});

test('host responses require the exact owner and timeouts are explicit', async () => {
    const h = fixture();
    let payload;
    h.sender.send = (_channel, p) => { payload = p; };
    const pending = h.service.request('activate');
    assert.equal(h.service.respond({}, { requestId: payload.requestId, success: true }), false);
    assert.equal(h.service.respond(h.sender, { requestId: payload.requestId, success: true, data: 42 }), true);
    assert.equal(await pending, 42);
    await assert.rejects(h.service.request('open'), { code: 'BROWSER_HOST_TIMEOUT' });
    assert.equal(h.service.pending.size, 0);
});

test('agent navigation rejects privileged protocols', () => {
    for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,x']) {
        assert.throws(() => webUrl(url), { code: 'INVALID_REQUEST' });
    }
    assert.equal(webUrl('https://example.com'), 'https://example.com/');
});