import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildScript, encodeCommand, parseLine, createFullscreenWatch } = require('../modules/deskpet/fullscreenWatch.js');

function fakeSpawn() {
    const spawned = [];
    const spawn = (command, args) => {
        const proc = Object.assign(new EventEmitter(), {
            command,
            args,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            killed: false,
            kill() { this.killed = true; this.emit('exit', null); },
        });
        spawned.push(proc);
        return proc;
    };
    return { spawn, spawned };
}

function fakeTimers() {
    const timers = [];
    return {
        timers,
        setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
        clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
        fire() { const due = timers.splice(0); for (const t of due) t.fn(); },
    };
}

test('the helper reports fullscreen as a monitor rect, anything else as none', () => {
    assert.deepEqual(parseLine('none'), { fullscreen: false, rect: null });
    assert.deepEqual(parseLine('fs -1920 0 1920 1080\r'), { fullscreen: true, rect: { x: -1920, y: 0, width: 1920, height: 1080 } });
    assert.equal(parseLine('fs 0 0 0 1080'), null);
    assert.equal(parseLine('Add-Type : error'), null);
    assert.equal(parseLine(''), null);
});

test('the script watches for VCPChat itself and only takes a numeric pid', () => {
    const script = buildScript(4242);
    assert.match(script, /GetProcessById\(4242\)/);
    assert.match(script, /Probe\(4242\)/);
    assert.throws(() => buildScript('1; Remove-Item'));
    assert.equal(Buffer.from(encodeCommand('hi'), 'base64').toString('utf16le'), 'hi');
});

test('outside Windows nothing is started', () => {
    const { spawn, spawned } = fakeSpawn();
    const watch = createFullscreenWatch({ spawn, platform: 'linux' });
    watch.start();
    assert.equal(spawned.length, 0);
});

test('state changes reach the listener once, split lines included', () => {
    const { spawn, spawned } = fakeSpawn();
    const seen = [];
    const watch = createFullscreenWatch({ spawn, platform: 'win32', ownPid: 77, onChange: (s) => seen.push(s.fullscreen) });
    watch.start();
    watch.start();
    assert.equal(spawned.length, 1);
    const [proc] = spawned;
    assert.equal(proc.command, 'powershell.exe');
    const encoded = proc.args[proc.args.indexOf('-EncodedCommand') + 1];
    assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), /Probe\(77\)/);
    proc.stdout.emit('data', 'none\r\nfs 0 0 19');
    proc.stdout.emit('data', '20 1080\r\n');
    proc.stdout.emit('data', 'fs 0 0 1920 1080\r\nnone\r\n');
    assert.deepEqual(seen, [true, false]);
    assert.equal(watch.running, true);
    watch.stop();
    assert.equal(proc.killed, true);
    assert.equal(watch.running, false);
});

test('if the helper dies while fullscreen, the pet comes back and the helper restarts a few times at most', () => {
    const { spawn, spawned } = fakeSpawn();
    const clock = fakeTimers();
    const seen = [];
    const watch = createFullscreenWatch({ spawn, platform: 'win32', onChange: (s) => seen.push(s.fullscreen), ...clock });
    watch.start();
    spawned[0].stdout.emit('data', 'fs 0 0 1920 1080\n');
    spawned[0].emit('exit', 1);
    assert.deepEqual(seen, [true, false]);
    for (let i = 0; i < 5; i += 1) {
        clock.fire();
        spawned.at(-1).emit('exit', 1);
    }
    assert.equal(spawned.length, 4, 'first run + 3 restarts');
    assert.equal(clock.timers.length, 0);
});

test('stopping cancels a pending restart', () => {
    const { spawn, spawned } = fakeSpawn();
    const clock = fakeTimers();
    const watch = createFullscreenWatch({ spawn, platform: 'win32', ...clock });
    watch.start();
    spawned[0].emit('exit', 1);
    assert.equal(clock.timers.length, 1);
    watch.stop();
    assert.equal(clock.timers.length, 0);
    clock.fire();
    assert.equal(spawned.length, 1);
});

// 真跑一次 PowerShell：C# 能编译、脚本能报出第一行状态（只在 Windows 上）
test('Windows: the real helper starts and reports a first state', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    const watch = createFullscreenWatch();
    try {
        watch.start();
        for (let i = 0; i < 90 && !watch.heard; i += 1) await new Promise((r) => setTimeout(r, 500));
        assert.equal(watch.heard, true, 'the helper printed its first state');
        assert.equal(watch.running, true);
    } finally {
        watch.stop();
    }
});
