import type { UiScope } from '../contracts.js';
export declare const TOAST_HOLD_MS = 3000;
export declare const TOAST_FADE_MS = 1000;
export interface ToastProps {
    readonly text: string;
    readonly icon?: Node;
    readonly anchor?: HTMLElement | null;
    readonly onDone: () => void;
}
export interface ToastController {
    readonly root: HTMLDivElement;
    readonly active: boolean;
    dispose(): void | Promise<void>;
}
/** One owner-controlled Harness transient banner rendered through a body portal. */
export declare function mountToast(props: ToastProps, scope: UiScope): ToastController;
