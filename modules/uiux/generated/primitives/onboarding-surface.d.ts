import type { UiScope } from '../contracts.js';
export interface OnboardingSurfaceProps {
    readonly content: Node | readonly Node[];
    readonly appRoot?: HTMLElement | null;
    readonly open?: boolean;
}
export interface OnboardingSurfaceController {
    readonly overlay: HTMLDivElement;
    readonly stage: HTMLDivElement;
    readonly open: boolean;
    setOpen(value: boolean): void;
    dispose(): void | Promise<void>;
}
/** Harness first-run takeover: body portal plus exact app-root inert ownership. */
export declare function mountOnboardingSurface(props: OnboardingSurfaceProps, scope: UiScope): OnboardingSurfaceController;
