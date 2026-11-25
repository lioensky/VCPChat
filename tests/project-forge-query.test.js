'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    createPrimitives,
    normalizeLimits,
    DEFAULT_LIMITS,
} = require('../VCPDistributedServer/Plugin/ProjectForge/queryPrimitives.js');
const { runQuery } = require('../VCPDistributedServer/Plugin/ProjectForge/queryRunner.js');
const linkGraph = require('../VCPDistributedServer/Plugin/ProjectForge/linkGraph.js');

async function makeWorkspace(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-query-test-'));
    t.after(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });
    return dir;
}

async function writeFile(root, rel, text) {
    const abs = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, 'utf8');
    return abs;
}

function makeIndexer({ symbols = [], hits = [], facts = null } = {}) {
    const calls = { outline: 0, findSymbols: 0, facts: 0 };
    return {
        usable: true,
        calls,
        async outline() {
            calls.outline += 1;
            return { symbols };
        },
        async findSymbols() {
            calls.findSymbols += 1;
            return {
                hits,
                total: hits.length,
                scanned: 1,
                parsed: 1,
                truncated: false,
            };
        },
        async facts() {
            calls.facts += 1;
            return typeof facts === 'function' ? facts() : facts;
        },
    };
}

test('createPrimitives exposes six methods and only canonical host budgets', async (t) => {
    const root = await makeWorkspace(t);
    const q = await createPrimitives({
        root,
        indexer: makeIndexer(),
        limits: {
            maxPrimitiveSteps: 3,
            maxFiles: 7,
            maxFileBytes: 100,
            maxTotalBytes: 200,
        },
    });

    assert.deepEqual(Object.keys(q).sort(), ['files', 'graph', 'outline', 'read', 'search', 'symbols']);
    assert.equal(Object.prototype.propertyIsEnumerable.call(q, 'limits'), false);
    assert.equal(q.limits.maxPrimitiveSteps, 3);
    assert.equal(q.limits.maxFiles, 7);
    assert.equal(q.limits.maxFileBytes, 100);
    assert.equal(q.limits.maxTotalBytes, 200);
    for (const alias of [
        'maxSteps', 'stepBudget', 'maxReadBytes',
        'maxConcurrency', 'maxConcurrentRpc', 'concurrency',
    ]) {
        assert.equal(q.limits[alias], undefined);
    }
    assert.ok(Object.isFrozen(q));
    assert.ok(Object.isFrozen(q.limits));

    const clamped = normalizeLimits({
        maxPrimitiveSteps: 0,
        maxFileBytes: 1,
        maxTotalBytes: 1,
        maxSteps: 3,
        maxConcurrency: 2,
    });
    assert.equal(clamped.maxPrimitiveSteps, 1);
    assert.equal(clamped.maxFileBytes, 1);
    assert.equal(clamped.maxTotalBytes, 1);
    assert.equal(clamped.maxSteps, undefined);
    assert.equal(clamped.maxConcurrency, undefined);

    const raised = normalizeLimits({
        maxPrimitiveSteps: 9999,
        maxFileBytes: 1024 * 1024,
        maxTotalBytes: 16 * 1024 * 1024,
    });
    assert.equal(raised.maxPrimitiveSteps, 9999);
    assert.equal(raised.maxFileBytes, 1024 * 1024);
    assert.equal(raised.maxTotalBytes, 16 * 1024 * 1024);
    assert.equal(DEFAULT_LIMITS.maxPrimitiveSteps, 64);
    assert.equal(DEFAULT_LIMITS.maxFileBytes, 256 * 1024);
    assert.equal(DEFAULT_LIMITS.maxTotalBytes, 4 * 1024 * 1024);
});

