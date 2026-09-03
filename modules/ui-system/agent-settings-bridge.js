// agent-settings-bridge — the Agent/Group sidebar settings domain.  The
// sidebar forms keep their original business DOM, form ids, defaults and IPC;
// this module only layers the VCPUI presentation (typed Input/Range/Choice/
// ColorPair/Button mounts, the production model picker and the section
// disclosure fallback) on top of the canonical sidebar shell.
import { ensurePresentationScope, enhance, mountUiuxSwitches, selectProjection } from './settings/bridge-shared.js';
import { mountAgentSectionDisclosures } from './settings/agent-disclosures.js';
import { createAgentModelPickerDirectory } from './settings/agent-model-picker-directory.js';

const agentSectionDisclosureStates = new Set();
const agentModelPickerReleases = new Map();

function enhanceForm(form) {
    mountTypedAgentIdentityInput(form);
    mountTypedAgentModelInput(form);
    mountTypedAgentTemperatureInput(form);
    mountTypedAgentNumericInputs(form);
    mountTypedAgentRegexInputs(form);
    mountTypedAgentStreamChoice(form);
    mountTypedAgentTtsSpeedRange(form);
    mountTypedAgentColorPairs(form);
    mountTypedAgentButtons(form);
    mountTypedAgentModelPicker(form);
    mountTypedAgentPromptModeButtons(form);
    const typedAgentSectionOwners = mountAgentSectionDisclosures(form, window.VCPUIUX, ensurePresentationScope(), window.settingsManager, agentSectionDisclosureStates);
    selectProjection.mount(form);
    // A successfully adopted Agent section is directly owned by the generated
    // DisclosureRow controller.  If the generated artifact did not load (or
    // an individual canonical section is incomplete), retain the established
    // SettingsSection controller for that *one* section.  This is a deliberate
    // per-section fallback, never two presentation owners on one header.
    form.querySelectorAll('.agent-settings-section').forEach(section => {
        if (!typedAgentSectionOwners.has(section)) enhance('SettingsSection', section);
    });
    // Group sections are not part of this migration slice.
    form.querySelectorAll('.group-settings-section').forEach(section => {
        enhance('SettingsSection', section);
    });
    form.querySelectorAll('input:is(:not([type]), [type="text"], [type="url"], [type="password"], [type="number"], [type="email"], [type="search"], [type="tel"])').forEach(input => {
        if (['agentNameInput', 'agentModel', 'agentTemperature', 'agentContextTokenLimit', 'agentMaxOutputTokens', 'agentTopP', 'agentTopK', 'agentTtsRegexPrimary', 'agentTtsRegexSecondary'].includes(input.id)) return;
        enhance('Input', input);
    });
    form.querySelectorAll('textarea').forEach(textarea => enhance('Textarea', textarea));
    form.querySelectorAll('select').forEach(select => {
        if (!select.closest('.vcp-uiux-select')) enhance('Select', select, { kernel: 'native' });
    });
    form.querySelectorAll('input[type="range"]').forEach(range => {
        if (!range.closest('.vcp-uiux-range')) enhance('Range', range);
    });
    mountUiuxSwitches(form);
    form.querySelectorAll('.agent-style-collapsible-container').forEach(disclosure => {
        disclosure.dataset.settingPrimitive = 'disclosure';
        disclosure.querySelector('.style-collapse-header')?.classList.add('vcp-uiux-disclosure-row');
    });
    form.querySelectorAll('.agent-name-wrapper, .group-name-wrapper, .group-settings-field-shell, .style-control-item, .params-content > div:not(.form-group-inline)').forEach(field => {
        if (field.querySelector('input:not([type="hidden"]), select, textarea')) enhance('Field', field);
    });
    form.querySelectorAll(':scope > .form-actions').forEach(actionBar => {
        enhance('SettingsActionBar', actionBar, { form });
    });
}

// The Agent form is canonical business DOM: section content can contain a
// live PromptManager, dynamically recreated regex rows and native form
// controls.  Mount the generated DisclosureRow at its header only, while the
// manager remains the sole owner of uiCollapseStates, summaries and config
// persistence.  This is deliberately a real Surface adapter, not a second
// collapse-state projection or a hidden-DOM click proxy.

