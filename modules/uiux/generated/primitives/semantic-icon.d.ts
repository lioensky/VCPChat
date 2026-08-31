import type { UiScope } from '../contracts.js';
export type HarnessSemanticIconName = 'warning' | 'close' | 'check' | 'chevron-down';
export interface SemanticIconProps {
    readonly name: HarnessSemanticIconName;
    readonly size?: 14 | 16 | 18;
}
export interface SemanticIconController {
    readonly root: HTMLSpanElement;
    readonly name: HarnessSemanticIconName;
    setName(name: HarnessSemanticIconName): void;
    setSize(size: 14 | 16 | 18): void;
    refresh(): void;
    dispose(): void | Promise<void>;
}
/** Private Candidate slot that delegates glyph rendering to the existing VCPIcons owner. */
export declare function mountSemanticIcon(host: HTMLElement, props: SemanticIconProps, scope: UiScope): SemanticIconController;
