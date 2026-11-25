'use strict';
/**
 * ProjectForge queryWorker.cjs
 *
 * One query per process. The parent process owns the read-only primitives and
 * speaks JSON-only IPC with this worker:
 *
 *   parent -> worker : { type: 'exec', code, maxPrimitiveSteps, maxOutputBytes }
 *   worker -> parent : { type: 'rpc', id, op, argsJson }
 *   parent -> worker : { type: 'rpc_res', id, ok: true, json } | { id, ok: false, message }
 *   worker -> parent : { type: 'result', ok: true, json } | { ok: false, code, message }
 *
 * The model code is compiled and executed inside a fresh V8 context. The
 * context only receives a JSON-string bridge; no host object, host q handle,
 * host Promise, host console, require(), process, fs or child_process handle is
 * injected. This is a resource-isolation layer, not a general security sandbox:
 * the enclosing process is still a separate short-lived Node process with a
 * 128 MiB V8 heap limit, and the parent applies the wall-clock limit and
 * process-tree kill.
 */
const vm = require('node:vm');

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_MAX_PRIMITIVE_STEPS = 64;
const ERROR_BYTES = 8 * 1024;
const TRUNCATION_HINT = '结果已软截断，请在脚本内用 .slice()/.map()/计数聚合';

function positiveInt(value, fallback, min = 1) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.floor(n));
}

/** UTF-8 safe truncation for error strings. */
function truncateUtf8(str, maxBytes = ERROR_BYTES) {
    const text = String(str == null ? '' : str);
    const limit = Math.min(ERROR_BYTES, positiveInt(maxBytes, ERROR_BYTES, 1));
    if (Buffer.byteLength(text, 'utf8') <= limit) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= Math.max(0, limit - 16)) lo = mid;
        else hi = mid - 1;
    }
    return text.slice(0, lo) + '...(truncated)';
}

function jsonByteLength(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
        return Infinity;
    }
}

/**
 * Set shownBytes to the byte length of the final JSON. shownBytes participates
 * in its own encoding, so iterate to a fixed point and verify the final frame.
 */
function sealTruncatedPayload(payload) {
    const value = { ...payload, shownBytes: 0 };
    let json = '';
    let previous = -1;
    for (let i = 0; i < 12; i++) {
        json = JSON.stringify(value);
        const bytes = Buffer.byteLength(json, 'utf8');
        if (value.shownBytes === bytes) return { value, json, bytes };
        if (previous === bytes) {
            // The fixed point did not move this round; the current value is
            // still a valid JSON frame, so report its real byte length.
            return { value, json, bytes };
        }
        previous = bytes;
        value.shownBytes = bytes;
    }
    json = JSON.stringify(value);
    return { value, json, bytes: Buffer.byteLength(json, 'utf8') };
}

function makeTruncatedPayload(payload, totalBytes, shownItems, maxBytes) {
    const sealed = sealTruncatedPayload({
        ...payload,
        _truncated: true,
        totalBytes,
        shownItems,
        hint: TRUNCATION_HINT,
    });
    return sealed.bytes <= maxBytes ? sealed : null;
}

function safeTruncatedFallback(totalBytes, maxBytes) {
    const variants = [
        { _truncated: true, totalBytes, shownBytes: 0, shownItems: 0, hint: TRUNCATION_HINT },
        { _truncated: true, totalBytes, shownBytes: 0, shownItems: 0, hint: TRUNCATION_HINT.slice(0, 24) },
        { _truncated: true, totalBytes, shownBytes: 0, shownItems: 0, hint: '结果已软截断' },
        { _truncated: true, totalBytes, shownBytes: 0, shownItems: 0 },
        { _truncated: true, totalBytes, shownBytes: 0 },
        { _truncated: true, totalBytes },
        { _truncated: true },
    ];
    for (const variant of variants) {
        const sealed = sealTruncatedPayload(variant);
        if (sealed.bytes <= maxBytes) return sealed;
    }
    const value = { _truncated: true };
    const json = JSON.stringify(value);
    return { value, json, bytes: Buffer.byteLength(json, 'utf8') };
}

