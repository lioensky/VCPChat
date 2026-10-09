import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../modules/ipc/chatHandlers.js', import.meta.url), 'utf8');
const encode = text => new TextEncoder().encode(text);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'controlled route did not settle');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

// Execute the real module and public IPC route, with isolated dependencies.
// No source rewriting or test-only access to its private stream function.
function route(fetchResponse, { settings = null, abortSignal = AbortSignal } = {}) {
    const handlers = new Map(), module = { exports: {} }, sent = [], warnings = [];
    const dependencies = new Map([
        ['electron', { ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} }, dialog: {}, BrowserWindow: {} }],
        ['fs-extra', { pathExists: async () => settings !== null, readJson: async () => settings }],
        ['path', require('node:path')], ['crypto', require('node:crypto')],
        ['../services/senderTaskRegistry', require('../modules/services/senderTaskRegistry.js')],
        ['../contextSanitizer', require('../modules/contextSanitizer.js')],
        // 真实的调用轨迹模块：没有配置记录目录时只返回空操作，不写盘
        ['../modelTrajectory', require('../modules/modelTrajectory.js')],
        // 真实的心情模块：没有配置时 observe 是空操作
        ['../agentMood', require('../modules/agentMood.js')],
        ['../services/attachmentDialogState', {}], ['../../Groupmodules/topicTitleManager', {}],
        ['../services/historyMutationQueue', {}], ['./workspaceHandlers', {}], ['./sideChatHandlers', {}],
        // 桌宠没打开时这些钩子全是空操作，用真实模块。
        ['./deskPetHandlers', require('../modules/ipc/deskPetHandlers.js')],
    ]);
    const load = name => { assert.ok(dependencies.has(name), 'unreviewed fixture dependency: ' + name); return dependencies.get(name); };
    vm.runInNewContext('(function(require,module,exports){' + source + '\n})', {
        console: { log() {}, warn: (...args) => warnings.push(args.join(' ')), error() {} },
        TextDecoder, URL, fetch: fetchResponse, AbortSignal: abortSignal,
    })(load, module, module.exports);
    module.exports.initialize(null, { USER_DATA_DIR: 'unused-isolated-fixture', APP_DATA_ROOT_IN_PROJECT: 'unused-isolated-fixture', historyMutationQueue: {} });
    const sender = Object.assign(new EventEmitter(), { id: 501, isDestroyed: () => false, send: (channel, event) => sent.push({ channel, event }) });
    const context = { agentId: 'fixture-agent', topicId: 'fixture-topic' };
    return { sent, warnings, sender, context, tasks: () => module.exports.getVcpStreamTaskSnapshot(),
        start: (url = 'http://controlled.invalid/v1/chat/completions') => handlers.get('send-to-vcp')({ sender }, url, '', [], { stream: true }, 'same-message', false, context),
        interrupt: (caller = sender) => handlers.get('interrupt-vcp-request')({ sender: caller }, { messageId: 'same-message' }),
        close: () => sender.emit('destroyed'),
    };
}