// The Agent inputs differ in business semantics (identity, free-form model,
// numeric limits and TTS regexes), but their presentation lifecycle is the
// same: a generated Input owns the Light-DOM wrap while the native input
// stays canonical.  Keep that small contract in one private helper instead
// of growing nine independent marker/restore paths.
function mountTypedAgentInput(form, { id, marker, ownerKey, placeholder = false, restoreClass = false }) {
    const input = form?.querySelector?.(`#${id}`);
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    if (!input || !api?.mountInput || !scope || input.dataset[marker] === 'true') return;

    const originalClass = restoreClass ? input.className : null;
    const props = placeholder ? { placeholder: input.getAttribute('placeholder') || undefined } : {};
    try {
        api.mountInput(input, props, scope);
        input.dataset[marker] = 'true';
        scope.own(() => {
            delete input.dataset[marker];
            if (restoreClass && input.isConnected && input.className !== originalClass) input.className = originalClass;
        }, ownerKey, 'ui-presentation');
    } catch (error) {
        console.warn(`[VCPUI SettingsBridge] Could not mount typed ${id} Input:`, error);
    }
}

function mountTypedAgentRegexInputs(form) {
    ['agentTtsRegexPrimary', 'agentTtsRegexSecondary'].forEach(id => {
        mountTypedAgentInput(form, {
            id,
            marker: 'vcpTypedPrimitiveMounted',
            ownerKey: `typed-${id}-marker`,
        });
    });
}

// The model picker owns the model trigger's presentation and lifecycle. Keep
// that trigger out of the generic Button batch below so one node never has
// two presentation owners.
function mountTypedAgentButtons(form) {
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    if (!api?.mountButton || !scope) return;
    const buttons = [
        ['#refreshTtsModelsBtn', 'outline', 'agent-tts-refresh'],
        ['#resetAvatarColorsBtn', 'outline', 'agent-reset-colors'],
        // The save/delete actions deliberately stay native.  Upstream renders
        // them through the unlayered settings-agent-form.css contract (37px
        // geometry, theme-token colors, no accent fill); mounting a typed
        // Button would replace that look with the primary-pill variant.
    ];
    buttons.forEach(([selector, variant, key]) => {
        const button = form?.querySelector?.(selector);
        const marker = `vcpTyped${key.replace(/(^|-)(\w)/g, (_, __, value) => value.toUpperCase())}`;
        // Submit/delete remain canonical compatibility commands, but their
        // controls are intentionally hidden while Agent autosave is active.
        // Do not mount a generated Button on a hidden node: the primitive's
        // geometry contract would correctly restore display and make the
        // obsolete action visible again.
        if (!button || button.hidden || button.dataset[marker] === 'true') return;
        try {
            const size = key.includes('refresh') ? 'sm' : 'md';
            api.mountButton(button, { variant, size }, scope);
            // Legacy action-bar rules still carry a 37px min-height. Once the
            // typed Button owns this node, that minimum becomes a geometry
            // override (md contract is 36px). Keep the correction owner-bound
            // and restore the exact declaration during teardown.
            const minHeight = key.includes('refresh') ? '32px' : (size === 'sm' ? '28px' : '36px');
            const originalMinHeight = [button.style.getPropertyValue('min-height'), button.style.getPropertyPriority('min-height')];
            button.style.setProperty('min-height', minHeight, 'important');
            if (key.includes('refresh')) {
                button.style.setProperty('height', '32px', 'important');
                button.style.setProperty('border-radius', '8px', 'important');
            }
            scope.own(() => {
                if (originalMinHeight[0]) button.style.setProperty('min-height', originalMinHeight[0], originalMinHeight[1]);
                else button.style.removeProperty('min-height');
                if (key.includes('refresh')) {
                    button.style.removeProperty('height');
                    button.style.removeProperty('border-radius');
                }
                delete button.dataset[marker];
            }, `${key}-button-marker`, 'ui-presentation');
            button.dataset[marker] = 'true';
            // mountButton already binds its disposer to this scope. Registering
            // its returned release again would retain a duplicate lifecycle
            // resource and run teardown twice.
        } catch (error) {
            console.warn(`[VCPUI SettingsBridge] Could not mount typed Agent ${key} Button:`, error);
        }
    });
}

