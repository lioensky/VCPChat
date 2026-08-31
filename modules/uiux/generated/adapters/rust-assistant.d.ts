import type { UiCommand, UiDisposer, UiReadable, UiServiceDefinition } from '../contracts.js';
export type RustAssistantState = Readonly<Record<string, unknown>>;
export type RustAssistantPatch = Readonly<Record<string, unknown>>;
export interface RustAssistantResult {
    readonly success: boolean;
    readonly error?: string;
    readonly [key: string]: unknown;
}
export interface RustAssistantUiService {
    readonly state: UiReadable<RustAssistantState>;
    readonly refresh: UiCommand<void, RustAssistantResult>;
    readonly save: UiCommand<RustAssistantPatch, RustAssistantResult>;
    readonly dispose: UiDisposer;
}
export interface RustAssistantUiAdapterInput {
    readonly get: () => Promise<RustAssistantState> | RustAssistantState;
    readonly save: (patch: RustAssistantPatch) => Promise<RustAssistantResult> | RustAssistantResult;
}
export declare function createRustAssistantUiService(input: RustAssistantUiAdapterInput): RustAssistantUiService;
export declare const rustAssistantUiDefinition: UiServiceDefinition<RustAssistantUiService>;
