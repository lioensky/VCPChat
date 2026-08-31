import type { UiDisposer, UiScope } from '../contracts.js';
import { type PopupSelectController } from './popup-select.js';
export interface AgentModelOption {
    readonly id: string;
    readonly label: string;
    readonly provider?: string;
    /** Optional presentation group (for example Hot/Favorites/All). */
    readonly group?: string;
    readonly favorite?: boolean;
    readonly active?: boolean;
    readonly disabled?: boolean;
}
export interface AgentModelEffortOption {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}
/**
 * Ephemeral model-directory operations injected by the real Settings Surface.
 * The primitive never imports chatAPI; the bridge remains the only boundary
 * that maps IPC results into presentation options.
 */
export interface AgentModelDirectoryCapability {
    refresh?(signal: AbortSignal): Promise<void>;
    toggleFavorite?(id: string, signal: AbortSignal): Promise<void>;
    subscribeUpdated?(listener: () => void): UiDisposer | void;
}
export interface AgentModelPickerProps {
    readonly label?: string;
    /** Harness ModelSelect disables the native trigger while its owner is locked. */
    readonly locked?: boolean;
    /** Reuse an existing surface trigger while keeping its identity intact. */
    readonly trigger?: HTMLButtonElement;
    readonly options: (signal: AbortSignal) => Promise<readonly AgentModelOption[]>;
    readonly directory?: AgentModelDirectoryCapability;
    /** `false` rejects the selection; Harness parity keeps the menu open and shows a Toast. */
    readonly onSelect: (option: AgentModelOption) => void | boolean | Promise<void | boolean>;
    readonly efforts?: readonly AgentModelEffortOption[];
    readonly onEffortSelect?: (option: AgentModelEffortOption) => void | Promise<void>;
    readonly selectedEffort?: string;
    readonly selectedId?: string;
    /** Keep the product extension searchable by default; disable for parity fixtures. */
    readonly searchEnabled?: boolean;
    /** Render explicit ordered groups for the production directory projection. */
    readonly grouped?: boolean;
    /** Opt into Harness provider-grouped menuitemradio DOM for equivalence fixtures. */
    readonly harnessEquivalent?: boolean;
    readonly open?: boolean;
}
export interface AgentModelPickerController {
    readonly root: HTMLSpanElement;
    readonly trigger: HTMLButtonElement;
    readonly popup: PopupSelectController;
    open(): void;
    close(): void;
    refresh(): void;
    setSelected(id: string | undefined): void;
    setPane(pane: 'root' | 'model' | 'effort'): void;
    dispose(): UiDisposer | Promise<void>;
}
/**
 * Candidate-only Agent model picker. It mirrors Harness model-selection
 * interaction while keeping model discovery and persistence injected.
 * `agentModel` remains a separate canonical native input in production.
 */
export declare function mountAgentModelPicker(host: HTMLElement, props: AgentModelPickerProps, scope: UiScope): AgentModelPickerController;
