'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SUPPORTED_PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64']);

function fail(message) {
    console.error(`[VCP-CDS build] ${message}`);
    process.exit(1);
}

function resolveRuntimeTarget(platform = process.platform, architecture = process.arch) {
    if (!SUPPORTED_PLATFORMS.has(platform)) {
        throw new Error(`Unsupported platform '${platform}'. Expected win32, darwin, or linux.`);
    }
    if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
        throw new Error(`Unsupported architecture '${architecture}'. Expected x64 or arm64.`);
    }

    const executableName = platform === 'win32'
        ? 'vcp_chat_data_service.exe'
        : 'vcp_chat_data_service';

    return {
        platform,
        architecture,
        runtimeDirectoryName: `${platform}-${architecture}`,
        executableName
    };
}

function buildAndDeploy() {
    let target;
    try {
        target = resolveRuntimeTarget();
    } catch (error) {
        fail(error.message);
    }

    const rustRoot = __dirname;
    const workspaceRoot = path.resolve(rustRoot, '..');
    const manifestPath = path.join(rustRoot, 'Cargo.toml');

    console.log(
        `[VCP-CDS build] Building native ${target.platform}-${target.architecture} release binary...`
    );
    const cargo = spawnSync(
        'cargo',
        ['build', '--release', '--manifest-path', manifestPath],
        {
            cwd: rustRoot,
            env: process.env,
            stdio: 'inherit',
            shell: process.platform === 'win32'
        }
    );
    if (cargo.error) {
        fail(`Unable to launch Cargo: ${cargo.error.message}`);
    }
    if (cargo.status !== 0) {
        fail(`Cargo exited with status ${cargo.status}.`);
    }

    const sourcePath = path.join(
        rustRoot,
        'target',
        'release',
        target.executableName
    );
    if (!fs.existsSync(sourcePath)) {
        fail(`Cargo succeeded but the binary was not found at ${sourcePath}.`);
    }

    const destinationDirectory = path.join(
        workspaceRoot,
        'modules',
        'services',
        'chatDataService',
        'bin',
        target.runtimeDirectoryName
    );
    const destinationPath = path.join(destinationDirectory, target.executableName);
    const temporaryPath = `${destinationPath}.tmp-${process.pid}`;

    fs.mkdirSync(destinationDirectory, { recursive: true });
    try {
        fs.copyFileSync(sourcePath, temporaryPath);
        if (target.platform !== 'win32') {
            fs.chmodSync(temporaryPath, 0o755);
        }
        if (fs.existsSync(destinationPath)) {
            fs.rmSync(destinationPath, { force: true });
        }
        fs.renameSync(temporaryPath, destinationPath);
    } finally {
        fs.rmSync(temporaryPath, { force: true });
    }

    console.log(`[VCP-CDS build] Runtime binary deployed to ${destinationPath}.`);
    return destinationPath;
}

if (require.main === module) {
    buildAndDeploy();
}

module.exports = {
    SUPPORTED_PLATFORMS,
    SUPPORTED_ARCHITECTURES,
    resolveRuntimeTarget,
    buildAndDeploy
};