/** Typed UI service seams. These contracts are presentation-only. */
export type UiDisposer = () => void | Promise<void>;
export interface UiSnapshot<TValue> {
    readonly value: Readonly<TValue>;
    readonly revision: number;
    readonly source: string;
}
export type UiSubscriber<TValue> = (value: Readonly<TValue>, snapshot: UiSnapshot<TValue>) => void;
export interface UiReadable<TValue> {
    get(): Readonly<TValue>;
    getSnapshot(): UiSnapshot<TValue>;
    subscribe(listener: UiSubscriber<TValue>, options?: {
        immediate?: boolean;
    }): UiDisposer;
}
export interface UiCommand<TRequest, TResult> {
    execute(request: TRequest): Promise<TResult> | TResult;
}
export interface UiScope {
    readonly label: string;
    readonly active: boolean;
    own(disposer: UiDisposer, label?: string, type?: string): UiDisposer;
    listen(target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions): UiDisposer;
    subscribe(register: () => UiDisposer | void, label?: string): UiDisposer;
    child(label: string): UiScope;
    track<T>(task: Promise<T>, label?: string): Promise<T>;
    dispose(reason?: string): Promise<void>;
    snapshot(): Readonly<Record<string, unknown>>;
}
export interface UiContext {
    readonly scope: UiScope;
    readonly services: Readonly<Record<string, unknown>>;
}
export interface UiServiceDefinition<TService> {
    readonly id: string;
    readonly provide: (context: UiContext) => TService;
}
export interface UiSurface<TProps = unknown> {
    mount(root: HTMLElement, props: TProps, context: UiContext): UiDisposer | void;
}
