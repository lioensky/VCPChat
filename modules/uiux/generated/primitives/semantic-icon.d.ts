import type { UiScope } from '../contracts.js';
export type UiuxSemanticIconName = 'warning' | 'close' | 'check' | 'chevron-down';
export interface SemanticIconProps {
    readonly name: UiuxSemanticIconName;
    readonly size?: 14 | 16 | 18;
}
export interface SemanticIconController {
    readonly root: HTMLSpanElement;
    readonly name: UiuxSemanticIconName;
    setName(name: UiuxSemanticIconName): void;
    setSize(size: 14 | 16 | 18): void;
    refresh(): void;
    dispose(): void | Promise<void>;
}
/** Private Candidate slot that delegates glyph rendering to the existing VCPIcons owner. */
export declare function mountSemanticIcon(host: HTMLElement, props: SemanticIconProps, scope: UiScope): SemanticIconController;
