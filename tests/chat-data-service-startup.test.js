'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const realClient = require('../modules/services/chatDataService/client');

const source = fs.readFileSync(
    path.join(__dirname, '../modules/services/chatDataService/lifecycle.js'), 'utf8'
);

function fixture(options = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
        return true;
    };
    let healthCalls = 0;
    let spawnOptions;
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module,
        require(name) {
            if (name === 'child_process') return {
                spawn(binary, args, opts) { spawnOptions = opts; return child; }
            };
            if (name === './client') return {
                ...realClient,
                ChatDataServiceClient: class {
                    async health() {
                        healthCalls++;
                        return options.health?.();
                    }
                }
            };
            return require(name);
        },
        process, console, __dirname, setTimeout, clearTimeout
    });
    const lifecycle = new module.exports.ChatDataServiceLifecycle({
        appDataPath: '/fixture',
        binaryPath: process.execPath,
        startupTimeoutMs: 40,
        recoveryTimeoutMs: 180,
        logger: { info() {}, error() {}, warn() {} },
        ...options
    });
    const send = frame => child.stdout.write(`${JSON.stringify(frame)}\n`);
    const progress = stage => send({ type: 'startup_progress', protocolVersion: 3, stage });
    const ready = () => send({
        type: 'ready', protocolVersion: 3, schemaVersion: 3,
        port: 12345, authToken: 'test-only', instanceId: 'fixture'
    });
    async function cleanup() {
        lifecycle.enabled = false;
        clearTimeout(lifecycle.stabilityTimer);
        clearTimeout(lifecycle.restartTimer);
        if (!child.killed) {
            const exited = once(child, 'exit');
            child.kill();
            await exited;
        }
    }
    return {
        lifecycle, child, send, progress, ready, cleanup,
        get healthCalls() { return healthCalls; },
        get spawnOptions() { return spawnOptions; }
    };
}

test('legacy ready-only runtime still starts; progress opt-in is child-local', async t => {
    const f = fixture();
    t.after(() => f.cleanup());
    const previous = process.env.VCP_CDS_STARTUP_PROGRESS;
    const pending = f.lifecycle.start();
    f.ready();
    assert.ok(await pending);
    assert.equal(f.lifecycle.isReady, true);
    assert.equal(f.spawnOptions.env.VCP_CDS_STARTUP_PROGRESS, '1');
    assert.equal(process.env.VCP_CDS_STARTUP_PROGRESS, previous);
});

test('recovery may exceed ordinary startup deadline without becoming ready early', async t => {
    const f = fixture();
    t.after(() => f.cleanup());
    const pending = f.lifecycle.start();
    f.progress('database_open');
    f.progress('integrity_check');
    await delay(65);
    assert.equal(f.lifecycle.isReady, false);
    assert.equal(f.child.killed, false);
    f.progress('integrity_complete');
    f.ready();
    assert.ok(await pending);
});

test('repeated progress does not renew recovery budget; timeout opens circuit', async t => {
    const f = fixture({ recoveryTimeoutMs: 70 });
    t.after(() => f.cleanup());
    const pending = f.lifecycle.start();
    const rejected = assert.rejects(pending, error =>
        error.code === 'RECOVERY_TIMEOUT' && error.retryable === false
    );
    f.progress('database_open');
    const ticker = setInterval(() => f.progress('integrity_check'), 10);
    try {
        await rejected;
        await delay(5);
        assert.equal(f.child.killed, true);
        assert.equal(f.lifecycle.circuitOpen, true);
        assert.equal(f.lifecycle.restartTimer, null);
        assert.equal(f.lifecycle.restartAttempts, 0);
    } finally {
        clearInterval(ticker);
    }
});

test('legacy silent startup retains ordinary timeout and retry semantics', async t => {
    const f = fixture({ startupTimeoutMs: 15 });
    t.after(() => f.cleanup());
    await assert.rejects(f.lifecycle.start(), error =>
        error.code === 'STARTUP_TIMEOUT' && error.retryable === true
    );
    await delay(5);
    assert.equal(f.lifecycle.circuitOpen, false);
    assert.notEqual(f.lifecycle.restartTimer, null);
});

test('unknown or out-of-order progress fails closed', async t => {
    for (const stage of ['surprise', 'integrity_check']) {
        const f = fixture();
        t.after(() => f.cleanup());
        const pending = f.lifecycle.start();
        const rejected = assert.rejects(pending, { code: 'INVALID_HANDSHAKE' });
        f.progress(stage);
        await rejected;
    }
});

test('duplicate ready starts one health check; late health cannot resurrect timed-out child', async t => {
    let completeHealth;
    const f = fixture({
        recoveryTimeoutMs: 30,
        health: () => new Promise(resolve => { completeHealth = resolve; })
    });
    t.after(() => f.cleanup());
    const pending = f.lifecycle.start();
    const rejected = assert.rejects(pending, { code: 'RECOVERY_TIMEOUT' });
    f.progress('database_open');
    f.ready();
    f.ready();
    assert.equal(f.healthCalls, 1);
    await rejected;
    completeHealth();
    await delay(5);
    assert.equal(f.lifecycle.isReady, false);
    assert.equal(f.lifecycle.handshake, null);
    assert.equal(f.lifecycle.client, null);
});
test('stop during pending health cannot publish ready', async t => {
    let completeHealth;
    const f = fixture({
        health: () => new Promise(resolve => { completeHealth = resolve; })
    });
    t.after(() => f.cleanup());
    let readyCount = 0;
    f.lifecycle.on('ready', () => readyCount++);
    const pending = f.lifecycle.start();
    const rejected = assert.rejects(pending, { code: 'EARLY_EXIT' });
    f.progress('database_open');
    f.ready();
    // Model the stop path while shutdown is awaiting child exit.
    f.lifecycle.stopping = true;
    f.lifecycle.enabled = false;
    f.child.kill();
    await rejected;
    completeHealth();
    await delay(5);
    assert.equal(readyCount, 0);
    assert.equal(f.lifecycle.isReady, false);
    assert.equal(f.lifecycle.restartTimer, null);
});