// hung：服务卡住不回中止请求，超时后照样走本地收尾，停止按钮不跟着卡
for (const failure of ['rejected', 'transport-error', 'missing-settings', 'hung']) {
    test(`failed interruption (${failure}) releases the caller's HTTP reader without a duplicate terminal`, async () => {
        let controller, aborted = false;
        const body = new ReadableStream({ start(value) { controller = value; } });
        const f = route(async (url, options) => {
            if (url.endsWith('/v1/interrupt')) {
                if (failure === 'transport-error') throw new Error('interrupt disconnected');
                if (failure === 'hung') {
                    // 只有请求自己的超时能让它结束；没有超时就要等满 2 秒
                    await new Promise((_resolve, reject) => {
                        setTimeout(() => reject(new Error('interrupt never answered')), 2000);
                        options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                    });
                }
                return { ok: false, status: 404, json: async () => ({ message: 'request not found' }) };
            }
            options.signal.addEventListener('abort', () => {
                aborted = true; controller.error(new DOMException('locally interrupted', 'AbortError'));
            }, { once: true });
            return { ok: true, body };
        }, { settings: failure === 'missing-settings' ? null : { vcpServerUrl: 'http://controlled.invalid/v1/chat/completions' },
            abortSignal: { timeout: () => { const timeout = new AbortController(); setTimeout(() => timeout.abort(new Error('timeout')), 20); return timeout.signal; } } });
        try {
            controller.enqueue(encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
            await f.start(); await waitFor(() => f.sent.length === 1);
            const startedAt = Date.now();
            assert.equal((await f.interrupt()).success, false);
            assert.ok(Date.now() - startedAt < 1000, 'stopping must not wait for an unresponsive server');
            await waitFor(() => !f.tasks().length);
            assert.equal(aborted, true); assert.equal(body.locked, false);
            assert.deepEqual(f.sent.map(item => item.event.type), ['data']);
            assert.equal(f.sent[0].event.chunk.choices[0].delta.content, 'partial');
            assert.equal(f.sender.eventNames().length, 0);
        } finally { f.close(); if (!body.locked) await body.cancel().catch(() => {}); }
    });
}

test('accepted interruption retains producer terminal delivery and its received content', async () => {
    let controller, aborted = false;
    const body = new ReadableStream({ start(value) { controller = value; } });
    const f = route(async (url, options) => {
        if (url.endsWith('/v1/interrupt')) return { ok: true, json: async () => ({ message: 'accepted' }) };
        options.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return { ok: true, body };
    }, { settings: { vcpServerUrl: 'http://controlled.invalid/v1/chat/completions' } });
    try {
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        await f.start(); await waitFor(() => f.sent.length === 1);
        assert.equal((await f.interrupt()).success, true);
        assert.equal(aborted, false); assert.equal(f.tasks().length, 1);
        controller.enqueue(encode('data: [DONE]\n\n'));
        await waitFor(() => !f.tasks().length);
        assert.deepEqual(f.sent.map(item => item.event.type), ['data', 'end']);
        assert.equal(body.locked, false); assert.equal(f.sender.eventNames().length, 0);
    } finally { f.close(); if (!body.locked) await body.cancel().catch(() => {}); }
});

test('failed interruption from another IPC window cannot abort the original HTTP reader', async () => {
    let controller, aborted = false;
    const body = new ReadableStream({ start(value) { controller = value; } });
    const f = route(async (url, options) => {
        if (url.endsWith('/v1/interrupt')) return { ok: false, status: 404, json: async () => ({ message: 'not found' }) };
        options.signal.addEventListener('abort', () => { aborted = true; controller.error(new DOMException('local stop', 'AbortError')); }, { once: true });
        return { ok: true, body };
    }, { settings: { vcpServerUrl: 'http://controlled.invalid/v1/chat/completions' } });
    try {
        await f.start();
        const foreignSender = Object.assign(new EventEmitter(), { id: 502, isDestroyed: () => false });
        assert.equal((await f.interrupt(foreignSender)).success, false);
        assert.equal(aborted, false); assert.equal(f.tasks().length, 1);
        await f.interrupt(); await waitFor(() => !f.tasks().length);
        assert.equal(aborted, true); assert.equal(body.locked, false);
    } finally { f.close(); if (!body.locked) await body.cancel().catch(() => {}); }
});

test('DONE before EOF cancels the actual response body and retains a single end event', async () => {
    let controller, cancelled = 0;
    const body = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled++; } });
    const f = route(async () => ({ ok: true, body }));
    try {
        controller.enqueue(encode('data: [DONE]\n\n'));
        assert.equal((await f.start()).streamingStarted, true);
        await waitFor(() => f.sent.length === 1 && f.tasks().length === 0); await tick();
        assert.equal(cancelled, 1, 'releaseLock alone leaves the response open');
        assert.equal(body.locked, false);
        assert.throws(() => controller.enqueue(encode('late bytes')), /closed/);
        assert.deepEqual(f.sent.map(item => item.event.type), ['end']);
        assert.equal(f.sent[0].event.context, f.context);
        assert.equal(f.sender.eventNames().length, 0, 'terminal task releases sender listeners');
        assert.deepEqual(f.warnings, []);
    } finally { if (!body.locked) await body.cancel().catch(() => {}); f.close(); }
});

