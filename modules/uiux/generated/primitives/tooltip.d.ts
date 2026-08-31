import type { UiScope } from '../contracts.js';
export type TooltipSide = 'right' | 'bottom' | 'top';
export interface TooltipProps {
    readonly label: string | (() => string);
    readonly side?: TooltipSide;
    readonly delayMs?: number;
    readonly disabled?: boolean;
    readonly maxWidth?: number;
}
export interface TooltipController {
    readonly anchor: HTMLElement;
    readonly bubble: HTMLSpanElement | null;
    readonly open: boolean;
    readonly disabled: boolean;
    setDisabled(disabled: boolean): void;
    dispose(): void | Promise<void>;
}
/** Harness Tooltip attaches to the existing anchor without adding a wrapper. */
export declare function mountTooltip(anchor: HTMLElement, props: TooltipProps, scope: UiScope): TooltipController;