function truncateArrayResult(value, totalBytes, maxBytes) {
    let best = null;
    let lo = 0;
    let hi = value.length;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const candidate = makeTruncatedPayload(
            { items: value.slice(0, mid) }, totalBytes, mid, maxBytes,
        );
        if (candidate) {
            best = candidate;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best || safeTruncatedFallback(totalBytes, maxBytes);
}

function truncateStringResult(value, totalBytes, maxBytes) {
    let best = null;
    let lo = 0;
    let hi = value.length;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const candidate = makeTruncatedPayload(
            { preview: value.slice(0, mid) }, totalBytes, mid > 0 ? 1 : 0, maxBytes,
        );
        if (candidate) {
            best = candidate;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best || safeTruncatedFallback(totalBytes, maxBytes);
}

function truncateObjectResult(value, totalBytes, maxBytes) {
    const work = { ...value };
    delete work._truncated;
    delete work.totalBytes;
    delete work.shownBytes;
    delete work.shownItems;
    delete work.hint;

    const arrayKeys = Object.keys(work)
        .filter((key) => Array.isArray(work[key]))
        .sort((a, b) => jsonByteLength(work[b]) - jsonByteLength(work[a]));
    const retained = new Map(arrayKeys.map((key) => [key, work[key].length]));
    const shownItemCount = () => [...retained.values()].reduce((sum, n) => sum + n, 0);
    const tryBuild = () => makeTruncatedPayload(work, totalBytes, shownItemCount(), maxBytes);

    let current = tryBuild();
    if (current) return current;

    for (const key of arrayKeys) {
        const original = work[key];
        let best = null;
        let lo = 0;
        let hi = original.length;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            work[key] = original.slice(0, mid);
            retained.set(key, mid);
            const candidate = tryBuild();
            if (candidate) {
                best = candidate;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (best) return best;
        work[key] = [];
        retained.set(key, 0);
    }

    const stringKeys = Object.keys(work)
        .filter((key) => typeof work[key] === 'string' && work[key].length > 0)
        .sort((a, b) => work[b].length - work[a].length);
    for (const key of stringKeys) {
        const original = work[key];
        let best = null;
        let lo = 0;
        let hi = original.length;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            work[key] = original.slice(0, mid);
            const candidate = tryBuild();
            if (candidate) {
                best = candidate;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (best) return best;
        work[key] = '';
    }

    return safeTruncatedFallback(totalBytes, maxBytes);
}

/**
 * Return a legal JSON frame no larger than maxBytes. Arrays become
 * { items: [...], _truncated, totalBytes, shownItems, shownBytes, hint };
 * strings become { preview, ... }; objects retain their top-level keys and
 * trim their largest arrays/strings first. The metadata is always itself
 * valid JSON, so callers never receive a broken prefix.
 */
function softTruncateJson(jsonStr, maxBytes = DEFAULT_MAX_OUTPUT_BYTES) {
    const raw = typeof jsonStr === 'string' ? jsonStr : 'null';
    const totalBytes = Buffer.byteLength(raw, 'utf8');
    const limit = positiveInt(maxBytes, DEFAULT_MAX_OUTPUT_BYTES, 1);
    if (totalBytes <= limit) {
        return { value: JSON.parse(raw), json: raw, truncated: false, totalBytes, shownBytes: totalBytes };
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        parsed = undefined;
    }

    let result;
    if (Array.isArray(parsed)) result = truncateArrayResult(parsed, totalBytes, limit);
    else if (parsed && typeof parsed === 'object') result = truncateObjectResult(parsed, totalBytes, limit);
    else if (typeof parsed === 'string') result = truncateStringResult(parsed, totalBytes, limit);
    else result = safeTruncatedFallback(totalBytes, limit);

    return {
        value: result.value,
        json: result.json,
        truncated: true,
        totalBytes,
        shownBytes: result.bytes,
    };
}

/**
 * The bootstrap is stringified into the fresh VM context. It must not close
 * over any host variable: its only input is __bridge, deleted from globalThis
 * both deleted from globalThis before model code is compiled.
 */
function vmBootstrap() {
    'use strict';
    const bridge = globalThis.__bridge;
    delete globalThis.__bridge;

    const noop = () => {};
    globalThis.console = Object.freeze({
        log: noop, info: noop, warn: noop, error: noop, debug: noop, trace: noop,
    });

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

    function toPosixRel(value) {
        return String(value == null ? '' : value)
            .split('\\').join('/')
            .replace(/^(\.\/)+/, '');
    }

    function invokeHost(op, args) {
        return new Promise((resolve, reject) => {
            let serialized;
            try {
                serialized = JSON.stringify(args);
            } catch (error) {
                reject(new Error('Invalid arguments to q.' + op + ': ' + String(error && error.message || error)));
                return;
            }
            bridge(
                op,
                serialized,
                (jsonText) => {
                    try {
                        resolve(JSON.parse(typeof jsonText === 'string' ? jsonText : 'null'));
                    } catch {
                        reject(new Error('Failed to decode response from q.' + op));
                    }
                },
                (errorMessage) => {
                    reject(new Error(String(errorMessage || ('q.' + op + ' failed'))));
                },
            );
        });
    }

    function makeGraphHandle(snapshot) {
        const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
        const filesList = Array.isArray(snap.files) ? snap.files : [];
        const depsMap = snap.deps && typeof snap.deps === 'object' ? snap.deps : {};
        const rdepsMap = snap.rdeps && typeof snap.rdeps === 'object' ? snap.rdeps : {};
        const ipcList = Array.isArray(snap.ipc) ? snap.ipc : [];
        const truncated = Boolean(snap.truncated);
        const stats = snap.stats && typeof snap.stats === 'object'
            ? { ...snap.stats }
            : { scanned: filesList.length, withFacts: filesList.length, truncated };

        const handle = {
            depsOf(targetPath) {
                const key = toPosixRel(targetPath);
                const list = Object.prototype.hasOwnProperty.call(depsMap, key) ? depsMap[key] : [];
                if (!Array.isArray(list)) return [];
                return list.map((edge) => ({
                    path: toPosixRel(edge && edge.path),
                    line: Number(edge && edge.line) || 0,
                    kind: String(edge && edge.kind || ''),
                }));
            },
            rdepsOf(targetPath) {
                const key = toPosixRel(targetPath);
                const list = Object.prototype.hasOwnProperty.call(rdepsMap, key) ? rdepsMap[key] : [];
                if (!Array.isArray(list)) return [];
                return list.map((edge) => ({
                    path: toPosixRel(edge && edge.path),
                    line: Number(edge && edge.line) || 0,
                    kind: String(edge && edge.kind || ''),
                }));
            },
            files() {
                return filesList.map(toPosixRel);
            },
            ipc() {
                return ipcList.map((item) => {
                    const source = item && typeof item === 'object' ? item : {};
                    return {
                        channel: String(source.channel || ''),
                        direction: String(source.direction || ''),
                        side: String(source.side || ''),
                        method: String(source.method || ''),
                        path: toPosixRel(source.path),
                        line: Number(source.line) || 0,
                    };
                });
            },
        };
        Object.defineProperty(handle, 'truncated', { value: truncated, enumerable: true });
        Object.defineProperty(handle, 'stats', { value: Object.freeze(stats), enumerable: true });
        return Object.freeze(handle);
    }

    const q = Object.freeze({
        async files(glob) {
            return await invokeHost('files', glob === undefined ? [] : [glob]);
        },
        async outline(targetPath) {
            return await invokeHost('outline', [targetPath]);
        },
        async symbols(opts) {
            return await invokeHost('symbols', opts === undefined ? [] : [opts]);
        },
        async graph(options) {
            if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
                throw new Error('q.graph: options must be an object');
            }
            const glob = options && options.glob;
            const args = glob === undefined ? [] : [glob];
            return makeGraphHandle(await invokeHost('graph', args));
        },
        async read(target) {
            return await invokeHost('read', [target]);
        },
        async search(query, opts) {
            return await invokeHost('search', opts === undefined ? [query] : [query, opts]);
        },
    });

    return {
        compile(userCode) {
            return new AsyncFunction('q', String(userCode));
        },
        run(fn, finish) {
            let done = false;
            const complete = (ok, payload) => {
                if (done) return;
                done = true;
                try {
                    finish(Boolean(ok), typeof payload === 'string' ? payload : String(payload));
                } catch {
                    // The host may have gone away; the worker exit path reports it.
                }
            };
            Promise.resolve().then(() => fn(q)).then(
                (rawResult) => {
                    let jsonText;
                    try {
                        jsonText = JSON.stringify(rawResult === undefined ? null : rawResult);
                    } catch (error) {
                        complete(false, 'QUERY_SERIALIZE_ERROR: ' + String(error && error.message || error));
                        return;
                    }
                    complete(true, typeof jsonText === 'string' ? jsonText : 'null');
                },
                (error) => {
                    const name = String(error && error.name || 'Error');
                    const message = String(error && error.message || error);
                    const stack = String(error && error.stack || '');
                    complete(false, stack && !stack.startsWith(name + ': ' + message)
                        ? name + ': ' + message + '\n' + stack
                        : name + ': ' + message);
                },
            );
        },
    };
}

function buildVmRunner() {
    const sandbox = Object.create(null);
    const context = vm.createContext(sandbox, {
        name: 'projectforge-query-worker',
        codeGeneration: { strings: true, wasm: false },
    });

    sandbox.__bridge = (op, argsJson, onResolve, onReject) => {
        if (typeof op !== 'string') {
            try { onReject('QUERY_RPC_FORBIDDEN: invalid primitive op'); } catch { /* disposed */ }
            return;
        }
        callHostRpc(op, argsJson).then(
            (jsonPayload) => {
                try { onResolve(typeof jsonPayload === 'string' ? jsonPayload : 'null'); } catch { /* disposed */ }
            },
            (error) => {
                const message = error && error.message ? error.message : String(error);
                try { onReject(truncateUtf8(message, ERROR_BYTES)); } catch { /* disposed */ }
            },
        );
    };

    const source = '(' + vmBootstrap.toString() + ')()';
    const script = new vm.Script(source, { filename: 'projectforge-query-bootstrap.vm.js' });
    const api = script.runInContext(context, { timeout: 2000 });
    return {
        compile(userCode) {
            return api.compile(userCode);
        },
        run(fn) {
            return new Promise((resolve, reject) => {
                let done = false;
                try {
                    api.run(fn, (ok, payload) => {
                        if (done) return;
                        done = true;
                        if (ok) {
                            resolve(typeof payload === 'string' ? payload : 'null');
                            return;
                        }
                        const text = typeof payload === 'string' ? payload : String(payload);
                        reject(new Error(text.replace(/^Error:\s*/, '')));
                    });
                } catch (error) {
                    if (!done) {
                        done = true;
                        reject(error);
                    }
                }
            });
        },
    };
}

let settled = false;
let running = false;
let maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
let nextRpcId = 1;
const pendingRpcs = new Map();

function safeSend(message) {
    try {
        if (typeof process.send === 'function' && process.connected) {
            process.send(message);
            return true;
        }
    } catch {
        // Parent may have disconnected; the parent reports the missing result.
    }
    return false;
}

function rejectPendingRpcs(reason) {
    for (const [, pending] of pendingRpcs) pending.reject(new Error(reason));
    pendingRpcs.clear();
}

function settleOk(jsonText) {
    if (settled) return;
    settled = true;
    rejectPendingRpcs('QUERY_ABORTED: worker settled');
    safeSend({ type: 'result', ok: true, json: typeof jsonText === 'string' ? jsonText : 'null' });
    setImmediate(() => process.exit(0));
}

function settleError(code, message) {
    if (settled) return;
    settled = true;
    rejectPendingRpcs('QUERY_ABORTED: worker settled');
    const text = String(message == null ? '' : message).replace(/^(?:Error:\s*)+/, '');
    safeSend({
        type: 'result',
        ok: false,
        code: String(code || 'QUERY_EXEC_ERROR'),
        message: truncateUtf8(text || 'Unknown query error', ERROR_BYTES),
    });
    setImmediate(() => process.exit(0));
}

function callHostRpc(op, argsJson) {
    return new Promise((resolve, reject) => {
        if (settled) {
            reject(new Error('QUERY_ABORTED: query already terminated'));
            return;
        }
        const id = nextRpcId++;
        pendingRpcs.set(id, { resolve, reject });
        const sent = safeSend({
            type: 'rpc',
            id,
            op,
            argsJson: typeof argsJson === 'string' ? argsJson : '[]',
        });
        if (!sent) {
            pendingRpcs.delete(id);
            reject(new Error('QUERY_IPC_ERROR: worker IPC channel is closed'));
        }
    });
}

function formatError(error) {
    const name = String(error && error.name || 'Error');
    const message = String(error && error.message || error);
    const stack = String(error && error.stack || '');
    return stack && !stack.startsWith(name + ': ' + message)
        ? name + ': ' + message + '\n' + stack
        : name + ': ' + message;
}

async function handleMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'rpc_res') {
        const pending = pendingRpcs.get(message.id);
        if (!pending) return;
        pendingRpcs.delete(message.id);
        if (message.ok) pending.resolve(typeof message.json === 'string' ? message.json : 'null');
        else pending.reject(new Error(String(message.message || 'QUERY_RPC_ERROR: primitive call failed')));
        return;
    }

    if (message.type !== 'exec' || running || settled) return;
    running = true;

    maxOutputBytes = positiveInt(message.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1);

    if (typeof message.code !== 'string' || !message.code.trim()) {
        settleError('QUERY_INVALID_ARGUMENTS', 'code must be a non-empty string');
        return;
    }

    let runner;
    try {
        runner = buildVmRunner();
    } catch (error) {
        settleError('QUERY_BOOTSTRAP_ERROR', formatError(error));
        return;
    }

    let fn;
    try {
        fn = runner.compile(message.code);
    } catch (error) {
        settleError('QUERY_SYNTAX_ERROR', formatError(error));
        return;
    }

    try {
        const jsonText = await runner.run(fn);
        if (settled) return;
        const soft = softTruncateJson(jsonText, maxOutputBytes);
        settleOk(soft.json);
    } catch (error) {
        const rawMessage = formatError(error);
        const codeMatch = /(?:^|\n)(?:Error:\s*)*(QUERY_[A-Z0-9_]+):\s*/.exec(rawMessage);
        if (codeMatch) settleError(codeMatch[1], rawMessage);
        else if (/Converting circular structure to JSON|Do not know how to serialize|Invalid string length/i.test(rawMessage)) {
            settleError('QUERY_SERIALIZE_ERROR', rawMessage);
        } else {
            settleError('QUERY_EXEC_ERROR', rawMessage);
        }
    }
}

function main() {
    process.on('disconnect', () => process.exit(0));
    process.on('unhandledRejection', (reason) => {
        const message = reason && reason.message ? reason.message : String(reason);
        if (!settled) settleError('QUERY_UNHANDLED_REJECTION', 'Unhandled promise rejection in query: ' + message);
        // After a successful result, orphan rejections are swallowed inside
        // this short-lived process only; they must never reach the host.
    });
    process.on('uncaughtException', (error) => {
        if (!settled) settleError('QUERY_UNCAUGHT_EXCEPTION', formatError(error));
        else process.exit(1);
    });
    process.on('message', (message) => {
        Promise.resolve(handleMessage(message)).catch((error) => {
            if (!settled) settleError('QUERY_WORKER_ERROR', formatError(error));
        });
    });
}

if (require.main === module) main();

module.exports = {
    softTruncateJson,
    truncateUtf8,
    formatError,
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_PRIMITIVE_STEPS,
    ERROR_BYTES,
    TRUNCATION_HINT,
};
