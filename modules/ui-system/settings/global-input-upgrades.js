// Global settings number/stepper + text Input upgrades.  The native inputs
// stay the sole business nodes; NumericStepperRow's structure is emitted
// statically by field-renderer (M5-c pass2 直出) and this binder only
// activates its behavior; the shortcut field's Input wrap is likewise
// renderer-emitted (M5-c pass3 直出) and this mount only converges on it
// (mountInput stays as the degraded fallback when the wrap is absent),
// without moving save/dirty semantics (the typed field owner keeps listening
// on the same native control).
// The stepper descriptors and every projection rule live in field-registry.js.
import { STEPPER_FIELDS } from './field-registry.js';

export function mountGlobalSteppers(form, api, scope) {
    if (!form || !scope || !api?.activateNumericStepperRow) return;
    STEPPER_FIELDS.forEach(({ id }) => {
        const input = form.querySelector(`#${id}`);
        const row = input?.closest('.vcp-uiux-numeric-stepper-row');
        if (!input || !row || input.dataset.vcpTypedPrimitiveMounted === 'true') return;
        input.dataset.vcpTypedPrimitiveMounted = 'true';
        api.activateNumericStepperRow(row, input, scope);
        scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-stepper-marker`, 'ui-primitive');
    });
}

export function mountVoiceShortcutInput(form, api, scope) {
    if (!form || !scope || !api?.mountInput) return;
    const input = form.querySelector('#voiceInputShortcut');
    if (!input || input.dataset.vcpTypedPrimitiveMounted === 'true') return;
    // The renderer emits this field's Input wrap statically (M5-c pass3
    // 直出); converge on it instead of stacking a second wrap — nesting a
    // second mountInput wrap inside it is what drew the double frame.
    const existingWrap = input.closest('.vcp-uiux-input-wrap');
    if (existingWrap) {
        existingWrap.classList.add('vcp-uiux-input-fill');
        return;
    }
    api.mountInput(input, {}, scope);
    input.dataset.vcpTypedPrimitiveMounted = 'true';
    scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; }, 'typed-voice-shortcut-input-marker', 'ui-primitive');
}

// Keep dynamically supplied/legacy text fields on the same primitive contract
// as schema fields.  This is deliberately scoped to the settings form and
// skips controls that already own a generated wrap or a typed special path.
export function mountGlobalTextInputs(form, api, scope) {
    if (!form || !scope || !api?.mountInput) return;
    form.querySelectorAll('input[type="text"], input:not([type])').forEach(input => {
        if (input.dataset.vcpTypedPrimitiveMounted === 'true' || input.closest('.vcp-uiux-input-wrap')) return;
        if (input.type === 'file' || input.dataset.vcpTypedFieldOwner === 'true') return;
        try {
            api.mountInput(input, {}, scope);
            input.dataset.vcpTypedPrimitiveMounted = 'true';
            input.dataset.vcpUiuxInputPrimitive = 'true';
            scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; delete input.dataset.vcpUiuxInputPrimitive; }, `typed-${input.id || 'text'}-input-marker`, 'ui-primitive');
        } catch (error) {
            console.warn('[VCPUI SettingsBridge] Could not mount global text Input primitive:', error);
        }
    });
}

// M5-c pass5：分段（Choice）行为激活。行类/标签类/dataset.value 初值已由
// field-renderer 的 radioGroup 直出，这里按结构通用扫描（不再维护 id 表），
// 只绑定 change/vcp-uiux-sync 的 dataset.value 重推导并注入分段样式表。
export function mountGlobalChoices(form, api, scope) {
    if (!form || !scope || !api?.activateChoice) return;
    form.querySelectorAll('.vcp-uiux-choice').forEach(row => {
        if (row.dataset.vcpTypedPrimitiveMounted === 'true') return;
        api.activateChoice(row, scope);
        row.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete row.dataset.vcpTypedPrimitiveMounted; }, `typed-${row.dataset.settingKey || 'choice'}-choice-marker`, 'ui-primitive');
    });
}
