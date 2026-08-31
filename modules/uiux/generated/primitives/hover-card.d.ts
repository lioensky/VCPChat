import type { UiScope } from '../contracts.js';
export interface HoverCardProps {
    readonly content: Node | readonly Node[];
    readonly openDelayMs?: number;
    readonly disabled?: boolean;
    readonly copyText?: string;
    readonly copyLabel?: string;
    readonly copiedLabel?: string;
}
export interface HoverCardController {
    readonly root: HTMLSpanElement;
    readonly card: HTMLDivElement | null;
    readonly open: boolean;
    readonly disabled: boolean;
    setDisabled(disabled: boolean): void;
    dispose(): void | Promise<void>;
}
/** Delayed, reachable Harness preview card rendered through a body portal. */
export declare function mountHoverCard(anchor: HTMLElement, props: HoverCardProps, scope: UiScope): HoverCardController;
