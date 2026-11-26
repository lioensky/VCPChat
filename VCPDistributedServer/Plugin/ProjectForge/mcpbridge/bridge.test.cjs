'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { tools, validateArguments } = require('./tools.cjs');
const { topicTools } = require('./topic.cjs');
const { loadConfig, createBridge, convertResult } = require('./bridge.cjs');

test('schemas reject VCP fields, unknown edits and incorrect types', () => {
    for (const tool of tools) assert.throws(() => validateArguments(tool, { unknown: true }));
    validateArguments('pf_edit_code', { projectId: 'p1', path: 'a.js', reason: 'fix', edits: [{ target: 'a', replace: 'b' }] });
    for (const extra of [{ ink: 'mark_history' }, { valet: 'Kerr' }, { steps: [] }, { edits: [{ replacement: 'x' }] }]) {
        assert.throws(() => validateArguments('pf_edit_code', { projectId: 'p1', path: 'a.js', reason: 'fix', ...extra }));
    }
    validateArguments('pf_update_todos', { projectId: 'p1', done: [1, 2] });
    validateArguments('pf_eval_symbol', { projectId: 'p1', path: 'a.rs#test', target: 'lib' });
    validateArguments('pf_query', { projectId: 'p1', code: 'return 42;', timeoutMs: 30000 });
    validateArguments('pf_bash', { projectId: 'p1', script: 'pwd', workdir: '.', timeoutMs: 110000, maxBytes: 1024 });
    assert.throws(() => validateArguments('pf_query', { projectId: 'p1', code: ' ', timeoutMs: 30001 }));
    assert.throws(() => validateArguments('pf_bash', { projectId: 'p1', script: 'pwd', allowBash: true }));
    assert.throws(() => validateArguments('pf_bash', { projectId: 'p1', script: 'pwd', maxBytes: 1024 * 1024 + 1 }));
    assert.throws(() => validateArguments('pf_update_todos', { projectId: 'p1', done: ['abc'] }));
    assert.throws(() => validateArguments('pf_create_file', { projectId: 'p1', path: 'a', content: '', reason: 'create', overwrite: 'true' }));
});

test('topic schemas enforce strict fields, reply/dispatch modes and reject river/unknowns', () => {
    const byName = new Map(topicTools.map(tool => [tool.name, tool]));
    assert.equal(topicTools.length, 13);
    for (const tool of topicTools) {
        assert.throws(() => validateArguments(tool, { unknown: true }));
        assert.throws(() => validateArguments(tool, { river: 'last:5' }));
        assert.throws(() => validateArguments(tool, { valet: 'Kerr' }));
    }
    validateArguments(byName.get('ts_list_agents'), {});
    validateArguments(byName.get('ts_list_recent_topics'), { query: 'Kerr', targetType: 'agent' });
    assert.throws(() => validateArguments(byName.get('ts_list_recent_topics'), { query: 'Kerr\nNova' }));
    validateArguments(byName.get('ts_create_flowlock_topic'), {
        maid: 'Kerr', topicName: '自主巡检', initialMessage: '开始执行', flowlockHeartbeat: 10,
    });
    assert.throws(() => validateArguments(byName.get('ts_create_flowlock_topic'), {
        maid: 'Kerr', topicName: '自主巡检', initialMessage: 'x', flowlockHeartbeat: 0,
    }));
    validateArguments(byName.get('ts_reply_to_topic'), {
        topicId: 'topic_1', senderName: 'Kerr', message: 'hello\nworld',
        riverLast: 3, contextItems: [{ kind: 'tool', name: 'src/a.rs:10', content: 'fn x<T>() {}' }],
    });
    validateArguments(byName.get('ts_reply_to_topic'), {
        mode: 'new_topic', sourceTopicId: 'topic_1', targetAgent: 'Nova',
        senderId: 'Kerr_1', message: 'dispatch task', flowlock: true,
    });
    for (const invalid of [
        { topicId: 'topic_1', message: 'missing sender' },
        { mode: 'new_topic', topicId: 'topic_1', sourceTopicId: 'topic_0', targetAgent: 'Nova', senderName: 'Kerr', message: 'mixed' },
        { topicId: 'topic_1', senderName: 'Kerr', message: 'bad flowlock', flowlock: true },
        { senderName: 'Kerr', message: 'no target' },
        { topicId: 'topic_1', senderName: 'Kerr', message: 'has river', river: 'last:3' },
        { topicId: 'topic_1', senderName: 'Kerr', message: 'bad riverLast', riverLast: 21 },
        { topicId: 'topic_1', senderName: 'Kerr', message: 'empty ctx', contextItems: [] },
    ]) {
        assert.throws(() => validateArguments(byName.get('ts_reply_to_topic'), invalid));
    }
    validateArguments(byName.get('tm_list_topics'), { maid: 'Kerr', query: '设计', unreadOnly: true, limit: 10, offset: 0 });
    validateArguments(byName.get('tm_outline_topic'), { topicId: 'topic_1', startSeq: 1, endSeq: 20 });
    validateArguments(byName.get('tm_search_topic'), { topicId: 'topic_1', query: 'BUG', isRegex: false });
    validateArguments(byName.get('tm_get_topic_content'), { topicId: 'topic_1', tail: 15, maxCharsPerTurn: 4000, includeTools: true });
});

