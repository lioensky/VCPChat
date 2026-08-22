'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { acquireOperationLock, createOperationId, writeJsonAtomic } = require('./launch-protocol');
const { verifyDirectoryAgainstManifest, resolveContainedPath, containedPathKey } = require('./runtime-closure');

const UPDATE_SCHEMA_VERSION = 1;
const UPDATE_LOCK_MAX_AGE_MS = 20 * 60 * 1000;
const UPDATE_RESERVE_BYTES = 64 * 1024 * 1024;

function sha256File(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
function updateRoot(stateRoot) { return path.join(stateRoot, 'versions'); }
function pointerPath(stateRoot) { return path.join(updateRoot(stateRoot), 'current.json'); }
function readJson(filePath, fallback = null) { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; } }

function canonicalize(value, omitTopLevelSignature = false) {
    if (Array.isArray(value)) return `[${value.map(item => canonicalize(item, false)).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).filter(key => !(omitTopLevelSignature && key === 'signature')).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key], false)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function validateUpdateSignature({ manifest, publicKey = null } = {}) {
    if (!manifest?.signature) return { ok: true, signed: false };
    if (!publicKey || typeof publicKey !== 'string') {
        const error = new Error('更新清单包含签名，但未提供公钥。'); error.code = 'E_UPDATE_SIGNATURE_INVALID'; throw error;
    }
    const signature = manifest.signature;
    if (signature.algorithm !== 'RSA-SHA256' || typeof signature.value !== 'string' || !signature.value) {
        const error = new Error('更新清单签名算法或内容无效。'); error.code = 'E_UPDATE_SIGNATURE_INVALID'; throw error;
    }
    let valid = false;
    try {
        valid = crypto.verify('RSA-SHA256', Buffer.from(canonicalize(manifest, true)), publicKey, Buffer.from(signature.value, 'base64'));
    } catch { valid = false; }
    if (!valid) {
        const error = new Error('更新清单签名验证失败。'); error.code = 'E_UPDATE_SIGNATURE_INVALID'; throw error;
    }
    return { ok: true, signed: true, algorithm: signature.algorithm };
}

function findSymbolicLink(root) {
    if (!fs.existsSync(root)) return null;
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink()) return root;
    if (!stat.isDirectory()) return null;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const candidate = path.join(root, entry.name);
        if (entry.isSymbolicLink()) return candidate;
        if (entry.isDirectory()) {
            const nested = findSymbolicLink(candidate);
            if (nested) return nested;
        }
    }
    return null;
}

function validateUpdateManifest({ sourceRoot, manifest, publicKey = null } = {}) {
    if (!manifest || manifest.schemaVersion !== UPDATE_SCHEMA_VERSION || !manifest.version || !manifest.files?.length) {
        const error = new Error('更新清单缺少版本、schema 或文件校验列表。'); error.code = 'E_UPDATE_MANIFEST_INVALID'; throw error;
    }
    const sourceLink = findSymbolicLink(sourceRoot);
    if (sourceLink) {
        const error = new Error(`更新 source 含有不允许的符号链接：${sourceLink}`);
        error.code = 'E_UPDATE_INTEGRITY_FAILED';
        error.failures = [{ path: sourceLink, reason: 'symbolic-link' }];
        throw error;
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(manifest.version)
        || (manifest.buildId != null && !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(manifest.buildId))) {
        const error = new Error('更新版本或 build ID 不是安全的目录标识。'); error.code = 'E_UPDATE_MANIFEST_INVALID'; throw error;
    }
    validateUpdateSignature({ manifest, publicKey });
    const failures = [];
    const seen = new Set();
    for (const entry of manifest.files) {
        let file;
        try { file = resolveContainedPath(sourceRoot, entry?.path); } catch (error) {
            failures.push({ path: entry?.path, reason: error.message });
            continue;
        }
        const key = containedPathKey(entry.path);
        if (seen.has(key)) { failures.push({ path: entry.path, reason: 'duplicate' }); continue; }
        seen.add(key);
        if (!fs.existsSync(file)) failures.push({ path: entry.path, reason: 'missing' });
        else if (fs.lstatSync(file).isSymbolicLink()) failures.push({ path: entry.path, reason: 'symbolic-link' });
        else if (entry.sha256 && sha256File(file) !== entry.sha256) failures.push({ path: entry.path, reason: 'sha256' });
    }
    if (manifest.launch?.executable && !seen.has(containedPathKey(manifest.launch.executable))) {
        failures.push({ path: manifest.launch.executable, reason: 'launch executable is not covered by the manifest' });
    }
    if (failures.length) {
        const error = new Error(`更新运行时校验失败：${failures.slice(0, 4).map(item => item.path).join(', ')}`);
        error.code = 'E_UPDATE_INTEGRITY_FAILED'; error.failures = failures; throw error;
    }
    return { ok: true };
}

function checkStagingCapacity({ stateRoot, manifest, reserveBytes = UPDATE_RESERVE_BYTES, statfs = fs.statfsSync } = {}) {
    const totalBytes = (manifest.files || []).reduce((sum, entry) => sum + (Number.isFinite(entry.size) ? Math.max(0, entry.size) : 0), 0);
    const requiredBytes = totalBytes * 2 + reserveBytes;
    try {
        const stats = statfs(stateRoot);
        const availableBytes = Number(stats.bavail) * Number(stats.bsize);
        if (Number.isFinite(availableBytes) && availableBytes < requiredBytes) {
            const error = new Error(`更新需要约 ${Math.ceil(requiredBytes / 1024 / 1024)} MiB 可用空间，当前仅有约 ${Math.floor(availableBytes / 1024 / 1024)} MiB。`);
            error.code = 'E_UPDATE_DISK_SPACE';
            error.requiredBytes = requiredBytes;
            error.availableBytes = availableBytes;
            throw error;
        }
    } catch (error) {
        if (error.code === 'E_UPDATE_DISK_SPACE') throw error;
        // statfs is unavailable on some older runtimes/filesystems; integrity
        // and atomic staging still protect the update, so capacity is advisory.
    }
    return { ok: true, requiredBytes };
}

function copyTree(sourceRoot, destinationRoot) {
    fs.mkdirSync(destinationRoot, { recursive: true });
    fs.cpSync(sourceRoot, destinationRoot, { recursive: true, errorOnExist: false, force: false });
}

function activeVersion(stateRoot) { return readJson(pointerPath(stateRoot), null); }

function switchVersion({ stateRoot, sourceRoot, manifest, publicKey = null, verify = verifyDirectoryAgainstManifest } = {}) {
    const root = updateRoot(stateRoot);
    fs.mkdirSync(root, { recursive: true });
    validateUpdateManifest({ sourceRoot, manifest, publicKey });
    checkStagingCapacity({ stateRoot: root, manifest });
    const versionRoot = path.join(root, `${manifest.version}-${manifest.buildId || Date.now()}`);
    if (fs.existsSync(versionRoot)) throw Object.assign(new Error('目标版本目录已存在。'), { code: 'E_UPDATE_MANIFEST_INVALID' });
    copyTree(sourceRoot, versionRoot);
    const result = verify({ root: versionRoot, manifest });
    if (!result.ok) {
        fs.rmSync(versionRoot, { recursive: true, force: true });
        throw Object.assign(new Error('staging 目录验证失败，未切换 current。'), { code: 'E_UPDATE_INTEGRITY_FAILED', failures: result.failures });
    }
    const previous = activeVersion(stateRoot);
    const next = {
        schemaVersion: UPDATE_SCHEMA_VERSION,
        version: manifest.version,
        buildId: manifest.buildId || null,
        directory: versionRoot,
        switchedAt: new Date().toISOString(),
        previous: previous?.directory || null,
    };
    writeJsonAtomic(pointerPath(stateRoot), next);
    return { current: next, previous };
}

function rollbackVersion({ stateRoot, failedVersion = null } = {}) {
    const current = activeVersion(stateRoot);
    const target = current?.previous || null;
    if (!target || !fs.existsSync(target)) {
        const error = new Error('没有可验证存在的旧版本可回滚。'); error.code = 'E_UPDATE_ROLLBACK'; throw error;
    }
    const next = { ...current, directory: target, version: null, buildId: null, rolledBackAt: new Date().toISOString(), failedVersion };
    writeJsonAtomic(pointerPath(stateRoot), next);
    return next;
}

async function promoteVersionWithHealthCheck({ stateRoot, sourceRoot, manifest, publicKey = null, verify, healthCheck } = {}) {
    if (typeof healthCheck !== 'function') throw new TypeError('healthCheck is required');
    const switched = switchVersion({ stateRoot, sourceRoot, manifest, publicKey, verify });
    try {
        const health = await healthCheck(switched.current);
        if (!health?.ok) {
            const error = new Error(health?.message || '新版本未发布 ready。');
            error.code = health?.code || 'E_STARTUP_TIMEOUT';
            throw error;
        }
        return { ...switched, health };
    } catch (error) {
        if (switched.previous?.directory && fs.existsSync(switched.previous.directory)) {
            const rollback = rollbackVersion({ stateRoot, failedVersion: switched.current.directory });
            error.rollback = rollback;
        }
        throw error;
    }
}

function acquireUpdateLock(stateRoot) {
    return acquireOperationLock({
        stateRoot,
        operationId: createOperationId('update'),
        kind: 'managed-update',
        maxAgeMs: UPDATE_LOCK_MAX_AGE_MS,
    });
}

module.exports = {
    UPDATE_SCHEMA_VERSION,
    UPDATE_LOCK_MAX_AGE_MS,
    UPDATE_RESERVE_BYTES,
    updateRoot,
    pointerPath,
    readJson,
    activeVersion,
    validateUpdateManifest,
    canonicalize,
    validateUpdateSignature,
    checkStagingCapacity,
    switchVersion,
    rollbackVersion,
    promoteVersionWithHealthCheck,
    acquireUpdateLock,
};
