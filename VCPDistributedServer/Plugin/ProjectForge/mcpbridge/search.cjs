'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PLUGIN = path.resolve(__dirname, '../../CodeSearcher');
const WRAPPER = path.join(PLUGIN, 'CodeSearcher.js');
const STDOUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const TIMEOUT = 60000;
const ENV_KEYS = ['MAX_RESULTS', 'IGNORED_FOLDERS', 'ALLOWED_EXTENSIONS'];
const searchTool = {
    name: 'pf_search',
    command: 'SearchCode',
    description: '在已启用工作区中直接使用 CodeSearcher 原生只读检索，无需创建或更改手工项目。workspace 为别名或 id，默认活动工作区；path 为根相对文件/目录，默认 .。默认使用 Rust 正则（非法正则回落字面量），忽略 .env 类文件；include 替代扩展名白名单。为防越界，搜索目标含符号链接/junction 时拒绝（忽略目录除外）。',
    inputSchema: {
        type: 'object', additionalProperties: false, required: ['query'],
        properties: {
            query: { type: 'string', minLength: 1 },
            workspace: { type: 'string', minLength: 1 },
            path: { type: 'string', minLength: 1, default: '.' },
            include: { type: 'string', minLength: 1 },
            isRegex: { type: 'boolean', default: true },
            caseSensitive: { type: 'boolean', default: false },
            wholeWord: { type: 'boolean', default: false },
            contextLines: { type: 'integer', minimum: 0, maximum: 20, default: 2 },
            maxResults: { type: 'integer', minimum: 1, maximum: 500 },
        },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

function validate(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Search arguments must be an object');
    for (const key of Object.keys(args)) {
        const rule = searchTool.inputSchema.properties[key];
        if (!rule) throw new Error(`Unknown search argument: ${key}`);
        const value = args[key];
        if (rule.type === 'integer') {
            if (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum) throw new Error(`Invalid ${key}: expected ${rule.minimum}..${rule.maximum}`);
        } else if (typeof value !== rule.type || (rule.type === 'string' && (!value.trim() || value.includes('\0')))) {
            throw new Error(`Invalid ${key}: expected nonempty ${rule.type}`);
        }
    }
    if (!Object.hasOwn(args, 'query')) throw new Error('query is required');
}

async function pluginEnvironment() {
    const manifest = JSON.parse(await fs.readFile(path.join(PLUGIN, 'plugin-manifest.json'), 'utf8'));
    // The wrapper forwards env verbatim and native does not load plugin config.env.
    // Do not inherit application credentials or unrelated plugin configuration.
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (['systemroot', 'windir', 'path', 'pathext', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'lang', 'lc_all'].includes(key.toLowerCase())) env[key] = value;
    }
    for (const key of ENV_KEYS) env[key] = String(manifest.configSchema[key].default);
    let source;
    try { source = await fs.readFile(path.join(PLUGIN, 'config.env'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const line of (source || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match || !ENV_KEYS.includes(match[1])) continue;
        let value = match[2];
        if (value.startsWith('"') || value.startsWith("'")) {
            const quote = value[0];
            const end = value.indexOf(quote, 1);
            if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) throw new Error('Invalid CodeSearcher config.env quoting');
            value = value.slice(1, end);
        } else value = value.replace(/\s+#.*$/, '').trim();
        env[match[1]] = value;
    }
    // Refuse ambiguous configuration rather than letting native fall back to a
    // different ignore list from the one used by the containment preflight.
    if (!/^\d+$/.test(env.MAX_RESULTS) || Number(env.MAX_RESULTS) < 1 || Number(env.MAX_RESULTS) > 500) throw new Error('Invalid CodeSearcher MAX_RESULTS');
    if (!env.IGNORED_FOLDERS.trim() || !/^[\x20-\x7e]+$/.test(env.IGNORED_FOLDERS)) throw new Error('Invalid CodeSearcher IGNORED_FOLDERS');
    return env;
}

function inside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function searchTarget(config, args, ignored, check) {
    const workspaces = Array.isArray(config.workspaces) ? config.workspaces : [];
    const selector = args.workspace ?? config.activeWorkspaceId;
    const matches = workspaces.filter(ws => ws && (selector === undefined
        ? false
        : [ws.id, ws.alias].some(value => typeof value === 'string' && value.toLowerCase() === String(selector).toLowerCase())));
    if (matches.length !== 1 || matches[0].enabled === false) throw new Error('Unknown, ambiguous or disabled workspace; select an enabled workspace id or alias');
    const workspace = matches[0];
    if (typeof workspace.path !== 'string' || !path.isAbsolute(workspace.path)) throw new Error('Workspace path must be absolute');
    const root = await fs.realpath(workspace.path);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Workspace must be a directory');
    const relative = args.path ?? '.';
    // Check both path dialects, even on Unix; reject ADS and drive-relative paths.
    if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes(':') || relative.split(/[\\/]/).includes('..')) throw new Error('path must be workspace-relative without .. or absolute paths');
    const parts = relative.split(/[\\/]/).filter(part => part && part !== '.');
    let target = root;
    for (const part of parts) {
        check();
        target = path.join(target, part);
        if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Symbolic link/junction paths are not allowed');
    }
    const real = await fs.realpath(target);
    if (!inside(root, real)) throw new Error('Search path escapes workspace');
    // Native skipped a directory junction in a bounded probe, but file-symlink
    // safety is unproven. Fail closed, including links in otherwise excluded
    // file extensions. Skip only actual ignored directories (not links), using
    // the exact effective native IGNORED_FOLDERS; explicit start is never skipped.
    const stack = [target];
    let entries = 0;
    while (stack.length) {
        check();
        const current = stack.pop();
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('Search target contains a symbolic link/junction');
        if (!stat.isDirectory() && !stat.isFile()) throw new Error('Search target contains an unsupported special file');
        if (!inside(root, await fs.realpath(current))) throw new Error('Search target escapes workspace');
        if (!stat.isDirectory()) continue;
        const directory = await fs.opendir(current);
        for await (const entry of directory) {
            check();
            if (++entries > 100000) throw new Error('Search safety scan entry limit exceeded; choose a narrower path');
            if (entry.isDirectory() && ignored.has(entry.name.toLowerCase())) continue;
            stack.push(path.join(current, entry.name));
        }
    }
    return real;
}

function runNative(payload, env, spawnProcess, timeoutMs, register) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnProcess(process.execPath, [WRAPPER], {
                cwd: PLUGIN, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (_) { reject(new Error('Could not start CodeSearcher')); return; }
        let failure;
        let stdoutSize = 0;
        let stderrSize = 0;
        const chunks = [];
        let termination;
        let forceTimer;
        const stop = message => {
            if (failure) return;
            failure = new Error(message);
            // On Windows killing Node alone does not kill its native descendant.
            if (process.platform === 'win32' && Number.isInteger(child.pid)) {
                termination = new Promise(done => {
                    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
                    const timer = setTimeout(() => { killer.kill(); child.kill('SIGKILL'); }, 2000);
                    killer.once('error', () => { child.kill('SIGKILL'); });
                    killer.once('close', () => { clearTimeout(timer); done(); });
                });
            } else {
                child.kill('SIGTERM');
                forceTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
            }
        };
        register(stop);
        const timer = setTimeout(() => stop('CodeSearcher timed out'), Math.max(1, timeoutMs));
        child.stdout.on('data', chunk => {
            stdoutSize += Buffer.byteLength(chunk);
            if (stdoutSize > STDOUT_LIMIT) stop('CodeSearcher stdout exceeded 8 MB');
            else if (!failure) chunks.push(Buffer.from(chunk));
        });
        // Drain stderr without retaining or returning native diagnostic secrets.
        child.stderr.on('data', chunk => {
            stderrSize += Buffer.byteLength(chunk);
            if (stderrSize > STDERR_LIMIT) stop('CodeSearcher stderr exceeded 64 KB');
        });
        child.on('error', () => { failure ||= new Error('Could not start CodeSearcher'); });
        child.stdin.on('error', () => { stop('CodeSearcher stdin failed'); });
        child.once('close', async (code, signal) => {
            clearTimeout(timer);
            clearTimeout(forceTimer);
            await termination;
            register(null);
            if (failure) { reject(failure); return; }
            if (code !== 0 || signal) { reject(new Error('CodeSearcher process failed')); return; }
            try {
                const response = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
                if (response.status !== 'success') throw new Error(typeof response.error === 'string' ? response.error : 'CodeSearcher returned an error');
                const content = response.result?.content;
                if (!Array.isArray(content) || !content.every(part => part?.type === 'text' && typeof part.text === 'string')) throw new Error('Invalid CodeSearcher result');
                resolve({ content: content.map(({ text }) => ({ type: 'text', text })), ...(response.result.isError === true ? { isError: true } : {}) });
            } catch (error) { reject(error instanceof SyntaxError ? new Error('Invalid CodeSearcher JSON response') : error); }
        });
        child.stdin.end(JSON.stringify(payload));
    });
}

function createSearcher(config = {}) {
    const spawnProcess = config.spawnProcess || spawn;
    // Tests may shorten, never expand, the production timeout.
    const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 ? Math.min(TIMEOUT, config.timeoutMs) : TIMEOUT;
    const pending = new Set();
    let closing = false;
    let closingPromise;
    return {
        async search(args) {
            if (closing || pending.size >= 4) return { isError: true, content: [{ type: 'text', text: 'CodeSearcher is closing or busy (maximum 4 searches)' }] };
            const job = { stop: null };
            pending.add(job);
            job.done = (async () => {
                const deadline = Date.now() + timeoutMs;
                const check = () => {
                    if (closing) throw new Error('CodeSearcher is closing');
                    if (Date.now() >= deadline) throw new Error('CodeSearcher timed out');
                };
                try {
                    validate(args);
                    const env = await pluginEnvironment();
                    check();
                    const ignored = new Set(env.IGNORED_FOLDERS.split(',').map(name => name.trim().toLowerCase()).filter(Boolean));
                    const target = await searchTarget(config, args, ignored, check);
                    check();
                    const payload = { query: args.query, search_path: target };
                    for (const [from, to] of Object.entries({ include: 'include', isRegex: 'is_regex', caseSensitive: 'case_sensitive', wholeWord: 'whole_word', contextLines: 'context_lines', maxResults: 'max_results' })) {
                        if (args[from] !== undefined) payload[to] = args[from];
                    }
                    return await runNative(payload, env, spawnProcess, deadline - Date.now(), stop => { job.stop = stop; });
                } catch (error) {
                    return { isError: true, content: [{ type: 'text', text: error.message }] };
                } finally { pending.delete(job); }
            })();
            return job.done;
        },
        close() {
            if (!closingPromise) {
                closing = true;
                const jobs = [...pending];
                for (const job of jobs) job.stop?.('CodeSearcher is closing');
                closingPromise = Promise.all(jobs.map(job => job.done)).then(() => undefined);
            }
            return closingPromise;
        },
    };
}

module.exports = { searchTool, createSearcher };
