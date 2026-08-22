'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;
const DEFAULT_LOCK_MAX_AGE_MS = 30 * 60 * 1000;

function pathForPlatform(platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}

function writeJsonAtomic(filePath, value) {
    const temp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    let fd;
    try {
        fd = fs.openSync(temp, 'wx');
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    try {
        fs.renameSync(temp, filePath);
    } catch (error) {
        if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error?.code)) {
            try { fs.unlinkSync(temp); } catch { /* best effort */ }
            throw error;
        }
        try { fs.unlinkSync(filePath); } catch (unlinkError) {
            if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        }
        fs.renameSync(temp, filePath);
    }
}

function createOperationId(prefix = 'vcpchat') {
    const safePrefix = String(prefix).replace(/[^a-z0-9_-]/gi, '-').slice(0, 32) || 'vcpchat';
    return `${safePrefix}-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

function resolveStateRoot({ env = process.env, platform = process.platform, homeDirectory = os.homedir() } = {}) {
    const explicit = typeof env.VCPCHAT_STATE_DIR === 'string' ? env.VCPCHAT_STATE_DIR.trim() : '';
    if (explicit) return path.resolve(explicit);

    const platformPath = pathForPlatform(platform);

    if (platform === 'win32') {
        return platformPath.join(env.LOCALAPPDATA || platformPath.join(homeDirectory, 'AppData', 'Local'), 'VCPChat', 'bootstrap');
    }
    if (platform === 'darwin') {
        return platformPath.join(homeDirectory, 'Library', 'Application Support', 'VCPChat', 'bootstrap');
    }
    return platformPath.join(env.XDG_STATE_HOME || platformPath.join(homeDirectory, '.local', 'state'), 'vcpchat', 'bootstrap');
}

function resolveProjectStateRoot({ projectRoot, env = process.env, platform = process.platform, homeDirectory = os.homedir() } = {}) {
    if (!projectRoot) return resolveStateRoot({ env, platform, homeDirectory });
    const base = resolveStateRoot({ env: { ...env, VCPCHAT_STATE_DIR: '' }, platform, homeDirectory });
    const platformPath = pathForPlatform(platform);
    const identity = crypto.createHash('sha256').update(platformPath.resolve(projectRoot)).digest('hex').slice(0, 16);
    return platformPath.join(platformPath.dirname(base), `${platformPath.basename(base)}-${identity}`);
}

function ensureStateRoot(options = {}) {
    const root = resolveStateRoot(options);
    fs.mkdirSync(root, { recursive: true });
    return root;
}

function lockPath(stateRoot) {
    return path.join(stateRoot, 'operation.lock');
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function readJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function inspectOperationLock(stateRoot, { now = Date.now(), maxAgeMs = DEFAULT_LOCK_MAX_AGE_MS } = {}) {
    const filePath = lockPath(stateRoot);
    if (!fs.existsSync(filePath)) return { state: 'free', path: filePath, record: null };

    const record = readJsonFile(filePath);
    const startedAtMs = Date.parse(record?.startedAt || '') || 0;
    const ageMs = startedAtMs > 0 ? Math.max(0, now - startedAtMs) : Infinity;
    const live = isProcessAlive(record?.pid);
    if (record && live && ageMs <= maxAgeMs) {
        return { state: 'busy', path: filePath, record, ageMs };
    }
    return { state: 'stale', path: filePath, record, ageMs, live };
}

function acquireOperationLock({ stateRoot, operationId, kind, targetRevision = null, now = new Date(), maxAgeMs } = {}) {
    if (!stateRoot) throw new TypeError('stateRoot is required');
    if (!operationId) throw new TypeError('operationId is required');
    const root = ensureStateRoot({ env: { VCPCHAT_STATE_DIR: stateRoot } });
    const filePath = lockPath(root);
    const inspected = inspectOperationLock(root, { maxAgeMs });
    if (inspected.state === 'busy') {
        const error = new Error(`Another VCPChat bootstrap operation is active (pid ${inspected.record.pid}).`);
        error.code = 'E_OPERATION_BUSY';
        error.lock = inspected;
        throw error;
    }
    if (inspected.state === 'stale') {
        const current = readJsonFile(filePath);
        const unchanged = JSON.stringify(current) === JSON.stringify(inspected.record);
        if (!unchanged) {
            const error = new Error('Bootstrap lock changed while stale ownership was being checked.');
            error.code = 'E_OPERATION_BUSY';
            throw error;
        }
        try { fs.unlinkSync(filePath); } catch (error) {
            const wrapped = new Error(`Unable to remove stale bootstrap lock: ${error.message}`);
            wrapped.code = 'E_OPERATION_STALE_LOCK';
            throw wrapped;
        }
    }

    const record = {
        schemaVersion: SCHEMA_VERSION,
        operationId,
        pid: process.pid,
        parentPid: process.ppid || null,
        kind: kind || 'launch',
        targetRevision,
        startedAt: new Date(now).toISOString(),
        stage: 'acquiring-lock',
    };
    let fd;
    try {
        fd = fs.openSync(filePath, 'wx');
        fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
    } catch (error) {
        if (error?.code === 'EEXIST') {
            const busy = inspectOperationLock(root, { maxAgeMs });
            const wrapped = new Error('Another VCPChat bootstrap operation acquired the lock first.');
            wrapped.code = busy.state === 'busy' ? 'E_OPERATION_BUSY' : 'E_OPERATION_STALE_LOCK';
            wrapped.lock = busy;
            throw wrapped;
        }
        throw error;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }

    let released = false;
    return {
        record,
        path: filePath,
        updateStage(stage) {
            if (released) return false;
            const next = { ...record, stage };
            writeJsonAtomic(filePath, next);
            Object.assign(record, { stage });
            return true;
        },
        release() {
            if (released) return false;
            released = true;
            try {
                const current = readJsonFile(filePath);
                if (current?.operationId === operationId) fs.unlinkSync(filePath);
            } catch { /* cleanup is best effort during process teardown */ }
            return true;
        },
    };
}

function readyPath(stateRoot, operationId) {
    if (!stateRoot || !operationId) throw new TypeError('stateRoot and operationId are required');
    return path.join(stateRoot, `ready-${operationId}.json`);
}

function writeReadyRecord({ stateRoot, operationId, buildId = null, checks = {}, now = new Date() } = {}) {
    const root = ensureStateRoot({ env: { VCPCHAT_STATE_DIR: stateRoot } });
    const filePath = readyPath(root, operationId);
    const record = {
        schemaVersion: SCHEMA_VERSION,
        operationId,
        pid: process.pid,
        buildId,
        readyAt: new Date(now).toISOString(),
        checks: { ...checks },
    };
    writeJsonAtomic(filePath, record);
    return { path: filePath, record };
}

function readReadyRecord({ stateRoot, operationId } = {}) {
    const filePath = readyPath(stateRoot, operationId);
    return { path: filePath, record: readJsonFile(filePath) };
}

function removeReadyRecord({ stateRoot, operationId } = {}) {
    const filePath = readyPath(stateRoot, operationId);
    try { fs.unlinkSync(filePath); return true; } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

module.exports = {
    SCHEMA_VERSION,
    DEFAULT_LOCK_MAX_AGE_MS,
    createOperationId,
    resolveStateRoot,
    resolveProjectStateRoot,
    ensureStateRoot,
    lockPath,
    inspectOperationLock,
    acquireOperationLock,
    readyPath,
    writeReadyRecord,
    readReadyRecord,
    removeReadyRecord,
    writeJsonAtomic,
};
