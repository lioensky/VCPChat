'use strict';
// Host lifecycle and protocol only. Rust owns every database connection and edit.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { WorkspaceResolver } = require('./workspace');
const { IndexerClient, resolveDefaultBinaryPath, resolveNativePath } = require('./indexerClient');
const { RustProjectStore } = require('./rustStore');
const { createNativeService } = require('./nativeService');
const ES = require('./evalSymbol');
const A = require('./args');

const DEFAULT_DB_PATH = path.resolve(__dirname, '../../../AppData/ProjectForge/projectforge.db');
function defaultDatabasePath() {
    if (!process.versions.electron) return DEFAULT_DB_PATH;
    const { app } = require('electron');
    return app.isPackaged
        ? path.join(app.getPath('userData'), 'ProjectForge', 'projectforge.db')
        : DEFAULT_DB_PATH;
}
const events = new EventEmitter();
events.setMaxListeners(50);
let runtime = null;
let queue = Promise.resolve();

// Admit host calls in order; a failed request does not discard later requests.
function enqueue(work) {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
}

async function closeService(state) {
    if (state.inFlightReads && state.inFlightReads.size) {
        await Promise.allSettled([...state.inFlightReads]);
    }
    if (state.store) {
        await state.store.close();
        state.store = null;
        state.client = null;
        state.facade = null;
    }
    if (state.configPath) {
        await fs.rm(state.configPath, { force: true });
        state.configPath = null;
    }
}

async function dispose(state) {
    if (!state) return;
    // closeService 可能在原生存储子进程已退出时抛 CONNECTION_LOST。
    // 无论成败都必须把 AST 索引子进程收回，否则 Node 事件循环无法收尾，
    // 整份测试文件会被文件级超时 SIGKILL。
    let closeError = null;
    try {
        await closeService(state);
    } catch (error) {
        closeError = error;
    }
    try {
        await state.indexer.stop();
    } catch (stopError) {
        if (!closeError) closeError = stopError;
    }
    if (closeError) throw closeError;
}

function initialize(options = {}) {
    const previous = runtime;
    const config = options.config || {};
    const logger = options.logger || console;
    const binaryPath = options.serviceBinaryPath || config.PROJECTFORGE_SERVICE_BINARY
        || process.env.PF_SERVICE_BINARY || resolveDefaultBinaryPath();
    const state = {
        initialized: true,
        bashEnabled: A.bool(config.BASH_ENABLED, false),
        bashExecutable: config.BASH_EXECUTABLE,
        lanes: new Map(),
        queries: new Set(),
        controllers: new Set(),
        inFlightReads: new Set(),
        queryConcurrency: Number(config.QUERY_MAX_CONCURRENCY ?? 2),
        logger,
        dbPath: path.resolve(config.PROJECTFORGE_DB_PATH || options.dbPath || defaultDatabasePath()),
        binaryPath,
        nodeExecutable: options.nodeExecutable || config.PROJECTFORGE_NODE_EXECUTABLE || process.execPath,
        resolver: new WorkspaceResolver({
            workspaceService: options.services?.workspaceService || options.workspaceService || null,
            extraAllowed: String(config.ALLOWED_DIRECTORIES || '').split(','),
        }),
        indexer: new IndexerClient({
            logger,
            binaryPath: options.indexerBinaryPath || binaryPath,
            disabled: !A.bool(config.AST_INDEX_ENABLED, true),
        }),
        maxEditSize: Number(config.MAX_EDIT_FILE_SIZE) || 5 * 1024 * 1024,
        readMaxFiles: Number(config.READ_MAX_FILES) || 20,
        readMaxBytes: Number(config.READ_MAX_TOTAL_BYTES) || 30 * 1024 * 1024,
        store: null,
        client: null,
        facade: null,
        configPath: null,
        rootsKey: null,
    };
    // No database is opened here. Startup happens on the first awaited call,
    // after all requests and shutdown of the previous instance have settled.
    if (!Number.isSafeInteger(state.queryConcurrency) || state.queryConcurrency < 1) throw new Error('QUERY_MAX_CONCURRENCY must be a positive integer');
    stopActive(previous);
    state.previousClosed = enqueue(() => dispose(previous));
    runtime = state;
    return state;
}

function ensureRuntime(options = {}) {
    return runtime || initialize(options);
}