test('MCP media conversion avoids duplicating snapshots or fetching URLs', () => {
    const result = convertResult({ content: [{ type: 'text', text: 'ok' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }], details: { snapshot: 'large' } });
    assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }, { type: 'image', mimeType: 'image/png', data: 'YQ==' }] });
    assert.match(convertResult({ content: [{ type: 'image_url', image_url: { url: 'https://example.com/x' } }] }).content[0].text, /no network/);
    assert.match(convertResult({ content: [{ type: 'image_url', image_url: { url: 'data:video/mp4;base64,YQ==' } }] }).content[0].text, /omitted/);
    assert.equal(convertResult({ content: [], details: { command: 'CreateFile', status: 'conflict' } }).isError, true);
    assert.equal(convertResult({ content: [], details: { command: 'EditCode', status: 'ambiguous' } }).isError, undefined);
    assert.deepEqual(convertResult({ content: [], details: { command: 'EvalSymbol', status: 'returned', value: 3 } }).structuredContent.value, 3);
});

test('direct service adapter filters dangerous and topic tools by default and never retries failures', async () => {
    let calls = 0;
    let options;
    const bridge = createBridge({ workspaces: [], dbPath: 'test', maid: 'Kerr' }, {
        initialize(value) { options = value; },
        async processToolCall(args) { calls++; assert.equal(args.maid, 'Kerr'); assert.equal(args.command, 'ListWorkspaces'); throw Object.assign(new Error('unknown outcome'), { code: 'OUTCOME_UNKNOWN', operationId: 'op1' }); },
        async cleanup() {},
    });
    assert.equal(options.workspaceService.list().length, 0);
    assert.equal(options.config.BASH_ENABLED, false);
    assert(!bridge.listTools().some(tool => ['pf_eval_symbol', 'pf_purge_projects', 'pf_bash'].includes(tool.name)));
    assert(!bridge.listTools().some(tool => tool.name.startsWith('ts_') || tool.name.startsWith('tm_')));
    assert.equal(bridge.listTools().find(tool => tool.name === 'pf_query').annotations.readOnlyHint, true);
    const reply = await bridge.call('pf_list_workspaces', {});
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /OUTCOME_UNKNOWN/);
    assert.equal(calls, 1);
    await bridge.call('pf_eval_symbol', {});
    const disabled = await bridge.call('pf_bash', { projectId: 'p1', script: 'pwd' });
    assert.equal(disabled.isError, true);
    assert.match(disabled.content[0].text, /Unknown or disabled tool/);
    const topicDisabled = await bridge.call('ts_list_agents', {});
    assert.equal(topicDisabled.isError, true);
    assert.match(topicDisabled.content[0].text, /Unknown or disabled tool/);
    assert.equal(calls, 1);
    await bridge.close();
});

