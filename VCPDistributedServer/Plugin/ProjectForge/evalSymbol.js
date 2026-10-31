'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const A = require('./args');
const runner = require('./evalProcess');

async function exists(file) {
    try { return (await fs.stat(file)).isFile(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function configOf(root) {
    const file = path.join(root, '.projectforge-eval.json');
    if (!await exists(file)) return {};
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('.projectforge-eval.json must contain an object');
    }
    return value;
}

function executable(value, root) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Runtime executable must be a nonempty string');
    return /[\\/]/.test(value) ? path.resolve(root, value) : value;
}

async function planRuntime(root, language, config) {
    if (language === 'javascript') {
        return {
            executable: config.node ? executable(config.node, root) : process.execPath,
            source: config.node ? 'project-config' : 'host-node-mode',
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
        };
    }
    if (config.python) return {
        executable: executable(config.python, root), source: 'project-config', env: process.env,
    };
    const candidates = [
        path.join(root, '.venv', 'Scripts', 'python.exe'),
        path.join(root, '.venv', 'bin', 'python'),
    ];
    for (const candidate of candidates) {
        if (await exists(candidate)) return { executable: candidate, source: 'project-venv', env: process.env };
    }
    return {
        executable: process.platform === 'win32' ? 'python.exe' : 'python3',
        source: 'PATH', env: process.env,
    };
}

function parseOptions(args, language) {
    const positional = A.json(args.args, 'args', []);
    const kwargs = A.json(args.kwargs, 'kwargs', {});
    if (!Array.isArray(positional)) throw new Error('args must be a JSON array');
    if (!kwargs || typeof kwargs !== 'object' || Array.isArray(kwargs)) throw new Error('kwargs must be a JSON object');
    const setup = args.setup === undefined ? undefined : String(args.setup);
    if (setup !== undefined && args.args !== undefined) throw new Error('setup and args are mutually exclusive');
    if (language !== 'python' && args.kwargs !== undefined) throw new Error('kwargs is only supported for Python');
    const timeoutMs = args.timeoutms === undefined ? (language === 'rust' ? 100000 : 5000) : Number(args.timeoutms);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 110000) {
        throw new Error('timeoutMs must be an integer in 1..110000 (tool transport deadline is 120s)');
    }
    return { args: positional, kwargs, ...(setup !== undefined ? { setup } : {}), timeoutMs };
}

function languageOf(file) {
    const ext = path.extname(file).toLowerCase();
    if (['.js', '.mjs', '.cjs'].includes(ext)) return 'javascript';
    if (ext === '.py') return 'python';
    if (ext === '.rs') return 'rust';
    return null;
}

async function evaluate({ root, file, symbol, sourceHash, args }) {
    const language = languageOf(file);
    if (!language) return { status: 'unsupported', error: { message: 'Supported: JS/CJS/ESM, Python, Rust existing tests. TS requires a future explicit loader.' } };
    let options;
    let config;
    try {
        options = parseOptions(args, language);
        config = await configOf(root);
    } catch (error) {
        return { status: 'invalid_arguments', error: { message: error.message } };
    }
    const base = { language, symbol, sourceHash, timeoutMs: options.timeoutMs };
    if (language === 'rust') {
        return { ...base, ...await require('./evalRust').evaluate({ root, file, symbol, sourceHash, args, options, config }) };
    }
    let temp;
    try {
        const runtime = await planRuntime(root, language, config);
        const request = { file, symbol, sourceHash, ...options };
        let worker;
        let argv;
        if (language === 'javascript') {
            worker = path.join(__dirname, 'evalWorker.cjs');
            argv = [worker];
        } else {
            temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-eval-'));
            request.resultFile = path.join(temp, 'result.json');
            worker = path.join(__dirname, 'evalWorker.py');
            argv = ['-B', '-u', worker];
        }
        const processResult = await runner.runProcess(runtime.executable, argv, {
            cwd: root, env: runtime.env, input: JSON.stringify(request),
            timeoutMs: options.timeoutMs, resultChannel: language === 'javascript',
        });
        const evidence = {
            durationMs: processResult.durationMs,
            exitCode: processResult.exitCode,
            runtime: { executable: runtime.executable, source: runtime.source },
            logs: { stdout: processResult.stdout, stderr: processResult.stderr },
        };
        if (processResult.status !== 'exited') return {
            ...base, ...evidence, status: processResult.status, error: processResult.error,
        };
        let wire;
        if (language === 'javascript') wire = processResult.result.text;
        else if (await exists(request.resultFile)) {
            const info = await fs.stat(request.resultFile);
            if (info.size > runner.RESULT_LIMIT) return { ...base, ...evidence, status: 'result_limit' };
            wire = await fs.readFile(request.resultFile, 'utf8');
        }
        let result;
        try {
            result = JSON.parse(wire || '');
            if (!result || typeof result.status !== 'string') throw new Error('Invalid worker response');
            if ((result.status === 'returned') !== (processResult.exitCode === 0)) throw new Error('Worker exit/result mismatch');
        } catch (error) {
            return { ...base, ...evidence, status: 'protocol_error', error: { message: error.message } };
        }
        return { ...base, ...evidence, ...result, runtime: { ...evidence.runtime, ...result.runtime } };
    } catch (error) {
        return { ...base, status: 'environment_error', error: { message: error.message } };
    } finally {
        if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    }
}

function render(result, rel) {
    const lines = [`## EvalSymbol · ${result.status}`, `- ${rel}#${result.symbol || ''} · ${result.language || 'unknown'} · ${result.durationMs ?? 0} ms`];
    if (result.value !== undefined) lines.push(`- value (typed-v1): ${JSON.stringify(result.value).slice(0, 2000)}`);
    if (result.checks) lines.push(`- checks: ${result.checks.passed} passed / ${result.checks.failed} failed`);
    if (result.error) lines.push(`- ${result.stage || 'error'}: ${result.error.message}`);
    if (result.candidates) lines.push(`- candidates: ${JSON.stringify(result.candidates)}`);
    if (result.runtime) lines.push(`- runtime: ${JSON.stringify(result.runtime)}`);
    if (result.sourceHash) lines.push(`- target source: ${result.sourceHash.slice(0, 12)} (not dependency fingerprint)`);
    for (const [name, log] of Object.entries(result.logs || {})) {
        if (log.truncated) lines.push(`- ${name}: truncated (${log.bytes} bytes)`);
        if (!['returned', 'passed'].includes(result.status) && log.text) lines.push(`- ${name}: ${log.text.slice(-3000)}`);
    }
    if (result.value !== undefined && JSON.stringify(result.value).length > 2000) lines.push('- value preview truncated; full typed value is in details');
    return lines.join('\n');
}

module.exports = { evaluate, render, languageOf, parseOptions, planRuntime, cleanup: runner.cleanup };