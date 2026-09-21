'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PLUGIN_DIR = __dirname;
const DEFAULT_TIMEOUT_MS = 180000;
const STARTUP_TIMEOUT_MS = 15000;
const MAX_STDERR_CHARS = 32000;

let runtime = {
    logger: console,
    config: {},
};

let worker = null;
let workerGeneration = 0;
let stdoutBuffer = '';
let stderrBuffer = '';
let startPromise = null;
let requestQueue = Promise.resolve();
let disposed = false;
const pending = new Map();

function parseEnvFile(filePath) {
    const result = {};
    if (!fs.existsSync(filePath)) return result;
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const separator = line.indexOf('=');
        if (separator < 1) continue;
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        result[key] = value;
    }
    return result;
}

function buildWorkerEnv() {
    const fileConfig = parseEnvFile(path.join(PLUGIN_DIR, 'config.env'));
    const injectedConfig = Object.fromEntries(
        Object.entries(runtime.config || {}).map(([key, value]) => [key, String(value)])
    );
    return {
        ...process.env,
        ...fileConfig,
        ...injectedConfig,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
    };
}

function workerCommand() {
    const configured = String(
        runtime.config?.SCREENPILOT_PYTHON
        || process.env.SCREENPILOT_PYTHON
        || 'python'
    ).trim();
    return configured || 'python';
}

function appendStderr(text) {
    stderrBuffer = `${stderrBuffer}${text}`;
    if (stderrBuffer.length > MAX_STDERR_CHARS) {
        stderrBuffer = stderrBuffer.slice(-MAX_STDERR_CHARS);
    }
    if (runtime.config?.DebugMode === true || process.env.DebugMode === 'true') {
        runtime.logger.error(`[ScreenPilot worker] ${String(text).trimEnd()}`);
    }
}

function rejectPending(error, generation = null) {
    for (const [id, entry] of pending) {
        if (generation !== null && entry.generation !== generation) continue;
        clearTimeout(entry.timeout);
        pending.delete(id);
        entry.reject(error);
    }
}

function handleWorkerLine(line, generation) {
    if (!line.trim()) return;

    let message;
    try {
        message = JSON.parse(line);
    } catch (error) {
        appendStderr(`\n[protocol] Invalid JSONL response: ${line.slice(0, 500)}\n`);
        return;
    }

    if (message.event === 'ready') {
        const readyEntry = pending.get(`ready:${generation}`);
        if (readyEntry) {
            clearTimeout(readyEntry.timeout);
            pending.delete(`ready:${generation}`);
            readyEntry.resolve(message);
        }
        return;
    }

    const id = message.id;
    if (!id || !pending.has(id)) {
        appendStderr(`\n[protocol] Orphan response: ${line.slice(0, 500)}\n`);
        return;
    }

    const entry = pending.get(id);
    pending.delete(id);
    clearTimeout(entry.timeout);

    if (message.status === 'error') {
        const error = new Error(
            typeof message.error === 'string'
                ? message.error
                : message.error?.message || 'ScreenPilot worker returned an error.'
        );
        error.code = message.error?.code || 'SCREENPILOT_WORKER_ERROR';
        error.details = message.error?.details;
        entry.reject(error);
        return;
    }

    entry.resolve(message.result);
}

function attachWorker(child, generation) {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
        if (generation !== workerGeneration) return;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) handleWorkerLine(line, generation);
    });

    child.stderr.on('data', appendStderr);

    child.on('error', (error) => {
        if (generation !== workerGeneration) return;
        rejectPending(
            new Error(`ScreenPilot Python Worker 启动或运行失败：${error.message}`),
            generation
        );
    });

    child.on('exit', (code, signal) => {
        if (generation !== workerGeneration) return;
        const diagnostics = stderrBuffer.trim();
        const suffix = diagnostics ? `\nWorker stderr:\n${diagnostics.slice(-4000)}` : '';
        rejectPending(
            new Error(
                `ScreenPilot Python Worker 已退出（code=${code}, signal=${signal || 'none'}）。${suffix}`
            ),
            generation
        );
        worker = null;
        startPromise = null;
        stdoutBuffer = '';
    });
}

function waitForReady(generation) {
    return new Promise((resolve, reject) => {
        const key = `ready:${generation}`;
        const timeout = setTimeout(() => {
            pending.delete(key);
            reject(new Error(`ScreenPilot Python Worker 在 ${STARTUP_TIMEOUT_MS}ms 内未就绪。`));
        }, STARTUP_TIMEOUT_MS);
        pending.set(key, { resolve, reject, timeout, generation });
    });
}

