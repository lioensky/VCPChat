'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProfiler } = require('../modules/diagnostics/bootProfile');

function fixture(env = {}) {
    let clock = 0;
    const lines = [];
    const handlers = new Map();
    const ipc = new EventEmitter();
    ipc.handle = function (channel, fn) {
        if (handlers.has(channel)) throw new Error('duplicate');
        handlers.set(channel, fn);
    };
    const modules = { _load(request) {
        clock += 40;
        if (request === 'outer') this._load('inner', { filename: 'outer.cjs' });
        if (request === 'bad') throw failure;
        return request;
    } };
    const originals = { load: modules._load, emit: ipc.emit, handle: ipc.handle };
    const profile = createProfiler({ env, now: () => clock, moduleApi: modules,
        write: line => lines.push(JSON.parse(line.slice('[BootProfile] '.length))) });
    return { profile, ipc, modules, originals, handlers, lines, advance: n => { clock += n; } };
}
const failure = new Error('original failure');

test('nested loads have inclusive/self time, parent, IPC context; hooks restore', () => {
    const f = fixture();
    try {
        f.profile.install(f.ipc);
        f.ipc.handle('load', () => f.modules._load('outer', { filename: 'handler.cjs' }));
        assert.equal(f.handlers.get('load')(), 'outer');
        assert.throws(() => f.modules._load('bad'), e => e === failure);
        f.profile.report('test');
        const loads = f.lines.filter(r => r.kind === 'module-load');
        const outer = loads.find(r => r.request === 'outer');
        assert.equal(outer.wallMs, 80);
        assert.equal(outer.selfMs, 40);
        assert.equal(outer.parent, 'handler.cjs');
        assert.equal(outer.ipc, 'handle:load');
        assert.equal(loads.find(r => r.request === 'bad').failed, true);
    } finally { f.profile.stop(); }
    assert.equal(f.modules._load, f.originals.load);
    assert.equal(f.ipc.emit, f.originals.emit);
    assert.equal(f.ipc.handle, f.originals.handle);
});

test('IPC preserves this, promise identity, throws, duplicate registration and listener removal', async () => {
    const f = fixture();
    try {
        f.profile.install(f.ipc);
        const receiver = {};
        const promise = Promise.resolve(42);
        f.ipc.handle('async', function (arg) {
            assert.equal(this, receiver);
            assert.equal(arg, 7);
            return promise;
        });
        assert.equal(f.handlers.get('async').call(receiver, 7), promise);
        assert.equal(await promise, 42);
        f.ipc.handle('throw', () => { throw failure; });
        assert.throws(() => f.handlers.get('throw')(), e => e === failure);
        assert.throws(() => f.ipc.handle('async', () => {}), /duplicate/);
        let calls = 0;
        const listener = function () { assert.equal(this, f.ipc); calls++; };
        f.ipc.once('event', listener);
        f.ipc.emit('event'); f.ipc.emit('event');
        assert.equal(calls, 1);
        f.ipc.on('event', listener);
        f.ipc.removeListener('event', listener);
        assert.equal(f.ipc.emit('event'), false);
        f.profile.stop();
        assert.equal(f.handlers.get('async').call(receiver, 7), promise);
    } finally { f.profile.stop(); }
});

test('plugin async spans distinguish sync entry from full wait and preserve failures', async () => {
    const f = fixture();
    try {
        f.profile.install();
        assert.equal(f.profile.measureSync('require', () => { f.advance(50); return 3; }), 3);
        assert.equal(await f.profile.measureAsync('initialize', () => {
            f.advance(10);
            return Promise.resolve().then(() => { f.advance(100); return 9; });
        }), 9);
        await assert.rejects(f.profile.measureAsync('failure', () => { throw failure; }), e => e === failure);
        f.profile.report('test');
        const init = f.lines.find(r => r.label === 'initialize' && r.kind === 'plugin-stage');
        assert.equal(init.syncMs, 10);
        assert.equal(init.wallMs, 110);
        assert.equal(f.lines.find(r => r.label === 'failure' && r.kind === 'plugin-stage').failed, true);
    } finally { f.profile.stop(); }
});

test('disabled profiler does not patch or log', async () => {
    const f = fixture({ VCP_BOOT_PROFILE: '0' });
    f.profile.install(f.ipc);
    assert.equal(f.modules._load, f.originals.load);
    assert.equal(f.ipc.handle, f.originals.handle);
    assert.equal(f.profile.measureSync('x', () => 4), 4);
    assert.equal(await f.profile.measureAsync('y', () => 5), 5);
    f.profile.report('disabled'); f.profile.stop();
    assert.equal(f.lines.length, 0);
});

test('bounded records and diagnostic sink failure cannot change business result', () => {
    const f = fixture();
    try {
        f.profile.install();
        for (let i = 0; i < 2100; i++) f.profile.measureSync('x', () => 1);
        f.profile.report('bounded');
        assert.ok(f.lines.find(r => r.tag === 'bounded').dropped > 0);
        assert.ok(f.lines.length <= 2001);
    } finally { f.profile.stop(); }
    const broken = createProfiler({ moduleApi: { _load() { return 1; } },
        write() { throw failure; } });
    try {
        broken.install();
        assert.equal(broken.measureSync('x', () => 8), 8);
        assert.doesNotThrow(() => broken.report('broken'));
    } finally { broken.stop(); }
});

test('deadline automatically restores hooks', async () => {
    const f = fixture({ VCP_BOOT_PROFILE_WINDOW_MS: '15' });
    f.profile.install(f.ipc);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(f.modules._load, f.originals.load);
    assert.equal(f.ipc.emit, f.originals.emit);
    assert.ok(f.lines.some(r => r.tag === 'startup-window-end'));
});