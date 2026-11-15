'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ProjectServiceClient, MAX_FRAME_BYTES } = require('../VCPDistributedServer/Plugin/ProjectForge/serviceClient');
const { ProjectStore } = require('../VCPDistributedServer/Plugin/ProjectForge/store');

const binaryPath = process.env.PF_SERVICE_BINARY || path.resolve(__dirname, '../rust_projectforge_indexer/target/debug',
    process.platform === 'win32' ? 'projectforge_indexer.exe' : 'projectforge_indexer');
const requireBinary = process.env.PF_SERVICE_REQUIRE_BINARY === '1';
if (requireBinary && !fs.existsSync(binaryPath)) throw new Error(`Required Rust binary missing: ${binaryPath}`);
const hasBinary = fs.existsSync(binaryPath);

test('cold startup admission is bounded and malformed envelopes fail closed', async () => {
    let released;
    const fake = fakeService((request, reply) => {
        if (request.method === 'ping') released = () => reply({ id: request.id, ok: true, result: {} });
    });
    const client = new ProjectServiceClient({ dbPath: path.resolve('unused.db'), spawnProcess: fake.spawnProcess });
    const requests = Array.from({ length: 32 }, () => client.request('ping', {}, { timeoutMs: 1000 }).catch(e => e.code));
    await assert.rejects(client.request('ping'), e => e.code === 'BUSY');
    await client.start();
    assert.equal(client.admitted, 32);
    assert.ok(released);
    // null is valid JSON but not a valid RPC envelope.
    client.child.stdout.write('null\n');
    assert.deepEqual(await Promise.all(requests), Array(32).fill('CONNECTION_LOST'));
    assert.equal(client.admitted, 0);
    assert.equal(client.admittedBytes, 0);
});
function fakeService(respond) {
    let killed = 0;
    const requests = [];
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { killed++; queueMicrotask(() => child.emit('exit', 1, null)); };
    child.stdin = new Writable({
        write(chunk, _encoding, callback) {
            const request = JSON.parse(chunk.toString());
            requests.push(request);
            callback();
            if (request.method === 'shutdown') {
                child.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { bye: true } }) + '\n');
                setImmediate(() => child.emit('exit', 0, null));
            } else respond(request, message => child.stdout.write(JSON.stringify(message) + '\n'));
        },
    });
    const spawnProcess = () => {
        queueMicrotask(() => child.stdout.write(JSON.stringify({
            type: 'ready', service: 'projectforge-storage', protocolVersion: 1,
            maxFrameBytes: MAX_FRAME_BYTES, capabilities: ['operationStatus'],
        }) + '\n'));
        return child;
    };
    return { spawnProcess, requests, get killed() { return killed; } };
}

test('mutation timeout is unknown, does not kill or silently retry, status remains queryable', async () => {
    let saved;
    const fake = fakeService((request, reply) => {
        if (request.method === 'store.createProject') saved = request;
        else reply({ id: request.id, ok: true, result: { state: 'committed', operationId: saved.params.operationId } });
    });
    const client = new ProjectServiceClient({ dbPath: path.resolve('unused.db'), spawnProcess: fake.spawnProcess });
    await assert.rejects(client.request('store.createProject', { operationId: 'op-1' }, { timeoutMs: 15 }),
        error => error.code === 'OUTCOME_UNKNOWN' && error.operationId === 'op-1');
    assert.equal(fake.killed, 0);
    assert.equal(fake.requests.filter(r => r.method === 'store.createProject').length, 1);
    assert.equal((await client.operationStatus('op-1')).state, 'committed');
    await client.close();
});

test('request is frozen before async startup and invalid mutation is rejected before spawn', async () => {
    const fake = fakeService((request, reply) => reply({ id: request.id, ok: true, result: request.params }));
    const client = new ProjectServiceClient({ dbPath: path.resolve('unused.db'), spawnProcess: fake.spawnProcess });
    await assert.rejects(client.request('store.recordBatch', {}), error => error.code === 'INVALID_OPERATION_ID');
    assert.equal(client.child, null);
    const params = { operationId: 'original', name: 'before' };
    const result = client.request('store.createProject', params);
    params.operationId = 'changed';
    params.name = 'after';
    assert.deepEqual(await result, { operationId: 'original', name: 'before' });
    await client.close();
});

