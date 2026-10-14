// input-cadence — when a settings edit should be persisted.
// Shared by the legacy whole-form autosave and the typed field owner so both
// chains treat typing the same way:
//   discrete controls (checkbox/select/radio/range/...) -> 400ms debounce
//   text controls, `input` event                        -> 1500ms idle fallback
//   text controls, `change` event (blur / Enter)         -> commit immediately
//   IME composition in progress                         -> never schedule
// Close-time flush in both chains still commits whatever is pending.

export const DISCRETE_DELAY_MS = 400;
export const TEXT_IDLE_DELAY_MS = 1500;

const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'hidden', 'button', 'submit', 'reset', 'image']);
const composing = new WeakSet();
const scheduledValues = new WeakMap();

export function isTextControl(control) {
    const tag = control?.tagName?.toLowerCase?.();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    return !NON_TEXT_INPUT_TYPES.has(String(control.type || 'text').toLowerCase());
}

/** @returns {'skip'|'discrete'|'text-idle'|'text-commit'} */
export function classifyInput(event) {
    const control = event?.target;
    if (event?.isComposing || (control && composing.has(control))) return 'skip';
    if (!isTextControl(control)) return 'discrete';
    return event.type === 'change' ? 'text-commit' : 'text-idle';
}

export function delayFor(kind) {
    if (kind === 'text-commit') return 0;
    return kind === 'text-idle' ? TEXT_IDLE_DELAY_MS : DISCRETE_DELAY_MS;
}

// Remember the value a text control last scheduled, so the `change` that
// follows an idle save of the same value does not write a second time.
export function markScheduled(control) {
    if (control && isTextControl(control)) scheduledValues.set(control, control.value);
}

export function unchangedSinceScheduled(control) {
    return Boolean(control) && scheduledValues.has(control) && scheduledValues.get(control) === control.value;
}

/**
 * Track IME composition on `target` (events bubble, so a form works too).
 * compositionend re-enters `handler` as a plain input, because Chromium does
 * not fire a non-composing input after the final composed text lands.
 * @returns {Array<Function|undefined>} listener releases returned by `listen`.
 */
export function trackComposition(target, listen, handler) {
    return [
        listen(target, 'compositionstart', event => { if (event.target) composing.add(event.target); }),
        listen(target, 'compositionend', event => {
            if (!event.target) return;
            composing.delete(event.target);
            handler({ type: 'input', target: event.target, isComposing: false });
        }),
    ];
}