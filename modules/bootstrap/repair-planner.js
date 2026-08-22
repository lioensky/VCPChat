'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { collectDoctorReport, probeNativeModules, resolveElectronBinary } = require('./environment-doctor');
const { acquireOperationLock, createOperationId, writeJsonAtomic } = require('./launch-protocol');
const { runProcess } = require('./process-runner');
const { createRepairManifest } = require('./repair-manifest');

const MAX_REPAIR_ATTEMPTS_PER_EPISODE = 2;
const HISTORY_FILE = 'repair-history.json';
const JOURNAL_FILE = 'repair-journal.json';
const FINGERPRINT_FILE = 'environment-fingerprint.json';

function sha256File(filePath) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); } catch { return null; }
}

function environmentEpisode({ projectRoot, doctorReport }) {
    const failures = doctorReport.checks
        .filter(item => item.status === 'fail' || item.status === 'warn')
        .map(item => `${item.id}:${item.code || item.status}`)
        .sort();
    const identity = {
        projectRoot: path.resolve(projectRoot),
        failures,
        packageLock: sha256File(path.join(projectRoot, 'package-lock.json')),
        node: process.versions.node,
        electron: (() => {
            try { return require(path.join(projectRoot, 'node_modules', 'electron', 'package.json')).version; } catch { return null; }
        })(),
        platform: process.platform,
        arch: process.arch,
    };
    return {
        id: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
        identity,
    };
}

function readJson(filePath, fallback) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeStateJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeJsonAtomic(filePath, value);
}

function selectRepairStages({ doctorReport, manifest, includeRust = false, repairVendor = false, full = false } = {}) {
    const byId = new Map(manifest.stages.map(stage => [stage.id, stage]));
    const failedCodes = new Set(doctorReport.checks
        .filter(item => item.status === 'fail')
        .map(item => item.code));
    const warningCodes = new Set(doctorReport.checks
        .filter(item => item.status === 'warn')
        .map(item => item.code));
    const selected = ['validate-lockfile'];
    const installsDependencies = full || failedCodes.has('E_DEPENDENCY_MISSING') || failedCodes.has('E_DEPENDENCY_CORRUPT');
    if (installsDependencies) {
        selected.push('install-dependencies');
    }
    selected.push('probe-native-modules');
    if (installsDependencies || failedCodes.has('E_NATIVE_ABI_MISMATCH')) selected.push('rebuild-native-modules');
    if (includeRust && (full || warningCodes.has('E_RUST_RUNTIME_MISSING') || warningCodes.has('E_RUST_RUNTIME_INVALID'))) {
        selected.push('build-rust-runtime');
    }
    if (includeRust && (full || warningCodes.has('E_AUDIO_RUNTIME_MISSING') || warningCodes.has('E_AUDIO_RUNTIME_INVALID'))) {
        selected.push('build-audio-runtime');
    }
    const vendorInvalid = warningCodes.has('E_VENDOR_CLOSURE_INVALID');
    if (repairVendor && (full || vendorInvalid)) selected.push('repair-vendor-closure');
    if (!vendorInvalid || repairVendor) selected.push('verify-vendor-closure');
    selected.push('publish-fingerprint');
    return [...new Set(selected)].map(id => byId.get(id)).filter(Boolean);
}

function createRepairPlan({ projectRoot, stateRoot, doctorReport, includeRust, repairVendor, full } = {}) {
    const root = path.resolve(projectRoot || process.cwd());
    const report = doctorReport || collectDoctorReport({ projectRoot: root, deep: true });
    const manifest = createRepairManifest({ projectRoot: root });
    const episode = environmentEpisode({ projectRoot: root, doctorReport: report });
    const history = readJson(path.join(stateRoot, HISTORY_FILE), { schemaVersion: 1, episodes: {} });
    const attempts = history.episodes?.[episode.id]?.attempts || 0;
    return {
        schemaVersion: 1,
        projectRoot: root,
        stateRoot,
        episode,
        attempts,
        budgetRemaining: Math.max(0, MAX_REPAIR_ATTEMPTS_PER_EPISODE - attempts),
        doctor: report,
        stages: selectRepairStages({ doctorReport: report, manifest, includeRust, repairVendor, full }),
    };
}

function validateLockfile(projectRoot) {
    const packageFile = path.join(projectRoot, 'package.json');
    const lockFile = path.join(projectRoot, 'package-lock.json');
    const pkg = readJson(packageFile, null);
    const lock = readJson(lockFile, null);
    if (!pkg || !lock || !Number.isInteger(lock.lockfileVersion) || !lock.packages?.['']) {
        const error = new Error('package.json/package-lock.json 无法形成可复现安装输入。');
        error.code = 'E_LOCKFILE_INVALID';
        throw error;
    }
    if (lock.packages[''].name !== pkg.name || lock.packages[''].version !== pkg.version) {
        const error = new Error('package-lock.json 根包身份与 package.json 不一致。');
        error.code = 'E_LOCKFILE_INVALID';
        throw error;
    }
    return { ok: true };
}

