'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { runProcess } = require('./evalProcess');

async function evaluate({ root, file, symbol, sourceHash, args, options, config }) {
    if (args.args !== undefined || args.kwargs !== undefined || options.setup !== undefined) {
        return { status: 'unsupported', error: { message: 'Rust v1 runs existing #[test] symbols only; args/setup harness is not implemented.' } };
    }
    const started = performance.now();
    let last;
    const remaining = () => Math.max(1, Math.floor(options.timeoutMs - (performance.now() - started)));
    const run = async (exe, argv, cwd) => {
        if (performance.now() - started >= options.timeoutMs) return { status: 'timeout' };
        last = await runProcess(exe, argv, { cwd, timeoutMs: remaining(), env: { ...process.env, CARGO_TERM_COLOR: 'never' } });
        return last;
    };
    const evidence = () => ({
        durationMs: Math.round(performance.now() - started),
        ...(last ? { exitCode: last.exitCode, logs: { stdout: last.stdout, stderr: last.stderr } } : {}),
    });
    const failure = (status, message) => ({ ...evidence(), status, error: { message } });
    try {
        let dir = path.dirname(file);
        let manifest;
        while (true) {
            const candidate = path.join(dir, 'Cargo.toml');
            try { if ((await fs.stat(candidate)).isFile()) { manifest = candidate; break; } }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (dir === path.resolve(root)) break;
            const parent = path.dirname(dir);
            if (parent === dir || path.relative(root, parent).startsWith('..')) break;
            dir = parent;
        }
        if (!manifest) return failure('environment_error', 'No Cargo.toml between target file and project root');
        const cargo = config.cargo
            ? (/[\\/]/.test(config.cargo) ? path.resolve(root, config.cargo) : config.cargo)
            : 'cargo';
        const flags = ['--manifest-path', manifest, '--offline'];
        if (args.package !== undefined) flags.push('--package', String(args.package));
        if (args.features !== undefined) flags.push('--features', String(args.features));
        // Offline prevents network resolution; Cargo may still generate/update local lock/build artifacts.
        const build = await run(cargo, ['test', ...flags, '--no-run', '--message-format=json'], dir);
        if (build.status !== 'exited') return failure(build.status, build.error?.message || 'Cargo did not complete');
        if (build.exitCode !== 0) return failure('compile_error', 'Cargo test compilation failed (offline); inspect diagnostics');
        if (build.stdout.truncated) return failure('output_limit', 'Cargo artifact list exceeded capture limit; narrow package scope');
        const artifacts = [];
        for (const line of build.stdout.text.split(/\r?\n/)) {
            let msg;
            try { msg = JSON.parse(line); } catch (_) { continue; }
            if (msg.reason === 'compiler-artifact' && msg.profile?.test && msg.executable) {
                if (!artifacts.some(a => a.executable === msg.executable)) artifacts.push(msg);
            }
        }
        artifacts.sort((a, b) => a.executable.localeCompare(b.executable));
        const query = symbol.replace(/\./g, '::');
        const candidates = [];
        for (const artifact of artifacts) {
            if (args.target !== undefined && artifact.target.name !== String(args.target)) continue;
            const entry = path.resolve(artifact.target.src_path);
            const relative = path.relative(path.dirname(entry), file);
            if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
            let moduleParts = [];
            if (path.resolve(file) !== entry) {
                moduleParts = relative.replace(/\.rs$/, '').split(path.sep);
                if (moduleParts.at(-1) === 'mod') moduleParts.pop();
                if (moduleParts.some(part => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) continue;
            }
            const expectedName = [...moduleParts, query].join('::');
            const list = await run(artifact.executable, ['--list', '--format', 'terse'], dir);
            if (list.status !== 'exited') return failure(list.status, 'Listing Rust tests did not complete');
            if (list.exitCode !== 0 || list.stdout.truncated) return failure('protocol_error', 'Cannot obtain a complete Rust test list');
            for (const line of list.stdout.text.split(/\r?\n/)) {
                const match = /^(.*): test$/.exec(line);
                if (match && match[1] === expectedName) {
                    candidates.push({
                        name: match[1], executable: artifact.executable,
                        target: artifact.target.name, packageId: artifact.package_id,
                        source: artifact.target.src_path,
                    });
                }
            }
        }
        // Exact test name takes precedence over suffix matches; otherwise require explicit pick.
        const exact = candidates.filter(c => c.name === query);
        const pool = exact.length ? exact : candidates;
        if (!pool.length) return failure('not_found', 'No existing #[test] matched the conventional file/module path; custom #[path]/include! layouts are unsupported. Zero executed tests is not a pass');
        let candidate;
        if (args.testpick !== undefined) {
            const pick = Number(args.testpick);
            if (!Number.isSafeInteger(pick) || pick < 1 || pick > pool.length) return failure('invalid_arguments', `testPick must be 1..${pool.length}`);
            candidate = pool[pick - 1];
        } else if (pool.length === 1) candidate = pool[0];
        else return {
            ...evidence(), status: 'ambiguous',
            candidates: pool.map((c, i) => ({ testPick: i + 1, name: c.name, target: c.target, packageId: c.packageId })),
            error: { message: 'Multiple compiled tests match; retry with testPick, target or a complete test name' },
        };
        const hash = async () => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
        if (await hash() !== sourceHash) return failure('source_changed', 'Target changed during compilation; retry');
        const executed = await run(candidate.executable, [candidate.name, '--exact', '--nocapture', '--test-threads=1'], dir);
        if (executed.status !== 'exited') return failure(executed.status, 'Rust test execution did not complete');
        if (await hash() !== sourceHash) return failure('source_changed', 'Target changed during execution');
        if (executed.stdout.truncated) return failure('output_limit', 'Test summary was truncated; result not certified');
        const summaries = [...executed.stdout.text.matchAll(/test result: (?:ok|FAILED)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;/g)];
        const summary = summaries.at(-1);
        if (!summary) return failure('protocol_error', 'No standard libtest summary; custom test harness is unsupported');
        const passed = Number(summary[1]);
        const failed = Number(summary[2]);
        const ignored = Number(summary[3]);
        const runtime = { executable: candidate.executable, test: candidate.name, target: candidate.target, packageId: candidate.packageId, cargo, offline: true };
        if (passed + failed !== 1 || ignored !== 0) return {
            ...evidence(), runtime, status: 'not_executed', checks: { passed, failed },
            error: { message: 'Expected exactly one executed test; ignored/zero/multiple tests are not a pass' },
        };
        return {
            ...evidence(), runtime,
            status: executed.exitCode === 0 && passed === 1 ? 'passed' : 'test_failed',
            checks: { passed, failed },
        };
    } catch (error) { return failure('environment_error', error.message); }
}

module.exports = { evaluate };