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
        "var replayBuffer = '';",
        'var mirrorStartupPending = true;',
        "var mirrorStartupHeld = '';",
        pick('emitMirrorData'),
        pick('releaseMirrorStartup'),
        pick('dispatchPtyData'),
        'this.release = releaseMirrorStartup; this.getReplay = () => replayBuffer;'
    ].join('\n'), context);
    context.dispatchPtyData("[Console]::OutputEncoding = ...; Write-Host $__vcpReady\r\n__VCP_PTY_READY_x__\r\n");
    assert.deepEqual(notified, [], 'nothing reaches the side pane during startup');
    context.release('PS C:\\> ');
    context.dispatchPtyData('dir\r\n');
    assert.deepEqual(notified.map(([, data]) => data), ['PS C:\\> ', 'dir\r\n']);
    assert.equal(context.getReplay(), 'PS C:\\> dir\r\n');
});