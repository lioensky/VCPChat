// modules/services/gitService.js
// 工作区 Git 源代码管理服务（ProjectForge Git 侧栏的主进程实现）。
// - 只用 execFile('git', [...args]) 数组传参，不经过 shell，不拼接命令字符串。
// - 所有命令在仓库顶层目录执行；文件一律用"仓库根相对路径"（posix 分隔符）传递，
//   并校验必须落在工作区根目录之内。工作区是仓库子目录时，状态只列出该子树。
// - 修改索引 / 工作树 / 提交 / 推送按仓库串行，避免 index.lock 竞争。
// - 不改动任何 git config，不跳过 hooks，不做 force push。
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_PATHS_PER_CALL = 5000;
const DIFF_TEXT_LIMIT = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const ARG_CHUNK_CHARS = 8000; // Windows 命令行上限约 32K，按块拆分路径参数
const DEFAULT_TIMEOUT = 30_000;
const COMMIT_TIMEOUT = 120_000; // 需给 pre-commit hook 留时间
const PUSH_TIMEOUT = 180_000;
const MAX_MESSAGE_CHARS = 20_000;

const IS_WIN = process.platform === 'win32';

// ============================ 基础工具 ============================

function toPosix(p) {
    return String(p).split(path.sep).join('/');
}

function realpathSafe(p) {
    try {
        return fs.realpathSync.native(p);
    } catch (_error) {
        return path.resolve(p);
    }
}

/** path.relative 的结果是否仍在 root 之内（win32 下 path.relative 本身大小写不敏感）。 */
function isInsideRelative(rel) {
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function isInside(root, target) {
    return isInsideRelative(path.relative(root, target));
}

function withinPrefix(relPath, prefix) {
    if (!prefix) return true;
    const a = IS_WIN ? relPath.toLowerCase() : relPath;
    const p = IS_WIN ? prefix.toLowerCase() : prefix;
    return a === p || a.startsWith(`${p}/`);
}

function comparePath(a, b) {
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
}

function runGit(cwd, args, { timeout = DEFAULT_TIMEOUT, input = null } = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile('git', [
            '-c', 'core.quotepath=false',
            '-c', 'color.ui=false',
            '--literal-pathspecs', // 路径按字面匹配，禁用 glob / 魔法前缀
            ...args,
        ], {
            cwd,
            timeout,
            maxBuffer: MAX_BUFFER,
            windowsHide: true,
            encoding: 'buffer',
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0', // 没有终端可交互，缺凭据时直接失败而不是挂起
                GIT_OPTIONAL_LOCKS: '0', // status 刷新不抢 index.lock
            },
        }, (error, stdout, stderr) => {
            if (error) {
                const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : '';
                let message = detail || error.message;
                if (error.code === 'ENOENT') message = '未找到 git 可执行文件，请确认已安装 Git 并加入 PATH。';
                else if (error.killed) message = `git ${args[0]} 执行超时。`;
                const wrapped = new Error(message);
                wrapped.code = error.code;
                reject(wrapped);
                return;
            }
            resolve({ stdout, stderr });
        });
        if (input !== null) child.stdin?.end(input);
        else child.stdin?.end();
    });
}

// ============================ porcelain v2 解析 ============================

/** 取前 count 个空格分隔字段，剩余部分（可能含空格的路径）原样返回。 */
function takeFields(record, count) {
    const fields = [];
    let cursor = 0;
    for (let i = 0; i < count; i += 1) {
        const next = record.indexOf(' ', cursor);
        if (next === -1) return null;
        fields.push(record.slice(cursor, next));
        cursor = next + 1;
    }
    return { fields, rest: record.slice(cursor) };
}

