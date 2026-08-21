#!/usr/bin/env node

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const {
    acquireOperationLock,
    createOperationId,
    readReadyRecord,
    removeReadyRecord,
    resolveStateRoot,
} = require('../modules/bootstrap/launch-protocol');
const { collectDoctorReport, resolveElectronBinary } = require('../modules/bootstrap/environment-doctor');
const { writeDiagnosticReport } = require('../modules/bootstrap/diagnostic-report');
const { managedSpawnOptions, terminateManagedProcess } = require('../modules/bootstrap/platform-process');

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const ALREADY_RUNNING_EXIT_CODE = 42;

function parseArguments(argv) {
    const options = {
        projectRoot: null,
        readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
        handoff: false,
        deepDoctor: true,
        appArgs: [],
    };
    let passThrough = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (passThrough) {
            options.appArgs.push(argument);
        } else if (argument === '--') {
            passThrough = true;
        } else if (argument === '--project-root') {
            options.projectRoot = argv[++index] || null;
        } else if (argument === '--ready-timeout-ms') {
            options.readyTimeoutMs = Number(argv[++index]);
            if (!Number.isFinite(options.readyTimeoutMs) || options.readyTimeoutMs <= 0) {
                throw new Error('--ready-timeout-ms 必须是正数。');
            }
        } else if (argument === '--handoff') {
            options.handoff = true;
        } else if (argument === '--deep-doctor') {
            options.deepDoctor = true;
        } else if (argument === '--shallow-doctor') {
            options.deepDoctor = false;
        } else if (argument === '--repair') {
            throw new Error('M2 启动器不会自动修复环境；依赖修复将在 M3 实现。');
        } else {
            options.appArgs.push(argument);
        }
    }
    return options;
}

function resolveBuildId(projectRoot) {
    try {
        const { execFileSync } = require('node:child_process');
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim() || null;
    } catch {
        return null;
    }
}

function formatDoctorFailure(report) {
    return report.checks
        .filter(item => item.status === 'fail')
        .map(item => `${item.code || item.id}: ${item.message}`)
        .join('\n');
}

