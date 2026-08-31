import type { UiCommand, UiDisposer, UiReadable, UiServiceDefinition } from '../contracts.js';
export type SettingsState = Readonly<Record<string, unknown>>;
export type SettingsPatch = Readonly<Record<string, unknown>>;
export interface SettingsSaveResult {
    readonly success: boolean;
    readonly error?: string;
}
export interface SettingsUiService {
    readonly state: UiReadable<SettingsState>;
    readonly save: UiCommand<SettingsPatch, SettingsSaveResult>;
    /** Invalidate an in-flight command whose UI owner reached a terminal timeout. */
    readonly cancelPendingSaves?: () => void;
    readonly dispose?: UiDisposer;
}
export interface SettingsUiAdapterInput {
    readonly get: () => SettingsState;
    readonly save: (patch: SettingsPatch) => Promise<SettingsSaveResult> | SettingsSaveResult;
    readonly cancelPendingSaves?: () => void;
    readonly subscribe?: (listener: (state: SettingsState) => void) => UiDisposer;
}
export declare function createSettingsUiService(input: SettingsUiAdapterInput): SettingsUiService;
export declare const settingsUiDefinition: UiServiceDefinition<SettingsUiService>;
