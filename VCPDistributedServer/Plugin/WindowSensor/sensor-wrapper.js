#!/usr/bin/env node
// WindowSensor PowerShell bridge.
// This wrapper keeps the PowerShell collector on a short leash so a stalled
// Windows desktop/DWM/user32 call cannot occupy the static plugin worker for
// the full PluginManager timeout window.

const { spawn } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'sensor.ps1');
const POWERSHELL_TIMEOUT_MS = parseInt(process.env.WINDOW_SENSOR_PS_TIMEOUT_MS || '5000', 10);
const MAX_STDOUT_BYTES = parseInt(process.env.WINDOW_SENSOR_MAX_STDOUT_BYTES || String(512 * 1024), 10);
const MAX_STDERR_BYTES = parseInt(process.env.WINDOW_SENSOR_MAX_STDERR_BYTES || String(64 * 1024), 10);

let stdoutBuffer = Buffer.alloc(0);
let stderrBuffer = Buffer.alloc(0);
let settled = false;

function makeFallbackJson(reason) {
    const content = `[WindowSensor 暂不可用：${reason}。可能是系统刚从睡眠中恢复，窗口子系统仍在初始化。]`;
    return JSON.stringify({
        vcp_dynamic_fold: true,
        fold_name: 'WindowSense_Unavailable',
        plugin_description: '窗口感知暂不可用。该降级结果由 sensor-wrapper.js 生成，用于避免 PowerShell 窗口扫描卡死拖垮插件调度。',
        fold_blocks: [
            {
                threshold: 0.7,
                content
            },
            {
                threshold: 0.4,
                content: '[窗口简报暂不可用]'
            },
            {
                threshold: 0.0,
                content: '[WindowSensor 降级保护已启用]'
            }
        ]
    });
}

function writeStdoutAndExit(payload, code = 0) {
    if (settled) return;
    settled = true;
    process.stdout.write(`${payload}\n`, () => process.exit(code));
}

function killProcessTree(child, reason) {
    if (!child || !child.pid || child.killed) return;

    if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
            windowsHide: true,
            stdio: 'ignore'
        });
        killer.on('error', () => {});
    } else {
        try {
            process.kill(-child.pid, 'SIGKILL');
        } catch (_) {
            try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
        }
    }

    if (!settled) {
        writeStdoutAndExit(makeFallbackJson(reason), 0);
    }
}

const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    SCRIPT_PATH
], {
    cwd: __dirname,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
});

const timeoutId = setTimeout(() => {
    killProcessTree(child, `PowerShell collector timed out after ${POWERSHELL_TIMEOUT_MS}ms`);
}, POWERSHELL_TIMEOUT_MS);

child.stdout.on('data', (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    if (stdoutBuffer.length > MAX_STDOUT_BYTES) {
        clearTimeout(timeoutId);
        killProcessTree(child, `PowerShell collector stdout exceeded ${MAX_STDOUT_BYTES} bytes`);
    }
});

child.stderr.on('data', (chunk) => {
    stderrBuffer = Buffer.concat([stderrBuffer, chunk]);
    if (stderrBuffer.length > MAX_STDERR_BYTES) {
        clearTimeout(timeoutId);
        killProcessTree(child, `PowerShell collector stderr exceeded ${MAX_STDERR_BYTES} bytes`);
    }
});

child.on('error', (err) => {
    clearTimeout(timeoutId);
    writeStdoutAndExit(makeFallbackJson(`failed to start PowerShell: ${err.message}`), 0);
});

child.on('exit', (code, signal) => {
    clearTimeout(timeoutId);
    if (settled) return;

    const stdoutText = stdoutBuffer.toString('utf8').trim();
    if (code === 0 && stdoutText) {
        writeStdoutAndExit(stdoutText, 0);
        return;
    }

    const stderrText = stderrBuffer.toString('utf8').trim();
    const reason = signal
        ? `PowerShell collector exited by signal ${signal}`
        : `PowerShell collector exited with code ${code}${stderrText ? `: ${stderrText.slice(0, 500)}` : ''}`;

    writeStdoutAndExit(makeFallbackJson(reason), 0);
});