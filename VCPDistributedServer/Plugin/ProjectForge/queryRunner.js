'use strict';
/**
 * ProjectForge queryRunner.js
 *
 * Parent-side executor for the Query entry point. It owns the read-only
 * primitives (which live in the host process and may use the workspace
 * indexer / linkGraph), spawns one short-lived queryWorker.cjs per query, and
 * bridges the worker's JSON-only IPC requests to those primitives.
 *
 * Public API:
 *   const { runQuery, LIMITS } = require('./queryRunner');
 *   const value = await runQuery({
 *     root, code, indexer, signal, timeoutMs,
 *     limits: { maxOutputBytes, maxPrimitiveSteps, ... },
 *   });
 *
 * runQuery resolves with the user's JSON value. If the serialized value is
 * larger than maxOutputBytes, the worker returns a legal truncated JSON frame
 * (an object carrying _truncated/totalBytes/shownItems/shownBytes/hint), and
 * that frame is the resolved value. Errors are Error objects whose `code`
 * starts with QUERY_.
 */
const { fork } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const {
    truncateUtf8,
} = require('./queryWorker.cjs');

const WORKER_PATH = path.join(__dirname, 'queryWorker.cjs');
const PRIMITIVES_PATH = path.join(__dirname, 'queryPrimitives.js');

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_HEAP_MIB = 128;
const DEFAULT_MAX_PRIMITIVE_STEPS = 64;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const IPC_ERROR_BYTES = 8 * 1024;
const OOM_RE = /JavaScript heap out of memory|Allocation failed|Fatal error in|Reached heap limit|OOM/i;

const ALLOWED_RPC_OPS = Object.freeze([
    'files', 'outline', 'symbols', 'graph', 'read', 'search',
]);

/**
 * Public budget advertisement for the parent agent. These are the approved
 * construction-plan budgets; no private concurrency, RPC-size or code-size
 * limits are exposed here.
 */
const LIMITS = Object.freeze({
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: MAX_TIMEOUT_MS,
    maxHeapMiB: DEFAULT_MAX_HEAP_MIB,
    maxPrimitiveSteps: DEFAULT_MAX_PRIMITIVE_STEPS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
});

function makeQueryError(code, message, cause) {
    const normalizedCode = String(code || 'QUERY_ERROR');
    const rawMessage = String(message == null ? '' : message);
    const text = rawMessage.startsWith(normalizedCode + ':')
        ? rawMessage
        : normalizedCode + ': ' + (rawMessage || normalizedCode);
    const error = new Error(text);
    error.code = normalizedCode;
    if (cause !== undefined) error.cause = cause;
    return error;
}

function normalizeQueryError(error, fallbackCode = 'QUERY_ERROR') {
    if (error && typeof error === 'object' && typeof error.code === 'string' &&
        /^QUERY_[A-Z0-9_]+$/.test(error.code)) {
        return makeQueryError(error.code, error.message || error.code, error);
    }
    const message = error && typeof error === 'object' && error.message !== undefined
        ? String(error.message)
        : String(error);
    const prefixed = /^(QUERY_[A-Z0-9_]+):\s*/.exec(message);
    if (prefixed) return makeQueryError(prefixed[1], message, error);
    return makeQueryError(fallbackCode, message, error);
}

function positiveLimit(value, fallback, min, name) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'number' && typeof value !== 'string') {
        throw makeQueryError('QUERY_ARGUMENT', name + ' must be a finite number');
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
        throw makeQueryError('QUERY_ARGUMENT', name + ' must be a finite number');
    }
    const floored = Math.floor(n);
    return floored < min ? min : floored;
}

function normalizeTimeout(value) {
    return Math.min(MAX_TIMEOUT_MS, positiveLimit(value, DEFAULT_TIMEOUT_MS, 1, 'timeoutMs'));
}

/**
 * Normalize query budgets. timeoutMs stays bounded by the plugin transport
 * deadline (30s); limits.* overrides accept any positive integer without
 * clamping down to defaults.
 */