test('q.files reuses workspace ignores and supports comma/brace globs', async (t) => {
    const root = await makeWorkspace(t);
    await writeFile(root, 'a.txt', 'a');
    await writeFile(root, 'src/b.js', 'b');
    await writeFile(root, 'src/nested/c.md', 'c');
    await writeFile(root, 'node_modules/ignored.js', 'ignored');
    await writeFile(root, 'vendor/ignored.js', 'ignored');
    await writeFile(root, '.git/secret.txt', 'secret');
    await writeFile(root, '.DS_Store', 'junk');
    await writeFile(root, 'desktop.ini', 'junk');
    await writeFile(root, 'ignored-by-git.txt', 'ignored by root gitignore');
    await writeFile(root, 'src/generated.txt', 'ignored by root gitignore');
    await writeFile(root, '.gitignore', 'ignored-by-git.txt\nsrc/generated.txt\n');
    await writeFile(root, 'customvenv/pyvenv.cfg', 'home = fake\n');
    await writeFile(root, 'customvenv/inside.py', 'alpha');

    const q = await createPrimitives({ root, indexer: makeIndexer() });
    const braceHits = await q.files('**/*.{txt,js,md}');
    assert.deepEqual(braceHits.map((item) => item.path), [
        'a.txt', 'src/b.js', 'src/nested/c.md',
    ]);
    assert.ok(braceHits.every((item) => Number.isInteger(item.size)));

    const all = await q.files();
    const paths = all.map((item) => item.path);
    assert.ok(paths.includes('a.txt'));
    for (const ignored of [
        'node_modules/ignored.js',
        'vendor/ignored.js',
        '.git/secret.txt',
        '.DS_Store',
        'desktop.ini',
        'ignored-by-git.txt',
        'src/generated.txt',
        'customvenv/pyvenv.cfg',
        'customvenv/inside.py',
    ]) {
        assert.equal(paths.includes(ignored), false, `${ignored} should be ignored`);
    }

    assert.deepEqual((await q.files('*.txt,*.md')).map((item) => item.path), ['a.txt']);
    assert.deepEqual((await q.files('src/**/*.js')).map((item) => item.path), ['src/b.js']);

    const limited = await createPrimitives({ root, indexer: makeIndexer(), limits: { maxFiles: 1 } });
    assert.equal((await limited.files()).length, 1);
    await assert.rejects(q.files(123), /q\.files: glob must be a string/);
});

test('q.read returns full, line-range and symbol slices with boundary checks', async (t) => {
    const root = await makeWorkspace(t);
    await writeFile(root, 'data.txt', 'one\ntwo\nthree\nfour\n');
    await writeFile(root, 'code.js', 'function alpha() {\n  return 1;\n}\n');
    const indexer = makeIndexer({
        symbols: [
            { name: 'alpha', qualified: 'alpha()', kind: 'function', start: 1, end: 2 },
        ],
    });
    const q = await createPrimitives({ root, indexer });

    assert.equal(await q.read('data.txt'), 'one\ntwo\nthree\nfour\n');
    assert.equal(await q.read('data.txt:2-3'), 'two\nthree');
    assert.equal(await q.read('data.txt:3-99'), 'three\nfour');
    await assert.rejects(q.read('data.txt:5-6'), /out of range/);
    await assert.rejects(q.read('data.txt:3-2'), /invalid line range/);
    assert.equal(await q.read('code.js#alpha()'), 'function alpha() {\n  return 1;');
    await assert.rejects(q.read('code.js#missing'), /symbol "missing" not found/);
    await assert.rejects(q.read('../outside.txt'), /outside project root/);
    await assert.rejects(q.read(path.join(os.tmpdir(), 'pf-query-outside.txt')), /outside project root/);

    const outside = path.join(os.tmpdir(), `pf-query-outside-${process.pid}-${Date.now()}.txt`);
    await fs.writeFile(outside, 'secret', 'utf8');
    t.after(async () => fs.rm(outside, { force: true }));
    const link = path.join(root, 'link.txt');
    let linked = false;
    try {
        await fs.symlink(outside, link, 'file');
        linked = true;
    } catch {
        // Windows 可能因开发者模式/权限不允许创建符号链接；../ 用例仍覆盖词法边界。
    }
    if (linked) {
        await assert.rejects(q.read('link.txt'), /outside project root/);
        assert.equal((await q.files()).some((item) => item.path === 'link.txt'), false);
    }
});

