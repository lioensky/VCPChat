/*
 * 副屏标签的两级生命周期：
 *   side-pane（根）
 *    └─ tab:<id>   occurrence：标签打开到关闭，带 AbortSignal 和可见性
 *        └─ view   视图：每次挂载新建，休眠或关标签时释放
 * provider 把监听、Observer、定时器、IPC 订阅都挂到 view scope 上，释放时一起拆掉，不用自己逐个配对。
 */
import '../lifecycle-scope.js';
import '../state-channel.js';

function lifecycleApi() {
    const api = globalThis.VCPLifecycle;
    if (!api?.LifecycleScope) throw new Error('VCPLifecycle is not installed.');
    return api;
}

function stateChannelApi() {
    const api = globalThis.VCPStateChannels;
    if (!api?.StateChannel) throw new Error('VCPStateChannels is not installed.');
    return api;
}

/** 有父 scope 时挂到它下面，跟着它一起回收；否则单独建一个根 */
export function createSidePaneRootScope(parent = null, label = 'side-pane') {
    if (parent && typeof parent.child === 'function' && parent.active !== false) return parent.child(label);
    return new (lifecycleApi().LifecycleScope)(label);
}

/**
 * @param {object} parentScope 控制器的根 scope
 * @param {{ tabId: string, kind?: string }} info
 */
export function createTabOccurrence(parentScope, { tabId, kind = '' }) {
    const scope = parentScope.child(`tab:${tabId}`);
    const abort = scope.abortController('occurrence-signal');
    // 每个标签一份，不进全局注册表；名字只用于诊断输出
    const visible = new (stateChannelApi().StateChannel)('side-pane.visible', false);
    scope.own(() => visible.dispose(), 'visible-channel', 'state-channel');
    let view = null;

    /** 交给 provider 的只读部分 */
    const occurrence = Object.freeze({
        id: tabId,
        kind,
        signal: abort.signal,
        visible,
        isVisible: () => !visible.disposed && visible.get() === true
    });

    return Object.freeze({
        occurrence,
        scope,
        get active() { return scope.active; },
        get view() { return view?.active ? view : null; },
        /** 新建这次挂载的 view scope；上一次的还没释放就先释放 */
        openView() {
            if (view?.active) void view.dispose('remounted');
            view = scope.child('view');
            return view;
        },
        closeView(reason = 'view-released') {
            const current = view;
            view = null;
            return current ? current.dispose(reason) : Promise.resolve();
        },
        /** 返回值表示可见性是否真的变了 */
        setVisible(value) {
            if (!scope.active || visible.disposed) return false;
            const next = Boolean(value);
            if (visible.get() === next) return false;
            visible.publish(next, { source: 'side-pane' });
            return true;
        },
        dispose(reason = 'tab-closed') {
            if (!abort.signal.aborted) abort.abort(reason);
            return scope.dispose(reason);
        }
    });
}

/**
 * 只在可见时轮询：隐藏时整段定时器都不存在；重新可见时距上次已超过一个周期就先补一次。
 * callback 返回 Promise 时，上一次没结束不会叠加下一次。
 * @param {object} scope 通常是 view scope
 * @param {{ get(): boolean, subscribe(fn): () => void }} visible occurrence.visible
 * @param {() => unknown} callback
 * @param {number} intervalMs
 * @param {{ leading?: boolean, label?: string }} [options] leading 为 true 时第一次可见就立即执行
 * @returns {() => void} 停止
 */
export function pollWhileVisible(scope, visible, callback, intervalMs, { leading = false, label = 'poll-while-visible' } = {}) {
    let lastRun = leading ? 0 : Date.now();
    let running = null;
    let inFlight = false;
    let stopped = false;

    const tick = () => {
        if (inFlight || stopped || !scope.active) return;
        lastRun = Date.now();
        let result;
        try {
            result = callback();
        } catch (error) {
            console.error(`[SidePane] ${label} failed:`, error);
            return;
        }
        if (result && typeof result.then === 'function') {
            inFlight = true;
            Promise.resolve(result)
                .catch(error => console.error(`[SidePane] ${label} failed:`, error))
                .finally(() => { inFlight = false; });
        }
    };
    const start = () => {
        if (running || stopped || !scope.active) return;
        running = scope.child(label);
        running.interval(tick, intervalMs, label);
        if (Date.now() - lastRun >= intervalMs) tick();
    };
    const stop = () => {
        const current = running;
        running = null;
        if (current) void current.dispose('hidden');
    };

    const unsubscribe = scope.subscribe(() => visible.subscribe(value => (value ? start() : stop())), `${label}:visibility`);
    return () => {
        stopped = true;
        void unsubscribe();
        stop();
    };
}
