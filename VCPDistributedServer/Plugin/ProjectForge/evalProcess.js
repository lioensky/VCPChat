'use strict';
// Trusted project execution, NOT a security sandbox. This module never invokes a shell;
// bashRunner.js is the single explicit shell entry point.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const active = new Set();
const OUTPUT_LIMIT = 64 * 1024;
const RESULT_LIMIT = 1024 * 1024;
const ABORT_SETTLE_MS = 5000;

// Historical EvalSymbol capture: keep the first `limit` bytes.
function capture(limit) {
    const decoder = new StringDecoder('utf8');
    let bytes = 0;
    let text = '';
    let truncated = false;
    return {
        push(chunk) {
            const available = Math.max(0, limit - bytes);
            bytes += chunk.length;
            if (chunk.length > available) truncated = true;
            if (available) text += decoder.write(chunk.subarray(0, available));
        },
        finish() {
            text += decoder.end();
            return { text, bytes, truncated };
        },
    };
}

/** UTF-8 safe tail: never split a multi-byte code point at the kept boundary. */
function decodeTail(buffer, maxBytes) {
    let offset = Math.max(0, buffer.length - maxBytes);
    while (offset < buffer.length && (buffer[offset] & 0xC0) === 0x80) offset += 1;
    return buffer.subarray(offset).toString('utf8');
}

/** Bash-only tail collector: complete spill on overflow, with no spill size cap. */
class TailCapture {
    constructor(limit, { spill = false, name = 'output' } = {}) {
        this.limit = limit;
        this.spill = spill;
        this.name = name;
        this.total = 0;
        this.chunks = [];
        this.tailBytes = 0;
        this.pending = [];
        this.fd = null;
        this.spillPath = null;
        this.spillStarted = false;
        this.spillStatus = spill ? 'not-needed' : 'disabled';
    }

    push(chunk) {
        this.total += chunk.length;
        if (this.spill && !this.spillStarted) {
            this.pending.push(chunk);
            if (this.total > this.limit) {
                this.spillStarted = true;
                this.#openSpill();
            }
        } else if (this.fd !== null) {
            this.#writeSpill(chunk);
        }
        if (chunk.length >= this.limit) {
            this.chunks = [chunk.subarray(chunk.length - this.limit)];
            this.tailBytes = this.limit;
            return;
        }
        this.chunks.push(chunk);
        this.tailBytes += chunk.length;
        while (this.chunks.length > 1 && this.tailBytes - this.chunks[0].length >= this.limit) {
            this.tailBytes -= this.chunks.shift().length;
        }
    }

    #openSpill() {
        const pending = this.pending;
        this.pending = [];
        try {
            const file = path.join(os.tmpdir(),
                `pf-${this.name}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.log`);
            this.fd = fs.openSync(file, 'wx', 0o600);
            this.spillPath = file;
            this.spillStatus = 'complete';
            for (const chunk of pending) this.#writeSpill(chunk);
        } catch (_error) {
            this.spillStatus = 'lost';
            this.#closeSpill();
        }
    }

    #writeSpill(chunk) {
        if (this.fd === null || this.spillStatus !== 'complete') return;
        try {
            fs.writeSync(this.fd, chunk);
        } catch (_error) {
            this.spillStatus = 'lost';
            this.#closeSpill();
        }
    }

    #closeSpill() {
        if (this.fd !== null) {
            try {
                fs.closeSync(this.fd);
            } catch (_error) {
                if (this.spillStatus === 'complete') this.spillStatus = 'lost';
            }
            this.fd = null;
        }
    }

    finish() {
        this.pending = [];
        this.#closeSpill();
        if (this.spill && this.spillPath && this.spillStatus === 'complete') {
            try {
                if (fs.statSync(this.spillPath).size !== this.total) this.spillStatus = 'incomplete';
            } catch (_error) {
                this.spillStatus = 'lost';
            }
        }
        return {
            text: decodeTail(Buffer.concat(this.chunks), this.limit),
            bytes: this.total,
            maxBytes: this.limit,
            truncated: this.total > this.limit,
            spillPath: this.spillStatus === 'complete' ? this.spillPath : null,
            spillStatus: this.spillStatus,
        };
    }
}

function msysShellEnv() {
    const env = { ...process.env };
    delete env.BASH_ENV;
    delete env.ENV;
    return env;
}

