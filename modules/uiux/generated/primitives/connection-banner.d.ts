import type { UiDisposer, UiScope } from '../contracts.js';
export interface ConnectionBannerProps {
    readonly reconnecting: boolean;
    readonly label?: string;
}
export interface ConnectionBannerController extends UiDisposer {
    setReconnecting(value: boolean): void;
    setLabel(value: string): void;
}
/** Harness ConnectionBanner contract; the caller owns connection state. */
export declare function mountConnectionBanner(host: HTMLElement, props: ConnectionBannerProps, scope: UiScope): ConnectionBannerController;