async function waitForReady({ stateRoot, operationId, child, timeoutMs, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const deadline = Date.now() + timeoutMs;
    let childExit = null;
    let childError = null;
    const onExit = (code, signal) => { childExit = { code, signal }; };
    const onError = error => { childError = error; };
    child.once('exit', onExit);
    child.once('error', onError);
    try {
        while (Date.now() < deadline) {
            const { record } = readReadyRecord({ stateRoot, operationId });
            if (record && record.operationId === operationId) {
                const pidMatches = record.pid === child.pid;
                const checksReady = (
                    ['ready', 'visible'].includes(record.checks?.mainWindow) &&
                    record.checks?.preload === 'ready' &&
                    record.checks?.renderer === 'ready'
                );
                if (pidMatches && checksReady) return { ok: true, record };
            }
            if (childExit) {
                const markerPath = path.join(stateRoot, `already-running-${operationId}.json`);
                if (fs.existsSync(markerPath)) {
                    return {
                        ok: false,
                        code: 'E_APP_ALREADY_RUNNING',
                        message: 'VCPChat 已经在运行中。请切回已有的 VCPChat 窗口继续使用。',
                        childExit,
                    };
                }
                return {
                    ok: false,
                    code: 'E_ELECTRON_CRASH_BEFORE_READY',
                    message: `Electron 在 ready 前退出（code=${childExit.code}, signal=${childExit.signal || 'none'}）。`,
                    childExit,
                };
            }
            if (childError) {
                return {
                    ok: false,
                    code: 'E_ELECTRON_SPAWN',
                    message: `无法启动 Electron：${childError.message}`,
                    childError: { name: childError.name, message: childError.message, code: childError.code || null },
                };
            }
            await sleep(100);
        }
        return { ok: false, code: 'E_STARTUP_TIMEOUT', message: `等待 VCPChat ready 超时（${timeoutMs}ms）。` };
    } finally {
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
    }
}

function terminateChild(child) {
    if (child?.killed) return;
    terminateManagedProcess(child);
}

function detachChildForHandoff(child) {
    child?.unref?.();
}

function managedElectronSpawnOptions({ handoff = false, handoffLogFd = null } = {}) {
    const options = managedSpawnOptions();
    return {
        ...options,
        stdio: handoff ? ['ignore', handoffLogFd, handoffLogFd] : 'inherit',
        // Handoff transfers ownership away from the setup process. The log
        // file keeps output valid while the detached app survives parent exit.
        detached: handoff ? true : options.detached,
    };
}

// Recovery UI runs Node scripts through Electron with ELECTRON_RUN_AS_NODE=1.
// Never pass that flag to the real Electron application: with it set, Electron
// exposes no `app` module and main.js crashes before ready.
function createElectronChildEnv({ env = process.env, projectRoot, stateRoot, operationId, buildId = '' } = {}) {
    const childEnv = {
        ...env,
        VCPCHAT_APP_DATA_DIR: env.VCPCHAT_APP_DATA_DIR?.trim()
            || path.join(path.resolve(projectRoot), 'AppData'),
        VCPCHAT_STATE_DIR: stateRoot,
        VCPCHAT_BOOTSTRAP_OPERATION_ID: operationId,
        VCPCHAT_BUILD_ID: buildId,
        VCP_LAUNCHER_PROTOCOL: '1',
    };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    return childEnv;
}

export async function runManagedLauncher({
    argv = process.argv.slice(2),
    projectRoot = null,
    env = process.env,
    io = process,
    spawnProcess = spawn,
    now = new Date(),
} = {}) {
    const options = parseArguments(argv);
    const root = path.resolve(projectRoot || options.projectRoot || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const stateRoot = resolveStateRoot({ env });
    const operationId = createOperationId('launch');
    const report = collectDoctorReport({ projectRoot: root, deep: options.deepDoctor, env });
    if (!report.ok) {
        io.stderr.write(`VCPChat Doctor 阻止启动：\n${formatDoctorFailure(report)}\n`);
        io.stderr.write('当前 M2 只读启动器不会自动安装或重建依赖，请先修复环境后重试。\n');
        const diagnostic = writeDiagnosticReport({
            stateRoot,
            operationId,
            phase: 'validating',
            code: 'E_DOCTOR_BLOCKED',
            message: 'Environment Doctor reported blocking failures.',
            detail: report,
        });
        io.stderr.write(`诊断报告：${diagnostic.path}\n`);
        return 1;
    }

    let lock;
    try {
        lock = acquireOperationLock({
            stateRoot,
            operationId,
            kind: 'managed-launch',
            targetRevision: resolveBuildId(root),
            now,
        });
    } catch (error) {
        io.stderr.write(`VCPChat 启动操作未取得所有权：${error.code || 'E_OPERATION_BUSY'} ${error.message}\n`);
        return 1;
    }

    const electronBinary = resolveElectronBinary(root);
    const childEnv = createElectronChildEnv({
        env,
        projectRoot: root,
        stateRoot,
        operationId,
        buildId: lock.record.targetRevision || '',
    });
    let child;
    let handoffLogFd = null;
    const onInterrupt = () => terminateChild(child);
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    try {
        lock.updateStage('launching');
        if (options.handoff) {
            const handoffLogPath = path.join(stateRoot, 'electron-handoff.log');
            handoffLogFd = fs.openSync(handoffLogPath, 'a');
        }
        child = spawnProcess(electronBinary, ['.', ...options.appArgs], {
            cwd: root,
            env: childEnv,
            // A handoff must not leave Electron attached to the Tauri/Node
            // log pipes: those handles close when the setup UI exits and can
            // terminate the otherwise-ready app on Windows.
            ...managedElectronSpawnOptions({ handoff: options.handoff, handoffLogFd }),
        });
        if (handoffLogFd !== null) {
            fs.closeSync(handoffLogFd);
            handoffLogFd = null;
        }
        lock.updateStage('awaiting-ready');
        const ready = await waitForReady({
            stateRoot,
            operationId,
            child,
            timeoutMs: options.readyTimeoutMs,
        });
        if (!ready.ok) {
            io.stderr.write(`VCPChat 启动失败：${ready.code} ${ready.message}\n`);
            const diagnostic = writeDiagnosticReport({
                stateRoot,
                operationId,
                phase: 'awaiting-ready',
                code: ready.code,
                message: ready.message,
                detail: {
                    childPid: child.pid,
                    childExit: ready.childExit || null,
                    childError: ready.childError || null,
                    doctor: report.summary,
                },
            });
            io.stderr.write(`诊断报告：${diagnostic.path}\n`);
            terminateChild(child);
            return ready.code === 'E_APP_ALREADY_RUNNING' ? ALREADY_RUNNING_EXIT_CODE : 1;
        }
        lock.updateStage('running');
        lock.release();
        lock = null;
        io.stdout.write(`VCPChat 已启动（operation ${operationId}）。\n`);
        removeReadyRecord({ stateRoot, operationId });
        if (options.handoff) {
            detachChildForHandoff(child);
            return 0;
        }
        if (child.exitCode === null && child.signalCode === null) {
            await new Promise(resolve => child.once('exit', resolve));
        }
        return child.exitCode ?? 0;
    } catch (error) {
        io.stderr.write(`VCPChat 托管启动失败：${error.code || 'E_ELECTRON_SPAWN'} ${error.message}\n`);
        try {
            const diagnostic = writeDiagnosticReport({
                stateRoot,
                operationId,
                phase: lock?.record?.stage || 'launching',
                code: error.code || 'E_ELECTRON_SPAWN',
                message: error.message,
            });
            io.stderr.write(`诊断报告：${diagnostic.path}\n`);
        } catch { /* stderr already contains the primary failure */ }
        terminateChild(child);
        return 1;
    } finally {
        if (handoffLogFd !== null) {
            try { fs.closeSync(handoffLogFd); } catch { /* spawn failure owns primary error */ }
        }
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onInterrupt);
        lock?.release();
        try { fs.rmSync(path.join(stateRoot, `already-running-${operationId}.json`), { force: true }); } catch { /* best effort */ }
        removeReadyRecord({ stateRoot, operationId });
    }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    runManagedLauncher().then(code => { process.exitCode = code; }).catch(error => {
        process.stderr.write(`VCPChat Managed Launcher failed: ${error.message}\n`);
        process.exitCode = 2;
    });
}

export { ALREADY_RUNNING_EXIT_CODE, createElectronChildEnv, detachChildForHandoff, managedElectronSpawnOptions, parseArguments, waitForReady, formatDoctorFailure };
