/*
 * 共享数据源：同一份数据（命令运行记录、Git 状态、V工程 列表……）在一个窗口里只取一份，
 * 状态面板、侧栏标签等消费者读同一个快照。建在 VCPStateChannels 的 StateChannel 之上，补上「按持有者启停」：
 *   - 订阅者和 retain() 都算持有者；0→1 时 start()（订阅 main 推送）并 fetch() 一次；
 *   - 最后一个持有者离开后过 graceMs 才停（abort start 的 signal，调用它返回的清理函数），切标签不会来回抖动；
 *   - 有 pollMs 时整个源只有一个轮询，而且只在至少一个持有者可见时运行；
 *   - invalidate() 让所有消费者一起刷新，进行中的请求会合并，不会叠加。
 * 快照形如 { status: 'idle' | 'loading' | 'ready' | 'error', data, error, updatedAt }。
 * 停下以后回到 'idle'：data 留着当占位，但它已经没人维护了，不能再算 'ready'；
 * 下一个持有者来时先看到 'loading' 加上旧数据，等新结果回来才是 'ready'。
 */
import './state-channel.js';

const sources = new Set();

function stateChannelApi() {
    const api = globalThis.VCPStateChannels;
    if (!api?.StateChannel) throw new Error('VCPStateChannels is not installed.');
    return api;
}

function channelName(name, key) {
    const raw = key == null || key === '' ? name : `${name}.${key}`;
    // StateChannel 的名字只允许小写字母、数字、点和连字符
    const safe = String(raw).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').slice(0, 64);
    return /^[a-z]/.test(safe) && safe.length >= 2 ? safe : `s-${safe}`.slice(0, 64);
}

function unrefTimer(timer) {
    timer?.unref?.();
    return timer;
}

/**
 * @param {string} name 诊断用的名字，例如 'terminal.command-runs'
 * @param {object} options
 * @param {string} [options.key] 同名不同 key 各一份，例如工作区 id
 * @param {*} [options.initial] data 的初始值
 * @param {(ctx: { key, signal: AbortSignal, publish: Function, update: Function, invalidate: Function }) => (Function|void|Promise)} [options.start]
 *        有持有者时调用；返回的函数在停止时调用
 * @param {(ctx: { key, signal: AbortSignal }) => Promise<*>} [options.fetch] 取一次完整数据
 * @param {number} [options.graceMs=30000]
 * @param {number|null} [options.pollMs=null] 只给没有推送的源用
 */
