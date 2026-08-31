// Presentation-only visibility projection for the Rust Assistant section.
// The section is fully flattened (Phase 3): its conditional rows (thresholds,
// rule panels, diagnostics) declare data-visible-when in the canonical DOM
// and this projection just re-evaluates them against the native controls.
import { syncDependentRows } from './dependent-rows.js';

export function syncRustAssistantVisibility(form) {
    if (!form) return;
    syncDependentRows(form);
}
