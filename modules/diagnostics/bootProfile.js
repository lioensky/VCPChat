'use strict';

// Startup-only diagnostic. CPU is process-wide; wall/CPU ratios are NOT a verdict on antivirus.
const Module = require('node:module');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');

function createProfiler(options = {}) {
    const env = options.env || process.env;
    const enabled = env.VCP_BOOT_PROFILE !== '0';
    const now = options.now || (() => performance.now());
    const write = options.write || (line => console.log(line));
    const moduleApi = options.moduleApi || Module;
    const context = new AsyncLocalStorage();
    const number = (value, fallback, max) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
    };
    const threshold = number(env.VCP_BOOT_PROFILE_MS, 30, 60000);
    const windowMs = number(env.VCP_BOOT_PROFILE_WINDOW_MS, 60000, 300000);
    const limit = 2000;
    let active = false, installed = false, sequence = 0, dropped = 0;
    let records = [], stack = [], restores = [], timers = [], histogram = null;
    const ipcStats = new Map();

    function safe(fn) { try { return fn(); } catch { return undefined; } }
    function record(kind, data) {
        safe(() => {
            if (records.length >= limit) { dropped++; return; }
            records.push({ seq: ++sequence, at: new Date().toISOString(),
                uptimeMs: Math.round(process.uptime() * 1000), kind, ...data });
        });
    }
    function cpuSince(start) {
        const c = process.cpuUsage(start);
        return (c.user + c.system) / 1000;
    }
    function patch(object, key, make) {
        const original = object[key];
        if (typeof original !== 'function') return;
        const wrapped = make(original);
        object[key] = wrapped;
        restores.push(() => { if (object[key] === wrapped) object[key] = original; });
    }
    function ipcCall(kind, channel, fn, receiver, args) {
        if (!active) return Reflect.apply(fn, receiver, args);
        const start = now();
        let failed = true;
        try {
            const result = context.run({ ipc: `${kind}:${String(channel)}` },
                () => Reflect.apply(fn, receiver, args));
            failed = false;
            return result; // No then/catch attachment: preserve promise identity/rejection behavior.
        } finally {
            safe(() => {
                const wallMs = now() - start;
                const key = `${kind}:${String(channel)}`;
                let stat = ipcStats.get(key);
                if (!stat && ipcStats.size < 256) {
                    stat = { channel: key, calls: 0, totalSyncMs: 0, maxSyncMs: 0, throws: 0 };
                    ipcStats.set(key, stat);
                }
                if (stat) {
                    stat.calls++; stat.totalSyncMs += wallMs;
                    stat.maxSyncMs = Math.max(stat.maxSyncMs, wallMs);
                    if (failed) stat.throws++;
                }
                if (wallMs >= threshold) record('ipc-sync', { channel: key, wallMs, failed });
            });
        }
    }
    function install(ipcMain) {
        if (!enabled || installed) return;
        installed = active = true;
        safe(() => patch(moduleApi, '_load', original => function (request, parent, isMain) {
            if (!active) return Reflect.apply(original, this, arguments);
            const frame = { start: now(), childMs: 0 };
            stack.push(frame);
            let failed = true;
            try {
                const value = Reflect.apply(original, this, arguments);
                failed = false;
                return value;
            } finally {
                safe(() => {
                    stack.pop();
                    const wallMs = now() - frame.start;
                    if (stack.length) stack[stack.length - 1].childMs += wallMs;
                    const selfMs = Math.max(0, wallMs - frame.childMs);
                    if (wallMs >= threshold) record('module-load', {
                        request: String(request), parent: parent?.filename || null,
                        wallMs, selfMs, failed, ipc: context.getStore()?.ipc || null
                    });
                });
            }
        }));
        if (ipcMain) {
            safe(() => patch(ipcMain, 'handle', original => function (channel, listener) {
                if (typeof listener !== 'function') return Reflect.apply(original, this, arguments);
                const wrapped = function (...args) {
                    return ipcCall('handle', channel, listener, this, args);
                };
                return Reflect.apply(original, this, [channel, wrapped]);
            }));
            // EventEmitter listener identity, once and removal semantics stay untouched.
            safe(() => patch(ipcMain, 'emit', original => function (channel, ...args) {
                return ipcCall('event', channel, original, this, [channel, ...args]);
            }));
        }
        safe(() => {
            histogram = monitorEventLoopDelay({ resolution: 20 });
            histogram.enable();
        });
        record('installed', { windowMs, thresholdMs: threshold,
            moduleTiming: 'CommonJS _load inclusive/self, including resolution and cache hits',
            ipcTiming: 'synchronous entry only; async continuations are not timed' });
        const snapshot = setTimeout(() => report('startup+5s'), Math.min(5000, windowMs));
        const deadline = setTimeout(stop, windowMs);
        snapshot.unref?.(); deadline.unref?.();
        timers.push(snapshot, deadline);
    }
    // Explicit plugin spans remain available after global startup hooks expire.
    function measureSync(label, fn) {
        if (!enabled || !installed) return fn();
        const start = now(), cpu = process.cpuUsage();
        let failed = true;
        try {
            const value = fn();
            failed = false;
            return value;
        } finally {
            safe(() => record('plugin-stage', { label, wallMs: now() - start,
                processCpuMs: cpuSince(cpu), failed, phase: 'sync' }));
        }
    }
    async function measureAsync(label, fn) {
        if (!enabled || !installed) return await fn();
        const start = now(), cpu = process.cpuUsage();
        let syncMs = null, failed = true;
        record('plugin-begin', { label });
        try {
            let result;
            try { result = fn(); } finally { syncMs = now() - start; }
            const value = await result;
            failed = false;
            return value;
        } finally {
            safe(() => record('plugin-stage', { label, wallMs: now() - start, syncMs,
                processCpuMs: cpuSince(cpu), failed, phase: 'async',
                cpuScope: 'whole process during span, not exclusive plugin CPU' }));
        }
    }
    function report(tag) {
        if (!enabled || !installed) return;
        safe(() => {
            const batch = records;
            records = [];
            const ipc = [...ipcStats.values()].sort((a, b) => b.totalSyncMs - a.totalSyncMs).slice(0, 20);
            ipcStats.clear();
            const eventLoop = histogram ? {
                maxMs: histogram.max / 1e6,
                p99Ms: histogram.percentile(99) / 1e6
            } : null;
            histogram?.reset();
            const lost = dropped; dropped = 0;
            write(`[BootProfile] ${JSON.stringify({ tag, pid: process.pid,
                at: new Date().toISOString(), dropped: lost, eventLoop, ipc })}`);
            for (const item of batch) write(`[BootProfile] ${JSON.stringify(item)}`);
        });
    }
    function stop() {
        if (!installed || !active) return;
        active = false;
        for (const timer of timers) clearTimeout(timer);
        timers = [];
        for (const restore of restores.reverse()) safe(restore);
        restores = [];
        safe(() => histogram?.disable());
        report('startup-window-end');
    }
    return { install, report, stop, measureSync, measureAsync };
}

const profiler = createProfiler();
module.exports = { ...profiler, createProfiler };