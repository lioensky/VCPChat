'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { createBridge } = require('./bridge.cjs');

const request = { topicId: 'topic_example', message: '## Ready\n\n- Review', requestId: 'request-1' };
const tokenEnv = 'TEST_TOPIC_REPLY_TOKEN_' + process.pid;

function fixture(t, topic, upstream = {}) {
    const calls = [];
    const bridge = createBridge({ topic, workspaces: [], maid: 'Test', enableBash: true, ...upstream }, {
        initialize() {},
        processToolCall(args) {
            calls.push(args);
            return { content: [{ type: 'text', text: 'mock PF' }] };
        },
        async cleanup() {}
    });
    t.after(() => bridge.close());
    return { bridge, calls };
}

function credentials(t) {
    const token = randomBytes(32).toString('hex');
    const previous = process.env[tokenEnv];
    process.env[tokenEnv] = token;
    t.after(() => {
        if (previous === undefined) delete process.env[tokenEnv];
        else process.env[tokenEnv] = previous;
    });
    return token;
}

async function localServer(t, listener) {
    const server = http.createServer(listener);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return { server, config: { enabled: true, baseUrl: `http://127.0.0.1:${server.address().port}`, tokenEnv } };
}

test('disabled or malformed Topic config neither exposes nor dispatches Topic; PF catalog stays intact', async t => {
    const warn = t.mock.method(console, 'warn', () => {});
    const warning = '[TopicReply MCP] Invalid topic configuration; Topic tools disabled.';
    const cases = [
        [undefined, false], [{ enabled: false }, false],
        [{ enabled: false, baseUrl: 'http://127.0.0.1:6200', tokenEnv }, false],
        [null, true], [{ enabled: 'false' }, true], [{ enabled: false, unknown: 'private-value' }, true],
        [{ enabled: true, baseUrl: 'http://localhost:6200', tokenEnv }, true],
        [{ enabled: true, baseUrl: 'http://127.0.0.1:6199', tokenEnv }, true],
        [{ enabled: true, baseUrl: 'http://127.0.0.1:6200/?x=1', tokenEnv }, true]
    ];
    for (const [topic, invalid] of cases) {
        warn.mock.resetCalls();
        const { bridge, calls } = fixture(t, topic);
        assert.deepEqual(warn.mock.calls.map(call => call.arguments), invalid ? [[warning]] : []);
        const available = bridge.listTools().map(tool => tool.name);
        assert.ok(available.includes('pf_query') && available.includes('pf_bash'));
        assert.ok(!available.some(name => name.startsWith('topic_')));
        assert.equal((await bridge.call('topic_reply', request)).isError, true);
        assert.equal((await bridge.call('pf_list_workspaces')).content[0].text, 'mock PF');
        assert.deepEqual(calls, [{ command: 'ListWorkspaces', maid: 'Test' }]);
    }
});

test('Topic timeout/offline keep the original ID, never retry, and do not block PF', async t => {
    credentials(t);
    let requests = 0;
    let seen;
    const entered = new Promise(resolve => { seen = resolve; });
    const { server, config } = await localServer(t, req => { req.resume(); requests++; seen(); });
    const { bridge, calls } = fixture(t, { ...config, timeoutMs: 600 });
    assert.ok(bridge.listTools().some(tool => tool.name === 'topic_reply_status'));
    assert.equal(requests, 0);
    const pending = bridge.call('topic_reply', request);
    await entered;
    assert.equal((await bridge.call('pf_list_workspaces')).content[0].text, 'mock PF');
    const result = await pending;
    assert.ok(result.isError);
    assert.deepEqual(result.structuredContent,
        { error: 'TOPIC_UNAVAILABLE', requestId: request.requestId, uncertain: true });
    assert.match(result.content[0].text, /topic_reply_status/);
    assert.equal(requests, 1);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.ok(bridge.listTools().some(tool => tool.name === 'topic_reply'));
    assert.equal((await bridge.call('topic_reply', request)).structuredContent.error, 'TOPIC_UNAVAILABLE');
    assert.equal((await bridge.call('pf_list_workspaces')).content[0].text, 'mock PF');
    assert.equal(calls.length, 2);
});

