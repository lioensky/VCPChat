'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { BOOTSTRAP_SCHEMA_VERSION, CHECK_STATUS, ERROR_CODES } = require('./contracts');
const { resolveCommandInvocation } = require('./command-invocation');
const { inspectOperationLock, resolveStateRoot } = require('./launch-protocol');

const NATIVE_MODULES = Object.freeze(['better-sqlite3', 'node-pty', 'sharp']);
const MINIMUM_NODE_MAJOR = 20;

function check(id, status, message, detail = {}) {
    return { id, status, message, ...detail };
}

function safeReadJson(filePath) {
    try {
        return { value: JSON.parse(fs.readFileSync(filePath, 'utf8')), error: null };
    } catch (error) {
        return { value: null, error };
    }
}

function resolveModule(moduleId, projectRoot) {
    try {
        return require.resolve(moduleId, { paths: [projectRoot] });
    } catch {
        return null;
    }
}

function resolveElectronBinary(projectRoot) {
    const modulePath = resolveModule('electron', projectRoot);
    if (!modulePath) return null;
    try {
        const value = require(modulePath);
        return typeof value === 'string' && value ? value : null;
    } catch {
        return null;
    }
}

function probeNativeModules({ projectRoot, electronBinary, nativeModules = NATIVE_MODULES, spawn = spawnSync, env = process.env }) {
    if (!electronBinary) {
        return { ok: false, error: 'Electron binary is unavailable.', missing: nativeModules };
    }
    const source = [
        'const failures = [];',
        '(async () => {',
        `for (const id of ${JSON.stringify(nativeModules)}) {`,
        '  try {',
        "    if (id === 'better-sqlite3') { const Database = require(id); const db = new Database(':memory:'); db.prepare('SELECT 1').get(); db.close(); }",
        "    else if (id === 'node-pty') { const pty = require(id); if (typeof pty.spawn !== 'function') throw new Error('node-pty spawn API missing'); }",
        "    else if (id === 'sharp') { const sharp = require(id); await sharp({ create: { width: 1, height: 1, channels: 4, background: '#00000000' } }).metadata(); }",
        '    else { require(id); }',
        '  } catch (error) { failures.push({ id, message: error && error.message ? error.message : String(error) }); }',
        '}',
        'if (failures.length) { console.error(JSON.stringify(failures)); process.exit(2); }',
        '})().catch(error => { console.error(error && error.stack ? error.stack : String(error)); process.exit(2); });',
    ].join('\n');
    const result = spawn(electronBinary, ['-e', source], {
        cwd: projectRoot,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
    });
    if (result.error) return { ok: false, error: result.error.message, exitCode: null };
    if (result.status !== 0) {
        return {
            ok: false,
            error: String(result.stderr || result.stdout || `Electron native probe exited ${result.status}`).trim(),
            exitCode: result.status,
        };
    }
    return { ok: true, exitCode: 0 };
}

function summarize(checks) {
    return checks.reduce((summary, item) => {
        summary[item.status] = (summary[item.status] || 0) + 1;
        return summary;
    }, { pass: 0, warn: 0, fail: 0, skip: 0 });
}

function findExistingAncestor(targetPath) {
    let current = path.resolve(targetPath);
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
    return current;
}

function canAccess(targetPath, mode) {
    try { fs.accessSync(targetPath, mode); return true; } catch { return false; }
}

