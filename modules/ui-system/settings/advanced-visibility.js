// Presentation-only visibility projection for the Advanced settings section.
// The form remains the canonical business DOM; the section is fully flattened
// (Phase 3), so its conditional rows declare data-visible-when in the
// canonical DOM and this projection just re-evaluates them against the
// native controls.
import { syncDependentRows } from './dependent-rows.js';

export function syncAdvancedSettingsVisibility(form) {
    if (!form) return;
    syncDependentRows(form);
}
