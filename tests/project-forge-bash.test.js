'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BR = require('../VCPDistributedServer/Plugin/ProjectForge/bashRunner');
const { runProcess } = require('../VCPDistributedServer/Plugin/ProjectForge/evalProcess');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-bash-test-'));
const spills = new Set();
const BASH_CANDIDATES = [
    process.env.PF_BASH,
    process.env.FORGE_BASH_PATH,
    'E:/App/Git/usr/bin/bash.exe',
    'E:/App/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/usr/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    '/bin/bash',
    '/usr/bin/bash',
];
const bashPath = BASH_CANDIDATES.find(file => file && path.isAbsolute(file) && fs.existsSync(file)
    && !/(?:system32|syswow64|windowsapps)[\\/].*bash\.exe$/iu.test(file)) || null;
const skip = bashPath ? false : 'Git Bash unavailable';

function remember(value) {
    for (const name of ['stdout', 'stderr']) {
        const spill = value?.[name]?.spillPath;
        if (spill) spills.add(spill);
    }
    return value;
}

function run(script, options = {}) {
    return BR.runBash({ root, script, timeoutMs: 5000, executable: bashPath, ...options }).then(remember);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function read(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

async function withEnv(values, fn) {
    const saved = new Map();
    for (const [key, value] of Object.entries(values)) {
        saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await fn();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test.after(async () => {
    await BR.cleanup();
    for (const file of spills) {
        try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
});

test('detect: real Git Bash path is used and reported', { skip }, async () => {
    const result = await run('printf "bash-ok\\n"');
    assert.equal(result.status, 'exited');
    assert.equal(result.bashPath, bashPath);
    assert.equal(fs.existsSync(result.bashPath), true);
    assert.match(result.stdout.text, /bash-ok/u);
});

test('detect: PF_BASH path is honored without a version probe', { skip }, async () => {
    await withEnv({ PF_BASH: bashPath }, async () => {
        const result = await BR.runBash({ root, script: 'printf "env-bash\\n"', timeoutMs: 5000 });
        assert.equal(result.status, 'exited');
        assert.equal(result.bashPath, bashPath);
        assert.match(result.stdout.text, /env-bash/u);
    });
});

test('detect: WSL launcher is rejected before spawn', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
    await assert.rejects(
        run('echo x', { executable: 'C:\\Windows\\System32\\bash.exe' }),
        error => error.code === 'BASH_WSL',
    );
});

test('run: real exit code, split streams, cwd containment, non-interactive stdin', { skip }, async () => {
    const sub = path.join(root, 'work', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const result = await run([
        "printf 'hello-out\\n'",
        "printf 'oops-err\\n' >&2",
        'touch marker.txt',
        'if test -t 0; then echo stdin=tty; else echo stdin=notty; fi',
        'read -r line; echo read=$?',
        'exit 7',
    ].join('\n'), { workdir: 'work/sub' });
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 7);
    assert.equal(result.signal, null);
    assert.equal(result.ok, false);
    assert.equal(result.quiescence, 'exited');
    assert.equal(result.workdir, fs.realpathSync.native(sub));
    assert.equal(result.workdirRelative, 'work/sub');
    assert.match(result.stdout.text, /hello-out/u);
    assert.doesNotMatch(result.stdout.text, /oops-err/u);
    assert.match(result.stderr.text, /oops-err/u);
    assert.match(result.stdout.text, /stdin=notty/u);
    assert.match(result.stdout.text, /read=1/u);
    assert.equal(fs.existsSync(path.join(sub, 'marker.txt')), true);
    assert.equal(result.stdout.truncated, false);
    assert.equal(result.stdout.spillStatus, 'not-needed');
    assert.equal(typeof result.durationMs, 'number');
});

test('cwd: rejects outside, missing, MSYS path and junction escape', { skip }, async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-bash-outside-'));
    try {
        await assert.rejects(run('echo x', { workdir: '..' }),
            error => error.code === 'BASH_WORKDIR_OUTSIDE');
        await assert.rejects(run('echo x', { workdir: outside }),
            error => error.code === 'BASH_WORKDIR_OUTSIDE');
        await assert.rejects(run('echo x', { workdir: 'missing-dir' }),
            error => error.code === 'BASH_WORKDIR_NOT_FOUND');
        if (process.platform === 'win32') {
            await assert.rejects(run('echo x', { workdir: '/c/Users' }),
                error => error.code === 'BASH_ROOT_RELATIVE');
        }
        const junction = path.join(root, 'escape-junction');
        let linked = false;
        try {
            fs.symlinkSync(outside, junction, 'junction');
            linked = true;
        } catch { /* symlink privileges may be unavailable */ }
        if (linked) {
            await assert.rejects(run('echo x', { workdir: 'escape-junction' }),
                error => error.code === 'BASH_WORKDIR_OUTSIDE');
            try { fs.unlinkSync(junction); } catch { fs.rmdirSync(junction); }
        }
    } finally {
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('env: scrubs credentials, shell hooks, host identity and interactive prompts', { skip }, async () => {
    const evil = path.join(root, 'evil-env.sh');
    fs.writeFileSync(evil, 'touch sourced-marker.txt\n');
    await withEnv({
        PF_BASH_SECRET_TOKEN: 'top-secret',
        BASH_ENV: evil,
        NODE_OPTIONS: '--require /definitely/not/here.js',
        VCP_HOST_ONLY: 'vcp-host',
        'BASH_FUNC_evil%%': '() { echo hacked; }',
    }, async () => {
        const result = await run([
            "printf 'secret=%s\\n' \"${PF_BASH_SECRET_TOKEN-unset}\"",
            "printf 'bashenv=%s\\n' \"${BASH_ENV-unset}\"",
            "printf 'node=%s\\n' \"${NODE_OPTIONS-unset}\"",
            "printf 'vcp=%s\\n' \"${VCP_HOST_ONLY-unset}\"",
            "printf 'term=%s\\n' \"$TERM\"",
            "printf 'nocolor=%s\\n' \"$NO_COLOR\"",
            'if declare -F evil >/dev/null; then echo func=leaked; else echo func=clean; fi',
        ].join('\n'));
        assert.equal(result.status, 'exited');
        assert.equal(result.exitCode, 0);
        for (const expected of [
            'secret=unset', 'bashenv=unset', 'node=unset', 'vcp=unset',
            'term=dumb', 'nocolor=1', 'func=clean',
        ]) {
            assert.match(result.stdout.text, new RegExp(expected, 'u'));
        }
        assert.equal(fs.existsSync(path.join(root, 'sourced-marker.txt')), false);
    });
});

test('timeout: kills the whole Git Bash tree and reports terminated', { skip }, async () => {
    const tick = path.join(root, 'timeout-tick.txt');
    const result = await run([
        'rm -f timeout-tick.txt',
        "bash -c 'i=0; while :; do i=$((i+1)); echo $i >> timeout-tick.txt; sleep 0.05; done' & wait",
    ].join('\n'), { timeoutMs: 800 });
    const before = read(tick);
    assert.ok(before.length > 0, 'background job should have written before timeout');
    await sleep(600);
    assert.equal(read(tick), before, 'background job must stop writing after timeout');
    assert.equal(result.status, 'timeout');
    assert.equal(result.timedOut, true);
    assert.notEqual(result.quiescence, 'unproven');
    assert.equal(result.treeKill?.ok, true);
    assert.ok(result.durationMs >= 500);
});

test('abort: rejects BASH_ABORTED and stops the tree', { skip }, async () => {
    const tick = path.join(root, 'abort-tick.txt');
    const controller = new AbortController();
    const running = BR.runBash({
        root,
        script: [
            'rm -f abort-tick.txt',
            "bash -c 'i=0; while :; do i=$((i+1)); echo $i >> abort-tick.txt; sleep 0.05; done' & wait",
        ].join('\n'),
        timeoutMs: 10000,
        signal: controller.signal,
    });
    setTimeout(() => controller.abort('test-abort'), 800);
    await assert.rejects(running, error => {
        assert.equal(error.code, 'BASH_ABORTED');
        assert.equal(error.name, 'AbortError');
        assert.equal(error.result.status, 'cancelled');
        assert.equal(error.result.aborted, true);
        assert.notEqual(error.result.quiescence, 'unproven');
        remember(error.result);
        return true;
    });
    const before = read(tick);
    assert.ok(before.length > 0, 'background job should have written before abort');
    await sleep(600);
    assert.equal(read(tick), before, 'background job must stop writing after abort');
});

test('output: tail inline plus complete spill for both streams', { skip }, async () => {
    const result = await run([
        "i=0; while [ $i -lt 4000 ]; do printf 'line-%05d\\n' \"$i\"; i=$((i+1)); done",
        "i=0; while [ $i -lt 4000 ]; do printf 'err-%05d\\n' \"$i\" >&2; i=$((i+1)); done",
    ].join('\n'), { maxBytes: 1024, timeoutMs: 15000 });
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 0);
    for (const [name, prefix] of [['stdout', 'line'], ['stderr', 'err']]) {
        const stream = result[name];
        assert.equal(stream.truncated, true);
        assert.equal(stream.spillStatus, 'complete');
        assert.ok(stream.spillPath);
        assert.ok(Buffer.byteLength(stream.text, 'utf8') <= 1024);
        assert.ok(stream.text.includes(`${prefix}-03999`));
        assert.ok(!stream.text.includes(`${prefix}-00000`));
        const full = fs.readFileSync(stream.spillPath, 'utf8');
        assert.equal(Buffer.byteLength(full, 'utf8'), stream.bytes);
        assert.ok(full.startsWith(`${prefix}-00000\n`));
        assert.ok(full.endsWith(`${prefix}-03999\n`));
    }
    assert.notEqual(result.stdout.spillPath, result.stderr.spillPath);
});

test('output: UTF-8 tail never splits a code point', { skip }, async () => {
    const result = await run([
        "i=0; while [ $i -lt 2000 ]; do printf '中文'; i=$((i+1)); done",
        "printf '\\n'",
    ].join('\n'), { maxBytes: 1001, timeoutMs: 10000 });
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 0);
    assert.ok(Buffer.byteLength(result.stdout.text, 'utf8') <= 1001);
    assert.equal(result.stdout.text.includes('\uFFFD'), false);
    assert.equal(result.stdout.truncated, true);
    assert.equal(result.stdout.spillStatus, 'complete');
    const full = fs.readFileSync(result.stdout.spillPath, 'utf8');
    assert.equal(full, `${'中文'.repeat(2000)}\n`);
    assert.equal(Buffer.byteLength(full, 'utf8'), result.stdout.bytes);
});

test('validation: only parameter shape and approved timeout are enforced', { skip }, async () => {
    await assert.rejects(BR.runBash({ root, script: '   ' }),
        error => error.code === 'BASH_ARGUMENT');
    await assert.rejects(BR.runBash({ root, script: 'echo \0x' }),
        error => error.code === 'BASH_ARGUMENT');
    await assert.rejects(run('echo x', { timeoutMs: 0 }),
        error => error.code === 'BASH_ARGUMENT');
    await assert.rejects(run('echo x', { timeoutMs: 110001 }),
        error => error.code === 'BASH_ARGUMENT');
    await assert.rejects(run('echo x', { maxBytes: 0 }),
        error => error.code === 'BASH_ARGUMENT');
    await assert.rejects(run('echo x', { signal: {} }),
        error => error.code === 'BASH_ARGUMENT');
    await assert.rejects(run('echo x', { executable: 'bash.exe' }),
        error => error.code === 'BASH_EXECUTABLE');
    await assert.rejects(BR.runBash({ root: path.join(root, 'missing-root'), script: 'echo x' }),
        error => error.code === 'BASH_ROOT_NOT_FOUND');
    const controller = new AbortController();
    controller.abort('early');
    await assert.rejects(run('echo x', { signal: controller.signal }),
        error => error.code === 'BASH_ABORTED');
});

test('limits: long script and maxBytes above former caps are accepted', { skip }, async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('pf-bash-script-')));
    const script = `# ${'x'.repeat(30000)}\nprintf 'long-ok\\n'`;
    const result = await run(script, { maxBytes: 9 * 1024 * 1024 });
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 0);
    assert.equal(result.maxBytes, 9 * 1024 * 1024);
    assert.match(result.stdout.text, /long-ok/u);
    const leaked = fs.readdirSync(os.tmpdir())
        .filter(name => name.startsWith('pf-bash-script-') && !before.has(name));
    assert.deepEqual(leaked, []);
});

