import type { UiDisposer, UiScope } from '../contracts.js';
export interface SelectProps {
    readonly label?: string;
    readonly portal?: boolean;
}
/**
 * Harness-compatible Select shell over an existing native select. The native
 * element remains the business/serialization source; the Light-DOM trigger
 * and menu are disposable presentation nodes.
 */
export declare function mountSelect(select: HTMLSelectElement, props: SelectProps | undefined, scope: UiScope): UiDisposer;
