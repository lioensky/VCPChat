'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Database = require('better-sqlite3');
const { ProjectServiceClient, MAX_FRAME_BYTES } = require('../VCPDistributedServer/Plugin/ProjectForge/serviceClient');
const { resolveDefaultBinaryPath } = require('../VCPDistributedServer/Plugin/ProjectForge/indexerClient');

const binName = process.platform === 'win32' ? 'projectforge_indexer.exe' : 'projectforge_indexer';
const deployedBinary = resolveDefaultBinaryPath();
const debugBinary = path.resolve(__dirname, '../rust_projectforge_indexer/target/debug', binName);
const binaryPath = process.env.PF_SERVICE_BINARY || (fs.existsSync(deployedBinary) ? deployedBinary : debugBinary);
const requireBinary = process.env.PF_SERVICE_REQUIRE_BINARY === '1';
if (requireBinary && !fs.existsSync(binaryPath)) throw new Error(`Required Rust binary missing: ${binaryPath}`);
const hasBinary = fs.existsSync(binaryPath);

test('ProjectForge manifest no longer advertises operation inspection or reconciliation', () => {
    const manifest = require('../VCPDistributedServer/Plugin/ProjectForge/plugin-manifest.json');
    const commands = manifest.capabilities.invocationCommands.map(item => item.command);
    assert.ok(commands.includes('EditCode'));
    assert.equal(commands.includes('InspectOperation'), false);
    assert.equal(commands.includes('ReconcileOperation'), false);
});

// 旧 JS 存储层写过的表结构：历史库可以没有服务专表，但业务表必须在。
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT, workspace_alias TEXT,
    root TEXT NOT NULL, subpath TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
    report TEXT, created_by TEXT, deleted_by TEXT, report_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, seq INTEGER NOT NULL,
    title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', note TEXT, updated_by TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, kind TEXT NOT NULL,
    reason TEXT, maid TEXT, summary TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, batch_id INTEGER,
    file_path TEXT NOT NULL, op TEXT NOT NULL, before_hash TEXT, after_hash TEXT,
    todo_id INTEGER, reason TEXT, summary TEXT, added INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS file_state (project_id TEXT NOT NULL, file_path TEXT NOT NULL, hash TEXT, PRIMARY KEY (project_id, file_path));
`;

// 只用于测试的历史库夹具：直接写“旧 JS 存储层曾写出”的字节形态，服务重启后 Rust 必须原样读回。
class LegacySqlFixture {
    constructor(dbPath) {
        this.db = new Database(dbPath);
        this.db.pragma('foreign_keys = ON');
        this.db.exec(LEGACY_SCHEMA);
        this.ts = '2026-01-02T03:04:05.000Z';
    }
    close() { this.db.close(); }
    blob(bytes) {
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        this.db.prepare('INSERT OR IGNORE INTO blobs(hash, size, data) VALUES (?, ?, ?)')
            .run(hash, bytes.length, zlib.gzipSync(bytes));
        return hash;
    }
    project({ id = 'plegacy', name, root, workspaceId = null, workspaceAlias = null, createdBy = null }) {
        this.db.prepare(`INSERT INTO projects(id, name, workspace_id, workspace_alias, root, subpath, status, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, '', 'active', ?, ?, ?)`)
            .run(id, name, workspaceId, workspaceAlias, root, createdBy, this.ts, this.ts);
        return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    }
    todos(projectId, titles, updatedBy = null) {
        const insert = this.db.prepare('INSERT INTO todos(project_id, seq, title, status, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
        titles.forEach((title, i) => insert.run(projectId, i + 1, title, 'pending', updatedBy, this.ts));
        return this.db.prepare('SELECT * FROM todos WHERE project_id = ? ORDER BY seq, id').all(projectId);
    }
    batch(projectId, kind, reason = null, maid = null) {
        const id = Number(this.db.prepare('INSERT INTO batches(project_id, kind, reason, maid, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(projectId, kind, reason, maid, this.ts).lastInsertRowid);
        return this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
    }
    node(projectId, batchId, { filePath, op, beforeHash = null, afterHash = null, added = 0, removed = 0 }) {
        const id = Number(this.db.prepare(`INSERT INTO nodes(project_id, batch_id, file_path, op, before_hash, after_hash, added, removed, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(projectId, batchId, filePath, op, beforeHash, afterHash, added, removed, this.ts).lastInsertRowid);
        this.db.prepare(`INSERT INTO file_state(project_id, file_path, hash) VALUES (?, ?, ?)
            ON CONFLICT(project_id, file_path) DO UPDATE SET hash = excluded.hash`).run(projectId, filePath, afterHash);
        return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    }
}

