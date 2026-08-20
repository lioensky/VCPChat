'use strict';

const { spawn } = require('child_process');

function terminateProcess(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
        if (process.platform === 'win32') {
            const { spawn } = require('child_process');
            spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else if (child.pid) {
            try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        } else {
            child.kill('SIGTERM');
        }
    } catch { /* best effort */ }
}

function runProcess({
    command,
    args = [],
    cwd,
    env = process.env,
    timeoutMs = 10 * 60 * 1000,
    signal,
    onOutput = () => {},
    spawnProcess = spawn,
} = {}) {
    if (!command) throw new TypeError('command is required');
    return new Promise(resolve => {
        const startedAt = Date.now();
        let settled = false;
        let timeout = null;
        let child;
        const finish = result => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            signal?.removeEventListener?.('abort', onAbort);
            resolve({ durationMs: Date.now() - startedAt, ...result });
        };
        const onAbort = () => {
            finish({ ok: false, cancelled: true, code: 'E_REPAIR_CANCELLED', exitCode: null, signal: null });
            terminateProcess(child);
        };
        if (signal?.aborted) return onAbort();
        try {
            child = spawnProcess(command, args, {
                cwd,
                env,
                windowsHide: true,
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
            });
        } catch (error) {
            finish({ ok: false, code: error.code || 'E_REPAIR_STAGE_FAILED', error, exitCode: null });
            return;
        }
        signal?.addEventListener?.('abort', onAbort, { once: true });
        child.stdout?.on('data', chunk => onOutput({ stream: 'stdout', text: String(chunk) }));
        child.stderr?.on('data', chunk => onOutput({ stream: 'stderr', text: String(chunk) }));
        child.once('error', error => finish({
            ok: false,
            code: error.code || 'E_REPAIR_STAGE_FAILED',
            error,
            exitCode: null,
        }));
        child.once('exit', (exitCode, processSignal) => finish({
            ok: exitCode === 0,
            code: exitCode === 0 ? null : 'E_REPAIR_STAGE_FAILED',
            exitCode,
            signal: processSignal,
        }));
        timeout = setTimeout(() => {
            finish({ ok: false, timedOut: true, code: 'E_REPAIR_TIMEOUT', exitCode: null, signal: null });
            terminateProcess(child);
        }, timeoutMs);
        timeout.unref?.();
    });
}

module.exports = { runProcess, terminateProcess };