test('Topic uses only schema fields and dedicated HTTP paths/results; redirects are not followed', async t => {
    const token = credentials(t);
    const observed = [];
    const { config } = await localServer(t, (req, res) => {
        const parts = [];
        req.on('data', part => parts.push(part));
        req.on('end', () => {
            const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
            observed.push({ path: req.url, data, authorized: req.headers.authorization === `Bearer ${token}` });
            if (data.requestId === 'redirect') {
                res.writeHead(307, { Location: '/should-not-follow' }).end('{}');
            } else {
                res.writeHead(200).end(JSON.stringify({ requestId: data.requestId, state: 'queued',
                    entryId: 'mock-entry', advanceRequested: null, advanceEffective: true, ignored: 'ignore' }));
            }
        });
    });
    const { bridge, calls } = fixture(t, config);
    assert.equal((await bridge.call('topic_reply', { ...request, senderId: 'spoof' })).isError, true);
    assert.equal((await bridge.call('topic_reply_status', { requestId: request.requestId, topicId: request.topicId })).isError, true);
    assert.equal(observed.length, 0);
    const reply = await bridge.call('topic_reply', request);
    assert.deepEqual(reply.structuredContent, { requestId: request.requestId, state: 'queued',
        entryId: 'mock-entry', advanceRequested: null, advanceEffective: true });
    const query = { requestId: request.requestId };
    assert.deepEqual((await bridge.call('topic_reply_status', query)).structuredContent, reply.structuredContent);
    const redirect = await bridge.call('topic_reply', { ...request, requestId: 'redirect' });
    assert.equal(redirect.structuredContent.error, 'TOPIC_BAD_RESPONSE');
    assert.ok(redirect.structuredContent.uncertain);
    assert.deepEqual(observed, [
        { path: '/v1/topic-replies', data: request, authorized: true },
        { path: '/v1/topic-replies/status', data: query, authorized: true },
        { path: '/v1/topic-replies', data: { ...request, requestId: 'redirect' }, authorized: true }
    ]);
    await bridge.close();
    for (const [tool, args] of [['topic_reply', request], ['topic_reply_status', query]]) {
        const closed = await bridge.call(tool, args);
        assert.equal(closed.isError, true);
        assert.equal(closed.structuredContent.error, 'TOPIC_CLOSING');
    }
    assert.equal((await bridge.call('pf_list_workspaces')).isError, true);
    assert.equal(observed.length, 3);
    assert.equal(calls.length, 0);
});

test('upstream Topic and dedicated replies have independent switches and routes', async t => {
    const token = credentials(t);
    const observed = [];
    const upstream = await localServer(t, async (req, res) => {
        for await (const chunk of req) void chunk;
        observed.push(['upstream', req.url, req.headers.authorization === 'Bearer mock-vcp-key']);
        res.end(JSON.stringify({ accepted: true }));
    });
    const dedicated = await localServer(t, async (req, res) => {
        const parts = [];
        for await (const chunk of req) parts.push(chunk);
        const input = JSON.parse(Buffer.concat(parts).toString('utf8'));
        observed.push(['dedicated', req.url, req.headers.authorization === `Bearer ${token}`, input]);
        res.end(JSON.stringify({ requestId: input.requestId, state: 'queued',
            advanceRequested: true, advanceEffective: true, entryId: 'mock-entry' }));
    });
    const upstreamConfig = { enableTopic: true, vcpUrl: upstream.config.baseUrl, vcpKey: 'mock-vcp-key' };
    const tools = ['ts_reply_to_topic', 'tm_list_topics', 'topic_reply', 'topic_reply_status'];
    for (const [topic, official, expected] of [
        [dedicated.config, {}, [false, false, true, true]],
        [{ enabled: false }, upstreamConfig, [true, true, false, false]],
        [dedicated.config, upstreamConfig, [true, true, true, true]]
    ]) {
        const { bridge, calls } = fixture(t, topic, official);
        const names = new Set(bridge.listTools().map(tool => tool.name));
        assert.deepEqual(tools.map(name => names.has(name)), expected);
        if (!expected[0]) assert.equal((await bridge.call(tools[0], {})).isError, true);
        if (!expected[2]) assert.equal((await bridge.call(tools[2], request)).isError, true);
        assert.equal(observed.length, 0);
        if (!expected.every(Boolean)) continue;
        const upstreamReply = await bridge.call(tools[0], {
            topicId: request.topicId, senderName: 'Example', message: request.message
        });
        assert.equal(upstreamReply.structuredContent.accepted, true);
        const reply = { ...request, advance: true };
        const query = { requestId: request.requestId };
        assert.equal((await bridge.call(tools[2], reply)).structuredContent.advanceEffective, true);
        assert.equal((await bridge.call(tools[3], query)).structuredContent.state, 'queued');
        assert.deepEqual(observed, [
            ['upstream', '/v1/human/tool', true],
            ['dedicated', '/v1/topic-replies', true, reply],
            ['dedicated', '/v1/topic-replies/status', true, query]
        ]);
        assert.equal(calls.length, 0);
    }
});