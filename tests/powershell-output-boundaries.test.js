const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { CommandOutputParser } = require('../VCPDistributedServer/Plugin/PowerShellExecutor/command-output-parser');

const start = '__VCP_COMMAND_START_test__';
const end = '__VCP_COMMAND_END_test__';

test('every two-chunk split preserves output and detects completion', () => {
    const stream = 'old echo\r\n' + start + '\r\nhello 中文\r\n' + end;
    for (let split = 0; split <= stream.length; split++) {
        const parser = new CommandOutputParser(start, end);
        const results = [parser.push(stream.slice(0, split)), parser.push(stream.slice(split))];
        assert.equal(results.map(r => r.output).join(''), '\r\nhello 中文\r\n');
        assert.equal(parser.done, true, `split ${split}`);
    }
});

test('single-character chunks and same-chunk trailing prompt', () => {
    const parser = new CommandOutputParser(start, end);
    let output = '';
    for (const char of start + 'body' + end.slice(0, -1)) {
        output += parser.push(char).output;
    }
    const result = parser.push(end.slice(-1) + '\r\nPS> ');
    output += result.output;
    assert.equal(output, 'body');
    assert.equal(result.done, true);
    assert.equal(result.trailing, '\r\nPS> ');
});

test('multi-megabyte output is intact while parser retains only bounded lookbehind', () => {
    const parser = new CommandOutputParser(start, end);
    parser.push(start);
    const body = 'x'.repeat(2 * 1024 * 1024);
    const outputs = [];
    for (let i = 0; i < body.length; i += 4093) {
        outputs.push(parser.push(body.slice(i, i + 4093)).output);
        assert.ok(parser.pending.length < end.length);
    }
    outputs.push(parser.push(end.slice(0, 8)).output);
    const result = parser.push(end.slice(8));
    outputs.push(result.output);
    assert.equal(result.done, true);
    assert.equal(outputs.join(''), body);
});

test('short output is handed over right away while the command is still running', () => {
    const parser = new CommandOutputParser(start, end);
    parser.push(start);
    assert.equal(parser.push('step 1\r\n').output, 'step 1\r\n');
    // only a tail that could begin the end marker is held back
    assert.equal(parser.push('step 2\r\n__VCP').output, 'step 2\r\n');
    const result = parser.push('_COMMAND_END_test__');
    assert.equal(result.output, '');
    assert.equal(result.done, true);
});

