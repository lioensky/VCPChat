import type { UiScope } from '../contracts.js';
import { type MenuController } from './menu.js';
/** One selectable preset; trust drives the PresetMenu label suffix. */
export interface AgentPresetRowOption {
    readonly id: string;
    readonly name?: string;
    readonly description?: string;
    readonly trust?: 'system' | 'user';
}
export interface AgentPresetRowProps {
    readonly options: readonly AgentPresetRowOption[];
    readonly currentValue?: string;
    /** Defaults mirror ui-agent-preset locales.ts en copy. */
    readonly title?: string;
    readonly descriptionLabel?: string;
    readonly loadingLabel?: string;
    readonly userTrustLabel?: string;
    readonly busy?: boolean;
    readonly writable?: boolean;
    readonly error?: string | null;
    readonly onSelect: (id: string) => void;
    readonly onClose?: () => void;
}
export interface AgentPresetRowController {
    readonly root: HTMLDivElement;
    readonly trigger: HTMLButtonElement;
    readonly menu: MenuController | null;
    readonly open: boolean;
    selectedLabel(): string;
    setOptions(options: readonly AgentPresetRowOption[]): Promise<void>;
    setCurrent(currentValue?: string): void;
    setBusy(busy: boolean): void;
    setWritable(writable: boolean): void;
    setError(error: string | null): void;
    setOpen(open: boolean): void;
    dispose(): void | Promise<void>;
}
export declare const AGENT_PRESET_ROW_DEFAULT_TITLE = "Agent preset";
export declare const AGENT_PRESET_ROW_DEFAULT_DESCRIPTION = "Applies to sessions you start from now on. Running sessions keep the preset they began with.";
export declare const AGENT_PRESET_ROW_LOADING_LABEL = "Loading presets\u2026";
export declare const AGENT_PRESET_ROW_USER_TRUST_LABEL = "Custom";
/**
 * Candidate replication of the Harness settings preference row: title over
 * description plus the shared PresetMenu pill (36px, align-end portal,
 * `· <userTrust>` suffix for locally authored presets). Caller-owned
 * snapshot projection; no durable business state.
 */
export declare function mountAgentPresetRow(host: HTMLElement, props: AgentPresetRowProps, scope: UiScope): AgentPresetRowController;
