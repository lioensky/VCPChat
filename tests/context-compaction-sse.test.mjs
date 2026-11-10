import test from 'node:test';
import assert from 'node:assert/strict';
import { requestContextCompaction, createContextCompactionService } from '../modules/chat/contextCompactionService.js';

const settings = { enableContextCompaction: true, contextCompactionModel: 'compressor',
    vcpServerUrl: 'https://fixture.local/v1/chatvcp/completions' };
const state = { messages: [{ role: 'user', content: '任务' }] };
const encoder = new TextEncoder();
const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({
    model: 'stream-model', choices: [{ index: 0, delta, finish_reason }],
})}\r\n\r\n`;
function response(text) {
    const bytes = encoder.encode(text);
    return new Response(new ReadableStream({
        start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
        },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const run = (reply, extra = {}) => requestContextCompaction({
    settings, state, fetchImpl: async () => reply, ...extra,
});

test('stream:true; one-byte UTF8/CRLF splits preserve content, ignore reasoning/tools and publish once', async () => {
    const diagnostics = [];
    const text = ': heartbeat\r\n\r\n'
        + chunk({ reasoning_content: '不可当作报告' })
        + chunk({ content: '中文🙂' })
        + chunk({ content: [{ type: 'text', text: '报告' }], tool_calls: [{}] })
        + chunk({}, 'stop') + 'data: {"choices":[],"usage":{"total_tokens":1}}\r\n\r\n'
        + 'data: [DONE]\r\n\r\n';
    const result = await run(null, {
        fetchImpl: async (url, init) => {
            assert.equal(url, 'https://fixture.local/v1/chat/completions');
            assert.equal(JSON.parse(init.body).stream, true);
            return response(text);
        },
        onResponse: data => diagnostics.push(data),
    });
    assert.equal(result, '中文🙂报告');
    assert.deepEqual(diagnostics, [{ model: 'stream-model', finishReason: 'stop', content: result }]);
});

test('waits after finish_reason until DONE; cancels connection without requiring EOF', async () => {
    let controller;
    let settled = false;
    let cancelled = false;
    const pending = run(new Response(new ReadableStream({
        start(value) { controller = value; },
        cancel() { cancelled = true; },
    }))).then(value => { settled = true; return value; });
    controller.enqueue(encoder.encode(chunk({ content: '完整报告' }, 'stop')));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    assert.equal(await pending, '完整报告');
    assert.equal(cancelled, true);
});

test('clean EOF with finish_reason accepts missing final newline', async () => {
    assert.equal(await run(response(chunk({ content: '报告' }) + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}')), '报告');
});

for (const [name, text, pattern] of [
    ['premature EOF', chunk({ content: '半截报告' }), /提前断开/],
    ['malformed event', 'data: not-json\n\n', /无效 JSON/],
    ['upstream error', chunk({ content: '半截' }) + 'data: {"error":{"message":"failure"}}\n\n', /流式错误/],
]) {
    test(`${name} never commits history or resumes heartbeat`, async () => {
        let saves = 0;
        let resumes = 0;
        const service = createContextCompactionService({
            historyMutationAuthority: { mutate() { saves++; throw new Error('must not save'); } },
            request: options => requestContextCompaction({ ...options, fetchImpl: async () => response(text) }),
            flowlock: { resumeAfterContextCompaction() { resumes++; } },
        });
        await assert.rejects(service.compact({
            scope: { itemType: 'agent', itemId: 'a', topicId: 't' },
            settings, history: [{ role: 'user', content: '任务' }],
        }), pattern);
        assert.equal(saves, 0);
        assert.equal(resumes, 0);
        service.dispose();
    });
}

test('abort cancels blocked reader and rejects partial content', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const pending = run(new Response(new ReadableStream({
        start(stream) { stream.enqueue(encoder.encode(chunk({ content: '半截' }))); },
        cancel() { cancelled = true; },
    })), { signal: controller.signal });
    const rejection = assert.rejects(pending, /取消/);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await rejection;
    assert.equal(cancelled, true);
});

test('transport failure rejects partial report', async () => {
    let stream;
    const pending = run(new Response(new ReadableStream({
        start(controller) {
            stream = controller;
            controller.enqueue(encoder.encode(chunk({ content: '半截' })));
        },
    })));
    const rejection = assert.rejects(pending, /connection reset/);
    await new Promise(resolve => setImmediate(resolve));
    stream.error(new Error('connection reset'));
    await rejection;
});

test('multiline data, CR-only, refusal fallback and JSON compatibility', async () => {
    assert.equal(await run(response('data: {"choices":\ndata: [{"index":0,"delta":{"refusal":"拒绝"}}]}\n\ndata: [DONE]\n\n')), '拒绝');
    assert.equal(await run(response('data: {"choices":[{"delta":{"content":"报告"}}]}\r\rdata: [DONE]\r\r')), '报告');
    assert.equal(await run(Response.json({ choices: [{ message: { content: 'JSON报告' } }] })), 'JSON报告');
    assert.equal(await run(response(chunk({ reasoning_content: '只有思考' }, 'stop') + 'data: [DONE]\n\n')), '');
});