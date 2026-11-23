'use strict';
// Trusted project shell execution. This is NOT a security sandbox.
// Authorization (writable project / projectId / tool policy) must be checked by the caller
// before runBash() is invoked. This module only owns the process-level guarantees:
// Git Bash discovery, cwd containment, env scrubbing, non-interactive stdin,
// real exit/timeout tree accounting, tail inline output and complete spill files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runner = require('./evalProcess');
const { isPathInside, toPosixRelative } = require('../../shared/fileKit/paths');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 110_000; // approved tool transport deadline
const DEFAULT_MAX_BYTES = runner.OUTPUT_LIMIT;

const GIT_BASH_CANDIDATES = Object.freeze([
    'E:/App/Git/usr/bin/bash.exe',
    'E:/App/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/usr/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
]);

const DROP_ENV = new Set([
    'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'BASH_XTRACEFD', 'CDPATH',
    'PROMPT_COMMAND', 'GLOBIGNORE', 'NODE_OPTIONS', 'NODE_PATH',
    'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'PWD', 'OLDPWD', 'SHLVL', '_',
]);
const SENSITIVE_ENV = /(^|_)(.*_)?(KEY|PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIALS?)($|_)/i;
const ENV_OVERRIDES = Object.freeze({
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: 'echo',
    SSH_ASKPASS: 'echo',
    SSH_ASKPASS_REQUIRE: 'never',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PIP_NO_INPUT: '1',
    DEBIAN_FRONTEND: 'noninteractive',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    MSYS: 'disable_pcon',
});

function fail(code, message) {
    throw Object.assign(new Error(message), { code });
}

function isAsarPath(file) {
    return String(file).split(/[\\/]+/u).some(part => /\.asar$/iu.test(part));
}

function isWslLauncher(file) {
    const normalized = String(file).replace(/\\/gu, '/');
    return /\/(?:system32|syswow64)\/bash\.exe$/iu.test(normalized)
        || /\/windowsapps\/.*bash\.exe$/iu.test(normalized);
}

function validateNativePath(raw, label) {
    if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) {
        fail('BASH_PATH', `${label} must be a nonempty path without NUL`);
    }
    if (process.platform === 'win32') {
        if (/^[a-z]:(?:$|[^\\/])/iu.test(raw)) {
            fail('BASH_DRIVE_RELATIVE', `${label} must not be a drive-relative path: ${raw}`);
        }
        if (/^[\\/]{2}/u.test(raw)) {
            fail('BASH_UNC_UNSUPPORTED', `${label} must be a local drive path, not UNC/device: ${raw}`);
        }
        if (/^[\\/]/u.test(raw)) {
            fail('BASH_ROOT_RELATIVE', `${label} must use a drive letter on Windows: ${raw}`);
        }
    }
    if (isAsarPath(raw)) fail('BASH_ASAR', `${label} is inside an asar archive: ${raw}`);
}

function resolveRoot(root) {
    if (typeof root !== 'string' || !root.trim() || root.includes('\0')) {
        fail('BASH_ROOT', 'root must be a nonempty path without NUL');
    }
    validateNativePath(root, 'root');
    if (!path.isAbsolute(root)) fail('BASH_ROOT', `root must be absolute: ${root}`);
    const absolute = path.resolve(root);
    let stat;
    try {
        stat = fs.statSync(absolute);
    } catch (error) {
        fail('BASH_ROOT_NOT_FOUND', `cannot access root ${absolute}: ${error.code}`);
    }
    if (!stat.isDirectory()) fail('BASH_ROOT_NOT_DIRECTORY', `root is not a directory: ${absolute}`);
    let physical;
    try {
        physical = fs.realpathSync.native(absolute);
    } catch (error) {
        fail('BASH_ROOT_NOT_FOUND', `cannot resolve root ${absolute}: ${error.code}`);
    }
    validateNativePath(physical, 'root');
    return physical;
}