/** 解析 `git status --porcelain=v2 -z --branch` 输出。 */
function parsePorcelainV2(buffer) {
    const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
    const records = text.split('\0');
    const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 };
    const entries = [];

    for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (!record) continue;
        const kind = record[0];

        if (kind === '#') {
            const [, key, ...rest] = record.split(' ');
            const value = rest.join(' ');
            if (key === 'branch.oid') branch.oid = value;
            else if (key === 'branch.head') branch.head = value;
            else if (key === 'branch.upstream') branch.upstream = value;
            else if (key === 'branch.ab') {
                const match = /^\+(\d+) -(\d+)$/.exec(value);
                if (match) {
                    branch.ahead = Number(match[1]);
                    branch.behind = Number(match[2]);
                }
            }
            continue;
        }

        if (kind === '?') {
            entries.push({ kind: 'untracked', path: record.slice(2), x: '?', y: '?' });
            continue;
        }

        if (kind === '1') {
            // 1 XY sub mH mI mW hH hI path
            const parsed = takeFields(record, 8);
            if (parsed) entries.push({ kind: 'ordinary', path: parsed.rest, x: parsed.fields[1][0], y: parsed.fields[1][1] });
            continue;
        }

        if (kind === '2') {
            // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
            const parsed = takeFields(record, 9);
            const origPath = records[i + 1] || '';
            i += 1;
            if (parsed) {
                entries.push({ kind: 'renamed', path: parsed.rest, origPath, x: parsed.fields[1][0], y: parsed.fields[1][1] });
            }
            continue;
        }

        if (kind === 'u') {
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            const parsed = takeFields(record, 10);
            if (parsed) entries.push({ kind: 'unmerged', path: parsed.rest, x: parsed.fields[1][0], y: parsed.fields[1][1] });
        }
        // '!'（已忽略）不请求，也不处理
    }

    return { branch, entries };
}

/** 按 VS Code 的分组方式整理：合并冲突 / 已暂存 / 更改（含未跟踪）。 */
function groupEntries(entries) {
    const staged = [];
    const changes = [];
    const conflicts = [];
    for (const entry of entries) {
        if (entry.kind === 'unmerged') {
            conflicts.push({ path: entry.path, status: `${entry.x}${entry.y}` });
            continue;
        }
        if (entry.kind === 'untracked') {
            changes.push({ path: entry.path, status: 'U', untracked: true });
            continue;
        }
        if (entry.x !== '.') {
            staged.push({ path: entry.path, origPath: entry.origPath || null, status: entry.x });
        }
        if (entry.y !== '.') {
            changes.push({ path: entry.path, origPath: entry.x === '.' ? (entry.origPath || null) : null, status: entry.y });
        }
    }
    staged.sort(comparePath);
    changes.sort(comparePath);
    conflicts.sort(comparePath);
    return { staged, changes, conflicts };
}

// ============================ 仓库上下文与路径校验 ============================

async function openRepository(workspaceRoot) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) throw new Error('缺少工作区根目录。');
    const root = realpathSafe(path.resolve(workspaceRoot));
    let top;
    try {
        const { stdout } = await runGit(root, ['rev-parse', '--show-toplevel']);
        top = stdout.toString('utf8').trim();
    } catch (error) {
        if (/not a git repository|不是\s*git\s*仓库/i.test(error.message)) return null;
        throw error;
    }
    const toplevel = realpathSafe(path.resolve(top));
    return { root, toplevel, prefix: toPosix(path.relative(toplevel, root)) };
}

async function requireRepository(workspaceRoot) {
    const repo = await openRepository(workspaceRoot);
    if (!repo) throw new Error('该工作区不是 Git 仓库。');
    return repo;
}

/**
 * 把调用方给出的仓库相对路径规范化并校验。
 * scope='workspace'（默认）要求落在工作区根内；scope='repo' 只要求在仓库内（仅用于只读 diff 的重命名源）。
 */
