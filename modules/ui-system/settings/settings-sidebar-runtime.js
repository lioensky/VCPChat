// Runtime adapter for schema-rendered settings sidebars.
// Ordinary inputs, choices, ranges and buttons are native schema controls.
// Only the two shape-shifting business slots need a runtime owner here.
import { ensurePresentationScope } from './bridge-shared.js';
import { MimoDirectorSlot, SequentialSpeakerSlot } from './settings-sidebar-slots.js';

const mountedSlots = new WeakMap();

function mountSettingsSidebarForm(form) {
    if (!form || mountedSlots.has(form)) return mountedSlots.get(form);
    const scope = ensurePresentationScope();
    if (!scope) return null;

    const slots = [];
    if (form.id === 'agentSettingsForm') {
        const slot = new MimoDirectorSlot({ form, scope }).mount();
        if (slot) {
            slots.push(slot);
            const registry = globalThis.window?.VCPSettingsSlots || (globalThis.window ? (globalThis.window.VCPSettingsSlots = {}) : null);
            if (registry) {
                registry.mimoDirector = slot;
                scope.own(() => {
                    if (registry.mimoDirector === slot) delete registry.mimoDirector;
                }, 'mimo-director-registry', 'ui-slot');
            }
        }
    }
    if (form.id === 'groupSettingsForm') {
        const slot = new SequentialSpeakerSlot({ form, scope }).mount();
        if (slot) slots.push(slot);
    }
    const mounted = { slots };
    mountedSlots.set(form, mounted);
    scope.own(() => {
        if (mountedSlots.get(form) === mounted) {
            mountedSlots.delete(form);
        }
    }, `mounted-slots-cleanup-${form.id || 'form'}`, 'ui-slot');
    return mounted;
}

function unmountSettingsSidebarForm(form) {
    if (!form) return;
    try {
        globalThis.window?.settingsManager?.cancelAutosave?.();
    } catch (_) {}
    const mounted = mountedSlots.get(form);
    if (mounted?.slots) {
        mounted.slots.forEach(slot => {
            try {
                slot.dispose?.();
            } catch (e) {
                console.warn('[SettingsSidebarRuntime] Error disposing slot on unmount:', e);
            }
        });
    }
    mountedSlots.delete(form);
}

export { MimoDirectorSlot, SequentialSpeakerSlot, mountSettingsSidebarForm, unmountSettingsSidebarForm };

