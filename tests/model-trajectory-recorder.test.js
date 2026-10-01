const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModelTrajectoryRecorder, normalizeMessage, estimateTokens, beginTrajectoryCall } = require('../modules/modelTrajectory');

function tempRecorder(options = {}) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-trajectory-'));
    let tick = 1000;
    const recorder = createModelTrajectoryRecorder({ rootDir, now: () => (tick += 250), ...options });
    return { recorder, rootDir, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

const chunk = (delta, extra = {}) => ({ model: 'm-1', choices: [{ delta, finish_reason: extra.finish_reason ?? null }], ...(extra.usage ? { usage: extra.usage } : {}) });

test('normalizeMessage handles strings, part arrays, images and tool calls without storing base64', () => {
    assert.deepEqual(normalizeMessage({ role: 'user', content: '你好' }, 100), { role: 'user', parts: [{ kind: 'text', text: '你好' }] });
    const multi = normalizeMessage({
        role: 'user',
        content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]
    }, 100);
    assert.equal(multi.parts[1].kind, 'image');
    assert.equal(multi.parts[1].mediaType, 'image/png');
    assert.equal(JSON.stringify(multi).includes('AAAA'), false);
    const assistant = normalizeMessage({ role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{"a":1}' } }] }, 100);
    assert.deepEqual(assistant.parts, [{ kind: 'tool-call', toolCallId: 't1', toolName: 'f', input: '{"a":1}' }]);
    const tool = normalizeMessage({ role: 'tool', tool_call_id: 't1', content: 'ok' }, 100);
    assert.deepEqual(tool.parts, [{ kind: 'tool-result', toolCallId: 't1', toolName: undefined, output: 'ok' }]);
    assert.match(normalizeMessage({ role: 'user', content: 'x'.repeat(50) }, 10).parts[0].text, /已截断 40 个字符/u);
});

test('estimateTokens counts CJK per character and latin per ~4 characters', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('你好世界'), 4);
    assert.equal(estimateTokens('abcdefgh'), 2);
});

test('streamed call accumulates text, reasoning, tool calls, finish reason and usage', async () => {
    const { recorder, cleanup } = tempRecorder();
    try {
        const call = recorder.begin({
            sessionKey: 'agent_a__topic_1',
            requestId: 'msg-1',
            source: { kind: 'main', agentName: 'Nova' },
            model: 'm-1',
            params: { temperature: 0.7, apiKey: 'sk-secret', vcpApiKey: 'sk-secret2', max_tokens: 100, requestId: 'x' },
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]
        });
        const running = await recorder.list('agent_a__topic_1');
        assert.equal(running.records.length, 1);
        assert.equal(running.records[0].status, 'running');

        call.chunk(chunk({ reasoning_content: '想' }));
        call.chunk(chunk({ reasoning_content: '一下' }));
        call.chunk(chunk({ content: '你' }));
        call.chunk(chunk({ content: '好' }));
        call.chunk(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'lookup', arguments: '{"q":' } }] }));
        call.chunk(chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }));
        call.chunk({ raw: 'bad', error: 'json_parse_error' });
        call.chunk(chunk({}, { finish_reason: 'tool_calls', usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }));
        call.finish();
        call.finish({ error: new Error('late') });

        const { records, truncated } = await recorder.list('agent_a__topic_1');
        assert.equal(truncated, false);
        assert.equal(records.length, 1);
        const [record] = records;
        assert.equal(record.status, 'completed');
        assert.equal(record.requestId, 'msg-1');
        assert.equal(record.durationMs, record.endedAt - record.startedAt);
        assert.deepEqual(record.model.params, { temperature: 0.7, max_tokens: 100 }, 'secrets and requestId are never recorded');
        assert.equal(JSON.stringify(record).includes('sk-secret'), false);
        assert.equal(record.request.messages.length, 2);
        assert.equal(record.response.text, '你好');
        assert.equal(record.response.reasoningText, '想一下');
        assert.deepEqual(record.response.toolCalls, [{ kind: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"q":"x"}' }]);
        assert.equal(record.response.finishReason, 'tool_calls');
        assert.deepEqual(record.response.usage, { inputTokens: 12, outputTokens: 5, totalTokens: 17 });
        assert.equal(record.response.modelId, 'm-1');
        assert.equal(record.error, undefined);
    } finally { cleanup(); }
});

test('non-stream response, missing usage estimate, errors and aborts', async () => {
    const { recorder, cleanup } = tempRecorder();
    try {
        const ok = recorder.begin({ sessionKey: 's', messages: [{ role: 'user', content: 'abcdefgh' }] });
        ok.finish({ response: { model: 'm-2', choices: [{ message: { content: '你好', reasoning_content: 'r' }, finish_reason: 'stop' }] } });
        const failed = recorder.begin({ sessionKey: 's', messages: [] });
        failed.finish({ error: { name: 'HTTPError', message: 'VCP请求失败: 500' } });
        const aborted = recorder.begin({ sessionKey: 's', messages: [] });
        aborted.chunk(chunk({ content: '半句' }));
        aborted.finish({ aborted: true, error: { name: 'AbortError', message: '请求已中止' } });

        const { records } = await recorder.list('s');
        assert.deepEqual(records.map(record => record.status), ['completed', 'error', 'aborted']);
        assert.equal(records[0].response.text, '你好');
        assert.equal(records[0].response.reasoningText, 'r');
        assert.equal(records[0].response.usage.estimated, true);
        assert.equal(records[0].response.usage.inputTokens, 2);
        assert.deepEqual(records[1].error, { name: 'HTTPError', message: 'VCP请求失败: 500' });
        assert.equal(records[1].response, null);
        assert.equal(records[2].response.text, '半句', 'partial output of an aborted call is kept');
    } finally { cleanup(); }
});

