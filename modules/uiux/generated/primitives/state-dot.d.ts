import type { UiScope } from '../contracts.js';
export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error';
export interface StateDotProps {
    readonly state: StateDotState;
    readonly size?: number;
    readonly className?: string;
}
export interface StateDotController {
    readonly host: HTMLElement;
    readonly element: HTMLElement | SVGSVGElement;
    readonly state: StateDotState;
    readonly size: number;
    setState(state: StateDotState): void;
    setSize(size: number): void;
    dispose(): void | Promise<void>;
}
/** Harness state marker; visual-only and deliberately aria-hidden. */
export declare function mountStateDot(host: HTMLElement, props: StateDotProps, scope: UiScope): StateDotController;
