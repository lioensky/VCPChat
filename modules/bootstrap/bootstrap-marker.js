'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./launch-protocol');

const MARKER_FILE = 'managed-bootstrap-complete.json';

function sha256File(filePath) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); } catch { return null; }
}

function markerPath(stateRoot) { return path.join(stateRoot, MARKER_FILE); }

function readMarker(stateRoot) {
    try { return JSON.parse(fs.readFileSync(markerPath(stateRoot), 'utf8')); } catch { return null; }
}

function electronVersion(projectRoot) {
    try { return require(path.join(projectRoot, 'node_modules', 'electron', 'package.json')).version || null; } catch { return null; }
}

function markerIdentity({ projectRoot, platform = process.platform, arch = process.arch, nodeVersion = process.versions.node } = {}) {
    return {
        packageLockSha256: sha256File(path.join(projectRoot, 'package-lock.json')),
        packageSha256: sha256File(path.join(projectRoot, 'package.json')),
        electronVersion: electronVersion(projectRoot),
        nodeMajor: String(nodeVersion).split('.')[0],
        platform,
        arch,
    };
}

function isFresh({ stateRoot, projectRoot, platform, arch, nodeVersion } = {}) {
    const marker = readMarker(stateRoot);
    if (!marker || marker.schemaVersion !== 1 || !marker.identity) return false;
    const current = markerIdentity({ projectRoot, platform, arch, nodeVersion });
    if (!current.packageLockSha256 || !current.packageSha256) return false;
    return Object.keys(current).every(key => current[key] === marker.identity[key]);
}

function writeMarker({ stateRoot, projectRoot, buildId = null, platform, arch, nodeVersion } = {}) {
    const identity = markerIdentity({ projectRoot, platform, arch, nodeVersion });
    const value = {
        schemaVersion: 1,
        completedAt: new Date().toISOString(),
        buildId,
        identity,
    };
    fs.mkdirSync(stateRoot, { recursive: true });
    writeJsonAtomic(markerPath(stateRoot), value);
    return value;
}

module.exports = { MARKER_FILE, markerPath, readMarker, markerIdentity, isFresh, writeMarker };
