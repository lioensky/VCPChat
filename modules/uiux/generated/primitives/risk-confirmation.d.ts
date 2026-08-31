import type { UiScope } from '../contracts.js';
import { type ModalController } from './modal.js';
export interface RiskConfirmationProps {
    readonly title: string;
    readonly description: string;
    readonly acknowledgeLabel: string;
    readonly cancelLabel: string;
    readonly confirmLabel: string;
    readonly acknowledged: boolean;
    readonly disabled?: boolean;
    readonly open?: boolean;
    readonly onAcknowledgedChange: (acknowledged: boolean) => void;
    readonly onCancel: () => void;
    readonly onConfirm: () => void;
}
export interface RiskConfirmationController {
    readonly modal: ModalController;
    readonly acknowledgement: HTMLInputElement;
    readonly confirmButton: HTMLButtonElement;
    readonly open: boolean;
    setOpen(open: boolean): void;
    setAcknowledged(acknowledged: boolean): void;
    setDisabled(disabled: boolean): void;
    dispose(): void | Promise<void>;
}
/** Candidate-only controlled acknowledgement gate; it owns no VCP business command or durable state. */
export declare function mountRiskConfirmation(props: RiskConfirmationProps, scope: UiScope): RiskConfirmationController;
