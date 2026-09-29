'use strict';
// 构建 ProjectForge AST 索引 sidecar，并部署到插件目录：
// VCPDistributedServer/Plugin/ProjectForge/bin/<platform>-<arch>/projectforge_indexer(.exe)
// 二进制随插件存放、由插件自行拉起；插件禁用时不会启动。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SUPPORTED_PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64']);

function fail(message) {
    console.error(`[PF-Indexer build] ${message}`);
    process.exit(1);
}

function resolveRuntimeTarget(platform = process.platform, architecture = process.arch) {
    if (!SUPPORTED_PLATFORMS.has(platform)) {
        throw new Error(`Unsupported platform '${platform}'. Expected win32, darwin, or linux.`);
    }
    if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
        throw new Error(`Unsupported architecture '${architecture}'. Expected x64 or arm64.`);
    }
    return {
        platform,
        architecture,
        runtimeDirectoryName: `${platform}-${architecture}`,
        executableName: platform === 'win32' ? 'projectforge_indexer.exe' : 'projectforge_indexer',
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

    console.log(`[PF-Indexer build] Building native ${target.runtimeDirectoryName} release binary...`);
    const cargo = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', manifestPath], {
        cwd: rustRoot,
        env: process.env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    if (cargo.error) fail(`Unable to launch Cargo: ${cargo.error.message}`);
    if (cargo.status !== 0) fail(`Cargo exited with status ${cargo.status}.`);

    const sourcePath = path.join(rustRoot, 'target', 'release', target.executableName);
    if (!fs.existsSync(sourcePath)) fail(`Cargo succeeded but the binary was not found at ${sourcePath}.`);

    const destinationDirectory = path.join(
        workspaceRoot, 'VCPDistributedServer', 'Plugin', 'ProjectForge', 'bin', target.runtimeDirectoryName,
    );
    const destinationPath = path.join(destinationDirectory, target.executableName);
    const temporaryPath = `${destinationPath}.tmp-${process.pid}`;

    fs.mkdirSync(destinationDirectory, { recursive: true });
    try {
        fs.copyFileSync(sourcePath, temporaryPath);
        if (target.platform !== 'win32') fs.chmodSync(temporaryPath, 0o755);
        // 运行中的 sidecar 在 Windows 上会锁住 exe：先尝试删除，失败时给出可操作提示。
        if (fs.existsSync(destinationPath)) {
            try {
                fs.rmSync(destinationPath, { force: true });
            } catch (error) {
                fail(`无法替换 ${destinationPath}（${error.code || error.message}）。请先停止 VCPDistributedServer / VChat 后重试。`);
            }
        }
        fs.renameSync(temporaryPath, destinationPath);
    } finally {
        fs.rmSync(temporaryPath, { force: true });
    }

    console.log(`[PF-Indexer build] Runtime binary deployed to ${destinationPath}.`);
    return destinationPath;
}

if (require.main === module) {
    buildAndDeploy();
}

module.exports = {
    SUPPORTED_PLATFORMS,
    SUPPORTED_ARCHITECTURES,
    resolveRuntimeTarget,
    buildAndDeploy,
};