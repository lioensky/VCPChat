'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildCaptureWrapper, parseCaptureReceipt } = require('../VCPDistributedServer/Plugin/PowerShellExecutor/commandCapture');
const source = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/PowerShellExecutor/PowerShellExecutor.js'), 'utf8');
const start = source.indexOf('function executeSingleCommandInPty(');
const code = source.slice(start, source.indexOf('\n}', start) + 2);

function fixture() {
    const files = new Map(), intervals = new Set(), timeouts = new Set(), states = [], writes = [];
    const run = { status: 'running', raw: '' };
    const context = vm.createContext({
        fs: {
            writeFileSync: (p, text) => files.set(p, text),
            readFileSync: p => files.get(p),
            existsSync: p => files.has(p),
            unlinkSync: p => files.delete(p)
        },
        path: path.posix, os: { tmpdir: () => '/tmp' },
        crypto: { randomUUID: () => 'test-id' },
        setTimeout(fn) { timeouts.add(fn); return fn; },
        clearTimeout: fn => timeouts.delete(fn),
        setInterval(fn) { intervals.add(fn); return fn; },
        clearInterval: fn => intervals.delete(fn),
        beginCommandRun: () => run,
        appendCommandRunOutput: (_, text) => { run.raw += text; },
        finishCommandRun: (_, state, receipt) => { run.status = state; states.push({ state, receipt }); },
        buildCaptureWrapper, parseCaptureReceipt,
        pendingCommandCleanup: null, activeCommandAbort: null, commandUnresolved: false,
        purgeExecutionQueue() {}, console
    });
    vm.runInContext(code, context);
    const promise = context.executeSingleCommandInPty({ write: text => writes.push(text) }, 'echo hello');
    return {
        promise, files, intervals, timeouts, states, writes, context, run,
        output(text) { files.set('/tmp/vcp-capture-test-id.log', text); },
        receipt(overrides = {}) {
            files.set('/tmp/vcp-capture-test-id.json', JSON.stringify({
                version: 1, runId: 'test-id', executionState: 'completed',
                errorCount: 0, terminatingError: false, nativeExitCode: null,
                durationMs: 10, truncated: false, ...overrides
            }));
        },
        tick() { for (const fn of [...intervals]) fn(); },
        expire() { for (const fn of [...timeouts]) fn(); }
    };
}

test('completion uses bottom-level output, preserves tabs and blanks, and cleans files', async () => {
    const h = fixture();
    h.output('\nA\tB\n\n{"long":"' + 'x'.repeat(1000) + '"}\n');
    h.receipt(); h.tick();
    const result = await h.promise;
    assert.ok(result.includes('\nA\tB\n\n'));
    assert.match(result, /output=complete/);
    assert.equal(h.files.size, 0);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.timeouts.size, 0);
    assert.equal(h.states.at(-1).state, 'completed');
    assert.equal(h.writes.length, 1);
});

test('timeout keeps capture and execution lease until a late receipt', async () => {
    const h = fixture();
    const rejected = assert.rejects(h.promise, /60 秒/);
    h.expire(); await rejected;
    assert.equal(h.context.commandUnresolved, true);
    assert.equal(h.intervals.size, 1);
    assert.equal(h.run.status, 'running_detached');
    h.output('late output'); h.receipt(); h.tick();
    assert.equal(h.context.commandUnresolved, false);
    assert.equal(h.states.at(-1).state, 'completed');
    assert.equal(h.files.size, 0);
});

test('interrupt is a request, lease remains until the receipt', async () => {
    const h = fixture();
    const rejected = assert.rejects(h.promise, /interrupt/);
    h.context.activeCommandAbort(); await rejected;
    assert.equal(h.writes.at(-1), '\x03');
    assert.equal(h.context.commandUnresolved, true);
    h.receipt(); h.tick();
    assert.equal(h.states.at(-1).state, 'cancelled');
    assert.equal(h.context.commandUnresolved, false);
});

test('foreign receipt never releases the lease; session abandonment cleans it', async () => {
    const h = fixture();
    const rejected = assert.rejects(h.promise, /采集失败/);
    h.receipt({ runId: 'foreign' }); h.tick(); await rejected;
    assert.equal(h.context.commandUnresolved, true);
    h.context.pendingCommandCleanup();
    assert.equal(h.files.size, 0);
    assert.equal(h.intervals.size, 0);
});
test('run store notifies detached state without declaring completion', () => {
    const store = require('../VCPDistributedServer/Plugin/PowerShellExecutor/commandRunStore');
    const run = store.beginCommandRun('capture-state-test', { outputSource: 'capture' });
    const events = [];
    const unsubscribe = store.subscribeCommandRuns(summary => events.push(summary));
    try {
        store.appendCommandRunOutput(run, '\nA\tB\r\n');
        store.finishCommandRun(run, 'running_detached');
        assert.equal(events.at(-1).status, 'running_detached');
        assert.equal(events.at(-1).endedAt, null);
        store.finishCommandRun(run, 'completed', { truncated: false });
        assert.ok(events.at(-1).endedAt !== null);
        assert.equal(store.getCommandRun(run.id).output, '\nA\tB\n');
    } finally { unsubscribe(); }
});

test('interactive preparation rejects unresolved execution and rolls back failed view setup', async () => {
    const begin = source.indexOf('async function ensureInteractiveTerminal(');
    const snippet = source.slice(begin, source.indexOf('\n}', begin) + 2);
    const context = vm.createContext({
        isExecutingCommand: false, queueProcessing: false, executionQueue: [],
        commandUnresolved: true, interactiveMode: false, ptyProcess: {},
        prepareTerminalView: async () => { throw new Error('view unavailable'); },
        createNewPtySession() {}, waitForPtyReady: async () => {}
    });
    vm.runInContext(snippet, context);
    await assert.rejects(context.ensureInteractiveTerminal(), /占用/);
    context.commandUnresolved = false;
    await assert.rejects(context.ensureInteractiveTerminal(), /view unavailable/);
    assert.equal(context.interactiveMode, false);
});