test('q.search covers all text files, literal fallback, globs, context and ignores', async (t) => {
    const root = await makeWorkspace(t);
    await writeFile(root, 'notes.txt', 'Alpha one\nbeta two\nALPHA three\nvalue [ here\n');
    await writeFile(root, 'src/code.js', 'const alpha = 1;\n');
    await writeFile(root, 'readme.md', 'alpha docs\n');
    await writeFile(root, 'blob.weird', 'alpha without an allowlisted extension\n');
    await writeFile(root, 'image.bin', 'alpha\0binary\n');
    await writeFile(root, 'literal.txt', 'a.b\naxb\n');
    await writeFile(root, 'node_modules/dep.js', 'alpha in node_modules\n');
    await writeFile(root, 'ignored-by-git.txt', 'alpha in gitignored file\n');
    await writeFile(root, '.gitignore', 'ignored-by-git.txt\n');

    const q = await createPrimitives({ root, indexer: makeIndexer() });
    const hits = await q.search('alpha');
    assert.equal(hits.some((hit) => hit.path === 'blob.weird'), true);
    assert.equal(hits.some((hit) => hit.path === 'image.bin'), false);
    assert.equal(hits.some((hit) => hit.path === 'node_modules/dep.js'), false);
    assert.equal(hits.some((hit) => hit.path === 'ignored-by-git.txt'), false);
    assert.equal(hits.some((hit) => hit.path === 'readme.md'), true);

    const txtHits = await q.search('alpha', { glob: '*.txt' });
    assert.deepEqual(txtHits.map((hit) => [hit.path, hit.line]), [
        ['notes.txt', 1], ['notes.txt', 3],
    ]);

    const caseHits = await q.search('ALPHA', { case_sensitive: true });
    assert.deepEqual(caseHits.map((hit) => [hit.path, hit.line]), [['notes.txt', 3]]);

    const bracketHits = await q.search('[', { glob: 'notes.txt' });
    assert.deepEqual(bracketHits.map((hit) => hit.line), [4]);

    const contextHits = await q.search('beta', { context_lines: 1, glob: 'notes.txt' });
    assert.equal(contextHits.length, 1);
    assert.deepEqual(contextHits[0].context, ['1: Alpha one', '3: ALPHA three']);

    const commaHits = await q.search('alpha', { glob: '*.txt,*.md' });
    assert.equal(commaHits.some((hit) => hit.path === 'src/code.js'), false);
    assert.equal(commaHits.some((hit) => hit.path === 'readme.md'), true);

    const literalHits = await q.search('a.b', { glob: 'literal.txt', is_regex: false });
    assert.deepEqual(literalHits.map((hit) => hit.line), [1]);
    const regexHits = await q.search('a.b', { glob: 'literal.txt' });
    assert.deepEqual(regexHits.map((hit) => hit.line), [1, 2]);

    await assert.rejects(q.search('x', { glob: 42 }), /q\.search: glob must be a string/);
});

