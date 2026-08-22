'use strict';

const path = require('path');
const { NATIVE_MODULES } = require('./environment-doctor');

const REPAIR_MANIFEST_VERSION = 1;
const DEFAULT_STAGE_TIMEOUT_MS = 15 * 60 * 1000;

function commandForPlatform(name, platform = process.platform) {
    return platform === 'win32' ? `${name}.cmd` : name;
}

function createRepairManifest({ projectRoot, platform = process.platform } = {}) {
    const npm = commandForPlatform('npm', platform);
    const node = process.execPath;
    return Object.freeze({
        schemaVersion: REPAIR_MANIFEST_VERSION,
        projectRoot: path.resolve(projectRoot || process.cwd()),
        stages: Object.freeze([
            { id: 'validate-lockfile', kind: 'internal', mutates: false, timeoutMs: 30_000 },
            {
                id: 'install-dependencies',
                kind: 'command',
                mutates: true,
                command: npm,
                args: ['ci', '--no-audit', '--no-fund'],
                timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
            },
            { id: 'probe-native-modules', kind: 'internal', mutates: false, timeoutMs: 30_000 },
            {
                id: 'rebuild-native-modules',
                kind: 'command',
                mutates: true,
                command: node,
                args: [
                    path.join('node_modules', '@electron', 'rebuild', 'lib', 'cli.js'),
                    '-f',
                    '--only',
                    NATIVE_MODULES.join(','),
                ],
                timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
            },
            {
                id: 'build-rust-runtime',
                kind: 'command',
                mutates: true,
                command: node,
                args: [path.join('rust_chat_data_service', 'build-runtime.js')],
                timeoutMs: 30 * 60 * 1000,
                optional: true,
            },
            {
                id: 'build-audio-runtime',
                kind: 'command',
                mutates: true,
                command: node,
                args: [path.join('rust_audio_engine', 'build-runtime.js')],
                timeoutMs: 30 * 60 * 1000,
                optional: true,
            },
            {
                id: 'repair-vendor-closure',
                kind: 'command',
                mutates: true,
                command: npm,
                args: ['run', 'vendor:webawesome:report'],
                timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
                optional: true,
            },
            {
                id: 'verify-vendor-closure',
                kind: 'command',
                mutates: false,
                command: npm,
                args: ['run', 'vendor:webawesome:check'],
                timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
            },
            { id: 'publish-fingerprint', kind: 'internal', mutates: true, timeoutMs: 30_000 },
        ]),
    });
}

module.exports = {
    REPAIR_MANIFEST_VERSION,
    DEFAULT_STAGE_TIMEOUT_MS,
    commandForPlatform,
    createRepairManifest,
};