// The Agent model picker is the first production consumer of the Uiux
// model-selection candidate.  The native #agentModel input remains the sole
// business/persistence node; this bridge only supplies model discovery and
// writes the same input/change events that the retired modal callback used.
// The Agent consumer now projects hot/favorite sections and injected directory
// actions. The legacy modal remains for topicSummaryModel and until the
// production parity evidence in the audit closes its separate retirement path.
function mountTypedModelPicker(form, {
    inputId = 'agentModel',
    triggerId = 'openModelSelectBtn',
    marker = 'vcpTypedAgentModelPicker',
    scopeLabel = 'agent-model-picker-production',
    eventKind = 'agent',
} = {}) {
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    const input = form?.querySelector?.(`#${inputId}`);
    const trigger = form?.querySelector?.(`#${triggerId}`);
    const host = trigger?.closest?.('.model-input-container') || input?.closest?.('.model-input-container');
    const electronAPI = window.chatAPI;
    if (!api?.mountAgentModelPicker || !scope || !host || !input || !trigger
        || trigger.dataset[marker] === 'true') return;

    // Agent Settings can retain the previous section bank in the connected
    // DOM while replacing the active form. Treat the picker as a single
    // surface owner so a connected-but-hidden trigger cannot retain a child
    // scope across form generations.
    for (const [previousTrigger, release] of agentModelPickerReleases) {
        if (previousTrigger === trigger) continue;
        void release().catch(error => {
            console.error('[VCPUI SettingsBridge] Failed to release replaced Agent model picker:', error);
        });
    }

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
            label: inputId === 'agentModel' ? '选择模型' : '选择话题总结模型',
            selectedId: input.value || undefined,
            options: modelDirectory.options,
            directory: modelDirectory,
            grouped: true,
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
            // `pickerScope` owns the primitive's child scope. Disposing the
            // controller first and then its parent created two synonymous
            // cleanup requests on every Settings surface swap; one parent
            // scope disposal reaches quiescence and preserves exact restore.
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

function mountTypedAgentModelPicker(form) {
    mountTypedModelPicker(form);
}

function mountTypedTopicSummaryModelPicker(form) {
    mountTypedModelPicker(form, {
        inputId: 'topicSummaryModel',
        triggerId: 'openTopicSummaryModelSelectBtn',
        marker: 'vcpTypedTopicSummaryModelPicker',
        scopeLabel: 'topic-summary-model-picker-production',
        eventKind: 'topic-summary',
    });
}

function mountTypedAgentPromptModeButtons(form) {
    const api = window.VCPUIUX;
    if (!api?.mountButton) return;
    const scope = ensurePresentationScope();
    if (!scope) return;
    form?.querySelectorAll?.('.prompt-mode-button').forEach((button, index) => {
        if (!(button instanceof HTMLButtonElement) || button.dataset.vcpTypedPrimitiveMounted === 'true') return;
        api.mountButton(button, { variant: 'ghost', size: 'sm' }, scope);
        button.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete button.dataset.vcpTypedPrimitiveMounted; }, `typed-agent-prompt-mode-${index}-marker`, 'ui-primitive');
    });
}

// The agent editor keeps the native input as its canonical form/business node;
// only the visual wrapper is owned by the typed Uiux candidate. This is a
// narrow migration slice and deliberately excludes chat-side assistant
// switching and the remaining agent fields.
function mountTypedAgentIdentityInput(form) {
    mountTypedAgentInput(form, {
        id: 'agentNameInput',
        marker: 'vcpTypedAgentIdentity',
        ownerKey: 'agent-name-input-marker',
        placeholder: true,
        restoreClass: true,
    });
}

// Agent model remains a free-form native value with a separate legacy model
// picker button/modal. Upgrade only the input presentation; the picker and
// persistence semantics stay owned by the existing Agent settings flow.
function mountTypedAgentModelInput(form) {
    mountTypedAgentInput(form, {
        id: 'agentModel',
        marker: 'vcpTypedAgentModel',
        ownerKey: 'agent-model-input-marker',
        placeholder: true,
    });
}

// Temperature remains a native number input because min/max/step and the
// settings manager's numeric parsing are part of the canonical business
// contract. Only its presentation is upgraded to the typed Uiux Input.
function mountTypedAgentTemperatureInput(form) {
    mountTypedAgentInput(form, {
        id: 'agentTemperature',
        marker: 'vcpTypedAgentTemperature',
        ownerKey: 'agent-temperature-input-marker',
        restoreClass: true,
    });
}

