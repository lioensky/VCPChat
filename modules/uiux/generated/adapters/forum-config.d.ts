import type { UiCommand, UiDisposer, UiReadable, UiServiceDefinition } from '../contracts.js';
export type ForumConfigState = Readonly<Record<string, unknown>>;
export type ForumConfigPatch = Readonly<Record<string, unknown>>;
export interface ForumConfigResult {
    readonly success: boolean;
    readonly error?: string;
    readonly [key: string]: unknown;
}
export interface ForumConfigUiService {
    readonly state: UiReadable<ForumConfigState>;
    readonly refresh: UiCommand<void, ForumConfigResult>;
    readonly save: UiCommand<ForumConfigPatch, ForumConfigResult>;
    readonly dispose: UiDisposer;
}
export interface ForumConfigUiAdapterInput {
    readonly get: () => Promise<ForumConfigState> | ForumConfigState;
    readonly save: (patch: ForumConfigPatch) => Promise<ForumConfigResult> | ForumConfigResult;
    readonly timeoutMs?: number;
}
export declare function createForumConfigUiService(input: ForumConfigUiAdapterInput): ForumConfigUiService;
export declare const forumConfigUiDefinition: UiServiceDefinition<ForumConfigUiService>;
