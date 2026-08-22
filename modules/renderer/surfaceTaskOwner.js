function createState() {
    return { generation: 0, scheduled: new Set(), running: new Set(), disposed: false };
}

/** Owns scheduler handles and already-started work for one DOM Surface root. */
export function createSurfaceTaskOwner({ environmentForRoot = root => root?.ownerDocument?.defaultView || globalThis } = {}) {
    const states = new WeakMap();
    const stateFor = root => {
        if (!root || (typeof root !== 'object' && typeof root !== 'function')) {
            throw new TypeError('SurfaceTaskOwner requires an object root');
        }
        let state = states.get(root);
        if (!state) {
            state = createState();
            states.set(root, state);
        }
        return state;
    };
    const cancelScheduled = (root, state) => {
        const environment = environmentForRoot(root);
        for (const task of [...state.scheduled]) {
            state.scheduled.delete(task);
            task.cancel?.();
            task.resolve({ status: 'revoked' });
        }
    };
    const schedule = (root, kind, callback, options = {}) => {
        const state = stateFor(root);
        if (state.disposed) return Promise.reject(new Error('SurfaceTaskOwner root is disposed'));
        const generation = state.generation;
        const environment = environmentForRoot(root);
        return new Promise((resolve, reject) => {
            const task = { kind, handle: null, resolve, cancel: null };
            const invoke = timestamp => {
                state.scheduled.delete(task);
                if (state.disposed || generation !== state.generation) {
                    resolve({ status: 'revoked' });
                    return;
                }
                const operation = Promise.resolve().then(() => callback(timestamp));
                state.running.add(operation);
                operation.then(
                    value => resolve({ status: 'completed', value }),
                    reject,
                ).finally(() => state.running.delete(operation));
            };
            if (kind === 'idle' && typeof environment.requestIdleCallback === 'function') {
                task.handle = environment.requestIdleCallback(invoke, options);
                task.cancel = () => environment.cancelIdleCallback?.(task.handle);
            } else {
                task.kind = 'frame';
                if (typeof environment.requestAnimationFrame === 'function') {
                    task.handle = environment.requestAnimationFrame(invoke);
                    task.cancel = () => environment.cancelAnimationFrame?.(task.handle);
                } else {
                    task.handle = environment.setTimeout(() => invoke(Date.now()), 0);
                    task.cancel = () => environment.clearTimeout?.(task.handle);
                }
            }
            state.scheduled.add(task);
        });
    };

    return Object.freeze({
        animationFrame(root, callback) { return schedule(root, 'frame', callback); },
        idle(root, callback, options) { return schedule(root, 'idle', callback, options); },
        revoke(root) {
            const state = stateFor(root);
            state.generation += 1;
            cancelScheduled(root, state);
        },
        async dispose(root) {
            const state = stateFor(root);
            if (!state.disposed) {
                state.disposed = true;
                state.generation += 1;
                cancelScheduled(root, state);
            }
            await Promise.allSettled([...state.running]);
        },
    });
}
