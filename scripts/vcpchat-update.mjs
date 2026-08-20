#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveProjectStateRoot, createOperationId, readReadyRecord, removeReadyRecord } = require('../modules/bootstrap/launch-protocol');
const { resolveContainedPath } = require('../modules/bootstrap/runtime-closure');
const { terminateProcess } = require('../modules/bootstrap/process-runner');
const { managedSpawnOptions } = require('../modules/bootstrap/platform-process');
const { promoteVersionWithHealthCheck, rollbackVersion, acquireUpdateLock } = require('../modules/bootstrap/update-manager');
const { downloadSignedUpdate } = require('../modules/bootstrap/update-downloader');

function parseArguments(argv) {
    const options = { apply: false, yes: false, source: null, manifest: null, manifestUrl: null, publicKey: null, rollback: false, json: false, projectRoot: null };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') options.apply = true;
        else if (arg === '--yes') options.yes = true;
        else if (arg === '--rollback') options.rollback = true;
        else if (arg === '--json') options.json = true;
        else if (arg === '--source') options.source = argv[++index] || null;
        else if (arg === '--manifest') options.manifest = argv[++index] || null;
        else if (arg === '--manifest-url') options.manifestUrl = argv[++index] || null;
        else if (arg === '--public-key') options.publicKey = argv[++index] || null;
        else if (arg === '--project-root') options.projectRoot = argv[++index] || null;
        else throw new Error(`未知 update 参数：${arg}`);
    }
    return options;
}

async function verifyCandidateReady({ current, manifest, stateRoot, timeoutMs = 60_000 }) {
    const relativeExecutable = manifest.launch?.executable;
    if (!relativeExecutable || path.isAbsolute(relativeExecutable) || relativeExecutable.split(/[\\/]/).includes('..')) {
        return { ok: false, code: 'E_UPDATE_MANIFEST_INVALID', message: '更新清单缺少安全的 launch.executable。' };
    }
    let executable;
    try { executable = resolveContainedPath(current.directory, relativeExecutable); } catch (error) {
        return { ok: false, code: 'E_UPDATE_MANIFEST_INVALID', message: error.message };
    }
    if (!fs.existsSync(executable)) return { ok: false, code: 'E_UPDATE_INTEGRITY_FAILED', message: '候选版本 executable 不存在。' };
    const operationId = createOperationId('update-health');
    const child = spawn(executable, manifest.launch.args || [], {
        cwd: path.dirname(executable),
        env: {
            ...process.env,
            VCPCHAT_STATE_DIR: stateRoot,
            VCPCHAT_BOOTSTRAP_OPERATION_ID: operationId,
            VCPCHAT_BUILD_ID: manifest.buildId || '',
        },
        stdio: 'ignore',
        ...managedSpawnOptions(),
    });
    let spawnError = null;
    child.once('error', error => { spawnError = error; });
    const deadline = Date.now() + timeoutMs;
    try {
        while (Date.now() < deadline) {
            const { record } = readReadyRecord({ stateRoot, operationId });
            if (record?.operationId === operationId && record.pid === child.pid && record.checks?.renderer === 'ready') {
                return { ok: true, record };
            }
            if (spawnError) return { ok: false, code: 'E_ELECTRON_SPAWN', message: spawnError.message };
            if (child.exitCode !== null) return { ok: false, code: 'E_ELECTRON_CRASH_BEFORE_READY', message: `候选版本在 ready 前退出（${child.exitCode}）。` };
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { ok: false, code: 'E_STARTUP_TIMEOUT', message: '候选版本未在时限内发布 ready。' };
    } finally {
        terminateProcess(child);
        await new Promise(resolve => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const timer = setTimeout(resolve, 2_000);
            timer.unref?.();
            child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        removeReadyRecord({ stateRoot, operationId });
    }
}

function liveReadyRecords(stateRoot) {
    const records = [];
    for (const name of fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot) : []) {
        if (!name.startsWith('ready-') || !name.endsWith('.json')) continue;
        try {
            const record = JSON.parse(fs.readFileSync(path.join(stateRoot, name), 'utf8'));
            const readyAt = Date.parse(record?.readyAt || '') || 0;
            const plausible = readyAt > 0 && Date.now() - readyAt < 7 * 24 * 60 * 60 * 1000;
            if (record?.pid > 0 && plausible) {
                try { process.kill(record.pid, 0); records.push(record); } catch { /* stale */ }
            }
        } catch { /* malformed records are ignored and cleaned by operation owner */ }
    }
    return records;
}

export async function run(argv = process.argv.slice(2), io = process) {
    const options = parseArguments(argv);
    const projectRoot = path.resolve(options.projectRoot || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const stateRoot = resolveProjectStateRoot({ projectRoot });
    if (!options.apply) {
        io.stdout.write('VCPChat 更新入口仅接受本地 staging source；默认只读，不会拉取或覆盖任何版本。\n');
        io.stdout.write(options.rollback ? '计划：验证并回滚到 current.previous。\n' : '计划：校验 manifest → staging → 验证 → 原子切换 → ready 失败时回滚。\n');
        return 0;
    }
    if (!options.yes) { io.stderr.write('执行更新需要 --apply --yes。\n'); return 2; }
    const lock = acquireUpdateLock(stateRoot);
    let completedDownloadRoot = null;
    try {
        const running = liveReadyRecords(stateRoot);
        if (running.length) {
            const error = new Error(`VCPChat 仍在运行（pid ${running[0].pid}）；请先正常退出主应用再更新。`);
            error.code = 'E_UPDATE_APP_RUNNING';
            throw error;
        }
        if (options.rollback) {
            const result = rollbackVersion({ stateRoot });
            io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        const publicKeyValue = options.publicKey || process.env.VCPCHAT_UPDATE_PUBLIC_KEY || null;
        const publicKey = publicKeyValue && fs.existsSync(publicKeyValue) ? fs.readFileSync(publicKeyValue, 'utf8') : publicKeyValue;
        let sourceRoot; let manifest;
        if (options.manifestUrl) {
            if (options.source || options.manifest) throw new Error('--manifest-url 不能与 --source/--manifest 同时使用。');
            const downloadRoot = path.join(stateRoot, 'downloads', createOperationId('download'));
            const downloaded = await downloadSignedUpdate({ manifestUrl: options.manifestUrl, publicKey, stagingRoot: downloadRoot });
            completedDownloadRoot = downloadRoot;
            ({ sourceRoot, manifest } = downloaded);
        } else {
            if (!options.source || !options.manifest) throw new Error('--source 和 --manifest 是必需的。');
            sourceRoot = path.resolve(options.source);
            manifest = JSON.parse(fs.readFileSync(path.resolve(options.manifest), 'utf8'));
        }
        const result = await promoteVersionWithHealthCheck({
            stateRoot,
            sourceRoot,
            manifest,
            publicKey,
            healthCheck: current => verifyCandidateReady({ current, manifest, stateRoot }),
        });
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
    } finally {
        if (completedDownloadRoot) fs.rmSync(completedDownloadRoot, { recursive: true, force: true });
        lock.release();
    }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    run().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
}

export { parseArguments, verifyCandidateReady, liveReadyRecords };
