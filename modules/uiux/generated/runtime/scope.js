/**
 * Typed seam over the existing LifecycleScope. It deliberately delegates all
 * ownership semantics instead of creating a second lifecycle implementation.
 */
export function createUiScope(scope) {
    return {
        label: scope.label,
        get active() { return scope.active; },
        own: (disposer, label, type) => scope.own(disposer, label, type),
        listen: (target, type, handler, options) => scope.listen(target, type, handler, options),
        subscribe: (register, label) => scope.subscribe(register, label),
        child: label => createUiScope(scope.child(label)),
        track: (task, label) => scope.track(task, label),
        dispose: reason => scope.dispose(reason),
        snapshot: () => scope.snapshot(),
    };
}
export function createUiScopeFromGlobal(label) {
    const lifecycle = globalThis.VCPLifecycle;
    if (!lifecycle?.LifecycleScope)
        throw new Error('VCPLifecycle.LifecycleScope is unavailable.');
    return createUiScope(new lifecycle.LifecycleScope(label));
}