export function createSharedSource(name, {
    key = '',
    initial = null,
    start = null,
    fetch = null,
    graceMs = 30_000,
    pollMs = null
} = {}) {
    const channel = new (stateChannelApi().StateChannel)(channelName(name, key), Object.freeze({ status: 'idle', data: initial, error: null, updatedAt: 0 }));
    const holders = new Set();
    let running = null; // { abort: AbortController, cleanup: Function|null }
    let graceTimer = null;
    let pollTimer = null;
    let inflight = null;
    let queued = null;
    let lastFetch = 0;
    let replay = null; // 请求进行中收到的增量推送，结果回来后再叠上去，免得被旧列表盖掉
    let pushes = 0; // 请求进行中来了完整推送，请求结果就过时了
    let fetches = 0;
    let starts = 0;
    let disposed = false;

    const envelope = () => channel.get();
    const commit = patch => channel.publish(Object.freeze({ ...envelope(), ...patch }), { source: name });

    function publish(data) {
        if (disposed) return;
        pushes += 1;
        commit({ status: 'ready', data, error: null, updatedAt: Date.now() });
    }

    /** 推送增量：updater 拿到当前 data，返回新的 data */
    function update(updater) {
        if (disposed) return;
        if (replay) replay.push(updater);
        const next = updater(envelope().data);
        commit({ status: envelope().status === 'idle' ? 'ready' : envelope().status, data: next, updatedAt: Date.now() });
    }

    function runFetch() {
        const signal = running.abort.signal;
        const seenPushes = pushes;
        fetches += 1;
        lastFetch = Date.now();
        replay = [];
        if (envelope().status === 'idle') commit({ status: 'loading' });
        const promise = (async () => {
            try {
                let data = await fetch({ key, signal });
                if (signal.aborted || disposed || pushes !== seenPushes) return envelope();
                for (const updater of replay || []) data = updater(data);
                commit({ status: 'ready', data, error: null, updatedAt: Date.now() });
            } catch (error) {
                if (!signal.aborted && !disposed) commit({ status: 'error', error: error?.message || String(error) });
            } finally {
                if (inflight === promise) { inflight = null; replay = null; }
            }
            return envelope();
        })();
        inflight = promise;
        return promise;
    }

    /** 让所有消费者一起刷新；没有持有者时不取，下次有人持有时自然会取 */
    function invalidate() {
        if (disposed || !running || typeof fetch !== 'function') return Promise.resolve(envelope());
        if (!inflight) return runFetch();
        if (!queued) {
            queued = inflight.then(() => {
                queued = null;
                return running && !disposed ? runFetch() : envelope();
            });
        }
        return queued;
    }

    const anyVisible = () => [...holders].some(holder => holder.isVisible());

    function syncPoll() {
        const want = Boolean(running && pollMs > 0 && typeof fetch === 'function' && anyVisible());
        if (want && !pollTimer) {
            pollTimer = unrefTimer(setInterval(() => { if (!inflight) void invalidate(); }, pollMs));
            // 隐藏了很久再显示：先补一次，不用等满一个周期
            if (Date.now() - lastFetch >= pollMs) void invalidate();
        } else if (!want && pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function startRunning() {
        if (running || disposed) return;
        starts += 1;
        running = { abort: new AbortController(), cleanup: null };
        const current = running;
        if (typeof start === 'function') {
            try {
                const result = start({ key, signal: current.abort.signal, publish, update, invalidate });
                if (typeof result === 'function') current.cleanup = result;
                else if (result && typeof result.then === 'function') {
                    result.then(cleanup => {
                        if (typeof cleanup !== 'function') return;
                        if (running === current) current.cleanup = cleanup;
                        else cleanup();
                    }, error => console.error(`[SharedSource] ${name} start failed:`, error));
                }
            } catch (error) {
                console.error(`[SharedSource] ${name} start failed:`, error);
            }
        }
        void invalidate();
    }

    function stopRunning() {
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
        const current = running;
        if (!current) return;
        running = null;
        inflight = null;
        queued = null;
        replay = null;
        syncPoll();
        current.abort.abort('released');
        try { current.cleanup?.(); } catch (error) { console.error(`[SharedSource] ${name} stop failed:`, error); }
        // 停下以后不再有推送，留下的数据随时会过时；出错状态也不留，下次重新取
        if (!disposed && envelope().status !== 'idle') commit({ status: 'idle', error: null });
    }

    function addHolder({ scope = null, visible = null, label = 'holder', listener = null, immediate = true } = {}) {
        if (disposed) throw new Error(`Shared source "${channel.name}" is disposed.`);
        const holder = {
            label,
            visible,
            isVisible: () => !visible || (!visible.disposed && visible.get() === true),
            offVisible: null,
            offListener: null
        };
        holders.add(holder);
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
        // 先启动再订阅：第一次拿到的就是 'loading'，不会先闪一下 'idle'
        if (holders.size === 1) startRunning();
        if (listener) holder.offListener = channel.subscribe(listener, { immediate });
        if (visible?.subscribe) holder.offVisible = visible.subscribe(() => syncPoll(), { immediate: false });
        syncPoll();

        let released = false;
        let releaseFromScope = null;
        const release = () => {
            if (released) return;
            released = true;
            holders.delete(holder);
            try { holder.offListener?.(); } catch (_e) { /* 已取消 */ }
            try { holder.offVisible?.(); } catch (_e) { /* 已取消 */ }
            releaseFromScope?.forget?.();
            syncPoll();
            if (holders.size || disposed) return;
            if (graceMs > 0) graceTimer = unrefTimer(setTimeout(stopRunning, graceMs));
            else stopRunning();
        };
        if (scope?.own && scope.active !== false) releaseFromScope = scope.own(release, `source:${channel.name}`, 'shared-source');
        return release;
    }

    const source = Object.freeze({
        name: channel.name,
        channel,
        get: envelope,
        get data() { return envelope().data; },
        get holders() { return holders.size; },
        get running() { return Boolean(running); },
        /** 只占住数据源（例如还没渲染就要它开始取） */
        retain(scope = null, { visible = null, label = 'retain' } = {}) {
            return addHolder({ scope, visible, label });
        },
        /** 读快照并跟随变化；订阅本身就算一个持有者 */
        subscribe(listener, { scope = null, visible = null, label = 'subscriber', immediate = true } = {}) {
            if (typeof listener !== 'function') throw new TypeError('Shared source subscriber must be a function.');
            return addHolder({ scope, visible, label, listener, immediate });
        },
        invalidate,
        /** 等进行中的请求（含排队的那次）结束；没有请求时立即返回当前快照 */
        settled() {
            return Promise.resolve(queued || inflight || envelope()).then(() => envelope());
        },
        publish,
        update,
        diagnostics() {
            return Object.freeze({
                name: channel.name,
                status: envelope().status,
                holders: holders.size,
                // 谁还占着这个数据源：只有登记时给的 label，泄漏时一眼看出是哪个面板没放手
                holderLabels: [...holders].map(holder => holder.label),
                visibleHolders: [...holders].filter(holder => holder.isVisible()).length,
                running: Boolean(running),
                polling: Boolean(pollTimer),
                pendingStop: Boolean(graceTimer),
                fetching: Boolean(inflight),
                fetches,
                starts,
                revision: channel.revision
            });
        },
        dispose() {
            if (disposed) return;
            holders.clear();
            stopRunning();
            disposed = true;
            sources.delete(source);
            channel.dispose();
        }
    });
    sources.add(source);
    return source;
}

/** 窗口里所有还活着的数据源，给 VCPLifecycleInspector 和泄漏测试用 */
export function sharedSourceDiagnostics() {
    return [...sources].map(source => source.diagnostics());
}

if (!globalThis.VCPSharedSources) {
    globalThis.VCPSharedSources = Object.freeze({ diagnostics: sharedSourceDiagnostics });
}