test('GUI IPC failure does not escape the PTY dispatcher', () => {
    const source = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js'), 'utf8');
    const begin = source.indexOf('function dispatchPtyData(');
    const finish = source.indexOf('\n}', begin) + 2;
    let warnings = 0;
    const mirrored = [];
    const context = {
        guiWindow: {
            isDestroyed: () => false,
            webContents: {
                isDestroyed: () => false,
                send: () => { throw new Error('renderer gone'); }
            }
        },
        console: { warn: () => { warnings++; } },
        mirrorStartupPending: false,
        emitMirrorData: (data) => { mirrored.push(data); }
    };
    vm.createContext(context);
    vm.runInContext(source.slice(begin, finish), context);
    assert.doesNotThrow(() => context.dispatchPtyData('output'));
    assert.equal(warnings, 1);
    assert.deepEqual(mirrored, ['output'], 'the side-pane mirror still receives output when the GUI window fails');
});
test('the startup handshake is held back from the side-pane mirror until PowerShell is ready', () => {
    const source = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js'), 'utf8');
    const pick = (name, isLet = false) => {
        const begin = source.indexOf(isLet ? `let ${name}` : `function ${name}(`);
        return source.slice(begin, isLet ? source.indexOf('\n', begin) : source.indexOf('\n}', begin) + 2);
    };
    const notified = [];
    const context = { guiWindow: null, console, notifyMirrors: (method, data) => notified.push([method, data]) };
    vm.createContext(context);
    vm.runInContext([
        'const MIRROR_REPLAY_LIMIT = 1024;',
        'var replayChunks = [], replayHead = 0, replayLength = 0;',
        pick('appendReplay'),
        pick('readReplay'),
        'var mirrorStartupPending = true;',
        "var mirrorStartupHeld = '';",
        pick('emitMirrorData'),
        pick('releaseMirrorStartup'),
        pick('dispatchPtyData'),
        'this.release = releaseMirrorStartup; this.getReplay = readReplay;'
    ].join('\n'), context);
    context.dispatchPtyData("[Console]::OutputEncoding = ...; Write-Host $__vcpReady\r\n__VCP_PTY_READY_x__\r\n");
    assert.deepEqual(notified, [], 'nothing reaches the side pane during startup');
    context.release('PS C:\\> ');
    context.dispatchPtyData('dir\r\n');
    assert.deepEqual(notified.map(([, data]) => data), ['PS C:\\> ', 'dir\r\n']);
    assert.equal(context.getReplay(), 'PS C:\\> dir\r\n');
});
function loadReplayBuffer(limit) {
    const source = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js'), 'utf8');
    const pick = name => {
        const begin = source.indexOf(`function ${name}(`);
        return source.slice(begin, source.indexOf('\n}', begin) + 2);
    };
    const context = {};
    vm.createContext(context);
    vm.runInContext([
        `const MIRROR_REPLAY_LIMIT = ${limit};`,
        'var replayChunks = [], replayHead = 0, replayLength = 0;',
        pick('appendReplay'), pick('readReplay'), pick('clearReplay'),
        'this.append = appendReplay; this.read = readReplay; this.clear = clearReplay;'
    ].join('\n'), context);
    return context;
}

test('the mirror replay keeps the latest output from a line start and forgets it on clear', () => {
    const replay = loadReplayBuffer(64);
    for (let i = 0; i < 40; i++) replay.append(`line ${String(i).padStart(2, '0')}\r\n`);
    const text = replay.read();
    assert.ok(text.length <= 64);
    assert.ok(text.startsWith('line '), 'replay starts at a line, not in the middle of one');
    assert.ok(text.endsWith('line 39\r\n'));
    replay.clear();
    assert.equal(replay.read(), '');
});

test('appending to a full mirror replay does not rescan the retained window on every chunk', () => {
    // 同 DSH terminal-io.bench：容量放大 64 倍，喂同样多的输出，耗时不能跟着放大
    const chunk = 'x'.repeat(63) + '\n';
    const feed = limit => {
        const replay = loadReplayBuffer(limit);
        const started = process.hrtime.bigint();
        for (let i = 0; i < 16384; i++) replay.append(chunk);
        replay.read();
        return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const median = limit => [feed(limit), feed(limit), feed(limit)].sort((a, b) => a - b)[1];
    const small = median(8 * 1024);
    const large = median(512 * 1024);
    assert.ok(large <= small * 4 + 25, `small window ${small.toFixed(1)}ms, large window ${large.toFixed(1)}ms`);
});

test('a PTY resize tells the mirror views the new size, once per change', () => {
    const source = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js'), 'utf8');
    const begin = source.indexOf('function applyPtyResize(');
    const finish = source.indexOf('\n}', begin) + 2;
    const notices = [];
    const resized = [];
    const context = {
        lastKnownSize: { cols: 120, rows: 30 },
        ptyProcess: { resize: (cols, rows) => resized.push([cols, rows]) },
        notifyMirrors: (method, ...args) => notices.push([method, ...args]),
        console,
    };
    vm.createContext(context);
    vm.runInContext(source.slice(begin, finish), context);
    context.applyPtyResize(45, 20);
    context.applyPtyResize(45, 20);
    context.applyPtyResize('bad', 0);
    assert.deepEqual(resized, [[45, 20], [45, 20], [45, 20]]);
    assert.deepEqual(notices, [['onResize', 45, 20]]);
});
