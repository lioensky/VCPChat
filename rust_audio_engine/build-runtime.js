'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SUPPORTED_PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64']);

function resolveRuntimeTarget(platform = process.platform, architecture = process.arch) {
    if (!SUPPORTED_PLATFORMS.has(platform)) throw new Error(`Unsupported platform '${platform}'.`);
    if (!SUPPORTED_ARCHITECTURES.has(architecture)) throw new Error(`Unsupported architecture '${architecture}'.`);
    return {
        platform,
        architecture,
        runtimeDirectoryName: `${platform}-${architecture}`,
        executableName: platform === 'win32' ? 'audio_server.exe' : 'audio_server',
    };
}

function buildAndDeploy() {
    const target = resolveRuntimeTarget();
    const rustRoot = __dirname;
    const workspaceRoot = path.resolve(rustRoot, '..');
    console.log(`[VCP Audio build] Building native ${target.runtimeDirectoryName} release binary...`);
    const cargo = spawnSync('cargo', ['build', '--release', '--locked', '--bin', 'audio_server'], {
        cwd: rustRoot,
        env: process.env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    if (cargo.error) throw cargo.error;
    if (cargo.status !== 0) throw new Error(`Cargo exited with status ${cargo.status}.`);

    const sourcePath = path.join(rustRoot, 'target', 'release', target.executableName);
    if (!fs.existsSync(sourcePath)) throw new Error(`Built audio runtime missing at ${sourcePath}.`);
    const destinationDirectory = path.join(workspaceRoot, 'audio_engine', 'bin', target.runtimeDirectoryName);
    const destinationPath = path.join(destinationDirectory, target.executableName);
    const temporaryPath = `${destinationPath}.tmp-${process.pid}`;
    fs.mkdirSync(destinationDirectory, { recursive: true });
    try {
        fs.copyFileSync(sourcePath, temporaryPath);
        if (target.platform !== 'win32') fs.chmodSync(temporaryPath, 0o755);
        fs.rmSync(destinationPath, { force: true });
        fs.renameSync(temporaryPath, destinationPath);
    } finally {
        fs.rmSync(temporaryPath, { force: true });
    }
    console.log(`[VCP Audio build] Runtime binary deployed to ${destinationPath}.`);
    return destinationPath;
}

if (require.main === module) {
    try { buildAndDeploy(); } catch (error) {
        console.error(`[VCP Audio build] ${error.message}`);
        process.exit(1);
    }
}

module.exports = { SUPPORTED_PLATFORMS, SUPPORTED_ARCHITECTURES, resolveRuntimeTarget, buildAndDeploy };
