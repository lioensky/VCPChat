import type { UiScope } from '../contracts.js';
import { type MenuController } from './menu.js';
export declare const AGENT_PRESET_SEAT_DEFAULT_HINT = "Agent preset for the session you are about to start";
export declare const AGENT_PRESET_SEAT_NO_DESCRIPTION = "No description";
/** One selectable preset, exactly the roster projection the seat consumes. */
export interface AgentPresetSeatOption {
    readonly id: string;
    readonly name?: string;
    readonly description?: string;
}
export interface AgentPresetSeatProps {
    readonly options: readonly AgentPresetSeatOption[];
    readonly selectedId?: string;
    readonly busy?: boolean;
    readonly error?: string | null;
    readonly hint?: string;
    readonly noDescriptionLabel?: string;
    readonly onSelect: (id: string) => void;
    readonly onClose?: () => void;
}
export interface AgentPresetSeatController {
    readonly root: HTMLSpanElement;
    readonly button: HTMLButtonElement;
    readonly menu: MenuController | null;
    readonly open: boolean;
    /** Display name of the staged preset, or '' when none is staged. */
    selectedLabel(): string;
    setOptions(options: readonly AgentPresetSeatOption[]): Promise<void>;
    setSelected(selectedId?: string): void;
    setBusy(busy: boolean): void;
    setError(error: string | null): void;
    setOpen(open: boolean): void;
    dispose(): void | Promise<void>;
}
/**
 * Candidate replication of the Harness hero chip: a seat button carrying the
 * staged preset over a body-portal Menu. Caller-owned open/busy/error state,
 * no durable business state.
 */
export declare function mountAgentPresetSeat(anchor: HTMLButtonElement, props: AgentPresetSeatProps, scope: UiScope): AgentPresetSeatController;
