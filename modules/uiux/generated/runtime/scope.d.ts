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
export declare function createUiScope(scope: LegacyScope): UiScope;
export declare function createUiScopeFromGlobal(label: string): UiScope;
export {};
