// Compatibility lifecycle ownership only: this module is NOT a security sandbox.
let nextHandle = 1;

export function createAnimationMountController(root, optimizer) {
    const realm = root.ownerDocument.defaultView;
    const revision = root._vcpRenderRevision;
    const message = root.closest('.message-item');
    const resources = new Set();
    const tasks = new Map();
    const requestFrame = optimizer?.createPausableRAF?.(message, realm) || realm.requestAnimationFrame.bind(realm);
    const cancelFrame = requestFrame.cancel || realm.cancelAnimationFrame?.bind(realm);
    let state = 'born';
    const safely = action => {
        try { action(); } catch (error) { console.warn('[AnimationMount] release failed:', error); }
    };
    const current = () => state !== 'revoked' && root._vcpRenderRevision === revision && root.isConnected;
    const cancel = handle => {
        const task = tasks.get(handle);
        if (!task) return;
        tasks.delete(handle);
        task.ticket++;
        if (task.native !== null) {
            if (task.kind === 'frame') cancelFrame?.(task.native);
            else realm.clearTimeout(task.native);
        }
    };
    const schedule = task => {
        if (!current() || !tasks.has(task.id) || state === 'paused') return;
        const ticket = ++task.ticket;
        const fire = timestamp => {
            if (ticket !== task.ticket) return;
            task.native = null;
            if (!current() || !tasks.has(task.id)) { cancel(task.id); return; }
            if (state === 'paused') return;
            if (!task.repeat) tasks.delete(task.id);
            try { task.callback(...(task.kind === 'frame' ? [timestamp] : task.args)); }
            finally {
                if (task.repeat && tasks.has(task.id)) schedule(task);
            }
        };
        task.native = task.kind === 'frame'
            ? requestFrame(fire)
            : realm.setTimeout(fire, task.delay);
    };
    const createTask = (kind, callback, delay = 0, args = [], repeat = false) => {
        if (!current()) return 0;
        if (typeof callback !== 'function') throw new TypeError('Managed callbacks must be functions');
        if (tasks.size >= 4096) throw new RangeError('Animation mount callback limit exceeded');
        const task = { id: nextHandle++, kind, callback, delay: Math.max(0, Number(delay) || 0), args, repeat, native: null, ticket: 0 };
        tasks.set(task.id, task);
        schedule(task);
        return task.id;
    };
    const controller = {
        root, revision, optimizer,
        get state() { return state; },
        isCurrent: current,
        own(dispose) {
            if (state === 'revoked') { safely(dispose); return () => {}; }
            resources.add(dispose);
            return () => resources.delete(dispose);
        },
        guard(callback) {
            return (...args) => { if (current()) return callback(...args); };
        },
        pause() {
            if (state === 'revoked' || state === 'paused') return;
            state = 'paused';
            for (const task of tasks.values()) {
                task.ticket++;
                if (task.native !== null) {
                    if (task.kind === 'frame') cancelFrame?.(task.native);
                    else realm.clearTimeout(task.native);
                    task.native = null;
                }
            }
        },
        resume() {
            if (state === 'revoked') return;
            state = 'running';
            for (const task of tasks.values()) if (task.native === null) schedule(task);
        },
        revoke() {
            if (state === 'revoked') return;
            state = 'revoked'; // Close registration before running arbitrary disposers.
            for (const id of tasks.keys()) safely(() => cancel(id));
            for (const dispose of resources) safely(dispose);
            resources.clear();
        },
        getStats: () => ({ state, tasks: tasks.size, resources: resources.size }),
        api: {
            requestAnimationFrame: callback => createTask('frame', callback),
            cancelAnimationFrame: cancel,
            setTimeout: (callback, delay, ...args) => createTask('timer', callback, delay, args),
            clearTimeout: cancel,
            setInterval: (callback, delay, ...args) => createTask('timer', callback, delay, args, true),
            clearInterval: cancel,
        },
    };
    const listeners = [];
    controller.listen = (target, type, callback, options) => {
        if (!current() || !callback) return;
        const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
        if (listeners.some(entry => entry.target === target && entry.type === type && entry.callback === callback && entry.capture === capture)) return;
        const wrapped = controller.guard(event => typeof callback === 'function'
            ? callback.call(target, event) : callback.handleEvent(event));
        const entry = { target, type, callback, capture, wrapped };
        listeners.push(entry);
        target.addEventListener(type, wrapped, options);
        entry.release = controller.own(() => target.removeEventListener(type, wrapped, capture));
    };
    controller.unlisten = (target, type, callback, options) => {
        const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
        const index = listeners.findIndex(entry => entry.target === target && entry.type === type && entry.callback === callback && entry.capture === capture);
        if (index < 0) return;
        const [entry] = listeners.splice(index, 1);
        target.removeEventListener(type, entry.wrapped, capture);
        entry.release();
    };
    controller.own(() => { listeners.length = 0; });
    for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
        if (typeof realm[name] !== 'function') continue;
        controller.api[name] = new Proxy(realm[name], {
            construct(Constructor, [callback, ...args]) {
                if (!current()) throw new Error('Animation mount revoked');
                const observer = new Constructor(controller.guard(callback), ...args);
                controller.own(() => observer.disconnect());
                return observer;
            },
        });
    }
    if (realm.Worker) controller.api.Worker = new Proxy(realm.Worker, {
        construct(Constructor, args) {
            if (!current()) throw new Error('Animation mount revoked');
            const worker = new Constructor(...args);
            controller.own(() => worker.terminate());
            return worker;
        },
    });
    if (realm.fetch) controller.api.fetch = (input, options = {}) => {
        if (!current()) return Promise.reject(new Error('Animation mount revoked'));
        const abort = new realm.AbortController();
        const forwardAbort = () => abort.abort(options.signal.reason);
        if (options.signal?.aborted) forwardAbort();
        else options.signal?.addEventListener('abort', forwardAbort, { once: true });
        const release = controller.own(() => abort.abort());
        return realm.fetch(input, { ...options, signal: abort.signal }).finally(() => {
            release();
            options.signal?.removeEventListener('abort', forwardAbort);
        });
    };
    if (realm.URL) {
        const urls = new Map();
        controller.api.URL = new Proxy(realm.URL, {
            get(target, prop) {
                if (prop === 'createObjectURL') return blob => {
                    if (!current()) throw new Error('Animation mount revoked');
                    const url = target.createObjectURL(blob);
                    urls.set(url, controller.own(() => target.revokeObjectURL(url)));
                    return url;
                };
                if (prop === 'revokeObjectURL') return url => {
                    target.revokeObjectURL(url);
                    urls.get(url)?.();
                    urls.delete(url);
                };
                return Reflect.get(target, prop);
            },
        });
    }
    controller.api.addEventListener = (type, callback, options) => controller.listen(realm, type, callback, options);
    controller.api.removeEventListener = (type, callback, options) => controller.unlisten(realm, type, callback, options);
    controller.api.queueMicrotask = callback => realm.queueMicrotask(controller.guard(callback));
    state = optimizer?.isMessagePaused?.(message) ? 'paused' : 'running';
    optimizer?.registerAnimationMount?.(message, controller);
    return controller;
}