test('normal EOF preserves a final partial SSE line and does not cancel a completed body', async () => {
    let cancelled = 0;
    const body = new ReadableStream({ start(controller) {
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":"last"}}]}')); controller.close();
    }, cancel() { cancelled++; } });
    const f = route(async () => ({ ok: true, body }));
    try {
        await f.start(); await waitFor(() => f.sent.length === 2 && !f.tasks().length);
        assert.deepEqual(f.sent.map(item => item.event.type), ['data', 'end']);
        assert.equal(f.sent[0].event.chunk.choices[0].delta.content, 'last');
        assert.equal(cancelled, 0); assert.equal(body.locked, false);
        assert.deepEqual(f.warnings, []);
    } finally { f.close(); }
});

test('read failure remains the primary terminal error when cancellation also rejects', async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error('controlled read failure')); } });
    const f = route(async () => ({ ok: true, body }));
    try {
        await f.start(); await waitFor(() => f.sent.length === 1 && !f.tasks().length); await tick();
        assert.deepEqual(f.sent.map(item => item.event.type), ['error']);
        assert.match(f.sent[0].event.error, /controlled read failure/);
        assert.equal(f.sent[0].event.context, f.context);
        assert.equal(body.locked, false); assert.equal(f.sender.eventNames().length, 0);
    } finally { f.close(); }
});

test('rejected cancellation is reported without duplicating the successful terminal event', async () => {
    let cancelled = 0;
    const body = new ReadableStream({ start(controller) { controller.enqueue(encode('data: [DONE]\n\n')); },
        cancel() { cancelled++; return Promise.reject(new Error('controlled cancel failure')); } });
    const f = route(async () => ({ ok: true, body }));
    try {
        await f.start(); await waitFor(() => f.sent.length === 1 && !f.tasks().length); await tick();
        assert.equal(cancelled, 1); assert.equal(body.locked, false);
        assert.deepEqual(f.sent.map(item => item.event.type), ['end']);
        assert.equal(f.warnings.filter(message => message.includes('controlled cancel failure')).length, 1);
    } finally { if (!body.locked) await body.cancel().catch(() => {}); f.close(); }
});

test('pending old cancellation does not retain its reader or finish a reused message task', async () => {
    let oldController, newController, rejectCancel, cancelStarted = false;
    const oldBody = new ReadableStream({ start(value) { oldController = value; }, cancel() {
        cancelStarted = true; return new Promise((_resolve, reject) => { rejectCancel = reject; });
    } });
    const newBody = new ReadableStream({ start(value) { newController = value; } });
    let request = 0;
    const f = route(async () => ({ ok: true, body: ++request === 1 ? oldBody : newBody }));
    try {
        oldController.enqueue(encode('data: [DONE]\n\n'));
        await f.start(); await waitFor(() => f.sent.length === 1 && !f.tasks().length); await tick();
        assert.equal(cancelStarted, true); assert.equal(oldBody.locked, false, 'local detach does not await remote cleanup');
        await f.start(); assert.equal(f.tasks().length, 1);
        rejectCancel(new Error('old cancellation rejected')); await tick();
        assert.equal(f.tasks().length, 1, 'late old cleanup cannot finish the replacement task');
        newController.enqueue(encode('data: {"value":"new"}\n\n')); newController.close();
        await waitFor(() => f.sent.length === 3 && !f.tasks().length);
        assert.deepEqual(f.sent.map(item => item.event.type), ['end', 'data', 'end']);
        assert.notEqual(f.sent[0].event.streamOperationId, f.sent[1].event.streamOperationId);
        assert.equal(f.sent[1].event.chunk.value, 'new');
        assert.equal(newBody.locked, false);
    } finally {
        rejectCancel?.(new Error('fixture cleanup'));
        if (!newBody.locked) await newBody.cancel();
        if (!oldBody.locked) {
            const cleanup = oldBody.cancel(); rejectCancel?.(new Error('fixture cleanup'));
            await cleanup.catch(() => {});
        }
        f.close();
    }
});

