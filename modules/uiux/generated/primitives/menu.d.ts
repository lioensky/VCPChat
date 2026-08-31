import type { UiScope } from '../contracts.js';
export interface MenuItem {
    readonly id: string;
    readonly label: string | Node;
    readonly disabled?: boolean;
    readonly icon?: Node;
    readonly danger?: boolean;
    readonly submenu?: readonly MenuItem[];
}
export interface MenuSeparator {
    readonly type: 'separator';
    readonly id: string;
}
export interface MenuLabel {
    readonly type: 'label';
    readonly id: string;
    readonly text: string;
}
export type MenuEntry = MenuItem | MenuSeparator | MenuLabel;
export interface MenuProps {
    readonly items: readonly MenuEntry[];
    readonly footer?: readonly MenuEntry[];
    readonly selectedId?: string;
    readonly selectedIds?: readonly string[];
    readonly onSelect: (id: string) => void;
    readonly onClose?: () => void;
    readonly align?: 'start' | 'end';
    readonly side?: 'bottom' | 'top' | 'right';
    readonly portal?: boolean;
    readonly closeOnPointerLeave?: boolean;
    readonly dense?: boolean;
    readonly compact?: boolean;
    readonly open?: boolean;
}
export interface MenuController {
    readonly root: HTMLSpanElement;
    readonly list: HTMLDivElement;
    readonly open: boolean;
    setOpen(open: boolean): void;
    setSelected(selectedId?: string, selectedIds?: readonly string[]): void;
    dispose(): void | Promise<void>;
}
/** Owner-controlled Harness Menu rendered in Light DOM. */
export declare function mountMenu(anchor: HTMLElement, props: MenuProps, scope: UiScope): MenuController;
