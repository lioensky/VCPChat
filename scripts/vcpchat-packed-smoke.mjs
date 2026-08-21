#!/usr/bin/env node

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createOperationId, readReadyRecord, removeReadyRecord } = require('../modules/bootstrap/launch-protocol');
const { resolveCommandInvocation } = require('../modules/bootstrap/command-invocation');
const { verifyPackagedRuntime } = require('../modules/bootstrap/packed-runtime');

function findPackagedExecutable(distRoot, platform = process.platform) {
    const entries = fs.existsSync(distRoot)
        ? fs.readdirSync(distRoot, { recursive: true, withFileTypes: true })
        : [];
    const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
    if (platform === 'darwin') return files.find(file => {
        const portable = file.replaceAll('\\', '/');
        return /\.app\/Contents\/MacOS\//.test(portable) && !/\/Frameworks\//.test(portable);
    }) || null;
    if (platform === 'win32') return files.find(file => /win[^/\\]*-unpacked[/\\].+\.exe$/i.test(file)) || null;
    return files.find(file => /linux-unpacked[/\\]/.test(file) && !path.extname(file)) || null;
}

async function waitForReady({ stateRoot, operationId, child, timeoutMs = 60_000 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const { record } = readReadyRecord({ stateRoot, operationId });
        if (record?.operationId === operationId && record.pid === child.pid && record.checks?.renderer === 'ready') return record;
        if (child.exitCode !== null) throw new Error(`Packaged app exited before ready (${child.exitCode}).`);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Packaged app ready timeout.');
}

function terminateProcessTree(child) {
    if (!child || child.exitCode !== null) return;
    try {
        if (process.platform === 'win32' && child.pid) {
            spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else if (child.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else child.kill('SIGKILL');
    } catch { /* best effort */ }
}

export async function run(argv = process.argv.slice(2), io = process) {
    const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const shouldBuild = argv.includes('--build');
    const distIndex = argv.indexOf('--dist');
    const distRoot = path.resolve(distIndex >= 0 ? argv[distIndex + 1] : path.join(projectRoot, 'dist'));
    if (shouldBuild) {
        const invocation = resolveCommandInvocation(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'pack']);
        const result = spawnSync(invocation.command, invocation.args, {
            cwd: projectRoot,
            stdio: 'inherit',
            windowsHide: true,
        });
        if (result.status !== 0) return result.status || 1;
    }
    const executable = findPackagedExecutable(distRoot);
    if (!executable) throw new Error(`未在 ${distRoot} 找到 unpacked application executable。`);
    const resourcesDirectory = process.platform === 'darwin'
        ? path.resolve(executable, '..', '..', 'Resources')
        : path.join(path.dirname(executable), 'resources');
    const manifestPath = path.join(resourcesDirectory, 'vcp-runtime-closure.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const closure = verifyPackagedRuntime({ resourcesDirectory, manifest });
    if (!closure.ok) throw new Error(`Packaged runtime closure failed: ${JSON.stringify(closure.failures.slice(0, 10))}`);

    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-packed-smoke-'));
    const stateRoot = path.join(isolatedRoot, 'state');
    const appDataRoot = path.join(isolatedRoot, 'app-data');
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    const operationId = createOperationId('packed');
    const child = spawn(executable, ['--allow-multiple-instances'], {
        cwd: path.dirname(executable),
        env: {
            ...process.env,
            PATH: process.platform === 'win32' ? process.env.SystemRoot || 'C:\\Windows' : '/usr/bin:/bin',
            VCPCHAT_STATE_DIR: stateRoot,
            VCPCHAT_APP_DATA_DIR: appDataRoot,
            VCPCHAT_BOOTSTRAP_OPERATION_ID: operationId,
            VCPCHAT_BUILD_ID: manifest.buildId || '',
        },
        stdio: 'ignore',
        windowsHide: true,
        detached: process.platform !== 'win32',
    });
    try {
        await waitForReady({ stateRoot, operationId, child });
        io.stdout.write(`Packaged runtime smoke passed: ${executable}\n`);
        return 0;
    } finally {
        terminateProcessTree(child);
        removeReadyRecord({ stateRoot, operationId });
        fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    run().then(code => { process.exitCode = code; }).catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

export { findPackagedExecutable, waitForReady };