// These fields are all canonical numeric settings. Keep their native number
// semantics and constraints while sharing the same typed Input presentation
// owner used by the identity/model/temperature slices.
function mountTypedAgentNumericInputs(form) {
    const fields = [
        ['agentContextTokenLimit', 'vcpTypedAgentContextLimit', 'agentContextTokenLimit-input-marker'],
        ['agentMaxOutputTokens', 'vcpTypedAgentMaxOutput', 'agentMaxOutputTokens-input-marker'],
        ['agentTopP', 'vcpTypedAgentTopP', 'agentTopP-input-marker'],
        ['agentTopK', 'vcpTypedAgentTopK', 'agentTopK-input-marker'],
    ];
    fields.forEach(([id, marker, ownerKey]) => {
        mountTypedAgentInput(form, { id, marker, ownerKey, restoreClass: true });
    });
}

// The stream output pair is a presentation-only Choice primitive over the
// existing native radio controls.  settingsManager remains the sole source
// of the persisted boolean and chatManager keeps its existing consumption.
function mountTypedAgentStreamChoice(form) {
    const group = form?.querySelector?.('#agentStreamOutputTrue')?.closest('.form-group-inline');
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    if (!group || !api?.mountChoice || !scope || group.dataset.vcpTypedAgentStreamChoice === 'true') return;
    try {
        api.mountChoice(group, scope);
        group.dataset.vcpTypedAgentStreamChoice = 'true';
        scope.own(() => { delete group.dataset.vcpTypedAgentStreamChoice; }, 'agent-stream-choice-marker', 'ui-presentation');
    } catch (error) {
        console.warn('[VCPUI SettingsBridge] Could not mount typed Agent stream Choice:', error);
    }
}

// TTS speed is a stable native range with an existing output node.  The typed
// Range owns only the visual wrapper and output synchronization; settings
// manager remains responsible for reading/writing the persisted numeric value.
function mountTypedAgentTtsSpeedRange(form) {
    const input = form?.querySelector?.('#agentTtsSpeed');
    const output = form?.querySelector?.('#ttsSpeedValue');
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    if (!input || !output || !api?.mountRange || !scope || input.dataset.vcpTypedAgentTtsSpeed === 'true') return;
    try {
        // Keep the existing persisted-number display contract ("1.0") while
        // making the generated Range the sole owner of user-driven output
        // synchronization.  The native input remains the canonical save node.
        api.mountRange(input, { output, format: value => Number.parseFloat(value).toFixed(1) }, scope);
        input.dataset.vcpTypedAgentTtsSpeed = 'true';
        scope.own(() => { delete input.dataset.vcpTypedAgentTtsSpeed; }, 'agent-tts-speed-range-marker', 'ui-presentation');
    } catch (error) {
        console.warn('[VCPUI SettingsBridge] Could not mount typed Agent TTS speed Range:', error);
    }
}

function mountTypedAgentColorPairs(form) {
    const api = window.VCPUIUX;
    if (!api?.mountColorPair) return;
    const scope = ensurePresentationScope();
    if (!scope) return;
    [
        ['#agentAvatarBorderColor', '#agentAvatarBorderColorText', 'agent-avatar-border-color', true],
        ['#agentNameTextColor', '#agentNameTextColorText', 'agent-name-text-color', false],
    ].forEach(([colorSelector, textSelector, key, updatesAvatarPreview]) => {
        const color = form?.querySelector?.(colorSelector);
        const text = form?.querySelector?.(textSelector);
        if (!color || !text || color.dataset.vcpTypedPrimitiveMounted === 'true') return;
        api.mountColorPair(color, text, scope, {
            onValueChange: value => {
                if (!updatesAvatarPreview) return;
                const preview = form.querySelector('#agentAvatarPreview');
                if (preview) preview.style.borderColor = value;
            },
            onInvalid: () => window.uiHelperFunctions?.showToastNotification?.('颜色格式无效，请使用 #RRGGBB 格式', 'warning'),
        });
        color.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete color.dataset.vcpTypedPrimitiveMounted; }, `typed-${key}-marker`, 'ui-primitive');
    });
}

// A closed Agent panel can leave its picker trigger connected but detached
// from the live form; the entry refresh sweep asks this domain to release it.
function cleanupDisconnectedAgentModelPickers() {
    for (const [trigger, release] of agentModelPickerReleases) {
        if (trigger.isConnected) continue;
        void release().catch(error => {
            console.error('[VCPUI SettingsBridge] Failed to release disconnected Agent model picker:', error);
        });
    }
}

function releaseAllAgentModelPickers() {
    for (const release of agentModelPickerReleases.values()) void release();
    agentModelPickerReleases.clear();
}

export {
    enhanceForm,
    mountTypedTopicSummaryModelPicker,
    cleanupDisconnectedAgentModelPickers,
    releaseAllAgentModelPickers,
};
