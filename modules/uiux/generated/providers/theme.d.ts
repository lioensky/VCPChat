import type { UiContext, UiDisposer, UiReadable, UiServiceDefinition } from '../contracts.js';
export interface ThemeState {
    readonly ready: boolean;
    /** User-selected mode; effective is the resolved mode used for rendering. */
    readonly preference: 'light' | 'dark' | 'system';
    readonly effective: 'light' | 'dark';
}
export type ThemeReadable = UiReadable<ThemeState>;
export interface ThemeUiService {
    readonly theme: ThemeReadable;
}
export declare const themeUiDefinition: UiServiceDefinition<ThemeUiService>;
/**
 * Presentation-only theme consumer. It never reads body.classList and owns its
 * subscription through the caller-provided UiScope.
 */
export declare function mountThemePresenter(root: HTMLElement, service: ThemeUiService, context: UiContext): UiDisposer;