test('real Rust: JS legacy snapshots/history -> Rust reads/writes -> legacy compatibility', { skip: !hasBinary }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-service-'));
    const dbPath = path.join(dir, 'pf.db');
    let legacy = new ProjectStore(dbPath);
    const project = legacy.createProject({ name: '兼容工程', root: dir, workspaceAlias: 'demo', createdBy: 'Kerr' });
    const bytes = Buffer.from('\ufeff原文\r\n\0binary', 'utf8');
    const h = legacy.putBlob(bytes);
    const b = legacy.createBatch(project.id, 'create', 'fixture', 'Kerr');
    legacy.addNode({ projectId: project.id, batchId: b, filePath: 'old.txt', op: 'create', afterHash: h, added: 2 });
    legacy.addTodos(project.id, ['迁移'], 'Kerr');
    const expectedTimeline = legacy.timeline(project.id);
    const expectedTodos = legacy.listTodos(project.id);
    const node = legacy.getBatchNodes(project.id, b)[0];
    const expected = [
        ['store.getProject', { projectId: project.id }, legacy.getProject(project.id)],
        ['store.listProjects', { workspaceAlias: 'demo' }, legacy.listProjects({ workspaceAlias: 'demo' })],
        ['store.listProjects', { workspaceId: 'other', workspaceAlias: 'demo' }, legacy.listProjects({ workspaceId: 'other', workspaceAlias: 'demo' })],
        ['store.projectStats', { projectId: project.id }, legacy.projectStats(project.id)],
        ['store.contributors', { projectId: project.id }, legacy.contributors(project.id)],
        ['store.changedFiles', { projectId: project.id }, legacy.changedFiles(project.id)],
        ['store.lastBatch', { projectId: project.id }, legacy.lastBatch(project.id)],
        ['store.getBatch', { projectId: project.id, batchId: b }, legacy.getBatch(project.id, b)],
        ['store.getNode', { projectId: project.id, nodeId: node.id }, legacy.getNode(project.id, node.id)],
        ['store.getBatchNodes', { projectId: project.id, batchId: b }, legacy.getBatchNodes(project.id, b)],
        ['store.nodesAfter', { projectId: project.id, nodeId: 0 }, legacy.nodesAfter(project.id, 0)],
        ['store.getTodoBySeq', { projectId: project.id, seq: 1 }, legacy.getTodoBySeq(project.id, 1)],
        ['store.searchNodes', { projectId: project.id, maid: 'kerr', keyword: 'fixture' }, legacy.searchNodes({ projectId: project.id, maid: 'kerr', keyword: 'fixture' })],
        ['store.fileHashAt', { projectId: project.id, filePath: 'old.txt', nodeId: 0 }, { known: true, hash: null }],
        ['store.fileHashAt', { projectId: project.id, filePath: 'old.txt', nodeId: node.id }, { known: true, hash: h }],
        ['store.exportSnapshot', { projectId: project.id }, { project: legacy.getProject(project.id), todos: expectedTodos, history: legacy.exportHistory(project.id) }],
    ];
    legacy.close();
    const client = new ProjectServiceClient({ dbPath, binaryPath });
    try {
        await client.start();
        for (const [method, params, expectedResult] of expected) {
            assert.deepEqual(await client.request(method, params), expectedResult, method);
        }
        assert.deepEqual(await client.request('store.timeline', { projectId: project.id }), expectedTimeline);
        assert.deepEqual(await client.request('store.listTodos', { projectId: project.id }), expectedTodos);
        const blob = await client.request('store.getBlob', { hash: h });
        assert.deepEqual(Buffer.from(blob.base64, 'base64'), bytes);
        assert.deepEqual(await client.request('store.getFileState', { projectId: project.id, filePath: 'unknown' }), { known: false });
        const empty = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
        const params = {
            operationId: 'empty-file', projectId: project.id, kind: 'create', reason: 'empty',
            blobs: [{ hash: empty, base64: '' }],
            nodes: [{ filePath: 'empty', op: 'create', beforeHash: null, afterHash: empty }],
        };
        const first = await client.request('store.recordBatch', params);
        assert.deepEqual(await client.request('store.recordBatch', params), first);
        assert.equal((await client.operationStatus(params.operationId)).state, 'committed');
        assert.deepEqual(await client.request('store.getBlob', { hash: empty }), { hash: empty, size: 0, base64: '' });
        await assert.rejects(client.request('store.recordBatch', { ...params, reason: 'different' }), /reused/);
        const competing = new ProjectServiceClient({ dbPath, binaryPath });
        await assert.rejects(competing.start(), /owned/);
        // Await process exit before removing its temporary files.
        if (competing.child) await once(competing.child, 'exit');
        await client.close();
        legacy = new ProjectStore(dbPath); // test-only compatibility probe, never concurrent with Rust
        assert.deepEqual(legacy.getBlob(h), bytes);
        assert.equal(legacy.getBlob(empty).length, 0);
        assert.equal(legacy.timeline(project.id).length, 2);
        legacy.close();
    } finally {
        if (!client.closed) await client.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('current Rust binary keeps default index protocol 3 and outline behavior', { skip: !hasBinary }, async () => {
    const { IndexerClient } = require('../VCPDistributedServer/Plugin/ProjectForge/indexerClient');
    const client = new IndexerClient({ binaryPath, logger: { warn() {} } });
    try {
        const result = await client.outline('function currentBuild() { return 1; }\n', 'fixture.js');
        assert.ok(result, 'current binary must complete protocol-3 handshake');
        assert.equal(result.hasError, false);
        assert.ok(result.symbols.some(symbol => symbol.name === 'currentBuild'));
    } finally {
        await client.stop();
    }
});

test('real Rust native edit RPC: trusted config, validation, durable replay and denied writes', { skip: !hasBinary }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-native-edit-'));
    const root = path.join(dir, 'project');
    fs.mkdirSync(root);
    const file = path.join(root, 'a.json');
    fs.writeFileSync(file, '{"value":1}\n');
    const dbPath = path.join(dir, 'pf.db');
    const configPath = path.join(dir, 'service.json');
    fs.writeFileSync(configPath, JSON.stringify({
        version: 1, allowedRoots: [root], nodeExecutable: process.execPath,
        validationWorker: path.resolve(__dirname, '../VCPDistributedServer/Plugin/ProjectForge/validationWorker.cjs'),
        validationCwd: path.resolve(__dirname, '..'), validationTimeoutMs: 10000,
    }));
    let client = new ProjectServiceClient({ dbPath, binaryPath });
    try {
        await client.request('store.createProject', {
            operationId: 'create', projectId: 'p1', name: 'native-rpc', root,
        });
        const command = {
            operationId: 'edit', projectId: 'p1', filePath: 'a.json',
            reason: 'real RPC', maid: 'Kerr',
            steps: [{ step: 1, op: 'target', target: '  1 | 1', replace: '>1 | 2', reason: '修正值边界' }],
        };
        await assert.rejects(client.request('edit.execute', command), /trusted service configuration/);
        assert.equal(fs.readFileSync(file, 'utf8'), '{"value":1}\n');
        await client.close();
        client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
        const result = await client.request('edit.execute', command);
        assert.equal(result.status, 'ok');
        assert.deepEqual(result.applied, [1]);
        assert.deepEqual(result.skipped, []);
        assert.equal(result.review.supported, true);
        const node = await client.request('store.getNode', { projectId: 'p1', nodeId: result.nodeId });
        const batch = await client.request('store.getBatch', { projectId: 'p1', batchId: result.batchId });
        assert.equal(node.reason, '步骤1：修正值边界');
        assert.equal(node.summary, '1 步：target');
        assert.equal(result.placements.length, 1);
        assert.equal(result.placements[0].step, 1);
        assert.equal(result.placements[0].op, 'target');
        assert.equal(result.placements[0].originalStartLine, 1);
        assert.equal(result.placements[0].newStartLine, 1);
        assert.equal(result.placements[0].originalStartByte, 9);
        assert.equal(result.placements[0].newEndByte, 10);
        assert.equal(batch.reason, 'real RPC');
        // A failed atomic plan must not write or create a durable commit.
        const partialSteps = [
            { step: 1, op: 'target', target: 'missing', replace: 'x', reason: '不得记成已应用' },
            { step: 2, op: 'target', target: '2', replace: '3', reason: '实际应用' },
        ];
        const atomic = await client.request('edit.execute', {
            ...command, operationId: 'atomic-failure', steps: partialSteps,
        });
        assert.equal(atomic.state, 'planningRejected');
        assert.equal((await client.operationStatus('atomic-failure')).state, 'unknown');
        assert.equal(fs.readFileSync(file, 'utf8'), '{"value":2}\n');
        const partialCommand = {
            ...command, operationId: 'best-effort', bestEffort: true, steps: partialSteps,
        };
        const partial = await client.request('edit.execute', partialCommand);
        assert.deepEqual(partial.applied, [2]);
        assert.equal(partial.skipped.length, 1);
        assert.equal(partial.skipped[0].step, 1);
        const partialNode = await client.request('store.getNode', {
            projectId: 'p1', nodeId: partial.nodeId,
        });
        assert.equal(partialNode.reason, '步骤2：实际应用');
        assert.equal(fs.readFileSync(file, 'utf8'), '{"value":3}\n');
        assert.deepEqual(await client.request('edit.execute', partialCommand), partial);
        // Restore the first operation's after-image for subsequent no-op assertions.
        fs.writeFileSync(file, '{"value":2}\n');
        assert.equal(fs.readFileSync(file, 'utf8'), '{"value":2}\n');
        assert.equal((await client.operationStatus('edit')).state, 'committed');
        await client.close();
        client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
        assert.deepEqual(await client.request('edit.execute', command), result);
        await assert.rejects(client.request('edit.execute', { ...command, reason: 'different' }), /reused/);
        const noop = {
            ...command, operationId: 'noop',
            steps: [{ step: 1, op: 'target', target: '2', replace: '2' }],
        };
        const unchanged = await client.request('edit.execute', noop);
        assert.equal(unchanged.status, 'unchanged');
        assert.equal((await client.operationStatus('noop')).result.status, 'unchanged');
        assert.equal((await client.request('store.projectStats', { projectId: 'p1' })).nodeCount, 2);
        await client.close();
        fs.writeFileSync(file, '{"external":true}\n');
        client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
        assert.deepEqual(await client.request('edit.execute', noop), unchanged);
        assert.equal(fs.readFileSync(file, 'utf8'), '{"external":true}\n');
        await assert.rejects(client.request('edit.execute', { ...noop, reason: 'different' }), /reused/);
        fs.writeFileSync(file, '{"value":2}\n');
        const syntax = await client.request('edit.execute', {
            ...command, operationId: 'syntax',
            steps: [{ step: 1, op: 'replace', start: 1, end: 1, content: '{"value":' }],
        });
        assert.equal(syntax.state, 'syntaxRejected');
        assert.equal((await client.operationStatus('syntax')).state, 'unknown');
        await assert.rejects(client.request('edit.execute', {
            ...command, operationId: 'escape', filePath: '../outside.json',
        }));
        await assert.rejects(client.request('edit.execute', {
            ...command, operationId: 'injected-config', allowedRoots: [dir],
        }));
        assert.equal(fs.readFileSync(file, 'utf8'), '{"value":2}\n');
        assert.equal((await client.request('store.projectStats', { projectId: 'p1' })).nodeCount, 2);
    } finally {
        if (!client.closed) await client.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('real Rust native todo binding: ordered association and failure has no todo side effects', { skip: !hasBinary }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-native-todo-'));
    const root = path.join(dir, 'project');
    fs.mkdirSync(root);
    const file = path.join(root, 'a.json');
    fs.writeFileSync(file, '{"value":1}\n');
    const dbPath = path.join(dir, 'pf.db');
    // Legacy fixture is closed before Rust acquires the database.
    const legacy = new ProjectStore(dbPath);
    let project;
    let initial;
    try {
        project = legacy.createProject({ name: 'todo-rpc', root, createdBy: 'Kerr' });
        legacy.addTodos(project.id, ['first', 'second', 'untouched'], 'Kerr');
        initial = legacy.listTodos(project.id);
    } finally {
        legacy.close();
    }
    const configPath = path.join(dir, 'service.json');
    fs.writeFileSync(configPath, JSON.stringify({
        version: 1, allowedRoots: [root], nodeExecutable: process.execPath,
        validationWorker: path.resolve(__dirname, '../VCPDistributedServer/Plugin/ProjectForge/validationWorker.cjs'),
        validationCwd: path.resolve(__dirname, '..'), validationTimeoutMs: 10000,
    }));
    const client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
    const command = {
        operationId: 'todo-edit', projectId: project.id, filePath: 'a.json',
        reason: 'associate todos', maid: 'Kerr', todo: '#2、1 #2',
        steps: [{ step: 1, op: 'target', target: '1', replace: '2' }],
    };
    try {
        await assert.rejects(client.request('edit.execute', {
            ...command, operationId: 'missing-todo', todo: '#1 #999',
        }), /todo/);
        assert.deepEqual(await client.request('store.listTodos', { projectId: project.id }), initial);
        assert.equal(fs.readFileSync(file, 'utf8'), '{"value":1}\n');
        const result = await client.request('edit.execute', command);
        const node = await client.request('store.getNode', {
            projectId: project.id, nodeId: result.nodeId,
        });
        assert.equal(node.todo_id, initial[1].id, 'first supplied sequence is primary');
        let todos = await client.request('store.listTodos', { projectId: project.id });
        assert.deepEqual(todos.map(t => t.status), ['doing', 'doing', 'pending']);
        assert.equal(todos[0].updated_by, 'Kerr');
        assert.equal(todos[1].updated_by, 'Kerr');
        const afterCommit = todos;
        const noop = await client.request('edit.execute', {
            ...command, operationId: 'todo-noop', todo: [3],
            steps: [{ step: 1, op: 'target', target: '2', replace: '2' }],
        });
        assert.equal(noop.status, 'unchanged');
        const rejected = await client.request('edit.execute', {
            ...command, operationId: 'todo-syntax', todoId: '#3', todo: undefined,
            steps: [{ step: 1, op: 'replace', start: 1, end: 1, content: '{"value":' }],
        });
        assert.equal(rejected.state, 'syntaxRejected');
        todos = await client.request('store.listTodos', { projectId: project.id });
        assert.deepEqual(todos, afterCommit);
        assert.deepEqual(await client.request('edit.execute', command), result);
        assert.equal((await client.request('store.projectStats', { projectId: project.id })).nodeCount, 1);
        assert.equal(fs.readFileSync(file, 'utf8'), '{"value":2}\n');
    } finally {
        if (!client.closed) await client.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('native edit timeout is outcome unknown and never retries or kills the service', async () => {
    let saved;
    const fake = fakeService((request, reply) => {
        if (request.method === 'edit.execute') saved = request;
        else reply({ id: request.id, ok: true, result: {
            state: 'committed', operationId: saved.params.operationId,
        } });
    });
    const client = new ProjectServiceClient({
        dbPath: path.resolve('unused.db'), spawnProcess: fake.spawnProcess,
    });
    try {
        await assert.rejects(client.request('edit.execute', { operationId: 'edit-timeout' }, { timeoutMs: 15 }),
            error => error.code === 'OUTCOME_UNKNOWN' && error.operationId === 'edit-timeout');
        assert.equal(fake.killed, 0);
        assert.equal(fake.requests.filter(r => r.method === 'edit.execute').length, 1);
        assert.equal((await client.operationStatus('edit-timeout')).state, 'committed');
    } finally {
        await client.close();
    }
});