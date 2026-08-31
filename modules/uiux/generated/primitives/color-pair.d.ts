import type { UiDisposer, UiScope } from '../contracts.js';
export interface ColorPairProps {
    /** Presentation-only reaction; canonical values remain in native controls. */
    readonly onValueChange?: (value: string, source: 'color' | 'text') => void;
    /** Called after invalid text is restored to the canonical color value. */
    readonly onInvalid?: (value: string) => void;
}
export declare function mountColorPair(color: HTMLInputElement, text: HTMLInputElement, scope: UiScope, props?: ColorPairProps): UiDisposer;
