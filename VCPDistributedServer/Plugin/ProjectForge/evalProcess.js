'use strict';
// Trusted project execution, NOT a security sandbox. Never invoke a shell.
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const active = new Set();
const OUTPUT_LIMIT = 64 * 1024;
const RESULT_LIMIT = 1024 * 1024;

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

function killTree(child) {
    if (!child.pid) return Promise.resolve();
    return new Promise(resolve => {
        if (process.platform === 'win32') {
            const killer = spawn('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], {
                windowsHide: true, shell: false, stdio: 'ignore',
            });
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                // Fallback also covers a failed taskkill invocation.
                try { child.kill('SIGKILL'); } catch (_) { /* already exited */ }
                resolve();
            };
            const timer = setTimeout(finish, 3000);
            killer.once('error', finish);
            killer.once('close', finish);
        } else {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch (_) { try { child.kill('SIGKILL'); } catch (_) { /* exited */ } }
            resolve();
        }
    });
}

/**
 * fd 3 is an optional JSON result channel (Node workers).
 * Other adapters can use stdout for their native machine protocol.
 * timeoutMs covers spawn, loading, execution and output transfer.
 */
function runProcess(executable, argv, {
    cwd, env = process.env, input, timeoutMs = 5000, resultChannel = false,
} = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 110000) {
        throw new Error('timeoutMs must be an integer in 1..110000');
    }
    return new Promise(resolve => {
        const start = performance.now();
        const out = capture(OUTPUT_LIMIT);
        const err = capture(OUTPUT_LIMIT);
        const result = capture(RESULT_LIMIT);
        let child;
        let timer;
        let forcedTimer;
        let settled = false;
        let termination = null;
        let spawnError = null;
        let killing = null;
        const finish = (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(forcedTimer);
            if (child) active.delete(record);
            const stdout = out.finish();
            const stderr = err.finish();
            const wire = result.finish();
            resolve({
                status: termination || (spawnError ? 'environment_error' : 'exited'),
                exitCode: code, signal, durationMs: Math.round(performance.now() - start),
                stdout, stderr, result: wire,
                ...(spawnError ? { error: { message: spawnError.message, code: spawnError.code } } : {}),
            });
        };
        const stop = reason => {
            if (settled) return Promise.resolve();
            if (killing) return killing;
            termination = reason;
            killing = killTree(child);
            // A broken inherited pipe must not hold the tool call forever.
            forcedTimer = setTimeout(() => {
                child.stdout?.destroy();
                child.stderr?.destroy();
                child.stdio[3]?.destroy();
                finish(null, 'SIGKILL');
            }, 4000);
            return killing;
        };
        const record = { stop: () => stop('cancelled') };
        try {
            child = spawn(executable, argv, {
                cwd, env, shell: false, windowsHide: true,
                detached: process.platform !== 'win32',
                stdio: ['pipe', 'pipe', 'pipe', ...(resultChannel ? ['pipe'] : [])],
            });
            active.add(record);
            timer = setTimeout(() => { void stop('timeout'); }, timeoutMs);
            child.stdout.on('data', chunk => out.push(chunk));
            child.stderr.on('data', chunk => err.push(chunk));
            if (resultChannel) {
                let wireBytes = 0;
                child.stdio[3].on('data', chunk => {
                    result.push(chunk);
                    wireBytes += chunk.length;
                    if (wireBytes > RESULT_LIMIT) void stop('result_limit');
                });
            }
            child.once('error', error => { spawnError = error; });
            child.once('close', (code, signal) => finish(code, signal));
            child.stdin.on('error', () => { /* EPIPE: worker exited before reading */ });
            child.stdin.end(input === undefined ? undefined : input);
        } catch (error) {
            spawnError = error;
            finish(null, null);
        }
    });
}

async function cleanup() {
    await Promise.all([...active].map(record => record.stop()));
}

module.exports = { runProcess, cleanup, OUTPUT_LIMIT, RESULT_LIMIT };