function normalizeLimits(limits = {}, timeoutMs) {
    if (limits == null) limits = {};
    if (typeof limits !== 'object' || Array.isArray(limits)) {
        throw makeQueryError('QUERY_ARGUMENT', 'limits must be a plain object');
    }
    const maxHeapMiB = positiveLimit(limits.maxHeapMiB, DEFAULT_MAX_HEAP_MIB, 1, 'limits.maxHeapMiB');
    const maxPrimitiveSteps = positiveLimit(limits.maxPrimitiveSteps, DEFAULT_MAX_PRIMITIVE_STEPS, 1, 'limits.maxPrimitiveSteps');
    const maxOutputBytes = positiveLimit(limits.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1, 'limits.maxOutputBytes');
    const maxFileBytes = positiveLimit(limits.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1, 'limits.maxFileBytes');
    const maxTotalBytes = positiveLimit(limits.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 1, 'limits.maxTotalBytes');

    return Object.freeze({
        timeoutMs: normalizeTimeout(timeoutMs),
        maxTimeoutMs: MAX_TIMEOUT_MS,
        maxHeapMiB,
        maxPrimitiveSteps,
        maxOutputBytes,
        maxFileBytes,
        maxTotalBytes,
    });
}

function loadCreatePrimitives() {
    let loaded;
    try {
        loaded = require(PRIMITIVES_PATH);
    } catch (error) {
        if (error && error.code === 'MODULE_NOT_FOUND' &&
            String(error.message).includes('queryPrimitives')) {
            throw makeQueryError(
                'QUERY_PRIMITIVES_MISSING',
                'queryPrimitives.js 不存在或无法解析: ' + error.message,
                error,
            );
        }
        throw makeQueryError('QUERY_PRIMITIVES_LOAD_ERROR', error && error.message || String(error), error);
    }
    if (typeof loaded === 'function') return loaded;
    if (loaded && typeof loaded.createPrimitives === 'function') return loaded.createPrimitives;
    throw makeQueryError(
        'QUERY_PRIMITIVES_INVALID',
        'queryPrimitives.js 必须导出 createPrimitives({root,indexer,signal,limits})',
    );
}

function assertPrimitiveHandle(primitives) {
    if (!primitives || typeof primitives !== 'object') {
        throw makeQueryError('QUERY_PRIMITIVES_INVALID', 'createPrimitives() 必须返回对象');
    }
    const missing = ALLOWED_RPC_OPS.filter((op) => typeof primitives[op] !== 'function');
    if (missing.length) {
        throw makeQueryError(
            'QUERY_PRIMITIVES_INVALID',
            'queryPrimitives 缺少只读原语: ' + missing.join(', '),
        );
    }
}

function isGraphRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeGraphEdges(list, label) {
    if (!Array.isArray(list)) {
        throw makeQueryError('QUERY_GRAPH_SHAPE_ERROR', label + ' 必须是数组');
    }
    return list.map((edge, index) => {
        if (!isGraphRecord(edge) || typeof edge.path !== 'string' || !edge.path) {
            throw makeQueryError('QUERY_GRAPH_SHAPE_ERROR', `${label}[${index}] 必须是 { path, line, kind }`);
        }
        return {
            path: edge.path,
            line: Number(edge.line) || 0,
            kind: String(edge.kind == null ? '' : edge.kind),
        };
    });
}

/**
 * q.graph() in queryPrimitives.js resolves plain JSON:
 * { files: string[], deps: Record<string, Edge[]>, rdeps: Record<string, Edge[]>,
 *   ipc: IpcEntry[], truncated: boolean, stats: object }.
 * The worker rebuilds depsOf/rdepsOf/files/ipc from this snapshot. Legacy
 * handle/Map/Set/to-from aliases are deliberately not accepted.
 */
function normalizeGraphSnapshot(value) {
    if (!isGraphRecord(value)) {
        throw makeQueryError('QUERY_GRAPH_SHAPE_ERROR', 'q.graph() 必须返回纯 JSON 快照对象');
    }
    if (!Array.isArray(value.files) ||
        value.files.some((item) => typeof item !== 'string' || !item)) {
        throw makeQueryError('QUERY_GRAPH_SHAPE_ERROR', 'q.graph() 快照缺少 files 字符串数组');
    }
    if (!isGraphRecord(value.deps)) {
        throw makeQueryError('QUERY_GRAPH_SHAPE_ERROR', 'q.graph() 快照缺少 deps 对象');
    }
    if (!isGraphRecord(value.rdeps)) {
        throw makeQueryError('QUERY_GRAPH_SHAPE_ERROR', 'q.graph() 快照缺少 rdeps 对象');
    }
    if (!Array.isArray(value.ipc)) {
        throw makeQueryError('QUERY_GRAPH_SHAPE_ERROR', 'q.graph() 快照缺少 ipc 数组');
    }
    if (typeof value.truncated !== 'boolean') {
        throw makeQueryError('QUERY_GRAPH_SHAPE_ERROR', 'q.graph() 快照缺少 truncated 布尔值');
    }
    if (!isGraphRecord(value.stats)) {
        throw makeQueryError('QUERY_GRAPH_SHAPE_ERROR', 'q.graph() 快照缺少 stats 对象');
    }

    const deps = Object.create(null);
    for (const [key, list] of Object.entries(value.deps)) {
        deps[String(key)] = normalizeGraphEdges(list, `deps[${JSON.stringify(key)}]`);
    }
    const rdeps = Object.create(null);
    for (const [key, list] of Object.entries(value.rdeps)) {
        rdeps[String(key)] = normalizeGraphEdges(list, `rdeps[${JSON.stringify(key)}]`);
    }

    const ipc = value.ipc.map((item, index) => {
        if (!isGraphRecord(item)) {
            throw makeQueryError('QUERY_GRAPH_SHAPE_ERROR', `ipc[${index}] 必须是对象`);
        }
        return {
            channel: String(item.channel == null ? '' : item.channel),
            direction: String(item.direction == null ? '' : item.direction),
            side: String(item.side == null ? '' : item.side),
            method: String(item.method == null ? '' : item.method),
            path: String(item.path == null ? '' : item.path),
            line: Number(item.line) || 0,
        };
    });

    return {
        files: value.files.slice(),
        deps,
        rdeps,
        ipc,
        truncated: value.truncated,
        stats: { ...value.stats },
    };
}

