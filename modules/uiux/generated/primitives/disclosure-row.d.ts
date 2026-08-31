import type { UiScope } from '../contracts.js';
export interface DisclosureRowProps {
    readonly icon: Node;
    readonly title: string;
    readonly open: boolean;
    readonly expandable: boolean;
    readonly onToggle: () => void;
    readonly expandOnRowClick?: boolean;
    readonly previewChevron?: boolean;
    readonly keepContentWhenOpen?: boolean;
    readonly collapsedContent?: Node | readonly Node[];
    readonly children?: Node | readonly Node[];
    readonly className?: string;
    readonly rowClassName?: string;
    readonly leadingClassName?: string;
    readonly chevronClassName?: string;
    readonly titleClassName?: string;
}
export interface DisclosureRowController {
    readonly root: HTMLDivElement;
    readonly row: HTMLDivElement;
    readonly leading: HTMLElement;
    readonly open: boolean;
    readonly expandable: boolean;
    setOpen(open: boolean): void;
    setExpandable(expandable: boolean): void;
    setTitle(title: string): void;
    dispose(): void | Promise<void>;
}
/**
 * Controlled adoption contract for a production surface whose canonical DOM
 * cannot be replaced.  It shares DisclosureRow's interaction and lifecycle
 * rules without moving content such as a live form, a PromptManager mount or
 * a dynamic list into a new tree.
 */
export interface DisclosureRowAdoptionProps {
    readonly content: HTMLElement;
    readonly open: boolean;
    readonly expandable: boolean;
    readonly onToggle: () => void;
    readonly className?: string;
    readonly toggle?: HTMLElement | null;
}
export interface DisclosureRowAdoptionController {
    readonly host: HTMLElement;
    readonly open: boolean;
    readonly expandable: boolean;
    setOpen(open: boolean): void;
    setExpandable(expandable: boolean): void;
    dispose(): void | Promise<void>;
}
/** Controlled Harness DisclosureRow with reversible Light-DOM ownership. */
export declare function mountDisclosureRow(host: HTMLElement, props: DisclosureRowProps, scope: UiScope): DisclosureRowController;
/**
 * Adopt an existing Light-DOM disclosure header without replacing its child
 * nodes.  This is intentionally not a general DOM renderer: callers keep the
 * business DOM and supply the canonical open state through setOpen().
 */
export declare function mountDisclosureRowController(host: HTMLElement, props: DisclosureRowAdoptionProps, scope: UiScope): DisclosureRowAdoptionController;