function resolveRepoPath(repo, relPath, { scope = 'workspace' } = {}) {
    if (typeof relPath !== 'string' || !relPath.trim() || relPath.includes('\0')) {
        throw new Error('无效的文件路径。');
    }
    const normalized = IS_WIN ? relPath.replace(/\\/g, '/') : relPath;
    if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
        throw new Error(`必须使用仓库相对路径: ${relPath}`);
    }
    const abs = path.resolve(repo.toplevel, normalized);
    const boundary = scope === 'repo' ? repo.toplevel : repo.root;
    const relToBoundary = path.relative(boundary, abs);
    if (relToBoundary === '' || !isInsideRelative(relToBoundary)) {
        throw new Error(`路径不在工作区内: ${relPath}`);
    }
    const rel = toPosix(path.relative(repo.toplevel, abs));
    if (rel.split('/').some(segment => segment.toLowerCase() === '.git')) {
        throw new Error(`不允许操作 .git 目录: ${relPath}`);
    }
    return rel;
}

function resolveRepoPaths(repo, list) {
    if (!Array.isArray(list) || !list.length) throw new Error('请至少选择一个文件。');
    if (list.length > MAX_PATHS_PER_CALL) throw new Error(`单次最多操作 ${MAX_PATHS_PER_CALL} 个文件。`);
    return [...new Set(list.map(item => resolveRepoPath(repo, item)))];
}

/** 仓库相对路径 → 磁盘绝对路径；父目录经符号链接逃出仓库时拒绝。 */
function absoluteInRepo(repo, rel) {
    const abs = path.join(repo.toplevel, ...rel.split('/'));
    if (!isInside(repo.toplevel, realpathSafe(path.dirname(abs)))) {
        throw new Error(`路径经符号链接指向仓库之外: ${rel}`);
    }
    return abs;
}

function chunkPaths(paths) {
    const chunks = [];
    let current = [];
    let size = 0;
    for (const item of paths) {
        if (current.length && size + item.length + 1 > ARG_CHUNK_CHARS) {
            chunks.push(current);
            current = [];
            size = 0;
        }
        current.push(item);
        size += item.length + 1;
    }
    if (current.length) chunks.push(current);
    return chunks;
}

async function runForPaths(repo, baseArgs, paths) {
    for (const chunk of chunkPaths(paths)) {
        await runGit(repo.toplevel, [...baseArgs, '--', ...chunk]);
    }
}

const repoLocks = new Map();

function withRepoLock(repo, fn) {
    const key = IS_WIN ? repo.toplevel.toLowerCase() : repo.toplevel;
    const previous = repoLocks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    repoLocks.set(key, tail);
    tail.then(() => {
        if (repoLocks.get(key) === tail) repoLocks.delete(key);
    });
    return run;
}

async function headExists(repo) {
    try {
        await runGit(repo.toplevel, ['rev-parse', '--verify', '-q', 'HEAD']);
        return true;
    } catch (_error) {
        return false;
    }
}