async function ready(state) {
    await state.previousClosed;
    const roots = [...new Set(state.resolver.allowedRoots().map(root => path.resolve(root)))].sort();
    const rootsKey = JSON.stringify(roots);
    if (state.facade && state.rootsKey === rootsKey) return state.facade;
    // Root changes are applied between host calls, never during an admitted edit.
    // Stop the sole owner before starting its replacement against the same DB.
    await closeService(state);
    if (roots.length) {
        await fs.mkdir(path.dirname(state.dbPath), { recursive: true });
        state.configPath = path.join(path.dirname(state.dbPath), `.service-${crypto.randomUUID()}.json`);
        await fs.writeFile(state.configPath, JSON.stringify({
            version: 1,
            allowedRoots: roots,
            nodeExecutable: state.nodeExecutable,
            validationWorker: resolveNativePath(path.join(__dirname, 'validationWorker.cjs')),
            validationCwd: resolveNativePath(path.resolve(__dirname, '../../..')),
            validationTimeoutMs: 20000,
        }), { flag: 'wx' });
    }
    state.store = new RustProjectStore({
        dbPath: state.dbPath,
        configPath: state.configPath,
        binaryPath: state.binaryPath,
    });
    state.client = state.store.client;
    await state.store.start();
    const info = await state.store.info();
    if (info.serviceSchemaVersion !== 5) throw new Error('ProjectForge requires the schema 5 native service binary; rebuild before enabling it.');
    state.facade = createNativeService(state);
    state.facade.runtime.events.on('changed', payload => events.emit('changed', payload));
    state.rootsKey = rootsKey;
    return state.facade;
}

function projectLane(state, id, work) {
    const next = (state.lanes.get(id) || Promise.resolve()).then(work);
    const tail = next.then(() => {}, () => {});
    state.lanes.set(id, tail);
    tail.then(() => { if (state.lanes.get(id) === tail) state.lanes.delete(id); });
    return next;
}

function stopActive(state) {
    if (state) for (const controller of state.controllers) controller.abort();
}

const detachedReads = new Set(['query', 'readcode', 'outline', 'findsymbol', 'trace']);
function processToolCall(args = {}, executionContext = {}) {
    const state = ensureRuntime();
    const fields = A.lowerKeys(args);
    const command = A.str(fields, 'command', 'action').toLowerCase();
    const id = A.str(fields, 'projectId', 'project', 'id');
    const admit = async () => {
        if (runtime !== state) throw new Error('ProjectForge service closed');
        const facade = await ready(state);
        if (runtime !== state) throw new Error('ProjectForge service closed');
        return facade;
    };
    if (!detachedReads.has(command) && command !== 'bash') {
        const run = () => enqueue(async () => (await admit()).processToolCall(args, executionContext));
        return id ? projectLane(state, id, run) : run();
    }
    const run = async () => {
        if (command === 'query') {
            while (state.queries.size >= state.queryConcurrency) await Promise.race(state.queries);
        }
        const result = enqueue(async () => {
            const facade = await admit();
            const controller = new AbortController();
            state.controllers.add(controller);
            const task = facade.processToolCall(args, executionContext, controller.signal);
            const done = task.then(() => {}, () => {});
            state.inFlightReads.add(done);
            done.then(() => { state.controllers.delete(controller); state.inFlightReads.delete(done); });
            return { task };
        }).then(({task}) => task);
        if (command === 'query') {
            const done = result.then(() => {}, () => {});
            state.queries.add(done);
            done.then(() => state.queries.delete(done));
        }
        return result;
    };
    return command === 'bash' ? projectLane(state, id, run) : run();
}

const MUTATING_GUI = new Set(['revertFileChange', 'acceptProject', 'deleteProject']);

function currentRootsKey(state) {
    const roots = [...new Set(state.resolver.allowedRoots().map(root => path.resolve(root)))].sort();
    return JSON.stringify(roots);
}

const gui = Object.fromEntries([
    'listProjects', 'exportReport', 'getProject', 'getTimeline', 'searchHistory',
    'getBatchNodes', 'getNodeDetail', 'revertFileChange', 'acceptProject', 'deleteProject',
].map(name => [name, (...args) => {
    const state = ensureRuntime();
    if (!MUTATING_GUI.has(name) && state.facade && state.rootsKey === currentRootsKey(state)) {
        if (!state.inFlightReads) state.inFlightReads = new Set();
        const task = Promise.resolve().then(() => state.facade.gui[name](...args));
        const settled = task.then(() => undefined, () => undefined);
        state.inFlightReads.add(settled);
        settled.then(() => state.inFlightReads.delete(settled));
        return task;
    }
    const run = () => enqueue(async () => {
        if (runtime !== state) throw new Error('ProjectForge service closed');
        return (await ready(state)).gui[name](...args);
    });
    return MUTATING_GUI.has(name) ? projectLane(state, name === 'revertFileChange' ? args[0]?.projectId : args[0], run) : run();
}]));

function cleanup() {
    const state = runtime;
    runtime = null;
    stopActive(state);
    return enqueue(async () => {
        await dispose(state);
        await ES.cleanup();
    });
}

function astIgnoreDirs() {
    const { DEFAULT_IGNORED_DIRS } = require('../../../modules/services/workspaceIndex');
    return [...DEFAULT_IGNORED_DIRS];
}

module.exports = {
    initialize, ensureRuntime, processToolCall, cleanup, gui, events,
    _test: { resetForTests: cleanup, getRuntime: () => runtime, astIgnoreDirs },
};
