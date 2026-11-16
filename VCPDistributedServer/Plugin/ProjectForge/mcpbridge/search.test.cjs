'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createSearcher, searchTool } = require('./search.cjs');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-search-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-search-outside-'));
    t.after(async () => {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
    });
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'sample.js'), 'before-context\nLiteral(a+b)\nAlpha alpha alphabet\nafter-context\n');
    await fs.writeFile(path.join(root, 'src', 'other.ts'), 'UniqueTypeScriptNeedle\n');
    await fs.writeFile(path.join(root, '.env'), 'PRIVATE_ENV_MARKER\n');
    await fs.writeFile(path.join(root, '.env.local'), 'PRIVATE_ENV_MARKER\n');
    await fs.writeFile(path.join(outside, 'secret.js'), 'OUTSIDE_SECRET_MARKER\n');
    const config = {
        workspaces: [
            { id: 'fixture', alias: 'Demo', path: root, enabled: true },
            { id: 'disabled', alias: 'Off', path: outside, enabled: false },
        ],
        activeWorkspaceId: 'fixture',
    };
    const searcher = createSearcher(config);
    t.after(() => searcher.close());
    return { root, outside, config, searcher };
}
const text = result => result.content.map(part => part.text).join('\n');
const success = result => { assert.notEqual(result.isError, true, text(result)); return text(result); };

// Use stream-shaped fake children only for resource/lifecycle faults; all search
// semantics and containment tests below use the real neighboring wrapper/native.
function fakeSpawn(behavior, calls) {
    return (executable, argv, options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({ write(chunk, encoding, callback) { child.input = (child.input || '') + chunk.toString(); callback(); } });
        child.kill = signal => {
            calls.kills.push(signal);
            setTimeout(() => child.emit('close', null, signal), 15);
            return true;
        };
        calls.children.push(child);
        calls.invocations.push({ executable, argv, options });
        child.stdin.on('finish', () => behavior(child));
        return child;
    };
}
function mockConfig(config, behavior) {
    const calls = { children: [], invocations: [], kills: [] };
    return { calls, searcher: createSearcher({ ...config, spawnProcess: fakeSpawn(behavior, calls) }) };
}
async function waitFor(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'Timed out waiting for fake child');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

test('tool exports a read-only camelCase schema without project requirements', () => {
    assert.equal(searchTool.name, 'pf_search');
    assert.equal(searchTool.command, 'SearchCode');
    assert.equal(searchTool.annotations.readOnlyHint, true);
    assert.deepEqual(searchTool.inputSchema.required, ['query']);
    assert.equal(searchTool.inputSchema.additionalProperties, false);
    assert.equal(searchTool.inputSchema.properties.contextLines.maximum, 20);
    assert.equal(searchTool.inputSchema.properties.maxResults.maximum, 500);
});

test('real native: literal, regex, include, contexts, case, whole word and result limit', async t => {
    const { searcher } = await fixture(t);
    const literal = success(await searcher.search({ query: 'Literal(a+b)', isRegex: false, contextLines: 1 }));
    assert.match(literal, /2:1:Literal\(a\+b\)/);
    assert.match(literal, /1-before-context/);
    assert.match(literal, /3-Alpha alpha alphabet/);
    const regex = success(await searcher.search({ query: '^Alpha', workspace: 'demo', path: 'src/sample.js', isRegex: true, contextLines: 0 }));
    assert.match(regex, /3:1:Alpha/);
    assert.doesNotMatch(regex, /2-Literal/);
    const include = success(await searcher.search({ query: 'UniqueTypeScriptNeedle', include: '*.ts' }));
    assert.match(include, /other\.ts/);
    const excluded = success(await searcher.search({ query: 'UniqueTypeScriptNeedle', include: '*.js' }));
    assert.doesNotMatch(excluded, /1:1:UniqueTypeScriptNeedle/);
    // .ts is in plugin config.env but absent from manifest defaults: proves overlay.
    assert.match(success(await searcher.search({ query: 'UniqueTypeScriptNeedle' })), /other\.ts/);
    const exact = success(await searcher.search({ query: 'ALPHA', isRegex: false, caseSensitive: true, wholeWord: true }));
    assert.doesNotMatch(exact, /3:1:Alpha/);
    assert.match(success(await searcher.search({ query: 'Alpha', caseSensitive: true, wholeWord: true, maxResults: 1 })), /3:1:Alpha/);
});

