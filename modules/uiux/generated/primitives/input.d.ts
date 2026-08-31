import type { UiDisposer, UiScope } from '../contracts.js';
export interface InputProps {
    readonly placeholder?: string;
    readonly icon?: Node;
}
/** Harness Input contract: native input remains the authoritative control. */
export declare function mountInput(input: HTMLInputElement, props: InputProps | undefined, scope: UiScope): UiDisposer;