function collectDoctorReport({
    projectRoot = process.cwd(),
    deep = false,
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    nodeVersion = process.versions.node,
    spawn = spawnSync,
    now = new Date(),
} = {}) {
    const root = path.resolve(projectRoot);
    const checks = [];
    const packagePath = path.join(root, 'package.json');
    const lockPath = path.join(root, 'package-lock.json');
    const packageResult = safeReadJson(packagePath);

    if (!packageResult.value || packageResult.value.main !== 'main.js' || !fs.existsSync(path.join(root, 'main.js'))) {
        checks.push(check('project', CHECK_STATUS.FAIL, '当前目录不是完整的 VCPChat 项目根目录。', {
            code: ERROR_CODES.PROJECT_INCOMPLETE,
            path: packagePath,
        }));
    } else {
        checks.push(check('project', CHECK_STATUS.PASS, 'VCPChat 项目清单可读取。', {
            name: packageResult.value.name,
            version: packageResult.value.version,
        }));
    }

    const nodeMajor = Number.parseInt(String(nodeVersion).split('.')[0], 10);
    if (!Number.isInteger(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) {
        checks.push(check('node', CHECK_STATUS.FAIL, `Node.js ${nodeVersion} 不满足最低主版本 ${MINIMUM_NODE_MAJOR}。`, {
            code: ERROR_CODES.NODE_UNSUPPORTED,
            actual: nodeVersion,
            minimumMajor: MINIMUM_NODE_MAJOR,
        }));
    } else {
        checks.push(check('node', CHECK_STATUS.PASS, `Node.js ${nodeVersion} 可用于托管开发启动。`, { actual: nodeVersion }));
    }

    const npmInvocation = resolveCommandInvocation(
        platform === 'win32' ? 'npm.cmd' : 'npm',
        ['--version'],
        { platform, env },
    );
    const npmResult = spawn(npmInvocation.command, npmInvocation.args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
    });
    if (npmResult.error || npmResult.status !== 0) {
        checks.push(check('npm', CHECK_STATUS.FAIL, '无法执行 npm。', {
            code: ERROR_CODES.NPM_MISSING,
            detail: npmResult.error?.message || String(npmResult.stderr || '').trim(),
        }));
    } else {
        checks.push(check('npm', CHECK_STATUS.PASS, `npm ${String(npmResult.stdout).trim()} 可用。`));
    }

    const lockResult = safeReadJson(lockPath);
    const lockRootPackage = lockResult.value?.packages?.[''];
    const lockIdentityMismatch = Boolean(
        packageResult.value && lockRootPackage &&
        (lockRootPackage.name !== packageResult.value.name || lockRootPackage.version !== packageResult.value.version)
    );
    if (!lockResult.value || !Number.isInteger(lockResult.value.lockfileVersion) || lockIdentityMismatch) {
        checks.push(check('lockfile', CHECK_STATUS.FAIL, 'package-lock.json 缺失或无法解析。', {
            code: ERROR_CODES.LOCKFILE_INVALID,
            path: lockPath,
            detail: lockResult.error?.message || (lockIdentityMismatch ? 'Root package identity differs from package.json.' : null),
        }));
    } else {
        checks.push(check('lockfile', CHECK_STATUS.PASS, `package-lock.json v${lockResult.value.lockfileVersion} 可读取。`));
    }

    const nodeModulesPath = path.join(root, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
        checks.push(check('dependencies', CHECK_STATUS.FAIL, 'node_modules 不存在；M2 不会自动安装依赖。', {
            code: ERROR_CODES.DEPENDENCY_MISSING,
            path: nodeModulesPath,
        }));
    } else {
        const requiredModules = ['electron', ...NATIVE_MODULES];
        const missing = requiredModules.filter(moduleId => !resolveModule(moduleId, root));
        if (missing.length) {
            checks.push(check('dependencies', CHECK_STATUS.FAIL, `依赖不完整：${missing.join(', ')}`, {
                code: ERROR_CODES.DEPENDENCY_MISSING,
                missing,
            }));
        } else {
            checks.push(check('dependencies', CHECK_STATUS.PASS, '核心 JavaScript 和原生模块入口均可解析。'));
        }
    }

    const electronBinary = resolveElectronBinary(root);
    if (!electronBinary || !fs.existsSync(electronBinary)) {
        checks.push(check('electron', CHECK_STATUS.FAIL, '项目内 Electron binary 不存在。', {
            code: ERROR_CODES.DEPENDENCY_MISSING,
            path: electronBinary,
        }));
    } else {
        checks.push(check('electron', CHECK_STATUS.PASS, '项目内 Electron binary 可定位。', { path: electronBinary }));
    }

    if (deep) {
        if (!electronBinary || !fs.existsSync(electronBinary)) {
            checks.push(check('native-abi', CHECK_STATUS.SKIP, 'Electron binary 缺失，未重复执行原生模块 ABI probe。'));
        } else {
            const result = probeNativeModules({ projectRoot: root, electronBinary, spawn, env });
            checks.push(result.ok
                ? check('native-abi', CHECK_STATUS.PASS, '原生模块可在当前 Electron Node ABI 中加载。')
                : check('native-abi', CHECK_STATUS.FAIL, '原生模块无法在当前 Electron Node ABI 中加载。', {
                    code: ERROR_CODES.NATIVE_ABI_MISMATCH,
                    detail: result.error,
                }));
        }
    } else {
        checks.push(check('native-abi', CHECK_STATUS.SKIP, '未执行 Electron 原生模块深度 probe；使用 --deep 启用。'));
    }

    const rustExecutable = platform === 'win32' ? 'vcp_chat_data_service.exe' : 'vcp_chat_data_service';
    const rustPath = path.join(root, 'modules', 'services', 'chatDataService', 'bin', `${platform}-${arch}`, rustExecutable);
    if (!fs.existsSync(rustPath)) {
        checks.push(check('rust-runtime', CHECK_STATUS.WARN, 'VCP-CDS shadow runtime 不存在；主聊天仍可降级启动。', {
            code: ERROR_CODES.RUST_RUNTIME_MISSING,
            path: rustPath,
            optional: true,
        }));
    } else {
        let executable = true;
        if (platform !== 'win32') {
            try { fs.accessSync(rustPath, fs.constants.X_OK); } catch { executable = false; }
        }
        checks.push(executable
            ? check('rust-runtime', CHECK_STATUS.PASS, 'VCP-CDS shadow runtime 存在且权限可用。', { path: rustPath })
            : check('rust-runtime', CHECK_STATUS.WARN, 'VCP-CDS shadow runtime 不可执行；主聊天仍可降级启动。', {
                code: ERROR_CODES.RUST_RUNTIME_INVALID,
                path: rustPath,
                optional: true,
            }));
    }

    const audioExecutable = platform === 'win32' ? 'audio_server.exe' : 'audio_server';
    const audioPath = path.join(root, 'audio_engine', 'bin', `${platform}-${arch}`, audioExecutable);
    if (!fs.existsSync(audioPath)) {
        checks.push(check('audio-runtime', CHECK_STATUS.WARN, '当前平台的 Rust audio runtime 不存在；音乐播放会降级。', {
            code: ERROR_CODES.AUDIO_RUNTIME_MISSING,
            path: audioPath,
            optional: true,
        }));
    } else {
        const executable = platform === 'win32' || canAccess(audioPath, fs.constants.X_OK);
        checks.push(executable
            ? check('audio-runtime', CHECK_STATUS.PASS, 'Rust audio runtime 存在且权限可用。', { path: audioPath })
            : check('audio-runtime', CHECK_STATUS.WARN, 'Rust audio runtime 不可执行；音乐播放会降级。', {
                code: ERROR_CODES.AUDIO_RUNTIME_INVALID,
                path: audioPath,
                optional: true,
            }));
    }

    const vendorRoot = path.join(root, 'vendor', 'webawesome-runtime');
    const vendorManifest = path.join(root, 'modules', 'ui-system', 'webawesome-runtime-manifest.js');
    if (fs.existsSync(vendorRoot) && fs.existsSync(vendorManifest)) {
        checks.push(check('vendor-closure', CHECK_STATUS.PASS, 'Web Awesome 离线 runtime 与 manifest 存在。'));
    } else {
        checks.push(check('vendor-closure', CHECK_STATUS.WARN, 'Web Awesome 离线 runtime 闭包不完整；核心控件可回退但视觉能力可能降级。', {
            code: ERROR_CODES.VENDOR_CLOSURE_INVALID,
            optional: true,
        }));
    }

    const stateRoot = resolveStateRoot({ env, platform });
    const stateAncestor = findExistingAncestor(stateRoot);
    const appDataRoot = env.VCPCHAT_APP_DATA_DIR?.trim()
        ? path.resolve(env.VCPCHAT_APP_DATA_DIR.trim())
        : path.join(root, 'AppData');
    const appDataTarget = fs.existsSync(appDataRoot) ? appDataRoot : root;
    if (stateAncestor && canAccess(stateAncestor, fs.constants.W_OK) && canAccess(appDataTarget, fs.constants.R_OK | fs.constants.W_OK)) {
        checks.push(check('filesystem', CHECK_STATUS.PASS, 'Bootstrap state 与项目 AppData 的现有父目录权限可用。', {
            stateRoot,
            appDataRoot,
        }));
    } else {
        checks.push(check('filesystem', CHECK_STATUS.FAIL, 'Bootstrap state 或项目 AppData 的目录权限不足。', {
            code: ERROR_CODES.PROJECT_INCOMPLETE,
            stateRoot,
            stateAncestor,
            appDataRoot,
        }));
    }
    const operation = inspectOperationLock(stateRoot);
    checks.push(operation.state === 'busy'
        ? check('operation-lock', CHECK_STATUS.WARN, `另一个 Bootstrap 操作正在运行（PID ${operation.record.pid}）。`, {
            code: ERROR_CODES.OPERATION_BUSY,
            stateRoot,
            lock: operation.record,
        })
        : operation.state === 'stale'
            ? check('operation-lock', CHECK_STATUS.WARN, '发现陈旧 Bootstrap 锁；Managed Launcher 可在取得所有权前清理。', {
                code: ERROR_CODES.OPERATION_STALE_LOCK,
                stateRoot,
                lock: operation.record,
            })
            : check('operation-lock', CHECK_STATUS.PASS, 'Bootstrap 操作锁空闲。', { stateRoot }));

    const summary = summarize(checks);
    return {
        schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
        ok: summary.fail === 0,
        generatedAt: new Date(now).toISOString(),
        projectRoot: root,
        platform,
        arch,
        checks,
        summary,
    };
}

module.exports = {
    NATIVE_MODULES,
    MINIMUM_NODE_MAJOR,
    collectDoctorReport,
    probeNativeModules,
    resolveElectronBinary,
};
