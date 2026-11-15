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
    await closeService(state);
    await state.indexer.stop();
}

function initialize(options = {}) {
    const previous = runtime;
    const config = options.config || {};
    const logger = options.logger || console;
    const binaryPath = options.serviceBinaryPath || config.PROJECTFORGE_SERVICE_BINARY
        || process.env.PF_SERVICE_BINARY || resolveDefaultBinaryPath();
    const state = {
        initialized: true,
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

function processToolCall(args = {}, executionContext = {}) {
    const state = ensureRuntime();
    return enqueue(async () => (await ready(state)).processToolCall(args, executionContext));
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
    return enqueue(async () => (await ready(state)).gui[name](...args));
}]));

function cleanup() {
    const state = runtime;
    runtime = null;
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
