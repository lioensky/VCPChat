import type { UiDisposer, UiScope } from '../contracts.js';
export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar';
export type ButtonSize = 'md' | 'sm';
export interface ButtonProps {
    readonly variant?: ButtonVariant;
    readonly size?: ButtonSize;
    readonly icon?: Node;
    readonly disabled?: boolean;
}
/** Harness Button contract applied to a native button in Light DOM. */
export declare function mountButton(button: HTMLButtonElement, props: ButtonProps | undefined, scope: UiScope): UiDisposer;
