'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUNTIME_CLOSURE_SCHEMA_VERSION = 1;
const CORE_FILES = Object.freeze([
    'main.js',
    'preload.js',
    'renderer.js',
    'main.html',
    'package.json',
    'Groupmodules/groupchat.js',
    'Flowlockmodules/flowlock.js',
    'Promptmodules/prompt-manager.js',
    'Tavernmodules/tavern-manager.js',
    'rust_assistant_engine/ui/assistant-bar.html',
    'modules/bootstrap/contracts.js',
    'modules/ui-system/webawesome-runtime-manifest.js',
    'vendor/webawesome-runtime/vcp-runtime-manifest.json',
]);
const NATIVE_MODULES = Object.freeze(['better-sqlite3', 'node-pty', 'sharp']);

function sha256Buffer(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
    return sha256Buffer(fs.readFileSync(filePath));
}

function normalize(relativePath) {
    return relativePath.split(path.sep).join('/');
}

function resolveContainedPath(root, relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
        throw new Error(`Unsafe runtime path: ${relativePath}`);
    }
    const normalized = relativePath.replace(/\\/g, '/');
    if (normalized.split('/').some(segment => segment === '..' || segment === '')) {
        throw new Error(`Unsafe runtime path: ${relativePath}`);
    }
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, normalized);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`Runtime path escapes its root: ${relativePath}`);
    }
    return resolved;
}

function containedPathKey(relativePath) {
    const normalized = String(relativePath).replace(/\\/g, '/');
    return path.posix.normalize(normalized);
}

function runtimeExecutableRelative(platform = process.platform, arch = process.arch) {
    const executable = platform === 'win32' ? 'vcp_chat_data_service.exe' : 'vcp_chat_data_service';
    return normalize(path.join('modules', 'services', 'chatDataService', 'bin', `${platform}-${arch}`, executable));
}

function loadWebAwesomeFiles(projectRoot) {
    const manifestPath = path.join(projectRoot, 'vendor', 'webawesome-runtime', 'vcp-runtime-manifest.json');
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return (manifest.files || []).map(entry => normalize(path.join('vendor', 'webawesome-runtime', entry.path)));
    } catch {
        return [];
    }
}

function nativeBinaryFiles(projectRoot, moduleId) {
    const roots = [path.join(projectRoot, 'node_modules', moduleId)];
    if (moduleId === 'sharp') {
        const imagePackages = path.join(projectRoot, 'node_modules', '@img');
        if (fs.existsSync(imagePackages)) {
            roots.push(...fs.readdirSync(imagePackages)
                .filter(name => name.startsWith('sharp-'))
                .map(name => path.join(imagePackages, name)));
        }
    }
    return roots.filter(root => fs.existsSync(root)).flatMap(root =>
        fs.readdirSync(root, { recursive: true, withFileTypes: true })
            // node-gyp's obj.target tree contains build intermediates. It is
            // not shipped by electron-builder and must not be part of the
            // runtime closure checked after packaging.
            .filter(entry => entry.isFile()
                && entry.name.endsWith('.node')
                && !entry.parentPath.split(path.sep).includes('obj.target'))
            .map(entry => normalize(path.relative(projectRoot, path.join(entry.parentPath, entry.name))))
    ).sort();
}

function createRuntimeClosureManifest({ projectRoot, buildId = null, platform = process.platform, arch = process.arch } = {}) {
    const root = path.resolve(projectRoot || process.cwd());
    const rustRuntime = runtimeExecutableRelative(platform, arch);
    const candidates = [
        ...CORE_FILES,
        ...loadWebAwesomeFiles(root),
        ...NATIVE_MODULES.flatMap(moduleId => nativeBinaryFiles(root, moduleId)),
    ];
    if (fs.existsSync(path.join(root, rustRuntime))) candidates.push(rustRuntime);
    const files = [...new Set(candidates)].filter(relativePath => fs.existsSync(path.join(root, relativePath))).sort().map(relativePath => {
        const absolute = path.join(root, relativePath);
        return {
            path: normalize(relativePath),
            size: fs.statSync(absolute).size,
            sha256: sha256File(absolute),
        };
    });
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* verified below */ }
    return {
        schemaVersion: RUNTIME_CLOSURE_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        buildId,
        platform,
        arch,
        electronVersion: (() => {
            try { return require(path.join(root, 'node_modules', 'electron', 'package.json')).version; } catch { return null; }
        })(),
        appVersion: pkg.version || null,
        files,
        nativeModules: NATIVE_MODULES.map(id => ({ id, binaries: nativeBinaryFiles(root, id) })),
        rustRuntime: fs.existsSync(path.join(root, rustRuntime)) ? rustRuntime : null,
        packagePolicy: {
            files: pkg.build?.files || [],
            asarUnpack: pkg.build?.asarUnpack || [],
        },
    };
}

function verifyDirectoryAgainstManifest({ root, manifest }) {
    const failures = [];
    for (const entry of manifest.files || []) {
        let absolute;
        try { absolute = resolveContainedPath(root, entry?.path); } catch (error) {
            failures.push({ path: entry?.path, reason: error.message });
            continue;
        }
        if (!fs.existsSync(absolute)) {
            failures.push({ path: entry.path, reason: 'missing' });
            continue;
        }
        if (fs.lstatSync(absolute).isSymbolicLink()) {
            failures.push({ path: entry.path, reason: 'symbolic links are not allowed in a runtime closure' });
            continue;
        }
        const stat = fs.statSync(absolute);
        if (stat.size !== entry.size) failures.push({ path: entry.path, reason: 'size', expected: entry.size, actual: stat.size });
        const actual = sha256File(absolute);
        if (actual !== entry.sha256) failures.push({ path: entry.path, reason: 'sha256', expected: entry.sha256, actual });
    }
    return { ok: failures.length === 0, failures };
}

function validateRuntimePolicy(manifest) {
    const failures = [];
    const files = manifest.packagePolicy?.files || [];
    const unpack = manifest.packagePolicy?.asarUnpack || [];
    const requiredPatterns = ['modules/**/*', 'vendor/**/*', 'node_modules/**/*'];
    for (const pattern of requiredPatterns) {
        if (!files.includes(pattern)) failures.push({ path: 'package.json#build.files', reason: `missing ${pattern}` });
    }
    if (!unpack.some(pattern => pattern.includes('chatDataService/bin'))) {
        failures.push({ path: 'package.json#build.asarUnpack', reason: 'Rust runtime is not unpacked' });
    }
    for (const native of manifest.nativeModules || []) {
        if (!native.binaries.length) failures.push({ path: `node_modules/${native.id}`, reason: 'native binary missing' });
    }
    return { ok: failures.length === 0, failures };
}

module.exports = {
    RUNTIME_CLOSURE_SCHEMA_VERSION,
    CORE_FILES,
    NATIVE_MODULES,
    sha256Buffer,
    sha256File,
    runtimeExecutableRelative,
    createRuntimeClosureManifest,
    verifyDirectoryAgainstManifest,
    validateRuntimePolicy,
    resolveContainedPath,
    containedPathKey,
};
