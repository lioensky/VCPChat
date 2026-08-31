import type { UiScope } from '../contracts.js';
export interface ModalProps {
    readonly title: string;
    readonly closeLabel?: string;
    readonly description?: string;
    readonly className?: string;
    readonly contentClassName?: string;
    readonly body?: Node | readonly Node[];
    readonly footer?: Node | readonly Node[];
    readonly headless?: boolean;
    readonly open?: boolean;
    /** Lets an owning composite decline mask/Escape/close-button dismissal while a child owns interaction. */
    readonly canClose?: () => boolean;
    readonly onClose?: () => void;
}
export interface ModalController {
    readonly root: HTMLDivElement;
    readonly dialog: HTMLDivElement;
    readonly open: boolean;
    setOpen(open: boolean): void;
    dispose(): void | Promise<void>;
}
/** Controlled Harness Modal rendered as a body portal in Light DOM. */
export declare function mountModal(props: ModalProps, scope: UiScope): ModalController;