test('loadConfig validates enableTopic, vcpUrl and vcpKey / VCP_API_KEY fallback', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-topic-cfg-'));
    const filename = path.join(root, 'config.json');
    const previousEnv = process.env.VCP_API_KEY;
    t.after(async () => {
        if (previousEnv === undefined) delete process.env.VCP_API_KEY;
        else process.env.VCP_API_KEY = previousEnv;
        await fs.rm(root, { recursive: true, force: true });
    });
    delete process.env.VCP_API_KEY;

    const base = { workspaces: [{ id: 'w1', alias: 'w1', path: root }] };
    await fs.writeFile(filename, JSON.stringify(base));
    const offline = loadConfig(filename);
    assert.equal(offline.enableTopic, false);
    assert.equal(offline.vcpUrl, 'http://127.0.0.1:6005');

    await fs.writeFile(filename, JSON.stringify({ ...base, enableTopic: 'true' }));
    assert.throws(() => loadConfig(filename), /enableTopic must be boolean/);

    await fs.writeFile(filename, JSON.stringify({ ...base, enableTopic: true }));
    assert.throws(() => loadConfig(filename), /enableTopic requires vcpKey or VCP_API_KEY/);

    process.env.VCP_API_KEY = 'env-secret-key';
    const fromEnv = loadConfig(filename);
    assert.equal(fromEnv.enableTopic, true);
    assert.equal(fromEnv.vcpKey, 'env-secret-key');

    await fs.writeFile(filename, JSON.stringify({ ...base, enableTopic: true, vcpUrl: 'http://127.0.0.1:6005///', vcpKey: 'cfg-key' }));
    const explicit = loadConfig(filename);
    assert.equal(explicit.vcpUrl, 'http://127.0.0.1:6005');
    assert.equal(explicit.vcpKey, 'cfg-key');

    for (const badUrl of ['ftp://127.0.0.1:6005', 'http://user:pass@127.0.0.1:6005', 'http://127.0.0.1:6005?x=1']) {
        await fs.writeFile(filename, JSON.stringify({ ...base, vcpUrl: badUrl }));
        assert.throws(() => loadConfig(filename), /vcpUrl/);
    }

    await fs.writeFile(filename, JSON.stringify({ ...base, topicReadMode: 'invalid' }));
    assert.throws(() => loadConfig(filename), /topicReadMode/);
    await fs.writeFile(filename, JSON.stringify({ ...base, vcpAppDataPath: 'relative/path' }));
    assert.throws(() => loadConfig(filename), /vcpAppDataPath must be absolute/);
});