/**
 * Git Bash children are MSYS processes whose Windows parent chain is not reliable for
 * `taskkill /T` (measured 2026-11-20: the background loop survived /T and kept writing).
 * Map the spawned bash's Windows PID to its MSYS PGID via `ps -l`, then signal the group.
 */
function msysPgidOf(shell, winpid) {
    try {
        const result = spawnSync(shell, ['--noprofile', '--norc', '-c', 'ps -l'], {
            windowsHide: true, shell: false, timeout: 3000, encoding: 'utf8', env: msysShellEnv(),
        });
        if (result.status !== 0 || !result.stdout) return null;
        for (const line of result.stdout.split(/\r?\n/u)) {
            const cols = line.trim().split(/\s+/u);
            if (cols.length < 5) continue;
            if (!/^\d+$/u.test(cols[3]) || Number(cols[3]) !== winpid) continue;
            const pgid = Number(cols[2]);
            return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null;
        }
    } catch { /* fall through to taskkill */ }
    return null;
}

function killMsysGroup(shell, winpid) {
    if (!shell || process.platform !== 'win32') return false;
    const pgid = msysPgidOf(shell, winpid);
    if (!pgid) return false;
    try {
        const result = spawnSync(shell, ['--noprofile', '--norc', '-c', `kill -9 -${pgid}`], {
            windowsHide: true, shell: false, timeout: 3000, stdio: 'ignore', env: msysShellEnv(),
        });
        return result.status === 0;
    } catch {
        return false;
    }
}

/** Whole-tree termination. `taskkill /T` alone is insufficient for Git Bash/MSYS jobs. */
function killTree(child, { shell } = {}) {
    if (!child?.pid) return Promise.resolve({ ok: false, method: 'none' });
    if (process.platform !== 'win32') {
        try {
            process.kill(-child.pid, 'SIGKILL');
            return Promise.resolve({ ok: true, method: 'process-group' });
        } catch {
            try {
                child.kill('SIGKILL');
                return Promise.resolve({ ok: true, method: 'process' });
            } catch {
                return Promise.resolve({ ok: false, method: 'none' });
            }
        }
    }
    const msysKilled = killMsysGroup(shell, child.pid);
    const info = { ok: msysKilled, method: msysKilled ? 'msys-process-group' : 'taskkill' };
    let resolveTaskkill;
    const taskkillDone = new Promise(resolve => { resolveTaskkill = resolve; });
    const killer = spawn('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], {
        windowsHide: true, shell: false, stdio: 'ignore',
    });
    let settled = false;
    const finish = code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The fallback also covers a failed taskkill invocation.
        let fallback = false;
        try { fallback = child.kill('SIGKILL'); } catch { /* already exited */ }
        const taskkillOk = code === 0 || fallback;
        info.ok = info.ok || taskkillOk;
        if (msysKilled && taskkillOk) info.method = 'msys-process-group+taskkill';
        resolveTaskkill(info);
    };
    const timer = setTimeout(() => finish(-1), 3000);
    killer.once('error', () => finish(-1));
    killer.once('close', code => finish(code));
    // MSYS group kill is already proven synchronously; do not let taskkill's close event
    // race the child's `close` event and turn a real killTree receipt into null.
    return msysKilled ? Promise.resolve(info) : taskkillDone;
}

/** Drop inherited stdio so an escaped descendant cannot pin the tool call open. */
function releasePipes(child) {
    for (const stream of [child?.stdout, child?.stderr, child?.stdio?.[3]]) {
        try { stream?.destroy(); } catch { /* peer already gone */ }
    }
}

function waitFor(promise, ms) {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), ms);
        promise.then(
            () => { clearTimeout(timer); resolve(true); },
            () => { clearTimeout(timer); resolve(true); },
        );
    });
}

/**
 * fd 3 is an optional JSON result channel (Node workers).
 * Other adapters can use stdout for their native machine protocol.
 * timeoutMs covers spawn, loading, execution and output transfer.
 * New options are opt-in; defaults reproduce the historical head capture and stdin pipe
 * behaviour used by EvalSymbol.
 */