function resolveWorkdir(rootReal, raw) {
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        fail('BASH_WORKDIR', 'workdir must be a string when provided');
    }
    if (typeof raw === 'string' && !raw.trim()) fail('BASH_WORKDIR', 'workdir must not be empty');
    const requested = raw === undefined || raw === null ? '.' : raw;
    validateNativePath(requested, 'workdir');
    const candidate = path.isAbsolute(requested)
        ? path.resolve(requested)
        : path.resolve(rootReal, ...requested.split(/[/\\]+/u).filter(Boolean));
    let stat;
    try {
        stat = fs.statSync(candidate);
    } catch (error) {
        fail('BASH_WORKDIR_NOT_FOUND', `cannot access workdir ${candidate}: ${error.code}`);
    }
    if (!stat.isDirectory()) fail('BASH_WORKDIR_NOT_DIRECTORY', `workdir is not a directory: ${candidate}`);
    let physical;
    try {
        physical = fs.realpathSync.native(candidate);
    } catch (error) {
        fail('BASH_WORKDIR_NOT_FOUND', `cannot resolve workdir ${candidate}: ${error.code}`);
    }
    validateNativePath(physical, 'workdir');
    if (!isPathInside(physical, rootReal)) {
        fail('BASH_WORKDIR_OUTSIDE', `workdir escapes project root: ${physical} (root ${rootReal})`);
    }
    return { abs: physical, rel: toPosixRelative(rootReal, physical) || '.' };
}

/**
 * bash 可执行文件 basename 判定：接受 bash / bash4 / bash5 / bash-5.2 / bash-static 等，
 * 刻意排除 zsh / fish / dash。runBash 固定使用 `bash --noprofile --norc -c`，
 * 用户登录 shell 的类型不应悄悄改变脚本语义。
 */
function isBashExecutableName(fileName) {
    return /^bash(?:-?[0-9]+(?:\.[0-9]+)*)?(?:-static)?$/u.test(fileName);
}