test('spawn: missing executable is reported as spawn_error by the system', async () => {
    const result = await run('echo x', { executable: path.join(root, 'missing-bash.exe') });
    assert.equal(result.status, 'spawn_error');
    assert.equal(result.exitCode, null);
    assert.equal(result.ok, false);
    assert.equal(result.quiescence, 'not-started');
    assert.equal(result.error.code, 'ENOENT');
    assert.equal(result.stdout.text, '');
    assert.equal(result.stderr.text, '');
});

test('evalProcess: default head capture and environment_error stay unchanged', async () => {
    const head = await runProcess(process.execPath, ['-e', "process.stdout.write('A'.repeat(100000))"], {
        cwd: root,
        env: process.env,
        timeoutMs: 10000,
    });
    assert.equal(head.status, 'exited');
    assert.equal(head.exitCode, 0);
    assert.equal(head.stdout.bytes, 100000);
    assert.equal(head.stdout.text.length, 65536);
    assert.equal(head.stdout.truncated, true);
    assert.deepEqual(Object.keys(head.stdout).sort(), ['bytes', 'text', 'truncated']);
    const missing = await runProcess(path.join(root, 'no-such-runtime'), [], { timeoutMs: 1000 });
    assert.equal(missing.status, 'environment_error');
    assert.equal(missing.quiescence, 'not-started');
    assert.equal(missing.error.code, 'ENOENT');
});

