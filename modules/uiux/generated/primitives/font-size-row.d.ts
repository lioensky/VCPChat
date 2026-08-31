import type { UiScope } from '../contracts.js';
export interface FontSizeRowController {
    readonly root: HTMLDivElement;
    setValue(value: string): void;
    dispose(): void | Promise<void>;
}
/** Harness FontSizeRow presentation over the existing canonical select. */
export declare function mountFontSizeRow(host: HTMLElement, select: HTMLSelectElement, scope: UiScope): FontSizeRowController;
