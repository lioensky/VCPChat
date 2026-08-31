import type { UiContext, UiScope, UiServiceDefinition } from '../contracts.js';
export interface UiServiceRegistry {
    /** Install a definition; provider is a surface-local factory injection, not a global provider/plugin hook. */
    install<TService>(definition: UiServiceDefinition<TService>, provider?: (context: UiContext) => TService): TService;
    get<TService>(id: string): TService | undefined;
    uninstall(id: string): Promise<void>;
    release(id: string): Promise<void>;
    dispose(reason?: string): Promise<void>;
}
/**
 * A deliberately local service assembly. The registry owns one child scope;
 * it is not a global plugin container and cannot outlive its surface owner.
 */
export declare function createUiServiceRegistry(parentScope: UiScope): UiServiceRegistry;