test('a synchronous reader cancellation failure still releases ownership and the lock', async () => {
    let released = 0;
    const reader = { read: async () => ({ done: false, value: encode('data: [DONE]\n\n') }),
        cancel() { throw new Error('synchronous cancel failure'); }, releaseLock() { released++; } };
    const f = route(async () => ({ ok: true, body: { getReader: () => reader } }));
    try {
        await f.start(); await waitFor(() => f.sent.length === 1 && !f.tasks().length); await tick();
        assert.equal(released, 1);
        assert.equal(f.warnings.filter(message => message.includes('synchronous cancel failure')).length, 1);
        assert.deepEqual(f.sent.map(item => item.event.type), ['end']);
    } finally { f.close(); }
});

test('a non-Error cancellation rejection cannot throw from the cleanup reporter', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(encode('data: [DONE]\n\n')); }, cancel() { return Promise.reject(null); } });
    const f = route(async () => ({ ok: true, body }));
    try {
        await f.start(); await waitFor(() => f.sent.length === 1 && !f.tasks().length); await tick();
        assert.equal(body.locked, false);
        assert.equal(f.warnings.filter(message => message.includes('Failed to cancel') && message.endsWith('null')).length, 1);
        assert.deepEqual(f.sent.map(item => item.event.type), ['end']);
    } finally { if (!body.locked) await body.cancel().catch(() => {}); f.close(); }
});

async function serverFixture(writeResponse) {
    let responseClosed = false, currentResponse;
    const server = http.createServer((_request, response) => {
        currentResponse = response;
        response.on('close', () => { responseClosed = true; });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        writeResponse(response);
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    return { url: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions', closed: () => responseClosed,
        disconnect: () => currentResponse.destroy(),
        async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('DONE closes a real local HTTP response which the server deliberately leaves open', { timeout: 10000 }, async () => {
    const server = await serverFixture(response => response.write('data: [DONE]\n\n'));
    const f = route(fetch);
    try {
        await f.start(server.url); await waitFor(() => f.sent.length === 1 && !f.tasks().length);
        await waitFor(server.closed);
        assert.deepEqual(f.sent.map(item => item.event.type), ['end']);
    } finally { f.close(); await server.close(); }
});

test('a real HTTP disconnect after a data chunk emits one read error and releases the task', { timeout: 10000 }, async () => {
    const server = await serverFixture(response => response.write('data: {"value":"partial"}\n\n'));
    const f = route(fetch);
    try {
        await f.start(server.url); await waitFor(() => f.sent.some(item => item.event.type === 'data'));
        server.disconnect();
        await waitFor(() => f.sent.some(item => item.event.type === 'error') && !f.tasks().length);
        assert.deepEqual(f.sent.map(item => item.event.type), ['data', 'error']);
        assert.equal(f.sent[0].event.chunk.value, 'partial');
        assert.equal(f.sender.eventNames().length, 0);
    } finally { f.close(); await server.close(); }
});

test('sender navigation aborts the real HTTP stream without delivering into the next document', { timeout: 10000 }, async () => {
    const server = await serverFixture(response => response.write('data: {"value":"before navigation"}\n\n'));
    const f = route(fetch);
    try {
        await f.start(server.url); await waitFor(() => f.sent.length === 1 && f.tasks().length === 1);
        // 主框架、非页内跳转才算宿主文档被替换（event, url, isInPlace, isMainFrame）。
        f.sender.emit('did-start-navigation', {}, 'file:///next.html', false, true);
        await waitFor(() => !f.tasks().length && server.closed()); await tick();
        assert.deepEqual(f.sent.map(item => item.event.type), ['data'], 'aborted sender receives no later terminal/error event');
        assert.equal(f.sender.eventNames().length, 0);
    } finally { f.close(); await server.close(); }
});

// VCP 服务端把请求体原样转给后端；不认识的字段（如 stream_options）会让部分后端直接 400，主聊天就发不出去了
test('the streamed request body does not ask the server for stream usage', async () => {
    let requestBody = null;
    const f = route(async (url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(encode('data: [DONE]\n\n')); controller.close(); } }) };
    });
    try {
        await f.start(); await waitFor(() => f.sent.length === 1 && !f.tasks().length);
        assert.equal(requestBody.stream, true);
        assert.equal(requestBody.requestId, 'same-message');
        assert.equal('stream_options' in requestBody, false);
    } finally { f.close(); }
});
