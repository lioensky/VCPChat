import type { UiScope } from '../contracts.js';
export interface DiffHunk {
    readonly path: string;
    readonly oldText: string | null;
    readonly newText: string;
}
export interface DiffBlockProps {
    readonly diffs: readonly DiffHunk[];
    readonly maxLines?: number;
    readonly copy?: (text: string) => void | Promise<void>;
}
export interface DiffBlockController {
    readonly root: HTMLElement;
    readonly expanded: boolean;
    setExpanded(value: boolean): void;
    dispose(): void | Promise<void>;
}
/** Candidate-only frozen-domain fixture. It never consumes VCP tool or chat state. */
export declare function mountDiffBlock(host: HTMLElement, props: DiffBlockProps, scope: UiScope): DiffBlockController;
