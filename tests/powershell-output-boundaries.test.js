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

test('GUI IPC failure does not escape the PTY dispatcher', () => {
    const source = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js'), 'utf8');
    const begin = source.indexOf('function dispatchPtyData(');
    const finish = source.indexOf('\n}', begin) + 2;
    let warnings = 0;
    const context = {
        guiWindow: {
            isDestroyed: () => false,
            webContents: {
                isDestroyed: () => false,
                send: () => { throw new Error('renderer gone'); }
            }
        },
        console: { warn: () => { warnings++; } }
    };
    vm.createContext(context);
    vm.runInContext(source.slice(begin, finish), context);
    assert.doesNotThrow(() => context.dispatchPtyData('output'));
    assert.equal(warnings, 1);
});