async function listRemotes(repo) {
    try {
        const { stdout } = await runGit(repo.toplevel, ['remote']);
        return stdout.toString('utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch (_error) {
        return [];
    }
}

// ============================ 状态 ============================

async function readStatus(repo) {
    const args = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'];
    if (repo.prefix) args.push('--', repo.prefix);
    const [{ stdout }, remotes] = await Promise.all([runGit(repo.toplevel, args), listRemotes(repo)]);
    const { branch, entries } = parsePorcelainV2(stdout);
    const truncated = entries.length > MAX_ENTRIES;
    const groups = groupEntries(truncated ? entries.slice(0, MAX_ENTRIES) : entries);
    return {
        isRepo: true,
        root: repo.root,
        toplevel: repo.toplevel,
        prefix: repo.prefix,
        branch: {
            head: branch.head,
            oid: branch.oid,
            upstream: branch.upstream,
            ahead: branch.ahead,
            behind: branch.behind,
            detached: branch.head === '(detached)',
            initial: branch.oid === '(initial)',
        },
        remotes,
        ...groups,
        total: entries.length,
        truncated,
    };
}

async function getStatus(workspaceRoot) {
    const repo = await openRepository(workspaceRoot);
    if (!repo) return { isRepo: false, root: path.resolve(workspaceRoot) };
    return readStatus(repo);
}

/** 串行执行写操作，完成后附带最新状态返回，前端一次往返即可刷新。 */
async function mutate(workspaceRoot, fn) {
    const repo = await requireRepository(workspaceRoot);
    return withRepoLock(repo, async () => {
        const extra = await fn(repo);
        const status = await readStatus(repo);
        return { ...(extra || {}), status };
    });
}

// ============================ 暂存 / 取消暂存 / 放弃 ============================

function stage(workspaceRoot, paths) {
    return mutate(workspaceRoot, async repo => {
        // -A 让删除也能被暂存
        await runForPaths(repo, ['add', '-A'], resolveRepoPaths(repo, paths));
    });
}

function unstage(workspaceRoot, paths) {
    return mutate(workspaceRoot, async repo => {
        const list = resolveRepoPaths(repo, paths);
        if (await headExists(repo)) {
            await runForPaths(repo, ['restore', '--staged'], list);
        } else {
            // 尚无提交时 restore --staged 无法解析 HEAD，改为只从索引移除
            await runForPaths(repo, ['rm', '--cached', '-r', '-q'], list);
        }
    });
}

/**
 * 放弃更改：已跟踪文件恢复到索引版本（不可逆）；未跟踪文件交给 removeUntracked 处理
 * （IPC 层传入 shell.trashItem，移到回收站）。
 */
function discard(workspaceRoot, paths, { removeUntracked = null } = {}) {
    return mutate(workspaceRoot, async repo => {
        const list = resolveRepoPaths(repo, paths);
        const current = await readStatus(repo);
        const untracked = new Set(current.changes.filter(c => c.untracked).map(c => c.path));
        const tracked = list.filter(item => !untracked.has(item));
        const toRemove = list.filter(item => untracked.has(item));
        if (tracked.length) await runForPaths(repo, ['restore', '--worktree'], tracked);
        const remover = typeof removeUntracked === 'function'
            ? removeUntracked
            : abs => fs.promises.rm(abs, { force: true });
        for (const rel of toRemove) {
            await remover(absoluteInRepo(repo, rel));
        }
        return { restored: tracked.length, removed: toRemove.length };
    });
}

// ============================ 提交 / 推送 ============================

function commit(workspaceRoot, { message } = {}) {
    const text = typeof message === 'string' ? message.replace(/\r\n/g, '\n').trim() : '';
    if (!text) return Promise.reject(new Error('请填写提交信息。'));
    if (text.length > MAX_MESSAGE_CHARS) return Promise.reject(new Error(`提交信息过长（上限 ${MAX_MESSAGE_CHARS} 字符）。`));

    return mutate(workspaceRoot, async repo => {
        // git commit 提交的是整个索引，所以检查全仓库的暂存内容，而不只是工作区子树
        const { stdout } = await runGit(repo.toplevel, ['diff', '--cached', '--name-only', '-z']);
        const stagedAll = stdout.toString('utf8').split('\0').filter(Boolean);
        if (!stagedAll.length) throw new Error('没有已暂存的更改。请先暂存要提交的文件。');
        const outside = stagedAll.filter(item => !withinPrefix(item, repo.prefix));
        if (outside.length) {
            throw new Error(`仓库中还有 ${outside.length} 个工作区之外的已暂存文件（如 ${outside[0]}），为避免误提交已中止。`);
        }
        // --cleanup=whitespace：保留以 # 开头的行（如 "#12 修复…"），只清理首尾空白
        await runGit(repo.toplevel, ['commit', '-F', '-', '--cleanup=whitespace'], {
            input: `${text}\n`,
            timeout: COMMIT_TIMEOUT,
        });
        const head = await runGit(repo.toplevel, ['rev-parse', '--short', 'HEAD']);
        return { commit: head.stdout.toString('utf8').trim() };
    });
}

async function push(workspaceRoot, { setUpstream = false } = {}) {
    const repo = await requireRepository(workspaceRoot);
    return withRepoLock(repo, async () => {
        const { branch, remotes } = await readStatus(repo);
        if (branch.detached) throw new Error('当前处于分离 HEAD 状态，无法推送。');
        if (branch.initial) throw new Error('当前分支还没有任何提交。');

        let args;
        let remote = null;
        if (branch.upstream) {
            args = ['push'];
        } else {
            if (!remotes.length) throw new Error('仓库没有配置任何远端。');
            if (!setUpstream) {
                const error = new Error('当前分支没有上游分支。');
                error.code = 'NO_UPSTREAM';
                throw error;
            }
            remote = remotes.includes('origin') ? 'origin' : remotes[0];
            args = ['push', '-u', remote, 'HEAD'];
        }
        const result = await runGit(repo.toplevel, args, { timeout: PUSH_TIMEOUT });
        const output = `${result.stderr.toString('utf8')}${result.stdout.toString('utf8')}`.trim();
        return { output, remote, status: await readStatus(repo) };
    });
}

// ============================ Diff ============================

function missingContent() {
    return { exists: false, binary: false, text: '', size: 0, truncated: false };
}

function describeContent(buffer) {
    const size = buffer.length;
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        return { exists: true, binary: true, text: '', size, truncated: false };
    }
    const truncated = size > DIFF_TEXT_LIMIT;
    const text = (truncated ? buffer.subarray(0, DIFF_TEXT_LIMIT) : buffer).toString('utf8');
    return { exists: true, binary: false, text, size, truncated };
}