test('q.outline and q.symbols project native fields and enforce AST limits', async (t) => {
    const root = await makeWorkspace(t);
    await writeFile(root, 'code.js', 'function alpha() {\n  return 1;\n}\n');
    await writeFile(root, 'big.js', 'x'.repeat(2048));
    const outlineSymbols = [
        {
            name: 'alpha',
            qualified: 'alpha()',
            kind: 'function',
            start: 1,
            end: 2,
            signature: 'function alpha()',
        },
    ];
    const symbolHits = [
        {
            path: 'code.js',
            name: 'alpha',
            qualified: 'alpha()',
            kind: 'function',
            start: 1,
            end: 2,
        },
    ];
    const indexer = makeIndexer({ symbols: outlineSymbols, hits: symbolHits });
    const q = await createPrimitives({ root, indexer, limits: { maxAstFileBytes: 1024 } });

    assert.deepEqual(await q.outline('code.js'), [
        {
            name: 'alpha',
            qualifiedName: 'alpha()',
            kind: 'function',
            startLine: 1,
            endLine: 2,
            signature: 'function alpha()',
        },
    ]);
    assert.deepEqual(await q.symbols({ name: 'alpha', limit: 1 }), [
        {
            path: 'code.js',
            name: 'alpha',
            qualifiedName: 'alpha()',
            kind: 'function',
            startLine: 1,
            endLine: 2,
        },
    ]);
    await assert.rejects(
        q.outline('big.js'),
        (error) => error && error.code === 'QUERY_FILE_TOO_LARGE' && /exceeds 1024 bytes/.test(error.message),
    );
    await assert.rejects(q.outline('../code.js'), /outside project root/);
    await assert.rejects(q.symbols({ glob: 7 }), /q\.symbols: glob must be a string/);

    const noIndexer = await createPrimitives({ root, indexer: null });
    await assert.rejects(noIndexer.outline('code.js'), /q\.outline: AST indexer is not available/);
    await assert.rejects(noIndexer.symbols(), /q\.symbols: AST indexer is not available/);
});

test('q.graph returns a plain JSON snapshot and graph(glob) is explicitly scoped', async (t) => {
    const root = await makeWorkspace(t);
    await writeFile(root, 'src/a.js', 'require("./b.js");\n');
    await writeFile(root, 'src/b.js', 'module.exports = 1;\n');
    await writeFile(root, 'lib/c.js', 'module.exports = 2;\n');
    const facts = {
        files: [
            {
                path: 'src/a.js',
                kind: 'js',
                requires: [{ spec: './b.js', line: 1 }],
                ipc: [{ side: 'register', channel: 'demo:ping', method: 'handle', line: 4 }],
            },
            { path: 'src/b.js', kind: 'js' },
            { path: 'lib/c.js', kind: 'js' },
        ],
        scanned: 3,
        parsed: 3,
        truncated: false,
    };
    const q = await createPrimitives({ root, indexer: makeIndexer({ facts }) });
    const full = await q.graph();

    assert.deepEqual(full.files, ['lib/c.js', 'src/a.js', 'src/b.js']);
    assert.deepEqual(full.deps['src/a.js'][0], { path: 'src/b.js', line: 1, kind: 'require' });
    assert.deepEqual(full.rdeps['src/b.js'][0], { path: 'src/a.js', line: 1, kind: 'require' });
    assert.deepEqual(full.ipc.find((item) => item.path === 'src/a.js'), {
        channel: 'demo:ping',
        direction: 'handle',
        side: 'register',
        method: 'handle',
        path: 'src/a.js',
        line: 4,
    });
    assert.equal(full.truncated, false);
    assert.equal(full.stats.scanned, 3);
    assert.equal(typeof full.depsOf, 'undefined');
    assert.equal(typeof full.rdepsOf, 'undefined');
    assert.equal(typeof full.files.map, 'function');
    assert.equal(typeof JSON.stringify(full), 'string');

    const scoped = await q.graph('src/*.js');
    assert.deepEqual(scoped.files, ['src/a.js', 'src/b.js']);
    assert.deepEqual(scoped.deps['src/a.js'][0], { path: 'src/b.js', line: 1, kind: 'require' });
    assert.deepEqual(scoped.rdeps['src/b.js'][0], { path: 'src/a.js', line: 1, kind: 'require' });
    assert.equal(scoped.deps['lib/c.js'], undefined);
    assert.equal(scoped.ipc.some((item) => item.path === 'lib/c.js'), false);
    assert.equal(scoped.stats.filtered, true);
    assert.equal(scoped.stats.glob, 'src/*.js');
    assert.equal(scoped.stats.matchedFiles, 2);
    assert.equal(scoped.stats.totalFiles, 3);

    const none = await q.graph('nope/**');
    assert.deepEqual(none.files, []);
    assert.deepEqual(none.deps, {});
    assert.deepEqual(none.rdeps, {});
    assert.deepEqual(none.ipc, []);
    assert.equal(none.stats.filtered, true);
    assert.equal(none.stats.matchedFiles, 0);

    const withoutFacts = await createPrimitives({ root, indexer: makeIndexer({ facts: null }) });
    await assert.rejects(withoutFacts.graph(), /q\.graph: AST indexer facts unavailable/);

    const originalBuildGraph = linkGraph.buildGraph;
    try {
        linkGraph.buildGraph = () => ({ files: {}, deps: {}, rdeps: {}, stats: {}, dynamic: [] });
        const malformed = await createPrimitives({ root, indexer: makeIndexer({ facts: { files: [] } }) });
        await assert.rejects(malformed.graph(), /q\.graph: graph structure mismatch/);
    } finally {
        linkGraph.buildGraph = originalBuildGraph;
    }
});