async function executeRepairPlan({
    plan,
    signal,
    onEvent = () => {},
    runCommand = runProcess,
    doctor = collectDoctorReport,
} = {}) {
    if (!plan) throw new TypeError('plan is required');
    if (plan.budgetRemaining <= 0) {
        const error = new Error('同一失败 episode 的自动修复预算已耗尽；请查看诊断后人工处理。');
        error.code = 'E_REPAIR_BUDGET_EXHAUSTED';
        throw error;
    }
    const operationId = createOperationId('repair');
    const lock = acquireOperationLock({
        stateRoot: plan.stateRoot,
        operationId,
        kind: 'managed-repair',
        targetRevision: plan.episode.identity.packageLock,
    });
    const historyPath = path.join(plan.stateRoot, HISTORY_FILE);
    const journalPath = path.join(plan.stateRoot, JOURNAL_FILE);
    const history = readJson(historyPath, { schemaVersion: 1, episodes: {} });
    const previous = history.episodes[plan.episode.id] || { attempts: 0, failures: [] };
    history.episodes[plan.episode.id] = {
        ...previous,
        attempts: previous.attempts + 1,
        lastStartedAt: new Date().toISOString(),
    };
    writeStateJson(historyPath, history);
    const journal = {
        schemaVersion: 1,
        operationId,
        episodeId: plan.episode.id,
        state: 'running',
        startedAt: new Date().toISOString(),
        completedStages: [],
        activeStage: null,
    };
    writeStateJson(journalPath, journal);
    const results = [];
    try {
        for (const stage of plan.stages) {
            if (signal?.aborted) {
                const error = new Error('修复操作已取消。');
                error.code = 'E_REPAIR_CANCELLED';
                throw error;
            }
            journal.activeStage = stage.id;
            writeStateJson(journalPath, journal);
            lock.updateStage(stage.id);
            onEvent({ type: 'stage-started', operationId, stage: stage.id });
            let result;
            if (stage.id === 'validate-lockfile') {
                result = validateLockfile(plan.projectRoot);
            } else if (stage.id === 'probe-native-modules') {
                const electronBinary = resolveElectronBinary(plan.projectRoot);
                result = probeNativeModules({ projectRoot: plan.projectRoot, electronBinary });
                if (!result.ok) {
                    const rebuildPending = plan.stages.some(item => item.id === 'rebuild-native-modules');
                    if (!rebuildPending) {
                        const error = new Error(result.error || '原生模块 ABI probe 失败。');
                        error.code = 'E_NATIVE_ABI_MISMATCH';
                        throw error;
                    }
                }
            } else if (stage.id === 'publish-fingerprint') {
                const verified = doctor({ projectRoot: plan.projectRoot, deep: true });
                if (!verified.ok) {
                    const error = new Error('修复后 Doctor 仍存在阻塞项，不发布成功指纹。');
                    error.code = 'E_REPAIR_STAGE_FAILED';
                    error.doctor = verified;
                    throw error;
                }
                const fingerprint = {
                    schemaVersion: 1,
                    episodeId: plan.episode.id,
                    publishedAt: new Date().toISOString(),
                    packageLockSha256: sha256File(path.join(plan.projectRoot, 'package-lock.json')),
                    doctorSummary: verified.summary,
                };
                writeStateJson(path.join(plan.stateRoot, FINGERPRINT_FILE), fingerprint);
                result = { ok: true, fingerprint };
            } else {
                result = await runCommand({
                    command: stage.command,
                    args: stage.args,
                    cwd: plan.projectRoot,
                    timeoutMs: stage.timeoutMs,
                    signal,
                    onOutput: output => onEvent({ type: 'stage-output', operationId, stage: stage.id, ...output }),
                });
                if (!result.ok) {
                    const error = new Error(`修复阶段 ${stage.id} 失败。`);
                    error.code = result.code || 'E_REPAIR_STAGE_FAILED';
                    error.result = result;
                    throw error;
                }
            }
            results.push({ stage: stage.id, ...result });
            journal.completedStages.push(stage.id);
            journal.activeStage = null;
            writeStateJson(journalPath, journal);
            onEvent({ type: 'stage-completed', operationId, stage: stage.id, result });
        }
        journal.state = 'complete';
        journal.completedAt = new Date().toISOString();
        writeStateJson(journalPath, journal);
        history.episodes[plan.episode.id].lastCompletedAt = journal.completedAt;
        history.episodes[plan.episode.id].lastResult = 'complete';
        writeStateJson(historyPath, history);
        return { ok: true, operationId, results };
    } catch (error) {
        journal.state = error.code === 'E_REPAIR_CANCELLED' ? 'cancelled' : 'failed';
        journal.failedAt = new Date().toISOString();
        journal.error = { code: error.code || 'E_REPAIR_STAGE_FAILED', message: error.message };
        writeStateJson(journalPath, journal);
        const current = history.episodes[plan.episode.id];
        current.lastResult = journal.state;
        current.failures = [...(current.failures || []), journal.error].slice(-5);
        writeStateJson(historyPath, history);
        throw error;
    } finally {
        lock.release();
    }
}

module.exports = {
    MAX_REPAIR_ATTEMPTS_PER_EPISODE,
    HISTORY_FILE,
    JOURNAL_FILE,
    FINGERPRINT_FILE,
    environmentEpisode,
    selectRepairStages,
    createRepairPlan,
    executeRepairPlan,
    validateLockfile,
};