test('real native: ignores .env family and applies native failures as MCP errors', async t => {
    const { searcher } = await fixture(t);
    const result = success(await searcher.search({ query: 'PRIVATE_ENV_MARKER', include: '*' }));
    assert.doesNotMatch(result, /1:1:PRIVATE_ENV_MARKER/);
    assert.equal((await searcher.search({ query: 'PRIVATE_ENV_MARKER', path: '.env', include: '*' })).isError, true);
});

test('rejects escape paths, unknown/disabled workspaces and invalid arguments before spawn', async t => {
    const { config, outside } = await fixture(t);
    const { searcher, calls } = mockConfig(config, () => assert.fail('must not spawn'));
    t.after(() => searcher.close());
    for (const args of [
        { query: 'x', path: '../secret.js' }, { query: 'x', path: 'src/../sample.js' },
        { query: 'x', path: outside }, { query: 'x', path: 'C:secret.js' },
        { query: 'x', path: '\\rooted' }, { query: 'x', path: '//server/share' },
        { query: 'x', workspace: 'missing' }, { query: 'x', workspace: 'Off' },
        {}, { query: '' }, { query: 'x', contextLines: 21 }, { query: 'x', contextLines: -1 },
        { query: 'x', maxResults: 0 }, { query: 'x', maxResults: 501 },
        { query: 'x', maxResults: 1.5 }, { query: 'x', isRegex: 'false' },
        { query: 'x', search_path: '.' },
    ]) assert.equal((await searcher.search(args)).isError, true, JSON.stringify(args));
    const absent = createSearcher();
    assert.equal((await absent.search({ query: 'x' })).isError, true);
    await absent.close();
    assert.equal(calls.children.length, 0);
});

test('rejects directory junctions/symlinks in target tree and explicit paths', async t => {
    const { root, outside, searcher } = await fixture(t);
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const relative of ['.', 'linked', 'linked/secret.js']) {
        const result = await searcher.search({ query: 'OUTSIDE_SECRET_MARKER', path: relative });
        assert.equal(result.isError, true);
        assert.match(text(result), /symbolic link|junction/i);
        assert.doesNotMatch(text(result), /1:1:OUTSIDE_SECRET_MARKER/);
    }
});

test('rejects file symlinks, including dangling links', async t => {
    const { root, outside, searcher } = await fixture(t);
    try { await fs.symlink(path.join(outside, 'secret.js'), path.join(root, 'linked.js'), 'file'); }
    catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`File symlink creation unavailable: ${error.code}`); return; }
        throw error;
    }
    assert.equal((await searcher.search({ query: 'OUTSIDE_SECRET_MARKER' })).isError, true);
    assert.equal((await searcher.search({ query: 'x', path: 'linked.js' })).isError, true);
    await fs.unlink(path.join(root, 'linked.js'));
    await fs.symlink(path.join(outside, 'missing.js'), path.join(root, 'dangling.js'), 'file');
    assert.equal((await searcher.search({ query: 'x' })).isError, true);
});

