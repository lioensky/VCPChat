import type { UiDisposer, UiScope } from '../contracts.js';
export interface FieldProps {
    readonly label: string;
    readonly description?: string;
    readonly error?: string;
    readonly control: HTMLElement;
}
/** Harness Field contract rendered in Light DOM; no business state or IPC. */
export declare function mountField(root: HTMLElement, props: FieldProps, scope: UiScope): UiDisposer;