test('list returns only the most recent records and says so; clear removes the file; sessions are isolated', async () => {
    const { recorder, rootDir, cleanup } = tempRecorder({ maxRecords: 3 });
    try {
        for (let i = 0; i < 5; i += 1) recorder.begin({ sessionKey: 'a', requestId: `r${i}`, messages: [] }).finish();
        recorder.begin({ sessionKey: 'b', messages: [] }).finish();
        const a = await recorder.list('a');
        assert.deepEqual(a.records.map(record => record.requestId), ['r2', 'r3', 'r4']);
        assert.equal(a.truncated, true);
        assert.equal(a.total, 5);
        assert.equal((await recorder.list('b')).records.length, 1);
        assert.equal((await recorder.list('missing')).records.length, 0);
        await recorder.clear('a');
        assert.equal((await recorder.list('a')).records.length, 0);
        assert.equal(fs.existsSync(path.join(rootDir, 'b.jsonl')), true);
    } finally { cleanup(); }
});

test('oversized files are compacted to the newest records; corrupt lines are skipped', async () => {
    const { recorder, rootDir, cleanup } = tempRecorder({ maxRecords: 2, maxFileBytes: 600 });
    try {
        for (let i = 0; i < 6; i += 1) recorder.begin({ sessionKey: 'big', requestId: `r${i}`, messages: [{ role: 'user', content: 'x'.repeat(200) }] }).finish();
        await recorder.list('big');
        fs.appendFileSync(path.join(rootDir, 'big.jsonl'), '{not json\n');
        const { records } = await recorder.list('big');
        assert.ok(records.length <= 2 + 1);
        assert.equal(records.at(-1).requestId, 'r5');
        assert.ok(fs.statSync(path.join(rootDir, 'big.jsonl')).size < 3000);
    } finally { cleanup(); }
});

test('subscribers hear about start, finish and clear; a throwing subscriber does not break recording', async () => {
    const { recorder, cleanup } = tempRecorder();
    try {
        const events = [];
        recorder.subscribe(() => { throw new Error('boom'); });
        const unsubscribe = recorder.subscribe(event => events.push(`${event.status}:${event.sessionKey}`));
        const call = recorder.begin({ sessionKey: 's', messages: [] });
        call.finish();
        await recorder.clear('s');
        assert.deepEqual(events, ['running:s', 'completed:s', 'cleared:s']);
        unsubscribe();
        recorder.begin({ sessionKey: 's', messages: [] }).finish();
        assert.equal(events.length, 3);
    } finally { cleanup(); }
});

test('beginTrajectoryCall is a safe no-op before the shared recorder is configured', () => {
    const call = beginTrajectoryCall({ sessionKey: 'x', messages: [] });
    call.chunk({});
    call.finish();
    assert.equal(call.id, null);
});

test('session key and source come from the request context (group beats agent)', () => {
    const { sessionKeyFromContext, sourceFromContext } = require('../modules/modelTrajectory');
    assert.equal(sessionKeyFromContext({ agentId: 'a1', topicId: 't1' }), 'a1__t1');
    assert.equal(sessionKeyFromContext({ groupId: 'g1', agentId: 'a1', topicId: 't1' }), 'g1__t1');
    assert.equal(sessionKeyFromContext({ agentId: 'a1' }), 'unscoped');
    assert.equal(sessionKeyFromContext(null), 'unscoped');
    assert.deepEqual(sourceFromContext({ agentId: 'a1', agentName: 'Nova', topicId: 't1' }), { kind: 'main', agentId: 'a1', agentName: 'Nova', topicId: 't1' });
    assert.equal(sourceFromContext({ groupId: 'g1', isGroupMessage: true }).kind, 'group');
    assert.equal(sourceFromContext({ agentId: 'a1' }, 'title').kind, 'title');
});

test('topic title generation is recorded as a title call when it knows its topic, and not at all without one', async () => {
    const { configureSharedRecorder } = require('../modules/modelTrajectory');
    const topicTitleManager = require('../Groupmodules/topicTitleManager');
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-trajectory-title-'));
    const recorder = configureSharedRecorder({ rootDir });
    const realFetch = globalThis.fetch;
    let bodies = [];
    globalThis.fetch = async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ model: 'title-m', choices: [{ message: { content: '周报整理' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 } }) };
    };
    try {
        const history = [{ role: 'user', content: '帮我整理周报', name: '用户' }, { role: 'assistant', content: '好的', name: 'Nova' }];
        const settings = { vcpUrl: 'http://127.0.0.1:1/v1/chat/completions', vcpApiKey: 'sk-real-key', userName: '用户', topicSummaryModel: 'title-m' };
        assert.equal(await topicTitleManager.generateTitleForHistory(history, settings, { agentId: 'a1', topicId: 't1' }), '周报整理');
        await topicTitleManager.generateTitleForHistory(history, settings);
        const { records } = await recorder.list('a1__t1');
        assert.equal(records.length, 1);
        assert.equal(records[0].source.kind, 'title');
        assert.equal(records[0].model.modelId, 'title-m');
        assert.equal(records[0].response.text, '周报整理');
        assert.equal(records[0].response.usage.totalTokens, 44);
        assert.equal(JSON.stringify(records[0]).includes('sk-real-key'), false);
        assert.equal((await recorder.list('unscoped')).records.length, 0);
        assert.equal(bodies.length, 2);
    } finally {
        globalThis.fetch = realFetch;
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});
