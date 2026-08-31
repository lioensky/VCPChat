import type { UiDisposer, UiScope } from '../contracts.js';
export interface RangeProps {
    readonly output?: HTMLElement | null;
    readonly format?: (value: string) => string;
}
/** Harness range contract over a native range and optional output. */
export declare function mountRange(input: HTMLInputElement, props: RangeProps | undefined, scope: UiScope): UiDisposer;
