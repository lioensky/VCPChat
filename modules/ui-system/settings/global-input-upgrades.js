// Global settings number/stepper + text Input upgrades.  The native inputs
// stay the sole business nodes; NumericStepperRow's structure is emitted
// statically by field-renderer (M5-c pass2 直出) and this binder only
// activates its behavior; mountInput wraps the shortcut field without moving
// save/dirty semantics (the typed field owner keeps listening on the same
// native control).
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
    // The generic Input pass runs first and has usually wrapped this input
    // already; nesting a second mountInput wrap inside it is what drew the
    // double frame. Converge on that wrap instead of stacking another one.
    const existingWrap = input.closest('.vcp-uiux-input-wrap');
    if (existingWrap) {
        existingWrap.classList.add('vcp-uiux-input-fill');
        return;
    }
    api.mountInput(input, {}, scope);
    input.dataset.vcpTypedPrimitiveMounted = 'true';
    scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; }, 'typed-voice-shortcut-input-marker', 'ui-primitive');
}
