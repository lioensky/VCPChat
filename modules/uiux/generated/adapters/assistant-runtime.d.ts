import type { UiCommand, UiDisposer, UiReadable, UiServiceDefinition } from '../contracts.js';
export type AssistantRuntimeState = Readonly<Record<string, unknown>>;
export interface AssistantRuntimeUiService {
    readonly state: UiReadable<AssistantRuntimeState>;
    readonly refresh: UiCommand<void, {
        readonly success: boolean;
        readonly error?: string;
    }>;
    readonly dispose: UiDisposer;
}
export interface AssistantRuntimeUiAdapterInput {
    readonly get: () => Promise<AssistantRuntimeState> | AssistantRuntimeState;
}
export declare function createAssistantRuntimeUiService(input: AssistantRuntimeUiAdapterInput): AssistantRuntimeUiService;
export declare const assistantRuntimeUiDefinition: UiServiceDefinition<AssistantRuntimeUiService>;
