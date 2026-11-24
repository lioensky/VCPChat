'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { tools, validateArguments } = require('./tools.cjs');
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

test('MCP media conversion avoids duplicating snapshots or fetching URLs', () => {
    const result = convertResult({ content: [{ type: 'text', text: 'ok' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }], details: { snapshot: 'large' } });
    assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }, { type: 'image', mimeType: 'image/png', data: 'YQ==' }] });
    assert.match(convertResult({ content: [{ type: 'image_url', image_url: { url: 'https://example.com/x' } }] }).content[0].text, /no network/);
    assert.match(convertResult({ content: [{ type: 'image_url', image_url: { url: 'data:video/mp4;base64,YQ==' } }] }).content[0].text, /omitted/);
    assert.equal(convertResult({ content: [], details: { command: 'CreateFile', status: 'conflict' } }).isError, true);
    assert.equal(convertResult({ content: [], details: { command: 'EditCode', status: 'ambiguous' } }).isError, undefined);
    assert.deepEqual(convertResult({ content: [], details: { command: 'EvalSymbol', status: 'returned', value: 3 } }).structuredContent.value, 3);
});

test('direct service adapter filters dangerous tools and never retries failures', async () => {
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
    assert.equal(bridge.listTools().find(tool => tool.name === 'pf_query').annotations.readOnlyHint, true);
    const reply = await bridge.call('pf_list_workspaces', {});
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /OUTCOME_UNKNOWN/);
    assert.equal(calls, 1);
    await bridge.call('pf_eval_symbol', {});
    const disabled = await bridge.call('pf_bash', { projectId: 'p1', script: 'pwd' });
    assert.equal(disabled.isError, true);
    assert.match(disabled.content[0].text, /Unknown or disabled tool/);
    assert.equal(calls, 1);
    await bridge.close();
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
