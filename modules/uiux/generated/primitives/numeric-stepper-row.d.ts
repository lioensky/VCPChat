import type { UiScope } from '../contracts.js';
export interface NumericStepperRowController {
    readonly root: HTMLDivElement;
    dispose(): void | Promise<void>;
}
export declare function mountNumericStepperRow(host: HTMLElement, input: HTMLInputElement, props: {
    title: string;
    description: string;
    unit?: string;
}, scope: UiScope): NumericStepperRowController;
