/**
 * Runs the reproducible Electron/Windows release matrix serially.
 * This is an evidence collector, not a claim that other OS/configurations
 * were exercised; unsupported rows are recorded as skipped.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = path.join(root, 'artifacts', 'windows-matrix');
const evidencePath = path.join(evidenceDir, `${timestamp}.json`);
const timeoutMs = Number(process.env.VCPCHAT_MATRIX_TIMEOUT_MS || 12 * 60 * 1000);

const rows = [
    { id: 'ui-apps-next-classic', args: [path.join('scripts', 'test-electron-ui-apps-smoke.mjs')] },
    { id: 'settings-next', args: [path.join('scripts', 'test-settings-wa-electron.mjs')] },
    { id: 'next-tab-lifecycle', args: [path.join('scripts', 'test-next-ui-tab-lifecycle.mjs')] },
    { id: 'main-chat-default', args: [path.join('scripts', 'test-electron-main-chat-sequences.mjs')] },
    { id: 'auxiliary-crash-recovery', args: [path.join('scripts', 'test-electron-main-chat-sequences.mjs')], env: { VCPCHAT_AUX_CRASH_MATRIX: '1' } },
    { id: 'lifecycle-stress-60', args: [path.join('scripts', 'test-electron-lifecycle-stress.mjs')], env: { VCPCHAT_STRESS_CYCLES: '60' } },
];

function runRow(row) {
    return new Promise(resolve => {
        const startedAt = new Date().toISOString();
        const directScript = row.args?.[0]?.endsWith('.mjs');
        const executable = directScript ? process.execPath : process.execPath;
        const args = directScript ? row.args : [npmCli, ...row.args];
        const child = spawn(executable, args, {
            cwd: root,
            env: { ...process.env, ...(row.env || {}) },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let output = '';
        const append = chunk => { output = `${output}${chunk}`.slice(-60_000); };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
        }, timeoutMs);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({
                id: row.id,
                command: `${executable} ${args.join(' ')}`,
                env: row.env || {},
                startedAt,
                finishedAt: new Date().toISOString(),
                exitCode: code,
                signal: signal || null,
                status: code === 0 ? 'passed' : 'failed',
                output,
            });
        });
    });
}

const metadata = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    hostname: os.hostname(),
    matrixScope: process.platform === 'win32' ? 'windows-current-host' : 'non-windows-host',
    rows: [],
};

if (process.platform !== 'win32' && process.env.VCPCHAT_ALLOW_NON_WINDOWS_MATRIX !== '1') {
    metadata.rows.push({ id: 'windows-host-required', status: 'skipped', reason: 'Run on Windows or set VCPCHAT_ALLOW_NON_WINDOWS_MATRIX=1 for diagnostic execution.' });
} else {
    for (const row of rows) {
        console.log(`[windows-matrix] ${row.id}: ${row.args.join(' ')}`);
        const result = await runRow(row);
        metadata.rows.push(result);
        console.log(`[windows-matrix] ${row.id}: ${result.status} (exit=${result.exitCode})`);
        if (result.status !== 'passed') break;
    }
}

await fs.mkdir(evidenceDir, { recursive: true });
await fs.writeFile(evidencePath, JSON.stringify(metadata, null, 2), 'utf8');
console.log(`[windows-matrix] evidence: ${path.relative(root, evidencePath)}`);
if (metadata.rows.some(row => row.status === 'failed')) process.exitCode = 1;