async function ensureWorker() {
    if (disposed) {
        throw new Error('ScreenPilot 服务已经关闭。');
    }
    if (worker && !worker.killed && worker.exitCode === null) {
        return worker;
    }
    if (startPromise) return startPromise;

    startPromise = (async () => {
        workerGeneration += 1;
        const generation = workerGeneration;
        stdoutBuffer = '';
        stderrBuffer = '';

        // 必须先注册 ready barrier，再启动 Worker。否则极快启动的 Python
        // 进程可能在 pending 中尚无 ready 条目时就输出事件，造成假超时。
        const readyPromise = waitForReady(generation);
        const child = spawn(
            workerCommand(),
            ['-u', 'screen_pilot.py', '--worker'],
            {
                cwd: PLUGIN_DIR,
                env: buildWorkerEnv(),
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            }
        );
        worker = child;
        attachWorker(child, generation);
        await readyPromise;

        if (worker !== child || child.exitCode !== null) {
            throw new Error('ScreenPilot Python Worker 在初始化期间被替换或退出。');
        }
        return child;
    })();

    try {
        return await startPromise;
    } catch (error) {
        stopWorker('startup-failed');
        throw error;
    } finally {
        startPromise = null;
    }
}

function stopWorker(reason = 'cleanup') {
    const child = worker;
    worker = null;
    startPromise = null;
    stdoutBuffer = '';

    rejectPending(
        new Error(`ScreenPilot Python Worker 已停止：${reason}`),
        workerGeneration
    );

    if (!child || child.exitCode !== null || child.killed) return;
    try {
        child.stdin.end();
    } catch (_) {
        // Ignore a broken stdin during shutdown.
    }
    try {
        child.kill();
    } catch (_) {
        // Ignore an already exited process.
    }
}

function normalizeTimeout(args) {
    const requested = Number(args?.timeoutMs ?? args?.timeout);
    if (!Number.isFinite(requested)) return DEFAULT_TIMEOUT_MS;
    return Math.max(1000, Math.min(requested, 600000));
}

async function sendRequest(args, executionContext = {}) {
    const child = await ensureWorker();
    const generation = workerGeneration;
    const id = crypto.randomUUID();
    const timeoutMs = normalizeTimeout(args);

    const responsePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pending.delete(id);
            const error = new Error(
                `ScreenPilot 指令 ${args?.command || '<unknown>'} 在 ${timeoutMs}ms 内未完成。`
            );
            error.code = 'SCREENPILOT_TIMEOUT';
            reject(error);
            stopWorker('request-timeout');
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout, generation });
    });

    const envelope = {
        id,
        request: args,
        context: {
            requestId: executionContext?.requestId || null,
        },
    };

    try {
        child.stdin.write(`${JSON.stringify(envelope)}\n`, 'utf8');
    } catch (error) {
        const entry = pending.get(id);
        if (entry) {
            clearTimeout(entry.timeout);
            pending.delete(id);
        }
        stopWorker('stdin-write-failed');
        throw new Error(`无法向 ScreenPilot Python Worker 发送请求：${error.message}`);
    }

    return responsePromise;
}

function enqueue(operation) {
    const run = requestQueue.then(operation, operation);
    requestQueue = run.catch(() => undefined);
    return run;
}

const READ_ONLY_COMMANDS = new Set([
    'screencapture', 'capture', 'screenshot',
    'inspectui', 'inspect', 'uiinspect',
    'querywindows', 'query', 'getwindows',
    'waitforelement', 'waitforui', 'waitfortext', 'waitfordisappear',
]);

async function processToolCall(args = {}, executionContext = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('[ScreenPilot] 工具参数必须是对象。');
    }
    if (typeof args.command !== 'string' || !args.command.trim()) {
        throw new Error('[ScreenPilot] 缺少 command 参数。');
    }

    return enqueue(async () => {
        let restarted = false;
        try {
            return await sendRequest(args, executionContext);
        } catch (error) {
            const normalizedCommand = String(args.command)
                .toLowerCase()
                .replace(/[_-]/g, '');
            const retryable = (
                error.code !== 'SCREENPILOT_TIMEOUT'
                && READ_ONLY_COMMANDS.has(normalizedCommand)
            );
            if (!retryable) throw error;

            restarted = true;
            stopWorker('recoverable-readonly-request-failure');
            return sendRequest(args, executionContext);
        } finally {
            if (restarted) {
                runtime.logger.warn('[ScreenPilot] Python Worker 已在只读请求失败后自动重启。');
            }
        }
    });
}

async function initialize(options = {}) {
    runtime = {
        logger: options.logger || console,
        config: options.config || {},
    };
    disposed = false;

    // 延迟启动：避免仅启动服务器但从未使用 ScreenPilot 时加载 OCR/Win32 依赖。
    // 首次工具调用会建立常驻 Worker。
}

function cleanup() {
    disposed = true;
    stopWorker('service-cleanup');
}

function getRuntimeStatus() {
    return {
        workerRunning: Boolean(worker && !worker.killed && worker.exitCode === null),
        workerPid: worker?.pid || null,
        workerGeneration,
        pendingRequests: pending.size,
        stderrTail: stderrBuffer.slice(-2000),
    };
}

const onProcessExit = () => cleanup();
process.once('exit', onProcessExit);

module.exports = {
    initialize,
    processToolCall,
    cleanup,
    _test: {
        parseEnvFile,
        normalizeTimeout,
        getRuntimeStatus,
        stopWorker,
    },
};