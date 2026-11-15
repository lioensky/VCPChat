'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,
    '../VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js'), 'utf8');
function resizeFixture(pty = true) {
    const calls = [], notices = [];
    const context = vm.createContext({
        lastKnownSize: { cols: 80, rows: 24 },
        ptyProcess: pty ? { resize: (...args) => calls.push(args) } : null,
        notifyMirrors: (...args) => notices.push(args), console
    });
    const fn = source.match(/function applyPtyResize\(cols, rows\) \{[\s\S]*?\n\}/);
    assert.ok(fn);
    vm.runInContext(fn[0], context);
    return { context, calls, notices };
}
test('same-size and invalid resize requests never reach native PTY', () => {
    const { context: c, calls, notices } = resizeFixture();
    for (let i = 0; i < 100; i++) c.applyPtyResize(80, 24);
    for (const size of [[0,24],[-1,24],[80,NaN],[Infinity,24],[80,1.5]]) c.applyPtyResize(...size);
    assert.equal(calls.length, 0);
    assert.equal(notices.length, 0);
    c.applyPtyResize('120', '40');
    c.applyPtyResize(120, 40);
    assert.deepEqual(calls, [[120, 40]]);
    assert.deepEqual(notices, [['onResize', 120, 40]]);
});
test('resize before spawn preserves initial geometry without requiring PTY', () => {
    const { context: c, notices } = resizeFixture(false);
    c.applyPtyResize(100, 30);
    assert.equal(c.lastKnownSize.cols, 100);
    assert.equal(c.lastKnownSize.rows, 30);
    assert.equal(notices.length, 1);
});
test('old PTY output cannot touch replacement projection or dispatch after restart/exit', () => {
    const old = {}, next = {}, delivered = [];
    let projected = 0;
    const c = vm.createContext({
        currentPtyProcess: old, ptyProcess: old,
        terminalProjection: { push(data) { projected++; return `projected:${data}`; } },
        dispatchPtyData: data => delivered.push(data)
    });
    const listener = source.match(/guiDataListener = \(data\) => \{[\s\S]*?\n    \};/);
    assert.ok(listener);
    vm.runInContext(listener[0], c);
    c.guiDataListener('current');
    c.ptyProcess = next;
    c.guiDataListener('late-old');
    c.ptyProcess = null;
    c.guiDataListener('after-exit');
    assert.equal(projected, 1);
    assert.deepEqual(delivered, ['projected:current']);
    c.ptyProcess = old;
    c.terminalProjection = null;
    c.guiDataListener('raw-current');
    assert.deepEqual(delivered, ['projected:current', 'raw-current']);
});