function bashCandidates(env = process.env) {
    const candidates = [];
    // L2: 类 JAVA_HOME 的根目录环境变量契约（BASH_HOME / PF_SHELL_HOME / GIT_INSTALL_ROOT）
    const homeRoots = [env.BASH_HOME, env.PF_SHELL_HOME, env.GIT_INSTALL_ROOT]
        .filter(v => typeof v === 'string' && v.trim() && !v.includes('\0'))
        .map(v => v.trim());
    if (process.platform === 'win32') {
        for (const root of homeRoots) {
            if (!path.isAbsolute(root)) continue;
            candidates.push(path.join(root, 'usr', 'bin', 'bash.exe'));
            candidates.push(path.join(root, 'bin', 'bash.exe'));
            candidates.push(path.join(root, 'bash.exe'));
        }
        const programDirs = [
            env.ProgramFiles,
            env['ProgramFiles(x86)'],
            env.ProgramW6432,
            env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : null,
        ].filter(Boolean);
        for (const dir of programDirs) {
            candidates.push(path.join(dir, 'Git', 'usr', 'bin', 'bash.exe'));
            candidates.push(path.join(dir, 'Git', 'bin', 'bash.exe'));
        }
        candidates.push(...GIT_BASH_CANDIDATES);
    } else {
        for (const root of homeRoots) {
            if (!path.isAbsolute(root)) continue;
            candidates.push(path.join(root, 'bin', 'bash'));
            candidates.push(path.join(root, 'usr', 'bin', 'bash'));
            candidates.push(path.join(root, 'bash'));
        }
        // 1) 用户声明的登录 shell：仅当它确实是 bash 家族时才采用。
        //    zsh / fish / dash 直接跳过——runBash 用的是 bash 语义（--noprofile --norc -c），
        //    用别的 shell 跑 bash 脚本只会把兼容性问题藏得更深。
        const declaredShell = typeof env.SHELL === 'string'
            ? env.SHELL.trim().split(/\s+/u)[0]
            : '';
        if (declaredShell && path.isAbsolute(declaredShell) &&
            isBashExecutableName(path.basename(declaredShell))) {
            candidates.push(declaredShell);
        }
        // 2) 逐目录扫 PATH：覆盖 NixOS(/run/current-system/sw/bin)、
        //    Homebrew(/opt/homebrew/bin)、nix-env / asdf 等非常规前缀。
        const pathValue = typeof env.PATH === 'string' ? env.PATH : '';
        for (const dir of pathValue.split(path.delimiter)) {
            if (!dir || !path.isAbsolute(dir)) continue;
            candidates.push(path.join(dir, 'bash'));
        }
        // 3) 标准位置兜底，保持对既有部署的兼容。
        candidates.push('/bin/bash', '/usr/bin/bash');
    }
    const seen = new Set();
    return candidates.filter(file => {
        const key = String(file).replace(/\\/gu, '/').toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function resolveBash(executable, env = process.env) {
    const explicit = executable ?? env.PF_BASH ?? env.FORGE_BASH_PATH;
    if (explicit !== undefined && explicit !== null) {
        if (typeof explicit !== 'string' || !explicit.trim() || explicit.includes('\0')) {
            fail('BASH_EXECUTABLE', 'executable must be a nonempty absolute path without NUL');
        }
        validateNativePath(explicit, 'executable');
        if (!path.isAbsolute(explicit)) {
            fail('BASH_EXECUTABLE', `executable must be absolute: ${explicit}`);
        }
        if (isWslLauncher(explicit)) {
            fail('BASH_WSL', `WSL bash launchers are not supported: ${explicit}`);
        }
        // 显式路径的存在性/可执行性不在此处预检：交给 spawn 按系统语义报告。
        // 上游用例为「missing executable is reported as spawn_error by the system」，
        // 提前 fail() 会破坏该契约。
        return explicit;
    }
    for (const candidate of bashCandidates(env)) {
        if (!fs.existsSync(candidate) || isWslLauncher(candidate)) continue;
        return candidate;
    }
    return null;
}

/** Strip host credentials/hooks and other inherited authoring-runtime identity from the child. */
function scrubbedParentEnv(parent = process.env) {
    const env = {};
    for (const [key, value] of Object.entries(parent)) {
        if (value === undefined) continue;
        const upper = key.toUpperCase();
        if (SENSITIVE_ENV.test(key)) continue;
        if (upper.startsWith('VCP_')) continue;
        if (upper.startsWith('BASH_FUNC_')) continue;
        if (DROP_ENV.has(upper)) continue;
        env[key] = String(value);
    }
    return env;
}

function buildEnv(bashPath, parent = process.env) {
    const env = { ...scrubbedParentEnv(parent), ...ENV_OVERRIDES };
    if (process.platform === 'win32') {
        let gitRoot = path.dirname(path.dirname(bashPath));
        if (path.basename(gitRoot).toLowerCase() === 'usr') gitRoot = path.dirname(gitRoot);
        const bins = [
            path.join(gitRoot, 'usr', 'bin'),
            path.join(gitRoot, 'mingw64', 'bin'),
        ].filter(dir => fs.existsSync(dir));
        const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
        const ambient = pathKey ? env[pathKey] : '';
        if (pathKey && pathKey !== 'PATH') delete env[pathKey];
        env.PATH = [...bins, ambient].filter(Boolean).join(path.delimiter);
    }
    env.SHELL = bashPath;
    return env;
}

function abortError(reason, result) {
    const detail = reason instanceof Error ? null : String(reason || '');
    const error = reason instanceof Error
        ? reason
        : new Error(detail ? `runBash aborted: ${detail}` : 'runBash aborted');
    if (!error.code) error.code = 'BASH_ABORTED';
    if (error.name === 'Error') error.name = 'AbortError';
    if (result) error.result = result;
    return error;
}

function validateSignal(signal) {
    if (signal === undefined) return;
    if (signal === null
        || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function') {
        fail('BASH_ARGUMENT', 'signal must be an AbortSignal');
    }
}

/**
 * Run a bash script inside a trusted project root.
 *
 * @param {object} options
 * @param {string} options.root absolute project root; workdir must resolve inside it
 * @param {string} options.script bash script text, executed from a private temp script file
 * @param {string} [options.workdir] relative to root or an absolute path inside root
 * @param {number} [options.timeoutMs=30000] 1..110000; timeout kills the whole process tree
 * @param {number} [options.maxBytes=65536] per-stream inline tail budget, positive integer only
 * @param {string} [options.executable] absolute bash override; otherwise auto-detected Git Bash
 * @param {AbortSignal} [options.signal] cancellation; kills the tree and rejects with BASH_ABORTED
 * @returns {Promise<object>} status/exitCode/signal/timedOut/aborted/cancelled/quiescence/
 *   durationMs/root/workdir/stdout/stderr/bashPath/error (spawn_error when startup fails)
 */
function emptyStream(maxBytes) {
    return {
        text: '',
        bytes: 0,
        maxBytes,
        truncated: false,
        spillPath: null,
        spillStatus: 'not-needed',
    };
}

function spawnErrorResult({ code, message, root, cwd, timeoutMs, maxBytes, bashPath = null }) {
    return {
        status: 'spawn_error',
        exitCode: null,
        signal: null,
        durationMs: 0,
        stdout: emptyStream(maxBytes),
        stderr: emptyStream(maxBytes),
        timedOut: false,
        aborted: false,
        cancelled: false,
        quiescence: 'not-started',
        treeKill: null,
        ok: false,
        root,
        workdir: cwd.abs,
        workdirRelative: cwd.rel,
        bashPath,
        timeoutMs,
        maxBytes,
        error: { code, message },
    };
}

async function runBash(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        fail('BASH_ARGUMENT', 'runBash options must be an object');
    }
    const { root, script, workdir, executable, signal } = options;
    if (typeof script !== 'string' || !script.trim() || script.includes('\0')) {
        fail('BASH_ARGUMENT', 'script must be a nonempty string without NUL');
    }
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
        fail('BASH_ARGUMENT', `timeoutMs must be an integer in 1..${MAX_TIMEOUT_MS}`);
    }
    const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : Number(options.maxBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        fail('BASH_ARGUMENT', 'maxBytes must be a positive integer');
    }
    validateSignal(signal);
    if (signal?.aborted) throw abortError(signal.reason);
    const rootReal = resolveRoot(root);
    const cwd = resolveWorkdir(rootReal, workdir);
    const bashPath = resolveBash(executable);
    if (!bashPath) {
        return spawnErrorResult({
            code: 'BASH_NOT_FOUND',
            message: process.platform === 'win32'
                ? 'Git Bash was not found. Install Git for Windows or set PF_BASH to an absolute bash.exe path.'
                : 'bash was not found. Install bash (e.g. `apt install bash` / `pacman -S bash`), '
                    + 'or set PF_BASH / BASH_EXECUTABLE to an absolute bash path.',
            root: rootReal,
            cwd,
            timeoutMs,
            maxBytes,
        });
    }
    let scriptDir = null;
    try {
        let argv = ['--noprofile', '--norc', '-c', script];
        if (process.platform === 'win32') {
            scriptDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pf-bash-script-'));
            const scriptFile = path.join(scriptDir, 'script.sh');
            await fs.promises.writeFile(scriptFile, script, { encoding: 'utf8', mode: 0o600 });
            argv = ['--noprofile', '--norc', scriptFile.replace(/\\/gu, '/')];
        }
        const result = await runner.runProcess(
            bashPath,
            argv,
            {
                cwd: cwd.abs,
                env: buildEnv(bashPath),
                timeoutMs,
                maxBytes,
                tail: true,
                spill: true,
                spillName: 'bash',
                stdin: 'ignore',
                signal,
                treeKillShell: bashPath,
            },
        );
        const value = {
            ...result,
            status: result.status === 'environment_error' ? 'spawn_error' : result.status,
            ok: result.status === 'exited' && result.exitCode === 0 && !result.signal,
            root: rootReal,
            workdir: cwd.abs,
            workdirRelative: cwd.rel,
            bashPath,
            timeoutMs,
            maxBytes,
        };
        // fd 3 is an eval-worker protocol detail; bash does not use it.
        delete value.result;
        if (result.aborted) throw abortError(signal?.reason, value);
        return value;
    } finally {
        if (scriptDir) {
            try {
                await fs.promises.rm(scriptDir, { recursive: true, force: true });
            } catch {
                // Temp script cleanup is best effort; it must not mask the run receipt.
            }
        }
    }
}

async function cleanup() {
    await runner.cleanup();
}

module.exports = { runBash, cleanup };