function buildWorkerEnv() {
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP']) {
        const value = process.env[key];
        if (typeof value === 'string' && value) env[key] = value;
    }
    if (!env.TEMP) env.TEMP = os.tmpdir();
    if (!env.TMP) env.TMP = os.tmpdir();
    if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    return env;
}

function raceWithAbort(promise, signal) {
    if (signal.aborted) {
        return Promise.reject(makeQueryError('QUERY_ABORTED', '查询已被调用方取消'));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(makeQueryError('QUERY_ABORTED', '查询已被调用方取消'));
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

async function disposePrimitives(primitives) {
    if (!primitives || typeof primitives !== 'object') return;
    for (const name of ['dispose', 'close', 'destroy']) {
        if (typeof primitives[name] === 'function') {
            try {
                await primitives[name]();
            } catch {
                // Disposal is best effort; it must not mask the query result.
            }
            return;
        }
    }
}

/**
 * Run one user script against read-only query primitives.
 *
 * @param {object} options
 * @param {string} options.root Absolute or resolvable workspace root.
 * @param {string} options.code Async function body receiving `q`.
 * @param {object|null} [options.indexer] Workspace AST indexer passed to primitives.
 * @param {AbortSignal} [options.signal] Caller cancellation signal.
 * @param {number} [options.timeoutMs] Wall clock limit; default 10000, hard cap 30000.
 * @param {object} [options.limits] Budget overrides; see LIMITS.
 * @returns {Promise<unknown>} The user's JSON value (or a legal truncated frame).
 */
function runQuery(options = {}) {
    let root;
    let code;
    let indexer;
    let signal;
    let effectiveLimits;

    try {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw makeQueryError('QUERY_INVALID_ARGUMENTS', 'runQuery options must be an object');
        }
        if (typeof options.root !== 'string' || !options.root.trim()) {
            throw makeQueryError('QUERY_INVALID_ARGUMENTS', 'root must be a non-empty string');
        }
        if (typeof options.code !== 'string' || !options.code.trim()) {
            throw makeQueryError('QUERY_INVALID_ARGUMENTS', 'code must be a non-empty string');
        }
        if (options.signal != null && (
            typeof options.signal !== 'object' ||
            typeof options.signal.addEventListener !== 'function' ||
            typeof options.signal.removeEventListener !== 'function'
        )) {
            throw makeQueryError('QUERY_INVALID_ARGUMENTS', 'signal must be an AbortSignal-like object');
        }
        root = path.resolve(options.root);
        code = options.code;
        indexer = options.indexer;
        signal = options.signal;
        effectiveLimits = normalizeLimits(options.limits, options.timeoutMs);
    } catch (error) {
        return Promise.reject(normalizeQueryError(error, 'QUERY_INVALID_ARGUMENTS'));
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let child = null;
        let timer = null;
        let primitives = null;
        let primitivesDisposed = false;
        let stderrBuf = '';
        const ac = new AbortController();

        function cleanup() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (signal) signal.removeEventListener('abort', onExternalAbort);
        }

        function killChild() {
            const current = child;
            child = null;
            if (!current) return;
            try {
                if (current.connected) current.disconnect();
            } catch { /* already disconnected */ }
            try {
                current.kill('SIGKILL');
            } catch { /* already exited */ }
        }

        async function disposeOnce(handle) {
            if (!handle || primitivesDisposed) return;
            primitivesDisposed = true;
            await disposePrimitives(handle);
        }

        function finishError(error, fallbackCode) {
            if (settled) return;
            settled = true;
            cleanup();
            try { ac.abort(); } catch { /* no-op */ }
            killChild();
            const normalized = normalizeQueryError(error, fallbackCode || 'QUERY_ERROR');
            const bounded = makeQueryError(
                normalized.code,
                truncateUtf8(normalized.message, IPC_ERROR_BYTES),
                normalized.cause,
            );
            void disposeOnce(primitives);
            reject(bounded);
        }

        function finishOk(jsonText) {
            if (settled) return;
            let value;
            try {
                value = JSON.parse(jsonText);
            } catch (error) {
                finishError(
                    makeQueryError('QUERY_SERIALIZE_ERROR', error && error.message || String(error), error),
                    'QUERY_SERIALIZE_ERROR',
                );
                return;
            }
            if (settled) return;
            settled = true;
            cleanup();
            killChild();
            void disposeOnce(primitives);
            resolve(value);
        }

        function onExternalAbort() {
            finishError(makeQueryError('QUERY_ABORTED', '查询已被调用方取消'), 'QUERY_ABORTED');
        }

        function sendRpc(payload) {
            try {
                if (!settled && child && child.connected) {
                    child.send(payload, () => { /* parent reports missing result */ });
                }
            } catch {
                // The exit handler reports a closed IPC channel.
            }
        }

        function sendRpcOk(id, jsonText) {
            sendRpc({ type: 'rpc_res', id, ok: true, json: jsonText });
        }

        function sendRpcError(id, message) {
            sendRpc({
                type: 'rpc_res',
                id,
                ok: false,
                message: truncateUtf8(message, IPC_ERROR_BYTES),
            });
        }

        async function handleWorkerMessage(message) {
            if (settled || !message || typeof message !== 'object') return;

            if (message.type === 'result') {
                if (message.ok === true) {
                    if (typeof message.json !== 'string') {
                        finishError(
                            makeQueryError('QUERY_PROTOCOL_ERROR', 'worker result is missing JSON text'),
                            'QUERY_PROTOCOL_ERROR',
                        );
                        return;
                    }
                    finishOk(message.json);
                    return;
                }
                const code = typeof message.code === 'string' && /^QUERY_[A-Z0-9_]+$/.test(message.code)
                    ? message.code
                    : 'QUERY_WORKER_ERROR';
                const text = typeof message.message === 'string'
                    ? message.message
                    : 'Unknown worker error';
                finishError(makeQueryError(code, text), code);
                return;
            }

            if (message.type !== 'rpc') return;

            const id = message.id;
            const op = message.op;
            if (!Number.isSafeInteger(id) || id < 1) {
                finishError(makeQueryError('QUERY_PROTOCOL_ERROR', 'worker RPC id is invalid'), 'QUERY_PROTOCOL_ERROR');
                return;
            }

            if (!ALLOWED_RPC_OPS.includes(op)) {
                sendRpcError(id, 'QUERY_RPC_FORBIDDEN: ' + String(op));
                return;
            }
            let args;
            try {
                args = typeof message.argsJson === 'string' ? JSON.parse(message.argsJson) : [];
                if (!Array.isArray(args)) throw new Error('argsJson must encode a JSON array');
            } catch (error) {
                sendRpcError(id, 'QUERY_RPC_ARGS_ERROR: ' + (error && error.message || String(error)));
                return;
            }

            const primitive = primitives && primitives[op];
            if (typeof primitive !== 'function') {
                sendRpcError(id, 'QUERY_PRIMITIVES_INVALID: missing q.' + String(op));
                return;
            }

            try {
                let result = await raceWithAbort(
                    Promise.resolve().then(() => Reflect.apply(primitive, primitives, args)),
                    ac.signal,
                );
                if (settled) return;
                if (op === 'graph') result = normalizeGraphSnapshot(result);

                let jsonText;
                try {
                    jsonText = JSON.stringify(result === undefined ? null : result);
                } catch (error) {
                    sendRpcError(
                        id,
                        'QUERY_RPC_SERIALIZE_ERROR: ' + (error && error.message || String(error)),
                    );
                    return;
                }
                sendRpcOk(id, typeof jsonText === 'string' ? jsonText : 'null');
            } catch (error) {
                if (!settled) {
                    const normalized = normalizeQueryError(error, 'QUERY_PRIMITIVE_ERROR');
                    sendRpcError(id, normalized.message);
                }
            }
        }

        function spawnWorker() {
            if (settled) return;
            try {
                child = fork(WORKER_PATH, [], {
                    execPath: process.execPath,
                    execArgv: [`--max-old-space-size=${effectiveLimits.maxHeapMiB}`],
                    cwd: os.tmpdir(),
                    env: buildWorkerEnv(),
                    silent: true,
                    windowsHide: true,
                });
            } catch (error) {
                finishError(
                    makeQueryError('QUERY_SPAWN_ERROR', error && error.message || String(error), error),
                    'QUERY_SPAWN_ERROR',
                );
                return;
            }

            const current = child;
            if (current.stdout) current.stdout.resume();
            if (current.stderr) {
                current.stderr.on('data', (chunk) => {
                    if (stderrBuf.length >= 8192) return;
                    stderrBuf += chunk.toString('utf8').slice(0, 8192 - stderrBuf.length);
                });
            }

            current.on('error', (error) => {
                finishError(
                    makeQueryError('QUERY_WORKER_ERROR', error && error.message || String(error), error),
                    'QUERY_WORKER_ERROR',
                );
            });

            current.on('exit', (exitCode, exitSignal) => {
                if (settled) return;
                if (OOM_RE.test(stderrBuf)) {
                    finishError(
                        makeQueryError(
                            'QUERY_MEMORY_LIMIT_EXCEEDED',
                            `查询内存超过 ${effectiveLimits.maxHeapMiB}MB V8 堆限制`,
                        ),
                        'QUERY_MEMORY_LIMIT_EXCEEDED',
                    );
                    return;
                }
                const detail = stderrBuf.trim()
                    ? ': ' + truncateUtf8(stderrBuf.trim(), 512)
                    : '';
                finishError(
                    makeQueryError(
                        'QUERY_WORKER_EXITED',
                        `沙箱子进程异常退出 (code=${exitCode}, signal=${exitSignal || 'none'})${detail}`,
                    ),
                    'QUERY_WORKER_EXITED',
                );
            });

            current.on('message', (message) => {
                Promise.resolve(handleWorkerMessage(message)).catch((error) => {
                    if (!settled) {
                        finishError(
                            normalizeQueryError(error, 'QUERY_WORKER_ERROR'),
                            'QUERY_WORKER_ERROR',
                        );
                    }
                });
            });

            try {
                current.send({
                    type: 'exec',
                    code,
                    maxPrimitiveSteps: effectiveLimits.maxPrimitiveSteps,
                    maxOutputBytes: effectiveLimits.maxOutputBytes,
                }, (error) => {
                    if (error) {
                        finishError(
                            makeQueryError('QUERY_IPC_ERROR', error.message || String(error), error),
                            'QUERY_IPC_ERROR',
                        );
                    }
                });
            } catch (error) {
                finishError(
                    makeQueryError('QUERY_IPC_ERROR', error && error.message || String(error), error),
                    'QUERY_IPC_ERROR',
                );
            }
        }

        if (signal) {
            if (signal.aborted) {
                finishError(makeQueryError('QUERY_ABORTED', '查询在启动前已取消'), 'QUERY_ABORTED');
                return;
            }
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }

        timer = setTimeout(() => {
            finishError(
                makeQueryError('QUERY_TIMEOUT', `query 执行超过 ${effectiveLimits.timeoutMs}ms 限制`),
                'QUERY_TIMEOUT',
            );
        }, effectiveLimits.timeoutMs);

        const initPromise = Promise.resolve().then(() => {
            const createPrimitives = loadCreatePrimitives();
            return createPrimitives({
                root,
                indexer,
                signal: ac.signal,
                limits: effectiveLimits,
            });
        });

        initPromise.then((handle) => {
            primitives = handle;
            if (settled) void disposeOnce(handle);
        }, () => {
            // The initPromise is also awaited below; this branch only makes the
            // late-resolution disposal path explicit and prevents unhandled
            // rejection if the query settles during initialization.
        });

        (async () => {
            try {
                const handle = await raceWithAbort(initPromise, ac.signal);
                if (settled) return;
                assertPrimitiveHandle(handle);
                primitives = handle;
                spawnWorker();
            } catch (error) {
                if (!settled) {
                    finishError(
                        normalizeQueryError(error, 'QUERY_PRIMITIVE_INIT_ERROR'),
                        'QUERY_PRIMITIVE_INIT_ERROR',
                    );
                }
            }
        })();
    });
}

module.exports = {
    runQuery,
    LIMITS,
    normalizeLimits,
    ALLOWED_RPC_OPS,
    normalizeGraphSnapshot,
};