test('spill: complete stream beyond the former 64MiB cap', { timeout: 60000 }, async () => {
    const bytes = 64 * 1024 * 1024 + 1;
    const chunk = 1024 * 1024;
    const full = Math.floor(bytes / chunk);
    const rest = bytes % chunk;
    const code = [
        `const b = Buffer.alloc(${chunk}, 0x78);`,
        `for (let i = 0; i < ${full}; i += 1) process.stdout.write(b);`,
        `if (${rest}) process.stdout.write(Buffer.alloc(${rest}, 0x78));`,
    ].join('\n');
    const result = await runProcess(process.execPath, ['-e', code], {
        cwd: root,
        env: process.env,
        timeoutMs: 60000,
        maxBytes: 1024,
        tail: true,
        spill: true,
        spillName: 'cap-test',
    });
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.bytes, bytes);
    assert.equal(result.stdout.spillStatus, 'complete');
    assert.ok(result.stdout.spillPath);
    spills.add(result.stdout.spillPath);
    assert.equal(fs.statSync(result.stdout.spillPath).size, bytes);
    const fd = fs.openSync(result.stdout.spillPath, 'r');
    try {
        const head = Buffer.alloc(8);
        const tail = Buffer.alloc(8);
        fs.readSync(fd, head, 0, head.length, 0);
        fs.readSync(fd, tail, 0, tail.length, bytes - tail.length);
        assert.equal(head.toString('utf8'), 'xxxxxxxx');
        assert.equal(tail.toString('utf8'), 'xxxxxxxx');
    } finally {
        fs.closeSync(fd);
    }
});

test('cleanup: active run is cancelled and its tree stops', { skip }, async () => {
    const tick = path.join(root, 'cleanup-tick.txt');
    const running = BR.runBash({
        root,
        script: [
            'rm -f cleanup-tick.txt',
            "bash -c 'i=0; while :; do i=$((i+1)); echo $i >> cleanup-tick.txt; sleep 0.05; done' & wait",
        ].join('\n'),
        timeoutMs: 10000,
    });
    await sleep(800);
    const during = read(tick);
    assert.ok(during.length > 0, 'background job should be running before cleanup');
    await BR.cleanup();
    const result = remember(await running);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.cancelled, true);
    assert.notEqual(result.quiescence, 'unproven');
    const stable = read(tick);
    await sleep(600);
    assert.equal(read(tick), stable, 'cleanup must stop the whole tree');
});
