import type { UiDisposer, UiScope } from '../contracts.js';

interface LegacyScope {
    readonly label: string;
    readonly active: boolean;
    own(disposer: UiDisposer, label?: string, type?: string): UiDisposer;
    listen(target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions, label?: string): UiDisposer;
    subscribe(register: () => UiDisposer | void, label?: string): UiDisposer;
    child(label: string): LegacyScope;
    track<T>(task: Promise<T>, label?: string): Promise<T>;
    dispose(reason?: string): Promise<void>;
    snapshot(): Readonly<Record<string, unknown>>;
}

/**
 * Typed seam over the existing LifecycleScope. It deliberately delegates all
 * ownership semantics instead of creating a second lifecycle implementation.
 */
export function createUiScope(scope: LegacyScope): UiScope {
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

export function createUiScopeFromGlobal(label: string): UiScope {
    const lifecycle = (globalThis as typeof globalThis & {
        VCPLifecycle?: { LifecycleScope?: new (label: string) => LegacyScope };
    }).VCPLifecycle;
    if (!lifecycle?.LifecycleScope) throw new Error('VCPLifecycle.LifecycleScope is unavailable.');
    return createUiScope(new lifecycle.LifecycleScope(label));
}