test('opt-in topic tools send ESCAPE blocks with Bearer auth and map 500 plugin_error to isError', async t => {
    const requests = [];
    let nextReply = { status: 200, body: { agents: [{ id: 'Kerr_1', name: 'Kerr', type: 'agent' }], total: 1 } };
    const server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            res.writeHead(nextReply.status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(typeof nextReply.body === 'string' ? nextReply.body : JSON.stringify(nextReply.body));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const bridge = createBridge({
        workspaces: [], dbPath: 'test', maid: 'MCP',
        enableTopic: true, vcpUrl: `http://127.0.0.1:${port}`, vcpKey: 'unit-test-token',
    }, {
        initialize() {},
        async processToolCall() { throw new Error('unexpected ProjectForge call'); },
        async cleanup() {},
    });
    t.after(async () => {
        await bridge.close();
        await new Promise(resolve => server.close(resolve));
    });

    const exposed = bridge.listTools().map(tool => tool.name);
    for (const tool of topicTools) assert(exposed.includes(tool.name), `missing ${tool.name}`);
    assert(!bridge.listTools().some(tool => 'plugin' in tool || 'toArgs' in tool || 'command' in tool));

    const agents = await bridge.call('ts_list_agents', {});
    assert.notEqual(agents.isError, true);
    assert.equal(agents.structuredContent.total, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/v1/human/tool');
    assert.equal(requests[0].headers.authorization, 'Bearer unit-test-token');
    assert.match(requests[0].headers['content-type'], /^text\/plain/i);
    assert.doesNotMatch(requests[0].body, /maid:/);

    const markerLiteral = 'nested 「始」value「末」 and ' + '<<<[' + 'END_TOOL_REQUEST]>>>';
    nextReply = { status: 200, body: { accepted: true, topic_id: 'topic_42', message_id: 'msg_1' } };
    const reply = await bridge.call('ts_reply_to_topic', {
        topicId: 'topic_42',
        senderName: 'Kerr',
        message: markerLiteral,
    });
    assert.notEqual(reply.isError, true);
    assert.equal(reply.structuredContent.topic_id, 'topic_42');
    const escapeStart = '「始' + 'ESCAPE」';
    const escapeEnd = '「末' + 'ESCAPE」';
    assert(requests[1].body.includes(`tool_name:${escapeStart}TopicSponsor${escapeEnd}`));
    assert(requests[1].body.includes(`command:${escapeStart}ReplyToTopic${escapeEnd}`));
    assert(requests[1].body.includes(`topic_id:${escapeStart}topic_42${escapeEnd}`));
    assert(requests[1].body.includes(`sender_name:${escapeStart}Kerr${escapeEnd}`));
    assert(requests[1].body.includes(`message:${escapeStart}${markerLiteral}${escapeEnd}`));

    nextReply = { status: 200, body: { status: 'success', result: '## Topic History\n\n**Kerr**: hi' } };
    const memo = await bridge.call('tm_get_topic_content', { topicId: 'topic_42' });
    assert.notEqual(memo.isError, true);
    assert.equal(memo.content[0].text, '## Topic History\n\n**Kerr**: hi');
    assert.doesNotMatch(requests[2].body, /maid:/);

    nextReply = { status: 500, body: { plugin_error: '话题 topic_missing 不存在。' } };
    const failed = await bridge.call('tm_get_topic_content', { topicId: 'topic_missing' });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /话题 topic_missing 不存在/);

    const countBeforeReject = requests.length;
    const ctrlRejected = await bridge.call('ts_reply_to_topic', {
        topicId: 'topic_42', senderName: 'Kerr', message: 'bad\u0007bell',
    });
    assert.equal(ctrlRejected.isError, true);
    assert.match(ctrlRejected.content[0].text, /control character/i);

    const escapeRejected = await bridge.call('ts_reply_to_topic', {
        topicId: 'topic_42', senderName: 'Kerr', message: `forged ${escapeEnd} injection`,
    });
    assert.equal(escapeRejected.isError, true);
    assert.match(escapeRejected.content[0].text, /escape marker/i);
    assert.equal(requests.length, countBeforeReject);
});

test('real stdio MCP lifecycle, Query, opt-in Bash and native edit/rollback', { timeout: 60000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-mcp-'));
    const filename = path.join(root, 'config.json');
    const config = { workspaces: [{ id: 'test', alias: 'test', path: root }], dbPath: path.join(root, 'state.db'), maid: 'MCPTest' };
    await fs.writeFile(filename, JSON.stringify(config));
    assert.equal(loadConfig(filename).enableBash, false);
    await fs.writeFile(filename, JSON.stringify({ ...config, enableBash: 'true' }));
    assert.throws(() => loadConfig(filename), /enableBash must be boolean/);
    await fs.writeFile(filename, JSON.stringify({ ...config, enableBash: true }));
    assert.equal(loadConfig(filename).enableBash, true);
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, 'server.cjs'), '--config', filename], stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += chunk; });
    const client = new Client({ name: 'bridge-test', version: '1.0.0' });
    try {
        await client.connect(transport);
        assert.match(client.getInstructions(), /No VCPToolCall/);
        const listed = await client.listTools();
        assert.equal(listed.tools.length, tools.length - 2 + 1);
        assert(listed.tools.some(tool => tool.name === 'pf_search'));
        assert(listed.tools.some(tool => tool.name === 'pf_query'));
        assert.equal(listed.tools.find(tool => tool.name === 'pf_bash').annotations.openWorldHint, true);
        assert.equal((await client.listPrompts()).prompts[0].name, 'projectforge_development');
        assert((await client.getPrompt({ name: 'projectforge_development' })).messages[0].content.text.length > 100);
        assert((await client.readResource({ uri: 'projectforge://instructions' })).contents[0].text.length > 100);
        const call = async (name, args) => {
            const result = await client.callTool({ name, arguments: args });
            assert.notEqual(result.isError, true, JSON.stringify(result));
            return result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        };
        assert.match(await call('pf_list_workspaces', {}), /test/);
        const created = await call('pf_create_project', { name: 'MCP integration', workspace: 'test', dir: 'source' });
        const projectId = /projectId[：:]\s*`([^`]+)`/.exec(created)?.[1];
        assert(projectId, created);
        await call('pf_create_file', { projectId, path: 'a.js', content: 'function one() { return 1; }\nfunction two() { return 2; }\n', reason: 'integration fixture' });
        await call('pf_edit_code', { projectId, path: 'a.js', reason: 'batch replacement', edits: [{ target: 'return 1;', replace: 'return 3;' }, { target: 'return 2;', replace: 'return 4;' }] });
        let text = await fs.readFile(path.join(root, 'source/a.js'), 'utf8');
        assert.match(text, /return 3/); assert.match(text, /return 4/);
        assert.match(await call('pf_read_code', { projectId, path: 'a.js' }), /return 3/);
        const query = await client.callTool({ name: 'pf_query', arguments: { projectId, code: 'return { answer: 42 };' } });
        assert.notEqual(query.isError, true, JSON.stringify(query));
        assert.deepEqual(query.structuredContent.value, { answer: 42 });
        const badQuery = await client.callTool({ name: 'pf_query', arguments: { projectId, code: 'throw new Error("query fixture");' } });
        assert.equal(badQuery.isError, true);
        await t.test('Bash returns exit code and streams over stdio', async t => {
            const run = script => client.callTool({ name: 'pf_bash', arguments: { projectId, script } });
            const bash = await run('printf "%s" "bash fixture"; printf "%s" "diagnostic" >&2');
            if (bash.structuredContent?.error?.code === 'BASH_NOT_FOUND') {
                assert.equal(bash.isError, true);
                t.skip('Bash executable unavailable');
                return;
            }
            assert.notEqual(bash.isError, true, JSON.stringify(bash));
            assert.equal(bash.structuredContent.stdout.text, 'bash fixture');
            assert.equal(bash.structuredContent.stderr.text, 'diagnostic');
            assert.equal(bash.structuredContent.exitCode, 0);
            const failed = await run('exit 7');
            assert.equal(failed.isError, true);
            assert.equal(failed.structuredContent.exitCode, 7);
        });
        const search = await call('pf_search', { query: 'return 3;', path: 'source', include: '*.js', isRegex: false });
        assert.match(search, /a\.js/);
        assert.match(search, /return 3;/);
        const outside = await client.callTool({ name: 'pf_search', arguments: { query: 'return', path: '../' } });
        assert.equal(outside.isError, true);
        await call('pf_rollback', { projectId, batch: 'last', reason: 'verify rollback' });
        text = await fs.readFile(path.join(root, 'source/a.js'), 'utf8');
        assert.match(text, /return 1/); assert.match(text, /return 2/);
        const beforeRejected = text;
        const rejected = await client.callTool({ name: 'pf_edit_code', arguments: { projectId, path: 'a.js', reason: 'reject missing target', edits: [{ target: 'not present at all', replace: 'bad' }] } });
        assert.equal(rejected.isError, true);
        assert.equal(await fs.readFile(path.join(root, 'source/a.js'), 'utf8'), beforeRejected);
        const invalid = await client.callTool({ name: 'pf_create_file', arguments: { projectId, path: '../escape.js', content: 'bad', reason: 'reject traversal' } });
        assert.equal(invalid.isError, true);
        assert.equal(await fs.stat(path.join(root, 'escape.js')).catch(() => null), null);
    } catch (error) { error.message += `\nServer stderr: ${stderr}`; throw error; }
    finally { await client.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('local TopicMemo progressive disclosure, code protection and V2 river quote round-trip', async t => {
    const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-topic-local-'));
    const agentId = '_Agent_test_kerr';
    const topicId = 'topic_long_1';
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            requests.push({ url: req.url, body });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ accepted: true, topic_id: 'topic_target', message_id: 'msg_v2', entryId: 'e1' }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await fs.rm(appData, { recursive: true, force: true });
    });

    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({ userName: 'User' }));
    await fs.mkdir(path.join(appData, 'Agents', agentId), { recursive: true });
    await fs.mkdir(path.join(appData, 'UserData', agentId, 'topics', topicId), { recursive: true });
    await fs.writeFile(path.join(appData, 'Agents', agentId, 'config.json'), JSON.stringify({
        name: 'Kerr',
        topics: [
            { id: topicId, name: '双擎渐进压测话题', createdAt: 1795600000000, unread: true },
            { id: 'topic_old_2', name: '普通已读归档', createdAt: 1795500000000, unread: false },
        ],
    }));

    const history = Array.from({ length: 40 }, (_, i) => {
        const idx = i + 1;
        if (idx === 12) {
            return {
                role: 'assistant',
                name: 'Kerr',
                timestamp: 1795600000000 + idx * 1000,
                content: `<div id="vcp-root"><style>.x{color:red}</style><p>锁定锚点关键字：NEEDLE_ALPHA</p><img src="file://D:/pic.png" alt="示意图"></div>\n\`\`\`rust\nfn keep_indent<T>() {\n    let items: Vec<T> = Vec::new();\n}\n\`\`\`\n[[VCP调用结果信息汇总:\n- 工具名称: ProjectForge\n- 执行状态: ✅ SUCCESS\n- 返回内容: ok_tool_body\nVCP调用结果结束]]\n[[VCP调用结果信息汇总: [HIDDEN]\n- 工具名称: SecretTool\n- 执行状态: ✅ SUCCESS\n- 返回内容: should_never_leak\nVCP调用结果结束]]`,
            };
        }
        return {
            role: idx % 2 === 1 ? 'user' : 'assistant',
            timestamp: 1795600000000 + idx * 1000,
            content: `第 ${idx} 楼对话正文`,
        };
    });
    await fs.writeFile(path.join(appData, 'UserData', agentId, 'topics', topicId, 'history.json'), JSON.stringify(history));

    const bridge = createBridge({
        workspaces: [], dbPath: 'test', maid: 'MCP',
        enableTopic: true, vcpUrl: `http://127.0.0.1:${port}`, vcpKey: 'local-key',
        vcpAppDataPath: appData, topicReadMode: 'local',
    }, {
        initialize() {},
        async processToolCall() { throw new Error('unexpected ProjectForge call'); },
        async cleanup() {},
    });
    t.after(() => bridge.close());

    // 1. 本地直读列表过滤与未读标记（0 HTTP 请求）
    const listRes = await bridge.call('tm_list_topics', { maid: 'Kerr', unreadOnly: true });
    assert.match(listRes.content[0].text, /双擎渐进压测话题.*\[未读\]/);
    assert.doesNotMatch(listRes.content[0].text, /普通已读归档/);
    assert.equal(listRes.structuredContent.mode, 'local_direct');

    // 2. L1 楼层大纲 & L2 话题内搜索
    const outlineRes = await bridge.call('tm_outline_topic', { topicId, startSeq: 11, endSeq: 13 });
    assert.match(outlineRes.content[0].text, /#12 \| Kerr \(assistant\).*\[工具×1\]：锁定锚点关键字：NEEDLE_ALPHA/);

    const searchRes = await bridge.call('tm_search_topic', { topicId, query: 'NEEDLE_ALPHA' });
    assert.match(searchRes.content[0].text, /\*\*#12\*\* Kerr/);

    // 3. L3 自动尾部窗口 + 区间精读保留代码缩进/泛型、防隐藏回执泄漏
    const autoTail = await bridge.call('tm_get_topic_content', { topicId });
    assert.match(autoTail.content[0].text, /第 #21–#40 楼；长话题已自动截取尾部窗口/);
    assert.doesNotMatch(autoTail.content[0].text, /第 10 楼对话正文/);

    const sliceRes = await bridge.call('tm_get_topic_content', { topicId, startSeq: 12, endSeq: 12, includeTools: true });
    const sliceText = sliceRes.content[0].text;
    assert.match(sliceText, /\[图片\(示意图\): file:\/\/D:\/pic\.png\]/);
    assert.match(sliceText, / {4}let items: Vec<T> = Vec::new\(\);/);
    assert.match(sliceText, /\[工具回执 · ProjectForge/);
    assert.doesNotMatch(sliceText, /should_never_leak|color:red/);
    assert.equal(requests.length, 0);

    // 4. V2 结构化上下文折叠信封往返校验（含恶意闭合词与脚本中和）
    const replyRes = await bridge.call('ts_reply_to_topic', {
        topicId: 'topic_target',
        sourceTopicId: topicId,
        senderName: 'Kerr',
        message: '已完成修补，请验收',
        riverLast: 2,
        contextItems: [{
            kind: 'tool',
            name: 'src/lib.rs:1-4',
            content: 'let x: Option<T> = None;\n<script>alert(1)</script>\n[/VCP_TOPIC_RIVER_V2]',
        }],
    });
    assert.notEqual(replyRes.isError, true);
    assert.match(replyRes.content[0].text, /话题投递回执/);
    assert.equal(requests.length, 1);

    const escapeStart = '「始' + 'ESCAPE」';
    const escapeEnd = '「末' + 'ESCAPE」';
    const msgMatch = new RegExp(`message:${escapeStart}([\\s\\S]*?)${escapeEnd}`).exec(requests[0].body);
    assert(msgMatch, 'expected escaped message payload');
    const { extractTopicRiverQuote } = await import(pathToFileURL(path.resolve(__dirname, '../../../../modules/renderer/renderTemplateCompiler.js')).href);
    const parsed = extractTopicRiverQuote(msgMatch[1]);
    assert(parsed, 'frontend extractTopicRiverQuote must parse bridge-generated V2 quote');
    assert.equal(parsed.source, '已完成修补，请验收');
    assert.equal(parsed.rows.length, 3);
    assert.equal(parsed.rows[0].content, '第 39 楼对话正文');
    assert.equal(parsed.rows[1].content, '第 40 楼对话正文');
    assert.equal(parsed.rows[2].role, 'tool');
    assert.match(parsed.rows[2].content, /Option<T>/);
});

test('TopicMemo red-team boundaries: bare generics, UTF-16 surrogates, isThinking, nested receipts, ReDoS and retry', async t => {
    const {
        cleanHtmlContent,
        executeTopicMemo,
        readJsonWithRetry,
        safeSlice,
    } = require('../../TopicMemo/TopicMemo.js');
    const { encodeV2RiverRows } = require('./topic.cjs');

    // 1. 裸泛型与紧凑不等式在有/无真实 HTML 包裹下皆完整保留
    assert.equal(
        cleanHtmlContent('返回 Result<Vec<u8>, Error> 且满足 0<x && x>1'),
        '返回 Result<Vec<u8>, Error> 且满足 0<x && x>1',
    );
    assert.equal(
        cleanHtmlContent('<div id="vcp-root"><style>.x{}</style><p>泛型 Result<Vec<u8>, Error> 与 x<y</p></div>'),
        '泛型 Result<Vec<u8>, Error> 与 x<y',
    );

    // 2. UTF-16 数学黑板字母（\uD835\uDC11 = 𝐑）与 Emoji 边界切割零孤立半代理
    const mathSample = `${'A'.repeat(20)}𝐑🚀${'B'.repeat(20)}`;
    const slicedMath = safeSlice(mathSample, 0, 21);
    assert.equal(slicedMath.endsWith('\uD835'), false, 'must not split leading surrogate');
    assert.equal(/[\uD800-\uDFFF]/.test(slicedMath.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), false);

    // 3. 沙箱构造：isThinking、独立 [系统通知] vs 行内 [系统通知]、嵌套自指工具回执、病态正则、V2 引用读出
    const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-topic-redteam-'));
    t.after(async () => fs.rm(appData, { recursive: true, force: true }));
    const agentId = '_Agent_redteam';
    const topicId = 'topic_redteam';
    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({ userName: 'User' }));
    await fs.mkdir(path.join(appData, 'Agents', agentId), { recursive: true });
    await fs.mkdir(path.join(appData, 'UserData', agentId, 'topics', topicId), { recursive: true });
    await fs.writeFile(path.join(appData, 'Agents', agentId, 'config.json'), JSON.stringify({
        name: 'Kerr',
        topics: [{ id: topicId, name: '边界极限话题', createdAt: 1795600000000 }],
    }));

    const v2Quoted = `这是正文回复\n\n${encodeV2RiverRows([{ kind: 'user', name: 'User', content: 'Vec<T>' }])}`;
    const nestedTool = '[[VCP调用结果信息汇总:\n- 工具名称: ReadCode\n- 执行状态: ✅ SUCCESS\n- 返回内容: head\n[[VCP调用结果信息汇总:\ninner\nVCP调用结果结束]]\nouter_tail_keep\nVCP调用结果结束]]';
    const noticeBlock = '[系统通知]\n时间播报噪音\n[系统通知结束]\n';

    await fs.writeFile(path.join(appData, 'UserData', agentId, 'topics', topicId, 'history.json'), JSON.stringify([
        { role: 'user', content: `${noticeBlock}第一楼正常正文` },
        { role: 'user', content: '用户正在讨论 [系统通知] 机制本身' },
        { role: 'assistant', name: 'Kerr', content: `分析完毕\n${nestedTool}` },
        { role: 'assistant', name: 'Kerr', content: v2Quoted },
        { role: 'assistant', name: 'Kerr', isThinking: true, content: '流式未落盘半成品' },
    ]));

    // isThinking 被剔除，总共应只计 4 楼
    const out = await executeTopicMemo({ command: 'GetTopicContent', topic_id: topicId, includeTools: true }, { vchatDataDir: appData });
    assert.match(out, /消息数量：4 条/);
    assert.match(out, /### \[#1\] User\n第一楼正常正文/);
    assert.doesNotMatch(out, /时间播报噪音|流式未落盘半成品/);
    assert.match(out, /用户正在讨论 \[系统通知\] 机制本身/);
    assert.match(out, /outer_tail_keep/);
    assert.match(out, /\[随附上下文引用\]/);
    assert.match(out, /> Vec<T>/);

    // 病态嵌套量词正则安全回退字面量匹配不阻塞
    const redosRes = await executeTopicMemo({
        command: 'SearchTopic', topic_id: topicId, query: '(a+)+$', isRegex: true,
    }, { vchatDataDir: appData });
    assert.match(redosRes, /正则无效或存在回溯风险已回退字面匹配/);

    // 简称 query 寻址不自相矛盾（无 maid 时不把 query 当作标题筛选词）
    const shortList = await executeTopicMemo({ command: 'ListTopics', query: 'Ke' }, { vchatDataDir: appData });
    assert.match(shortList, /边界极限话题/);

    // 5. readJsonWithRetry 对并发原子写瞬态 SyntaxError 自愈重试
    const flakyFile = path.join(appData, 'flaky.json');
    await fs.writeFile(flakyFile, '{"broken": ');
    const fixTimer = setTimeout(() => {
        fs.writeFile(flakyFile, '{"ok":true}').catch(() => {});
    }, 10);
    t.after(() => clearTimeout(fixTimer));
    const healed = await readJsonWithRetry(flakyFile, 3);
    assert.deepEqual(healed, { ok: true });

    // 6. 远程 HTTP 模式下的 riverLast 兜底提取
    const remoteCalls = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            remoteCalls.push(body);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            if (body.includes('TopicMemo')) {
                res.end(JSON.stringify({
                    status: 'success',
                    result: '## 话题：远端\n\n### [#1] User\n远端第1楼\n\n### [#2] Kerr\n远端第2楼\n',
                }));
            } else {
                res.end(JSON.stringify({ accepted: true, topic_id: 'topic_remote_dst', message_id: 'm1' }));
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    t.after(async () => new Promise(resolve => server.close(resolve)));

    const remoteBridge = createBridge({
        workspaces: [], dbPath: 'test', maid: 'MCP',
        enableTopic: true, vcpUrl: `http://127.0.0.1:${port}`, vcpKey: 'remote-key',
        topicReadMode: 'http',
    }, { initialize() {}, async processToolCall() {}, async cleanup() {} });
    t.after(() => remoteBridge.close());

    const remoteReply = await remoteBridge.call('ts_reply_to_topic', {
        topicId: 'topic_remote_dst', sourceTopicId: 'topic_remote_src',
        senderName: 'Kerr', message: '跨机汇报', riverLast: 2,
    });
    assert.notEqual(remoteReply.isError, true);
    assert.equal(remoteCalls.length, 2);
    assert(remoteCalls[0].includes('TopicMemo'));
    assert(remoteCalls[1].includes('VCP_TOPIC_RIVER_V2'));
    assert(remoteCalls[1].includes('远端第2楼'));
});