test('concurrent reads share one atomic total budget without a private concurrency cap', async (t) => {
    const root = await makeWorkspace(t);
    await writeFile(root, 'a.txt', 'a'.repeat(80));
    await writeFile(root, 'b.txt', 'b'.repeat(80));

    const tight = await createPrimitives({
        root,
        indexer: makeIndexer(),
        limits: { maxFileBytes: 128, maxTotalBytes: 100 },
    });
    const settled = await Promise.allSettled([tight.read('a.txt'), tight.read('b.txt')]);
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    const rejected = settled.find((item) => item.status === 'rejected');
    assert.equal(rejected.reason.code, 'QUERY_READ_BUDGET_EXCEEDED');
    assert.match(rejected.reason.message, /cumulative read budget 100 bytes exceeded/);

    const loose = await createPrimitives({
        root,
        indexer: makeIndexer(),
        limits: {
            maxFileBytes: 1024,
            maxTotalBytes: 4096,
            maxConcurrency: 1,
        },
    });
    assert.equal(loose.limits.maxConcurrency, undefined);
    const values = await Promise.all([
        loose.read('a.txt'),
        loose.read('b.txt'),
        loose.read('a.txt'),
        loose.read('b.txt'),
    ]);
    assert.deepEqual(values.map((value) => value.length), [80, 80, 80, 80]);
});

test('q.search enforces single-file and cumulative read budgets without an extension whitelist', async (t) => {
    const root = await makeWorkspace(t);
    for (let i = 0; i < 20; i += 1) {
        await writeFile(root, `f${String(i).padStart(2, '0')}.txt`, `needle ${'x'.repeat(30)}\n`);
    }
    await writeFile(
        root,
        'big.txt',
        `needle\n${Array.from({ length: 20 }, () => 'x'.repeat(20)).join('\n')}\n`,
    );

    const budgeted = await createPrimitives({
        root,
        indexer: makeIndexer(),
        limits: { maxFileBytes: 64, maxTotalBytes: 100, maxSearchResults: 100 },
    });
    await assert.rejects(
        budgeted.search('needle'),
        (error) => error && error.code === 'QUERY_READ_BUDGET_EXCEEDED' &&
            /cumulative read budget 100 bytes exceeded/.test(error.message),
    );

    const q = await createPrimitives({
        root,
        indexer: makeIndexer(),
        limits: { maxFileBytes: 64, maxTotalBytes: 1024, maxSearchResults: 100 },
    });
    const hits = await q.search('needle');
    assert.equal(hits.length, 20);
    assert.equal(hits.some((hit) => hit.path === 'big.txt'), false);
    await assert.rejects(q.read('big.txt'), (error) => error && error.code === 'QUERY_FILE_TOO_LARGE');
    assert.equal(await q.read('big.txt:1-1'), 'needle');
});