// 崩场窗口等观测点只能在服务关闭后直接改 SQL：这些表由原生服务独占。
function withSql(file, fn) {
    const db = new Database(file);
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

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
    const fixture = new LegacySqlFixture(dbPath);
    const project = fixture.project({ name: '兼容工程', root: dir, workspaceAlias: 'demo', createdBy: 'Kerr' });
    const bytes = Buffer.from('\ufeff原文\r\n\0binary', 'utf8');
    const h = fixture.blob(bytes);
    const batch = fixture.batch(project.id, 'create', 'fixture', 'Kerr');
    const node = fixture.node(project.id, batch.id, { filePath: 'old.txt', op: 'create', afterHash: h, added: 2 });
    const expectedTodos = fixture.todos(project.id, ['迁移'], 'Kerr');
    fixture.close();
    const expectedTimeline = [{
        id: batch.id, kind: batch.kind, reason: batch.reason, maid: batch.maid, created_at: batch.created_at,
        files: 'old.txt', node_count: 1, added: 2, removed: 0,
    }];
    const expected = [
        ['store.getProject', { projectId: project.id }, project],
        ['store.listProjects', { workspaceAlias: 'demo' }, [project]],
        ['store.listProjects', { workspaceId: 'other', workspaceAlias: 'demo' }, [project]],
        ['store.projectStats', { projectId: project.id }, {
            nodeCount: 1, fileCount: 1, added: 2, removed: 0, lastNodeId: node.id, lastAt: node.created_at,
        }],
        ['store.contributors', { projectId: project.id }, [
            { maid: 'Kerr', batches: 1, added: 2, removed: 0, last_at: batch.created_at },
        ]],
        ['store.changedFiles', { projectId: project.id }, [
            { file_path: 'old.txt', edits: 1, added: 2, removed: 0, last_node: node.id },
        ]],
        ['store.lastBatch', { projectId: project.id }, batch],
        ['store.getBatch', { projectId: project.id, batchId: batch.id }, batch],
        ['store.getNode', { projectId: project.id, nodeId: node.id }, node],
        ['store.getBatchNodes', { projectId: project.id, batchId: batch.id }, [node]],
        ['store.nodesAfter', { projectId: project.id, nodeId: 0 }, [node]],
        ['store.getTodoBySeq', { projectId: project.id, seq: 1 }, expectedTodos[0]],
        ['store.searchNodes', { projectId: project.id, maid: 'kerr', keyword: 'fixture' }, [{
            ...node, effective_reason: 'fixture', batch_kind: 'create', maid: 'Kerr', project_name: '兼容工程',
        }]],
        ['store.fileHashAt', { projectId: project.id, filePath: 'old.txt', nodeId: 0 }, { known: true, hash: null }],
        ['store.fileHashAt', { projectId: project.id, filePath: 'old.txt', nodeId: node.id }, { known: true, hash: h }],
        ['store.exportSnapshot', { projectId: project.id }, {
            project, todos: expectedTodos, history: [{ ...batch, nodes: [node] }],
        }],
    ];

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
        // 服务关闭后只用原始 SQL 复核：旧库仍可被普通 SQLite 读取，历史未被改写。
        const compat = withSql(dbPath, db => ({
            blob: zlib.gunzipSync(db.prepare('SELECT data FROM blobs WHERE hash = ?').get(h).data),
            empty: zlib.gunzipSync(db.prepare('SELECT data FROM blobs WHERE hash = ?').get(empty).data),
            timeline: db.prepare(`SELECT COUNT(*) AS n FROM batches b WHERE b.project_id = ?
                AND EXISTS (SELECT 1 FROM nodes n WHERE n.batch_id = b.id)`).get(project.id).n,
        }));
        assert.deepEqual(compat.blob, bytes);
        assert.equal(compat.empty.length, 0);
        assert.equal(compat.timeline, 2);
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
        await client.start();
        assert.ok(client.capabilities.includes('nativeEditV1'));
        assert.equal(client.capabilities.includes('operationReconcile'), false);
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
        assert.equal((await client.operationStatus('atomic-failure')).state, 'planningRejected');
        await assert.rejects(client.request('edit.execute', {
            ...command, operationId: 'atomic-failure', reason: 'different', steps: partialSteps,
        }), /reused/);
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
        assert.deepEqual(await client.request('edit.execute', {
            ...command, operationId: 'atomic-failure', steps: partialSteps,
        }), atomic);
        assert.equal(fs.readFileSync(file, 'utf8'), '{"external":true}\n');
        await assert.rejects(client.request('edit.execute', { ...noop, reason: 'different' }), /reused/);
        fs.writeFileSync(file, '{"value":2}\n');
        const syntaxCommand = {
            ...command, operationId: 'syntax',
            steps: [{ step: 1, op: 'replace', start: 1, end: 1, content: '{"value":' }],
        };
        const syntax = await client.request('edit.execute', syntaxCommand);
        assert.equal(syntax.state, 'syntaxRejected');
        assert.equal((await client.operationStatus('syntax')).state, 'syntaxRejected');
        await client.close();
        client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
        assert.deepEqual(await client.request('edit.execute', syntaxCommand), syntax);
        await assert.rejects(client.request('edit.execute', {
            ...syntaxCommand, reason: 'different',
        }), /reused/);
        await assert.rejects(client.request('edit.execute', {
            ...command, operationId: 'escape', filePath: '../outside.json',
        }));
        await assert.rejects(client.request('edit.execute', {
            ...command, operationId: 'injected-config', allowedRoots: [dir],
        }));
        assert.equal(fs.readFileSync(file, 'utf8'), '{"value":2}\n');
        assert.equal((await client.request('store.projectStats', { projectId: 'p1' })).nodeCount, 2);
        await client.close();
        // Model a crash after intent persistence, before replacement/finalization.
        withSql(dbPath, db => db.transaction(() => {
            db.prepare('DELETE FROM service_operations WHERE id=?').run('best-effort');
            db.prepare('DELETE FROM batches WHERE id=?').run(partial.batchId);
            // Undo the terminal file-state update too: a real prepared window still points at before_hash.
            db.prepare(`UPDATE file_state SET hash=(SELECT before_hash FROM file_commit_intents WHERE operation_id=?)
                WHERE project_id='p1' AND file_path='a.json'`).run('best-effort');
            db.prepare("UPDATE file_commit_intents SET state='prepared',result=NULL WHERE operation_id=?")
                .run('best-effort');
        })());
        client = new ProjectServiceClient({ dbPath, binaryPath });
        await assert.rejects(client.start(), /prepared edit intents require trusted service configuration/);
        await client.close();
        assert.equal(fs.readFileSync(file, 'utf8'), '{"value":2}\n');
        client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
        await client.start();
        assert.equal(fs.readFileSync(file, 'utf8'), '{"value":3}\n');
        assert.equal((await client.operationStatus('best-effort')).state, 'committed');
        assert.equal((await client.request('store.projectStats', { projectId: 'p1' })).nodeCount, 2);
        await client.close();
        withSql(dbPath, db => db.transaction(() => {
            db.prepare('DELETE FROM service_operations WHERE id=?').run('best-effort');
            db.prepare('DELETE FROM batches WHERE id=?').run(partial.batchId);
            db.prepare(`UPDATE file_state SET hash=(SELECT before_hash FROM file_commit_intents WHERE operation_id=?)
                WHERE project_id='p1' AND file_path='a.json'`).run('best-effort');
            db.prepare("UPDATE file_commit_intents SET state='prepared',result=NULL,error=NULL WHERE operation_id=?")
                .run('best-effort');
        })());
        fs.writeFileSync(file, '{"thirdParty":true}\n');
        client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
        await assert.rejects(client.start(), /conflict|changed|drift/i);
        if (client.child) await once(client.child, 'exit');
        await client.close();
        const expectedBefore = crypto.createHash('sha256').update('{"value":2}\n').digest('hex');
        const conflictRow = withSql(dbPath, db => {
            const row = db.prepare(`SELECT state,before_hash,after_hash FROM file_commit_intents
                WHERE operation_id='best-effort'`).get();
            const blob = db.prepare('SELECT size FROM blobs WHERE hash=?').get(row.before_hash);
            return { state: row.state, beforeHash: row.before_hash, afterHash: row.after_hash, blobSize: blob?.size };
        });
        assert.equal(conflictRow.state, 'conflict');
        assert.equal(conflictRow.beforeHash, expectedBefore);
        assert.ok(Number.isInteger(conflictRow.blobSize) && conflictRow.blobSize > 0);
        assert.equal(fs.readFileSync(file, 'utf8'), '{"thirdParty":true}\n');
        // 冲突不留永久挂起态：重开服务即可启动，旧 opId 只报 conflict，资源锁已释放。
        client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
        await client.start();
        assert.equal((await client.operationStatus('best-effort')).state, 'conflict');
        const repaired = await client.request('edit.execute', {
            ...command, operationId: 'after-conflict',
            steps: [{ step: 1, op: 'target', target: '"thirdParty":true', replace: '"repaired":true', reason: '冲突后新操作' }],
        });
        assert.equal(repaired.status, 'ok');
        assert.equal(fs.readFileSync(file, 'utf8'), '{"repaired":true}\n');
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
    const fixture = new LegacySqlFixture(dbPath);
    let project;
    let initial;
    try {
        project = fixture.project({ id: 'ptodo', name: 'todo-rpc', root, createdBy: 'Kerr' });
        initial = fixture.todos(project.id, ['first', 'second', 'untouched'], 'Kerr');
    } finally {
        fixture.close();
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

test('native old parameters and persistent tickets use the Rust service end to end', { skip: !hasBinary }, async () => {
    const { buildEditRequest, buildResolveRequest } = require('../VCPDistributedServer/Plugin/ProjectForge/nativeEdit');
    const { RustProjectStore } = require('../VCPDistributedServer/Plugin/ProjectForge/rustStore');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-compat-'));
    const file = path.join(dir, 'a.js');
    fs.writeFileSync(file, 'const first=1;\nconst second=1;\n');
    const dbPath = path.join(dir, 'pf.db');
    const configPath = path.join(dir, 'service.json');
    fs.writeFileSync(configPath, JSON.stringify({
        version: 1, allowedRoots: [dir], nodeExecutable: process.execPath,
        validationWorker: path.resolve(__dirname, '../VCPDistributedServer/Plugin/ProjectForge/validationWorker.cjs'),
        validationCwd: path.resolve(__dirname, '..'), validationTimeoutMs: 10000,
    }));
    let client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
    try {
        const s = new RustProjectStore({ dbPath, client });
        await s.createProject({ projectId: 'pcompat', name: 'compat', root: dir });
        await s.addTodos('pcompat', ['connect native service'], 'MingYue');
        await s.updateTodo('pcompat', 1, { status: 'doing' }, 'MingYue');
        assert.equal((await s.listTodos('pcompat'))[0].status, 'doing');
        assert.equal((await s.listProjectSummaries()).items[0].todo_total, 1);
        const ctx = { projectId: 'pcompat', filePath: 'a.js', reason: 'compatibility', maid: 'MingYue' };
        const send = (id, args) => {
            const request = buildEditRequest({ ...ctx, operationId: id }, args);
            return client.request(request.method, request.params);
        };
        const ambiguous = await send('ambiguous', { target: '1', content: '2' });
        assert.equal(ambiguous.state, 'planningRejected');
        assert.ok(ambiguous.ticketId);
        await client.close();
        client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
        const selected = buildResolveRequest({ ticketId: ambiguous.ticketId, pick: '2' }, 'resolve');
        const result = await client.request(selected.method, selected.params);
        assert.equal(result.status, 'ok');
        assert.equal(result.projectId, ctx.projectId);
        assert.equal(result.reason, ctx.reason);
        assert.equal(fs.readFileSync(file, 'utf8'), 'const first=1;\nconst second=2;\n');
        assert.deepEqual(await client.request(selected.method, selected.params), result);
        await assert.rejects(client.request(selected.method, { ...selected.params, pick: '1' }), /different|reused/);
        await send('before', { before: 2, expect: 'const second=2;', content: 'const middle=3;' });
        await send('end', { after: 'end', content: 'const last=4;' });
        await send('all', { target: 'const', content: 'let', pick: 'all' });
        assert.equal(fs.readFileSync(file, 'utf8'), 'let first=1;\nlet middle=3;\nlet second=2;\nlet last=4;\n');
        const drifted = await send('drift-ticket', { target: 'let', content: 'const' });
        fs.appendFileSync(file, '// external change\n');
        // edit.resolve 不接收外层 expectedHash；票据内部 source_hash 会在外部篡改后拒绝写入。
        await assert.rejects(client.request('edit.resolve', {
            operationId: 'stale-resolve', ticketId: drifted.ticketId, pick: '1',
        }), /expectedHash|file changed/);
        assert.ok(fs.readFileSync(file, 'utf8').endsWith('// external change\n'));
    } finally {
        await client.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('native host file lifecycle and GUI share the Rust owner', { skip: !hasBinary }, async () => {
    const forge = require('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-host-native-'));
    const dbPath = path.join(dir, 'pf.db');
    const workspace = { id: 'native-ws', alias: 'native', path: dir, enabled: true };
    const workspaceService = { list: () => [workspace], getActiveWorkspaceId: () => workspace.id };
    const options = { dbPath, serviceBinaryPath: binaryPath, workspaceService };
    const changed = [];
    const onChanged = event => changed.push(event);
    forge.events.on('changed', onChanged);
    try {
        await forge._test.resetForTests();
        forge.initialize(options);
        const created = await forge.processToolCall({ command: 'CreateProject', name: 'host native', workspace: 'native', todos: 'wire files' });
        const projectId = created.details.project.id;
        const call = (command, args) => forge.processToolCall({ command, projectId, reason: 'native host smoke', maid: 'MingYue', ...args });
        const first = await call('CreateFile', { path: 'a.js', content: 'const a=1;\nconst b=2;\n', todo: 1 });
        assert.equal(first.details.status, 'ok');
        assert.deepEqual(changed.map(event => event.action), ['createproject', 'createfile']);
        assert.deepEqual(changed.map(event => event.projectId), [projectId, projectId]);
        await call('CreateFile', { path: 'nested/b.js', content: 'const c=3;\n' });
        const transfer = await call('MoveCode', { from: 'a.js:2-2', to: 'nested/b.js', after: 'end', indent: 'none' });
        assert.equal(transfer.details.status, 'ok');
        assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'const a=1;\n');
        assert.equal(fs.readFileSync(path.join(dir, 'nested/b.js'), 'utf8'), 'const c=3;\nconst b=2;\n');
        const rolled = await call('Rollback', { batch: `b${transfer.details.batchId}` });
        assert.equal(rolled.details.status, 'ok');
        assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'const a=1;\nconst b=2;\n');
        assert.equal(fs.readFileSync(path.join(dir, 'nested/b.js'), 'utf8'), 'const c=3;\n');
        await call('CopyCode', { from: 'a.js:1-1', to: 'copy.js', create: true, after: 'end', indent: 'none' });
        const moved = await call('MoveFile', { from: 'copy.js', to: 'moved.js' });
        assert.equal(moved.details.status, 'ok');
        assert.equal(fs.existsSync(path.join(dir, 'copy.js')), false);
        const removed = await call('RemoveFile', { paths: ['moved.js', 'nested/b.js'] });
        assert.equal(removed.details.files.length, 2);
        await call('Rollback', { batch: `b${removed.details.batchId}` });
        assert.equal(fs.readFileSync(path.join(dir, 'moved.js'), 'utf8'), 'const a=1;\n');
        const detail = await forge.gui.getProject(projectId);
        assert.equal(detail.todos[0].status, 'doing');
        assert.ok((await forge.gui.listProjects()).some(p => p.id === projectId));
        assert.match((await forge.gui.exportReport(projectId)).markdown, /host native/);
        const guiNode = first.details.nodeIds[0];
        const preview = await forge.gui.revertFileChange({ projectId, nodeId: guiNode, signature: 'MingYue', dryRun: true, force: true });
        assert.ok(['ready', 'dryRun', 'conflict'].includes(preview.status));
        fs.appendFileSync(path.join(dir, 'a.js'), '// outside edit\n');
        const conflict = await forge.gui.revertFileChange({ projectId, nodeId: guiNode, signature: 'MingYue', force: true, expectedHash: preview.expectedHash });
        assert.equal(conflict.status, 'conflict');
        assert.match(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), /outside edit/);
        const oldPid = forge._test.getRuntime().client.child.pid;
        workspace.enabled = false;
        await assert.rejects(call('EditCode', { path: 'a.js', target: 'outside', content: 'inside' }), /停用|只读|允许|writable/);
        assert.notEqual(forge._test.getRuntime().client.child.pid, oldPid);
        workspace.enabled = true;
        await call('EditCode', { path: 'a.js', target: 'outside', content: 'inside' });
        await call('CreateFile', { path: 'tok.js', content: 'function greet(a,   b) {\n  const   x = "hi  world";\n  return x;\n}\n' });
        const tokenAmb = await call('EditCode', {
            path: 'tok.js',
            target: 'function greet(a, b) {\n  const x = "hi  world";\n  return x;\n}',
            content: 'function greet(a, b) {\n  const x = "bye  world";\n  return x;\n}',
        });
        assert.equal(tokenAmb.details.status, 'ambiguous');
        assert.ok(/^[0-9a-f]{64}$/.test(tokenAmb.details.sourceHash));
        const pickedEdit = await call('EditCode', {
            path: 'tok.js', pick: 1,
            target: 'function greet(a, b) {\n  const x = "hi  world";\n  return x;\n}',
            content: 'function greet(a, b) {\n  const x = "bye  world";\n  return x;\n}',
        });
        assert.equal(pickedEdit.details.status, 'ok');
        assert.equal(fs.readFileSync(path.join(dir, 'tok.js'), 'utf8'),
            'function greet(a, b) {\n  const x = "bye  world";\n  return x;\n}\n');
        const clippedDiff = await call('GetNodeDiff', { node: `n${pickedEdit.details.nodeId}`, maxLines: 3 });
        assert.equal(clippedDiff.details.truncated, true);
        assert.ok(clippedDiff.details.shownLines > 0 && clippedDiff.details.shownLines <= 3);
        assert.equal(clippedDiff.details.diffs[0].hunksShown, 0);
        assert.equal(clippedDiff.details.diffs[0].hunksTotal, 1);
        assert.ok(clippedDiff.details.omittedLines > 0);
        assert.equal(clippedDiff.details.truncationReason, 'max_lines');
        const [listed, got, budget] = await Promise.all([
            forge.gui.listProjects(),
            forge.gui.getProject(projectId),
            forge._test.getRuntime().client.request('service.budget', {}),
        ]);
        assert.ok(listed.some(p => p.id === projectId) && got.project.id === projectId);
        assert.equal(budget.singleWriter, true);
        assert.equal(budget.readOnlyQueryPool, true);
        assert.ok(budget.completedReadQueries >= 2 && budget.completedMutations >= 1);
        await forge.cleanup();
        forge.initialize(options);
        assert.equal((await forge.gui.getProject(projectId)).project.id, projectId);
        assert.equal(forge._test.getRuntime().store.db, undefined);
        // 旧 JS 存储/编辑/票据实现已退役：运行期只剩原生服务所有权。
        for (const retired of ['store.js', 'engine.js', 'tickets.js']) {
            assert.equal(fs.existsSync(path.resolve(__dirname, '../VCPDistributedServer/Plugin/ProjectForge', retired)),
                false, `${retired} 已退役`);
        }
    } finally {
        forge.events.off('changed', onChanged);
        await forge.cleanup();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('native multi-file startup recovery preserves partial images and third-party conflicts', { skip: !hasBinary }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-multi-recovery-'));
    const root = path.join(dir, 'new', 'project');
    const dbPath = path.join(dir, 'pf.db');
    const configPath = path.join(dir, 'service.json');
    fs.writeFileSync(configPath, JSON.stringify({
        version: 1, allowedRoots: [dir], nodeExecutable: process.execPath,
        validationWorker: path.resolve(__dirname, '../VCPDistributedServer/Plugin/ProjectForge/validationWorker.cjs'),
        validationCwd: path.resolve(__dirname, '..'), validationTimeoutMs: 10000,
    }));
    let client = new ProjectServiceClient({ dbPath, binaryPath });
    const create = { operationId: 'create-root', projectId: 'p1', name: 'multi recovery', root, createRoot: true };
    const command = { operationId: 'move-crash', projectId: 'p1', kind: 'move', from: 'a.txt', to: 'b.txt', reason: 'recovery' };
    const resetCrashWindow = batchId => {
        withSql(dbPath, db => db.transaction(() => {
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM file_commit_changes WHERE operation_id=?').get(command.operationId).n, 2);
            db.prepare('DELETE FROM service_operations WHERE id=?').run(command.operationId);
            db.prepare('DELETE FROM batches WHERE id=?').run(batchId);
            db.prepare("UPDATE file_commit_plans SET state='prepared',result=NULL,error=NULL WHERE operation_id=?").run(command.operationId);
            db.prepare("UPDATE file_commit_changes SET state=CASE WHEN after_hash IS NULL THEN 'prepared' ELSE 'applied' END,error=NULL WHERE operation_id=?").run(command.operationId);
            db.prepare('DELETE FROM file_state WHERE project_id=?').run('p1');
        })());
    };
    try {
        await assert.rejects(client.request('store.createProject', create), /trusted service configuration/);
        assert.equal(fs.existsSync(root), false);
        await client.close();
        client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
        const project = await client.request('store.createProject', create);
        assert.equal(fs.statSync(root).isDirectory(), true);
        assert.deepEqual(await client.request('store.createProject', create), project);
        const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
        await assert.rejects(client.request('store.createProject', { ...create, operationId: 'outside', projectId: 'p2', root: outside }), /outside trusted allowed roots/);
        assert.equal(fs.existsSync(outside), false);
        fs.writeFileSync(path.join(root, 'a.txt'), 'original\n');
        const moved = await client.request('file.execute', command);
        assert.equal(moved.status, 'ok');
        await client.close();
        // Keep the durable target after-image, reconstruct the not-yet-deleted source.
        resetCrashWindow(moved.batchId);
        fs.writeFileSync(path.join(root, 'a.txt'), 'original\n');
        client = new ProjectServiceClient({ dbPath, binaryPath });
        await assert.rejects(client.start(), /prepared edit intents require trusted service configuration/);
        await client.close();
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original\n');
        client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
        await client.start();
        assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
        assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'original\n');
        const recovered = await client.operationStatus(command.operationId);
        assert.equal(recovered.state, 'committed');
        assert.deepEqual(await client.request('file.execute', command), recovered.result);
        assert.equal((await client.request('store.projectStats', { projectId: 'p1' })).nodeCount, 2);
        await client.close();
        // A third-party source image must survive, while the applied target is compensated.
        resetCrashWindow(recovered.result.batchId);
        fs.writeFileSync(path.join(root, 'a.txt'), 'third-party\n');
        client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
        await assert.rejects(client.start(), /conflict|changed|drift/i);
        if (client.child) await once(client.child, 'exit');
        await client.close();
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'third-party\n');
        assert.equal(fs.existsSync(path.join(root, 'b.txt')), false, '已应用目标必须补偿回滚');
        const originalHash = crypto.createHash('sha256').update('original\n').digest('hex');
        const conflictSnapshot = withSql(dbPath, db => {
            const changes = db.prepare(`SELECT file_path,state,before_hash,after_hash
                FROM file_commit_changes WHERE operation_id=? ORDER BY ordinal`).all(command.operationId);
            const source = changes.find(change => change.file_path === 'a.txt');
            const target = changes.find(change => change.file_path === 'b.txt');
            const beforeBlob = db.prepare('SELECT size FROM blobs WHERE hash=?').get(source?.before_hash);
            const afterBlob = db.prepare('SELECT size FROM blobs WHERE hash=?').get(target?.after_hash);
            const nodes = db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE project_id='p1'").get().n;
            return { source, target, beforeBlobSize: beforeBlob?.size, afterBlobSize: afterBlob?.size, nodes };
        });
        assert.ok(conflictSnapshot.source && conflictSnapshot.target);
        assert.equal(conflictSnapshot.source.state, 'conflict');
        assert.equal(conflictSnapshot.target.state, 'conflict');
        assert.equal(conflictSnapshot.source.before_hash, originalHash);
        assert.equal(conflictSnapshot.target.after_hash, originalHash);
        assert.ok(Number.isInteger(conflictSnapshot.beforeBlobSize) && conflictSnapshot.beforeBlobSize > 0);
        assert.ok(Number.isInteger(conflictSnapshot.afterBlobSize) && conflictSnapshot.afterBlobSize > 0);
        assert.equal(conflictSnapshot.nodes, 0);
        // 冲突不留永久挂起态：服务可正常重启，旧 opId 报 conflict，资源锁已释放。
        client = new ProjectServiceClient({ dbPath, binaryPath, configPath });
        await client.start();
        assert.equal((await client.operationStatus(command.operationId)).state, 'conflict');
        assert.equal((await client.request('store.projectStats', { projectId: 'p1' })).nodeCount, 0);
        const afterConflict = await client.request('file.execute', {
            operationId: 'after-conflict', projectId: 'p1', kind: 'create',
            filePath: 'a.txt', content: 'after conflict\n', overwrite: true,
            reason: 'conflict lock release probe',
        });
        assert.equal(afterConflict.status, 'ok');
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'after conflict\n');
        // 热态 pre-flight 失败同样不挂锁：报错后同路径新操作立即可写。
        await assert.rejects(client.request('file.execute', {
            operationId: 'preflight-fail', projectId: 'p1', kind: 'create',
            filePath: 'a.txt', content: 'must not land\n', overwrite: false,
            reason: 'preflight lock probe',
        }), /already exists/);
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'after conflict\n');
        const afterPreflight = await client.request('file.execute', {
            operationId: 'after-preflight', projectId: 'p1', kind: 'create',
            filePath: 'a.txt', content: 'after preflight\n', overwrite: true,
            reason: 'preflight lock release probe',
        });
        assert.equal(afterPreflight.status, 'ok');
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'after preflight\n');
        const purged = await client.request('store.purgeProjects', {
            operationId: 'purge-conflict-project', ids: ['p1'],
        });
        assert.deepEqual(purged.purged, ['p1']);
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'after preflight\n');
    } finally {
        await client.close();
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