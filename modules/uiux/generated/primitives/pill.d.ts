import type { UiDisposer, UiScope } from '../contracts.js';
export interface PillProps {
    readonly active?: boolean;
    readonly interactive?: boolean;
    readonly onClick?: ((event: MouseEvent) => void) | undefined;
}
/** Harness Pill contract applied to a native span or button in Light DOM. */
export declare function mountPill(host: HTMLElement, props: PillProps | undefined, scope: UiScope): UiDisposer;