test('runQuery resolves raw JSON values and rebuilds graph methods', async (t) => {
    const root = await makeWorkspace(t);
    await writeFile(root, 'a.txt', 'hello\n');
    const indexer = makeIndexer({
        facts: {
            files: [{ path: 'a.txt', kind: 'text' }],
            scanned: 1,
            parsed: 0,
            truncated: false,
        },
    });

    const value = await runQuery({
        root,
        indexer,
        code: `
            const files = await q.files("*.txt");
            const text = await q.read("a.txt");
            const graph = await q.graph();
            return {
                files,
                text,
                graphFiles: graph.files(),
                hasDepsOf: typeof graph.depsOf === "function",
                hasRdepsOf: typeof graph.rdepsOf === "function",
                hasIpc: typeof graph.ipc === "function",
                truncated: graph.truncated
            };
        `,
        limits: { maxOutputBytes: 64 * 1024 },
    });

    assert.deepEqual(value.files.map((item) => item.path), ['a.txt']);
    assert.equal(value.text, 'hello\n');
    assert.deepEqual(value.graphFiles, ['a.txt']);
    assert.equal(value.hasDepsOf, true);
    assert.equal(value.hasRdepsOf, true);
    assert.equal(value.hasIpc, true);
    assert.equal(value.truncated, false);

    assert.equal(await runQuery({ root, indexer, code: 'return "raw";' }), 'raw');
    assert.deepEqual(await runQuery({ root, indexer, code: 'return [1, 2];' }), [1, 2]);
});

test('runQuery shares maxTotalBytes across Promise.all primitives', async (t) => {
    const root = await makeWorkspace(t);
    await writeFile(root, 'a.txt', 'a'.repeat(80));
    await writeFile(root, 'b.txt', 'b'.repeat(80));

    const value = await runQuery({
        root,
        indexer: makeIndexer(),
        code: `
            const settled = await Promise.allSettled([q.read("a.txt"), q.read("b.txt")]);
            return settled.map((item) => item.status === "fulfilled"
                ? { status: item.status, value: item.value }
                : { status: item.status, message: item.reason.message });
        `,
        limits: {
            maxFileBytes: 100,
            maxTotalBytes: 100,
            maxOutputBytes: 64 * 1024,
        },
    });
    assert.equal(value.filter((item) => item.status === 'fulfilled').length, 1);
    const rejected = value.find((item) => item.status === 'rejected');
    assert.match(rejected.message, /cumulative read budget 100 bytes exceeded/);
});

test('runQuery enforces step budget, cancellation and timeout', async (t) => {
    const root = await makeWorkspace(t);
    await writeFile(root, 'a.txt', 'a');
    const indexer = makeIndexer();

    await assert.rejects(
        runQuery({
            root,
            indexer,
            code: 'await q.files(); await q.files(); await q.files(); return 1;',
            limits: { maxPrimitiveSteps: 2, maxOutputBytes: 64 * 1024 },
        }),
        /step/i,
    );

    const aborter = new AbortController();
    const pending = runQuery({
        root,
        indexer,
        code: 'await new Promise(() => {}); return 1;',
        signal: aborter.signal,
        timeoutMs: 5000,
    });
    setTimeout(() => aborter.abort(), 50);
    await assert.rejects(
        pending,
        (error) => error && (error.code === 'QUERY_ABORTED' || /QUERY_ABORTED/.test(error.message)),
    );

    await assert.rejects(
        runQuery({
            root,
            indexer,
            code: 'await new Promise(() => {}); return 1;',
            timeoutMs: 150,
        }),
        (error) => error && (error.code === 'QUERY_TIMEOUT' || /QUERY_TIMEOUT/.test(error.message)),
    );
});

test('runQuery returns a legal truncated frame instead of oversized raw output', async (t) => {
    const root = await makeWorkspace(t);
    const value = await runQuery({
        root,
        indexer: makeIndexer(),
        code: 'return "x".repeat(20000);',
        limits: { maxOutputBytes: 1024 },
    });
    assert.equal(value && value._truncated, true);
    assert.equal(typeof value.preview, 'string');
    assert.ok(value.totalBytes > 1024);
});
