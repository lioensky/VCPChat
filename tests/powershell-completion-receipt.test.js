'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { CommandOutputParser, CommandTerminalProjection } = require('../VCPDistributedServer/Plugin/PowerShellExecutor/command-output-parser');
const source = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js'), 'utf8');
const start = source.indexOf('function executeSingleCommandInPty(');
const code = source.slice(start, source.indexOf('\n}', start) + 2);

function fixture() {
    const files = new Map(), intervals = new Set(), timeouts = new Set(), states = [];
    let now = 1000, listener, serial = 0, disposed = 0;
    const pty = {
        onData(fn) { listener = fn; return { dispose() { disposed++; } }; },
        write() {}
    };
    const context = vm.createContext({
        fs: {
            writeFileSync: (p, text) => files.set(p, text),
            existsSync: p => files.has(p),
            unlinkSync: p => files.delete(p)
        },
        path, os: { tmpdir: () => '/tmp' },
        crypto: { randomUUID: () => `id-${++serial}` },
        Date: { now: () => now },
        setTimeout(fn) { timeouts.add(fn); return fn; },
        clearTimeout: fn => timeouts.delete(fn),
        setInterval(fn) { intervals.add(fn); return fn; },
        clearInterval: fn => intervals.delete(fn),
        COMMAND_RUN_RAW_LIMIT: 65536,
        beginCommandRun: () => ({}),
        appendCommandRunOutput() {},
        finishCommandRun: (_, state) => states.push(state),
        CommandOutputParser, CommandTerminalProjection,
        terminalProjection: null, activeCommandAbort: null,
        dispatchPtyData() {}, sanitizeTerminalOutput: text => text, console
    });
    vm.runInContext(code, context);
    const promise = context.executeSingleCommandInPty(pty, 'echo hello');
    const wrapper = [...files.values()].find(text => text.includes('Write-Host'));
    const markers = [...wrapper.matchAll(/Write-Host '([^']+)'/g)].map(m => m[1]);
    const receipt = wrapper.match(/WriteAllText\('([^']+)'/)[1];
    return {
        promise, files, intervals, timeouts, states, markers,
        emit: data => listener(data),
        receipt: () => files.set(receipt, 'completed'),
        tick(ms) { now += ms; for (const fn of [...intervals]) fn(); },
        abort: () => context.activeCommandAbort(),
        get disposed() { return disposed; }
    };
}

test('fragmented screen end marker cannot strand an executed command', async () => {
    const h = fixture();
    h.emit(h.markers[0] + '\r\nhello\r\n' + h.markers[1].slice(0, 15) + '\x1b[2;1H' + h.markers[1].slice(15));
    h.receipt();
    h.tick(300);
    const output = await h.promise;
    assert.match(output, /hello/);
    assert.match(output, /完成回执已确认/);
    assert.deepEqual(h.states, ['completed']);
    assert.equal(h.files.size, 0);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.timeouts.size, 0);
    assert.equal(h.disposed, 1);
});

test('normal boundary finishes immediately and clears receipt polling', async () => {
    const h = fixture();
    h.receipt();
    h.emit(h.markers[0] + 'hello' + h.markers[1]);
    assert.equal(await h.promise, 'hello');
    assert.equal(h.files.size, 0);
    assert.equal(h.intervals.size, 0);
});

test('no receipt and no end boundary cannot be reported as completed', async () => {
    const h = fixture();
    h.emit(h.markers[0] + 'still running');
    h.tick(10000);
    assert.deepEqual(h.states, []);
    const rejected = assert.rejects(h.promise, /interrupt/);
    h.abort();
    await rejected;
    assert.deepEqual(h.states, ['cancelled']);
    assert.equal(h.intervals.size, 0);
});

test('receipt fallback also returns output when the start marker was screen-fragmented', async () => {
    const h = fixture();
    h.emit(h.markers[0].slice(0, 10) + '\r\n' + h.markers[0].slice(10) + '\r\nhello');
    h.receipt();
    h.tick(300);
    assert.match(await h.promise, /hello/);
});