test('native ignore parity: case-insensitive ignored directory, explicit start still scanned', async t => {
    const { root, searcher } = await fixture(t);
    const ignored = path.join(root, 'NODE_MODULES');
    await fs.mkdir(ignored);
    await fs.writeFile(path.join(ignored, 'ignored.js'), 'IgnoredDirectoryNeedle');
    assert.doesNotMatch(success(await searcher.search({ query: 'IgnoredDirectoryNeedle' })), /1:1:IgnoredDirectoryNeedle/);
    assert.match(success(await searcher.search({ query: 'IgnoredDirectoryNeedle', path: 'NODE_MODULES' })), /1:1:IgnoredDirectoryNeedle/);
    await fs.symlink(root, path.join(ignored, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
    success(await searcher.search({ query: 'Literal', isRegex: false }));
    assert.equal((await searcher.search({ query: 'x', path: 'NODE_MODULES' })).isError, true);
});

test('single JSON stdin, fixed wrapper, snake_case mapping and sanitized environment', async t => {
    const { config } = await fixture(t);
    const secretKey = 'PF_SEARCH_TEST_SECRET';
    const previous = process.env[secretKey];
    process.env[secretKey] = 'must-not-be-forwarded';
    t.after(() => { if (previous === undefined) delete process.env[secretKey]; else process.env[secretKey] = previous; });
    const { searcher, calls } = mockConfig(config, child => {
        child.stdout.write(JSON.stringify({ status: 'success', result: { content: [{ type: 'text', text: 'ok' }] } }));
        child.emit('close', 0, null);
    });
    t.after(() => searcher.close());
    assert.equal(success(await searcher.search({ query: 'x', include: '*.js', isRegex: false, caseSensitive: true, wholeWord: true, contextLines: 0, maxResults: 7 })), 'ok');
    const invocation = calls.invocations[0];
    assert.equal(invocation.executable, process.execPath);
    assert.equal(invocation.argv.length, 1);
    assert.equal(path.isAbsolute(invocation.argv[0]), true);
    assert.equal(path.basename(invocation.argv[0]), 'CodeSearcher.js');
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.env[secretKey], undefined);
    const input = JSON.parse(calls.children[0].input);
    assert.deepEqual(input, { query: 'x', search_path: await fs.realpath(config.workspaces[0].path), include: '*.js', is_regex: false, case_sensitive: true, whole_word: true, context_lines: 0, max_results: 7 });
});

test('stdout/stderr limits terminate children and never return stderr', async t => {
    const { config } = await fixture(t);
    for (const stream of ['stdout', 'stderr']) {
        const { searcher, calls } = mockConfig(config, child => {
            child[stream].write(Buffer.alloc(stream === 'stdout' ? 8 * 1024 * 1024 + 1 : 64 * 1024 + 1, 65));
        });
        const result = await searcher.search({ query: 'x' });
        assert.equal(result.isError, true);
        assert.match(text(result), /exceeded/);
        assert.ok(text(result).length < 200);
        assert.ok(calls.kills.length);
        await searcher.close();
    }
});

test('timeout, concurrency limit 4 and close waits for child close', async t => {
    const { config } = await fixture(t);
    const timeoutCalls = { children: [], invocations: [], kills: [] };
    const timed = createSearcher({ ...config, timeoutMs: 100, spawnProcess: fakeSpawn(() => {}, timeoutCalls) });
    assert.match(text(await timed.search({ query: 'x' })), /timed out/);
    await timed.close();
    const { searcher, calls } = mockConfig(config, () => {});
    const jobs = Array.from({ length: 4 }, () => searcher.search({ query: 'x' }));
    await waitFor(() => calls.children.length === 4);
    assert.match(text(await searcher.search({ query: 'x' })), /busy/);
    let closed = false;
    const closing = searcher.close().then(() => { closed = true; });
    assert.equal(closed, false);
    assert.equal((await searcher.search({ query: 'x' })).isError, true);
    await closing;
    assert.equal(calls.kills.length, 4);
    for (const result of await Promise.all(jobs)) assert.equal(result.isError, true);
    await searcher.close();
});

test('malformed JSON, native error, bad content, nonzero exit and spawn error are MCP failures', async t => {
    const { config } = await fixture(t);
    for (const behavior of [
        child => { child.stdout.write('not-json'); child.emit('close', 0, null); },
        child => { child.stdout.write(JSON.stringify({ status: 'error', error: 'native rejected' })); child.emit('close', 0, null); },
        child => { child.stdout.write(JSON.stringify({ status: 'success', result: { content: [{ type: 'image' }] } })); child.emit('close', 0, null); },
        child => { child.stderr.write('private diagnostic'); child.emit('close', 1, null); },
        child => { child.emit('error', new Error('private spawn diagnostic')); child.emit('close', -1, null); },
    ]) {
        const { searcher } = mockConfig(config, behavior);
        const result = await searcher.search({ query: 'x' });
        assert.equal(result.isError, true);
        assert.doesNotMatch(text(result), /private/);
        await searcher.close();
    }
});