function runProcess(executable, argv, {
    cwd, env = process.env, input, timeoutMs = 5000, resultChannel = false,
    maxBytes = OUTPUT_LIMIT, tail = false, spill = false, spillName = 'output',
    stdin = 'pipe', signal, treeKillShell,
} = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 110000) {
        throw new Error('timeoutMs must be an integer in 1..110000');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new Error('maxBytes must be a positive integer');
    }
    if (stdin !== 'pipe' && stdin !== 'ignore') {
        throw new Error("stdin must be 'pipe' or 'ignore'");
    }
    if (signal !== undefined
        && (typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function')) {
        throw new Error('signal must be an AbortSignal');
    }
    return new Promise(resolve => {
        const start = performance.now();
        const out = tail ? new TailCapture(maxBytes, { spill, name: `${spillName}-stdout` }) : capture(maxBytes);
        const err = tail ? new TailCapture(maxBytes, { spill, name: `${spillName}-stderr` }) : capture(maxBytes);
        const result = capture(RESULT_LIMIT);
        let child = null;
        let timer = null;
        let settled = false;
        let termination = null;
        let quiescence = 'exited';
        let spawnError = null;
        let killing = null;
        let treeKill = null;
        let exitCode = null;
        let termSignal = null;
        let aborted = false;
        let abortHandler = null;
        let resolveClosed;
        const closed = new Promise(innerResolve => { resolveClosed = innerResolve; });
        const removeAbortListener = () => {
            if (signal && abortHandler) {
                signal.removeEventListener('abort', abortHandler);
                abortHandler = null;
            }
        };
        const finish = (code, sig) => {
            if (settled) return;
            settled = true;
            if (Number.isInteger(code)) exitCode = code;
            if (sig) termSignal = sig;
            clearTimeout(timer);
            removeAbortListener();
            if (child) active.delete(record);
            if (spawnError) quiescence = 'not-started';
            if (termination && quiescence === 'exited') quiescence = 'terminated';
            const stdout = out.finish();
            const stderr = err.finish();
            const wire = result.finish();
            resolve({
                status: termination || (spawnError ? 'environment_error' : 'exited'),
                exitCode,
                signal: termSignal,
                durationMs: Math.round(performance.now() - start),
                stdout,
                stderr,
                result: wire,
                timedOut: termination === 'timeout',
                aborted,
                cancelled: termination === 'cancelled' && !aborted,
                quiescence,
                treeKill,
                ...(spawnError ? { error: { message: spawnError.message, code: spawnError.code } } : {}),
            });
            resolveClosed();
        };
        const stop = reason => {
            if (settled) return Promise.resolve();
            if (killing) return killing;
            termination = reason;
            killing = (async () => {
                treeKill = await killTree(child, { shell: treeKillShell });
                const confirmed = await waitFor(closed, ABORT_SETTLE_MS);
                if (!confirmed) {
                    // "kill was sent" is not the same as "the tree is gone": never fake a clean stop.
                    quiescence = 'unproven';
                    releasePipes(child);
                    finish(null, 'SIGKILL');
                }
            })();
            return killing;
        };
        const record = { stop: () => stop('cancelled') };
        try {
            child = spawn(executable, argv, {
                cwd,
                env,
                shell: false,
                windowsHide: true,
                detached: process.platform !== 'win32',
                stdio: [stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe', ...(resultChannel ? ['pipe'] : [])],
            });
            active.add(record);
            timer = setTimeout(() => { void stop('timeout'); }, timeoutMs);
            child.stdout.on('data', chunk => out.push(chunk));
            child.stderr.on('data', chunk => err.push(chunk));
            if (resultChannel && child.stdio[3]) {
                let wireBytes = 0;
                child.stdio[3].on('data', chunk => {
                    result.push(chunk);
                    wireBytes += chunk.length;
                    if (wireBytes > RESULT_LIMIT) void stop('result_limit');
                });
            }
            child.once('error', error => { spawnError = error; finish(null, null); });
            child.once('close', (code, sig) => finish(code, sig));
            if (stdin === 'pipe') {
                child.stdin.on('error', () => { /* EPIPE: worker exited before reading */ });
                child.stdin.end(input === undefined ? undefined : input);
            }
            if (signal) {
                if (signal.aborted) {
                    aborted = true;
                    void stop('cancelled');
                } else {
                    abortHandler = () => { aborted = true; void stop('cancelled'); };
                    signal.addEventListener('abort', abortHandler, { once: true });
                }
            }
        } catch (error) {
            spawnError = error;
            finish(null, null);
        }
    });
}

async function cleanup() {
    await Promise.all([...active].map(record => record.stop()));
}

module.exports = { runProcess, cleanup, OUTPUT_LIMIT };