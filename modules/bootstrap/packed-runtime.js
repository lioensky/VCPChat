'use strict';

const fs = require('fs');
const path = require('path');
const { sha256Buffer } = require('./runtime-closure');

function readPackagedFile({ resourcesDirectory, relativePath, asar = null } = {}) {
    const unpacked = path.join(resourcesDirectory, 'app.asar.unpacked', relativePath);
    if (fs.existsSync(unpacked)) return fs.readFileSync(unpacked);
    const loose = path.join(resourcesDirectory, 'app', relativePath);
    if (fs.existsSync(loose)) return fs.readFileSync(loose);
    const asarPath = path.join(resourcesDirectory, 'app.asar');
    if (fs.existsSync(asarPath)) {
        const asarApi = asar || require('@electron/asar');
        try { return asarApi.extractFile(asarPath, relativePath); } catch { return null; }
    }
    return null;
}

function verifyPackagedRuntime({ resourcesDirectory, manifest, asar = null } = {}) {
    const failures = [];
    for (const entry of manifest.files || []) {
        const content = readPackagedFile({ resourcesDirectory, relativePath: entry.path, asar });
        if (!content) {
            failures.push({ path: entry.path, reason: 'missing from packaged runtime' });
            continue;
        }
        if (content.length !== entry.size) failures.push({ path: entry.path, reason: 'packaged size mismatch' });
        const actual = sha256Buffer(content);
        if (actual !== entry.sha256) failures.push({ path: entry.path, reason: 'packaged sha256 mismatch', actual, expected: entry.sha256 });
    }
    const runtimeManifestPath = path.join(resourcesDirectory, 'vcp-runtime-closure.json');
    if (!fs.existsSync(runtimeManifestPath)) failures.push({ path: runtimeManifestPath, reason: 'shipped closure manifest missing' });
    return { ok: failures.length === 0, failures };
}

module.exports = { readPackagedFile, verifyPackagedRuntime };
