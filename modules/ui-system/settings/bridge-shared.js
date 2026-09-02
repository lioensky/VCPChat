// bridge-shared — state and helpers shared by the settings bridge domains
// (entry orchestration, Agent sidebar, typed field owners).  One presentation
// scope, one controller registry and one Select projection serve every domain;
// the entry stays the only writer of the public bridge global.
import { createSelectProjection } from './select-projection.js';
import { fieldProjection } from './field-registry.js';

// globalThis.window?. keeps this module import-safe in bare node (tests);
// in the renderer window is always defined and this resolves identically.
const LifecycleScope = globalThis.window?.VCPLifecycle?.LifecycleScope;
const bridgeScope = LifecycleScope ? new LifecycleScope('settings-bridge-controller') : null;
let presentationScope = null;
let destroyed = false;
const controllers = new Set();
const controllerReleases = new Map();
let settingsKeySeed = 0;

function uniqueSettingsKey() {
    settingsKeySeed += 1;
    return `anon-${settingsKeySeed}`;
}

function ensurePresentationScope() {
    if (destroyed) return null;
    if (!presentationScope) {
        presentationScope = bridgeScope?.child('settings-presentation') || null;
    }
    return presentationScope;
}

// The single Select projection over the generated primitive; the bridge
// injects the presentation scope so the module never reaches back up here.
const selectProjection = createSelectProjection({ ensurePresentationScope });

function isPresentationDestroyed() {
    return destroyed;
}

// Teardown handoff: return the current presentation scope and clear the slot
// so a later refresh mounts a fresh one.
function takePresentationScope() {
    const scope = presentationScope;
    presentationScope = null;
    return scope;
}

function markPresentationDestroyed() {
    destroyed = true;
}

function enhance(name, element, options = {}) {
    if (!element || window.VCPUI.getController(element)) return;
    try {
        const controller = window.VCPUI.enhance(name, element, options);
        controllers.add(controller);
        const scope = ensurePresentationScope();
        if (scope) {
            controllerReleases.set(controller, scope.own(() => controller.destroy(), `settings:${name}`, 'ui-registration'));
        }
    } catch (error) {
        console.warn(`[VCPUI SettingsBridge] Could not enhance ${name}:`, error);
    }
}

// Switch labels adopt the real library Toggle primitive per checkbox: the
// native input stays the authoritative node while the primitive wrap draws
// the track/knob and hides the retired local `.slider` span.  The typed home
// visual toggles keep their own mounts, and the legacy VCPUI native-kernel
// switch stays as the degraded presentation when the primitive runtime or
// the presentation scope is unavailable.
// M5-c pass1 起，全局设置 schema 面的开关行 holder 由 field-renderer 直出，
// 本挂载方只剩 agent 设置面（agent-settings-bridge）一个消费方。
function mountUiuxSwitches(form) {
    if (!form) return;
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    form.querySelectorAll('label.switch').forEach(control => {
        // Toggle-projected fields (typed home-visual toggles) keep their own
        // mounts; the registry, not a hardcoded id list, decides the skip.
        if ([...control.querySelectorAll('[id]')].some(node => fieldProjection(node.id) === 'toggle')) return;
        const input = control.querySelector('input[type="checkbox"]');
        if (!input || input.dataset.vcpUiuxToggleMounted === 'true') return;
        if (!api?.mountToggle || !scope) {
            enhance('Switch', control);
            return;
        }
        try {
            const release = api.mountToggle(input, scope);
            if (!release) return;
            input.dataset.vcpUiuxToggleMounted = 'true';
            scope.own(() => { delete input.dataset.vcpUiuxToggleMounted; }, `uiux-toggle-${input.id || control.querySelector('input[name]')?.name || uniqueSettingsKey()}`, 'ui-presentation');
        } catch (error) {
            console.warn('[VCPUI SettingsBridge] Could not mount Uiux Toggle primitive:', error);
        }
    });
}

// Retract enhanced controllers whose element left the DOM; the caller
// composes this with the Agent-domain picker sweep.
function releaseDisconnectedControllers() {
    [...controllers].forEach(controller => {
        if (controller.element.isConnected) return;
        const release = controllerReleases.get(controller);
        if (release) void release();
        else controller.destroy();
        controllerReleases.delete(controller);
        controllers.delete(controller);
    });
}

function enhancedControllerCount() {
    return controllers.size;
}

function releaseAllControllers() {
    [...controllers].reverse().forEach(controller => {
        const release = controllerReleases.get(controller);
        if (release) {
            void release().catch(error => {
                console.error('[VCPUI SettingsBridge] Failed to release controller:', error);
            });
        } else controller.destroy();
    });
    controllers.clear();
    controllerReleases.clear();
}

export {
    bridgeScope,
    enhancedControllerCount,
    ensurePresentationScope,
    takePresentationScope,
    isPresentationDestroyed,
    markPresentationDestroyed,
    enhance,
    uniqueSettingsKey,
    selectProjection,
    mountUiuxSwitches,
    releaseDisconnectedControllers,
    releaseAllControllers,
};