async function readBlob(repo, spec) {
    try {
        const { stdout } = await runGit(repo.toplevel, ['cat-file', 'blob', spec]);
        return describeContent(stdout);
    } catch (error) {
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            return { exists: true, binary: true, text: '', size: MAX_BUFFER, truncated: true, tooLarge: true };
        }
        return missingContent();
    }
}

async function readIndexBlob(repo, rel) {
    const stage0 = await readBlob(repo, `:${rel}`);
    // 冲突文件没有 stage 0，退回到 ours（stage 2）
    return stage0.exists ? stage0 : readBlob(repo, `:2:${rel}`);
}

async function readWorktree(repo, rel) {
    let abs;
    try {
        abs = absoluteInRepo(repo, rel);
        const stat = await fs.promises.lstat(abs);
        // git 把符号链接存成链接文本，这里保持一致，也不跟随链接读出仓库外的内容
        if (stat.isSymbolicLink()) return describeContent(Buffer.from(await fs.promises.readlink(abs), 'utf8'));
        if (!stat.isFile()) return missingContent();
        if (stat.size > MAX_BUFFER) {
            return { exists: true, binary: true, text: '', size: stat.size, truncated: true, tooLarge: true };
        }
        return describeContent(await fs.promises.readFile(abs));
    } catch (_error) {
        return missingContent();
    }
}

/**
 * staged=true：HEAD ↔ 索引；staged=false：索引 ↔ 工作树（未跟踪文件左侧为空）。
 * origPath 为重命名源路径，只读，允许位于工作区之外。
 */
async function getDiff(workspaceRoot, relPath, { staged = false, origPath = null } = {}) {
    const repo = await requireRepository(workspaceRoot);
    const rel = resolveRepoPath(repo, relPath);
    const origRel = origPath ? resolveRepoPath(repo, origPath, { scope: 'repo' }) : null;
    const baseRel = origRel || rel;
    const [before, after] = staged
        ? await Promise.all([readBlob(repo, `HEAD:${baseRel}`), readIndexBlob(repo, rel)])
        : await Promise.all([readIndexBlob(repo, baseRel), readWorktree(repo, rel)]);
    return { path: rel, origPath: origRel, staged: Boolean(staged), before, after };
}

module.exports = {
    getStatus,
    getDiff,
    stage,
    unstage,
    discard,
    commit,
    push,
    // 供测试使用
    parsePorcelainV2,
    groupEntries,
    resolveRepoPath,
    chunkPaths,
};