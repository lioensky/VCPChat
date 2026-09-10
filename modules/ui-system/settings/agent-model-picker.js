// Agent ModelPicker presentation bridge.
//
// Mounts the modern floating AgentModelPicker primitive over the canonical
// input and trigger controls. The directory adapts electronAPI model caches
// into the short-lived options contract. The primitive intercepts the trigger
// click, stopping immediate propagation so the legacy modal dialog is never
// opened.

import { ensurePresentationScope } from './bridge-shared.js';
import { createAgentModelPickerDirectory } from './agent-model-picker-directory.js';

const agentModelPickerReleases = new Map();

export function mountTypedModelPicker(form, {
    inputId = 'agentModel',
    triggerId = 'openModelSelectBtn',
    marker = 'vcpTypedAgentModelPicker',
    scopeLabel = 'agent-model-picker-production',
    eventKind = 'agent',
    portalZIndex,
} = {}) {
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    const input = form?.querySelector?.(`#${inputId}`);
    const trigger = form?.querySelector?.(`#${triggerId}`);
    const host = trigger?.closest?.('.model-input-container') || input?.closest?.('.model-input-container');
    const electronAPI = window.chatAPI;
    if (!api?.mountAgentModelPicker || !scope || !host || !input || !trigger
        || trigger.dataset[marker] === 'true') return;

    // Agent and Group forms remain connected at the same time, although only
    // one is visible. Each canonical trigger therefore keeps its own picker
    // owner; disconnected generations are retracted by the bridge cleanup
    // sweep instead of incorrectly releasing the other form's live picker.

    // The directory is an injected, short-lived capability. The primitive
    // owns popup/focus lifecycle; this adapter owns only the chatAPI boundary.
    const modelDirectory = createAgentModelPickerDirectory({ electronAPI, input });

    const originalTriggerInline = {};
    ['position', 'right', 'top', 'transform', 'width', 'min-width', 'max-width', 'height', 'padding',
        'border-radius', 'border', 'background', 'background-color', 'display', 'justify-content'].forEach(property => {
        originalTriggerInline[property] = [trigger.style.getPropertyValue(property), trigger.style.getPropertyPriority(property)];
    });
    let picker = null;
    const pickerScope = scope.child(scopeLabel);
    try {
        picker = api.mountAgentModelPicker(host, {
            trigger,
            label: inputId === 'agentModel'
                ? '选择模型'
                : inputId === 'groupUnifiedModelInput'
                    ? '选择群组统一模型'
                    : '选择话题总结模型',
            selectedId: input.value || undefined,
            options: modelDirectory.options,
            directory: modelDirectory,
            grouped: true,
            portalZIndex,
            onSelect: option => {
                if (input.disabled) return;
                input.value = option.id;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            },
        }, pickerScope);

        // The model-input container is positioned; keep the popup and trigger
        // inside the anchored input box on the right.
        picker.root.style.setProperty('position', 'absolute', 'important');
        picker.root.style.setProperty('right', '4px', 'important');
        picker.root.style.setProperty('top', '50%', 'important');
        picker.root.style.setProperty('transform', 'translateY(-50%)', 'important');
        picker.root.style.setProperty('z-index', '2', 'important');
        trigger.style.setProperty('position', 'absolute', 'important');
        trigger.style.setProperty('right', '4px', 'important');
        trigger.style.setProperty('top', '50%', 'important');
        trigger.style.setProperty('transform', 'translateY(-50%)', 'important');
        trigger.style.setProperty('width', '24px', 'important');
        trigger.style.setProperty('min-width', '24px', 'important');
        trigger.style.setProperty('max-width', '24px', 'important');
        trigger.style.setProperty('height', '24px', 'important');
        trigger.style.setProperty('min-height', '24px', 'important');
        trigger.style.setProperty('max-height', '24px', 'important');
        trigger.style.setProperty('padding', '0', 'important');
        trigger.style.setProperty('border-radius', '4px', 'important');
        trigger.style.setProperty('border', '0', 'important');
        trigger.style.setProperty('background', 'transparent', 'important');
        trigger.style.setProperty('display', 'inline-flex', 'important');
        trigger.style.setProperty('align-items', 'center', 'important');
        trigger.style.setProperty('justify-content', 'center', 'important');
        trigger.style.setProperty('z-index', '2', 'important');
        const triggerLabel = trigger.querySelector('.vcp-uiux-agent-model-picker-trigger-label');
        if (triggerLabel) triggerLabel.style.setProperty('display', 'none', 'important');
        const triggerIcon = trigger.querySelector('.vcp-uiux-agent-model-picker-trigger-icon');
        if (triggerIcon) {
            triggerIcon.style.setProperty('display', 'inline-flex', 'important');
            triggerIcon.style.setProperty('align-items', 'center', 'important');
            triggerIcon.style.setProperty('justify-content', 'center', 'important');
            triggerIcon.style.setProperty('height', '100%', 'important');
            triggerIcon.style.setProperty('width', '100%', 'important');
            triggerIcon.style.setProperty('line-height', '1', 'important');
        }
        const triggerSlot = trigger.querySelector('.vcp-uiux-icon-slot');
        if (triggerSlot) {
            triggerSlot.style.setProperty('display', 'inline-flex', 'important');
            triggerSlot.style.setProperty('align-items', 'center', 'important');
            triggerSlot.style.setProperty('justify-content', 'center', 'important');
            triggerSlot.style.setProperty('height', '14px', 'important');
            triggerSlot.style.setProperty('width', '14px', 'important');
        }
        trigger.dataset[marker] = 'true';
        input.style.setProperty('padding-right', '32px', 'important');

        pickerScope.listen(input, 'input', () => picker?.setSelected(input.value || undefined));
        pickerScope.listen(input, 'change', () => picker?.setSelected(input.value || undefined));
        pickerScope.listen(document, 'vcp-settings-surface-updated', event => {
            if (event.detail?.root === form || event.detail?.kind === eventKind) picker?.setSelected(input.value || undefined);
        });
        const release = scope.own(async () => {
            delete trigger.dataset[marker];
            for (const [property, [value, priority]] of Object.entries(originalTriggerInline)) {
                if (value) trigger.style.setProperty(property, value, priority);
                else trigger.style.removeProperty(property);
            }
            await pickerScope.dispose(`${scopeLabel}-released`);
            agentModelPickerReleases.delete(trigger);
        }, scopeLabel, 'ui-primitive');
        agentModelPickerReleases.set(trigger, release);
    } catch (error) {
        void picker?.dispose?.();
        void pickerScope.dispose(`${scopeLabel}-failed`);
        console.warn('[VCPUI SettingsBridge] Could not mount typed Agent model picker:', error);
    }
}

export function mountTypedAgentModelPicker(form) {
    mountTypedModelPicker(form);
}

export function mountTypedGroupModelPicker(form) {
    mountTypedModelPicker(form, {
        inputId: 'groupUnifiedModelInput',
        triggerId: 'openGroupModelSelectBtn',
        marker: 'vcpTypedGroupModelPicker',
        scopeLabel: 'group-model-picker-production',
        eventKind: 'group',
    });
}

export function mountTypedTopicSummaryModelPicker(form) {
    mountTypedModelPicker(form, {
        inputId: 'topicSummaryModel',
        triggerId: 'openTopicSummaryModelSelectBtn',
        marker: 'vcpTypedTopicSummaryModelPicker',
        scopeLabel: 'topic-summary-model-picker-production',
        eventKind: 'topic-summary',
        portalZIndex: 'calc(var(--vcp-ui-z-overlay, 1400) + 1)',
    });
}

export function cleanupDisconnectedAgentModelPickers() {
    for (const [trigger, release] of agentModelPickerReleases) {
        if (!trigger.isConnected) {
            void release();
        }
    }
}

export function releaseAllAgentModelPickers() {
    for (const release of agentModelPickerReleases.values()) {
        void release();
    }
    agentModelPickerReleases.clear();
}
