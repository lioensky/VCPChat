import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import undici from 'undici';
import idleModule from '../modules/chat/sleepStreamIdle.js';
import requestsModule from '../modules/chat/sleepStreamRequests.js';

const { createSleepStreamIdle, getChatStreamDispatcher, CHAT_STREAM_TIMEOUT_MS, CHAT_BODY_IDLE_MS } = idleModule;
const { createSleepStreamRequests, parseSleepMs } = requestsModule;
const block = fields => ['<<<[TOOL_REQUEST]>>>', fields, '<<<[END_TOOL_REQUEST]>>>'].join('\n');
const jev = block('JEV: {始}睡眠[4分钟]，醒来后【检查状态】{末}');
const standard = block('tool_name: {始}VCPSleep{末},\nsleeptime: {始}10小时{末}');

test('chat transport uses the shared 500 s header and stream idle budgets', t => {
    assert.equal(CHAT_STREAM_TIMEOUT_MS, 500_000);
    assert.equal(CHAT_BODY_IDLE_MS, CHAT_STREAM_TIMEOUT_MS);

    const dispatch = t.mock.method(undici.Agent.prototype, 'dispatch', () => true);
    const fetchDefaults = { headersTimeout: 300_000, bodyTimeout: 300_000 };
    const handler = {};
    getChatStreamDispatcher().dispatch(fetchDefaults, handler);
    getChatStreamDispatcher({ hasBodyWatchdog: false }).dispatch(fetchDefaults, handler);

    assert.deepEqual(dispatch.mock.calls.map(call => call.arguments), [
        [{ headersTimeout: 500_000, bodyTimeout: 0 }, handler],
        [{ headersTimeout: 500_000, bodyTimeout: 300_000 }, handler],
    ]);
});

test('sleep requests arm once after a split marker, and actual content resumes normal idle', async () => {
    const events = [];
    const feed = await createSleepStreamRequests({
        sleep: ms => events.push(ms),
        resume: () => events.push('resume'),
    });
    feed(jev.slice(0, -8));
    assert.deepEqual(events, []);
    feed(jev.slice(-8));
    feed('\n ');
    assert.deepEqual(events, [240_000]);
    feed('继续处理');
    feed('\n' + standard);
    assert.deepEqual(events, [240_000, 'resume', 36_000_000]);
});

test('does not extend for examples, wrong tools, scheduled tool calls or invalid durations', async () => {
    const events = [];
    const feed = await createSleepStreamRequests({
        sleep: ms => events.push(ms),
        resume: () => events.push('resume'),
    });
    feed('说说睡眠[4分钟]\n');
    feed('```\n' + jev + '\n```\n');
    feed(standard.split('\n').map(line => '> ' + line).join('\n') + '\n');
    feed(block('tool_name: {始}Other{末},\nsleeptime: {始}10小时{末}') + '\n');
    feed(block('JEV: {始}睡眠[13小时]{末},\ntimely_contact: {始}2026-11-24-00:00{末}') + '\n');
    feed(block('JEV: {始}播放【睡眠[4分钟]】{末}') + '\n');
    assert.deepEqual(events, []);
    assert.equal(parseSleepMs('1小时30分钟'), 5_400_000);
    assert.equal(parseSleepMs('12小时'), 43_200_000);
    assert.equal(parseSleepMs('13小时'), 0);
    assert.equal(parseSleepMs('0'), 0);
});

async function openStream(t, mode) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: first\n\n');
        if (mode === 'continue') {
            const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 200);
            res.once('close', () => clearTimeout(timer));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.close(); server.closeAllConnections(); });
    const idle = createSleepStreamIdle({ idleMs: 100, wakeGraceMs: 0 });
    t.after(() => idle.close());
    const user = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
        dispatcher: getChatStreamDispatcher(),
        signal: AbortSignal.any([idle.signal, user.signal]),
    });
    idle.touch();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    assert.match(first, /first/);
    return { idle, user, reader, decoder, first };
}

test('ordinary HTTP stream still times out without body bytes', { timeout: 3000 }, async t => {
    const { idle, reader } = await openStream(t, 'quiet');
    await assert.rejects(reader.read());
    assert.equal(idle.signal.reason?.code, 'VCP_CHAT_BODY_IDLE_TIMEOUT');
});

test('sleep crosses the old idle window and receives DONE on the same connection', { timeout: 3000 }, async t => {
    const { idle, reader, decoder, first } = await openStream(t, 'continue');
    const feed = await createSleepStreamRequests(idle);
    feed(block('JEV: {始}睡眠[1秒]{末}'));
    let text = first;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        idle.touch();
        text += decoder.decode(value, { stream: true });
    }
    assert.match(text, /\[DONE\]/);
    assert.equal(idle.signal.aborted, false);
});

test('user can abort a 10-hour sleep without waiting for the idle clock', { timeout: 3000 }, async t => {
    const { idle, user, reader } = await openStream(t, 'quiet');
    const feed = await createSleepStreamRequests(idle);
    feed(standard);
    user.abort();
    await assert.rejects(reader.read());
    assert.equal(idle.signal.aborted, false);
});