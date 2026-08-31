import type { UiScope } from '../contracts.js';
import { type MenuController } from './menu.js';
export interface LanguageRowOption {
    readonly id: string;
    readonly label: string;
    readonly disabled?: boolean;
}
export interface LanguageRowProps {
    readonly title?: string;
    readonly description?: string;
    readonly options: readonly LanguageRowOption[];
    readonly activeId?: string;
    readonly loading?: boolean;
    readonly onSelect: (id: string) => void;
    readonly onClose?: () => void;
}
export interface LanguageRowController {
    readonly root: HTMLDivElement;
    readonly trigger: HTMLButtonElement;
    readonly menu: MenuController;
    readonly open: boolean;
    setOptions(options: readonly LanguageRowOption[]): Promise<void>;
    setActive(id?: string): void;
    setLoading(value: boolean): void;
    setOpen(value: boolean): void;
    dispose(): void | Promise<void>;
}
/** Candidate-only Light-DOM replication of Harness locale/LanguageRow. */
export declare function mountLanguageRow(host: HTMLElement, props: LanguageRowProps, scope: UiScope): LanguageRowController;
