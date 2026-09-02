// Central registry of every `dataset` marker the settings bridge domain uses
// for re-entrancy guards and lifecycle bookkeeping.  The audit test scans the
// domain sources and fails when a marker literal appears without a registry
// entry, so new markers must declare their owner and cleanup semantics here
// instead of accumulating as untracked string conventions.
//
// cleanup values:
// - 'scope-owned':      a presentation scope disposer deletes the marker
// - 'manual-retract':   the owner's teardown path deletes/restores it
// - 'persistent':       intentionally survives teardown (canonical DOM identity)
// - 'business-contract': persisted/save-contract state, not presentation bookkeeping

const MARKERS = Object.freeze({
    // canonical-rows.js — canonical row/section identity stamped onto the form
    vcpSettingsRow: { owner: 'settings/canonical-rows.js', cleanup: 'persistent' },
    canonicalRow: { owner: 'settings/canonical-rows.js', cleanup: 'persistent' },
    vcpCanonicalRowsMounted: { owner: 'settings/canonical-rows.js', cleanup: 'persistent' },
    vcpCanonicalNav: { owner: 'settings-bridge.js', cleanup: 'persistent' },
    settingsSections: { owner: 'settings-bridge.js', cleanup: 'persistent' },
    settingsSectionKey: { owner: 'settings/section-ownership.js + main.html', cleanup: 'persistent' },
    visibleWhen: { owner: 'settings/dependent-rows.js + main.html', cleanup: 'persistent' },
    // schema-surface.js — schema 渲染面的分区级幂等标记（exp/settings-schema）
    vcpSchemaRendered: { owner: 'settings/schema-surface.js', cleanup: 'persistent' },

    // uiux primitives — one re-entrancy marker per projection family
    // （vcpUiuxToggleMounted 自 M5-c pass1 起只剩 agent 设置面挂载方使用：
    // 全局设置 schema 面的开关行 holder 已由渲染器直出。vcpUiuxInputPrimitive
    // 随 M5-c pass3 uiux-inputs pass 退役一并注销：Input 包裹由渲染器直出，
    // 运行期不再有包裹标记。）
    vcpUiuxToggleMounted: { owner: 'agent-settings-bridge.js via settings/bridge-shared.js', cleanup: 'manual-retract' },
    vcpUiuxClose: { owner: 'settings-bridge.js', cleanup: 'manual-retract' },
    settingPrimitive: { owner: 'settings-bridge.js + agent-settings-bridge.js + settings/canonical-rows.js', cleanup: 'manual-retract' },
    vcpSelectRebuilding: { owner: 'settings/select-projection.js', cleanup: 'scope-owned' },
    vcpTypedPrimitiveMounted: { owner: 'all generated-primitive mount sites', cleanup: 'scope-owned' },
    vcpSettingsIconsNormalized: { owner: 'settings-bridge.js', cleanup: 'manual-retract' },
    // Appearance stepper/font-size editors are draft surfaces: the marker on
    // the editor and its business control makes settings/autosave.js skip
    // them; the primitive's scope disposer deletes it from the business node.
    vcpAppearanceDraftControl: { owner: 'generated primitives (numeric-stepper-row/font-size-row) + settings/autosave.js', cleanup: 'scope-owned' },
    // Icon name carried by injected icon hosts for the lucide adapter to
    // render; the host element's lifetime is the presentation scope's.
    vcpIcon: { owner: 'settings-bridge.js form icons + lucide-adapter.js', cleanup: 'persistent' },

    // settings-bridge.js — generated Buttons on the global surface
    vcpTypedGlobalSettingsEntry: { owner: 'settings-bridge.js', cleanup: 'scope-owned' },
    vcpTypedNetworkPathAction: { owner: 'settings-bridge.js', cleanup: 'scope-owned' },
    vcpSettingsFocusBound: { owner: 'settings-bridge.js', cleanup: 'scope-owned' },
    vcpIdentityNameBound: { owner: 'settings-bridge.js identity-name editor', cleanup: 'scope-owned' },
    vcpIdentityNameEditing: { owner: 'settings-bridge.js identity-name editor', cleanup: 'scope-owned' },
    vcpIdentityNameOriginal: { owner: 'settings-bridge.js identity-name editor', cleanup: 'scope-owned' },

    // typed-field-owners.js — typed settings seam
    vcpTypedFieldOwner: { owner: 'typed-field-owners.js + settings/autosave.js', cleanup: 'manual-retract' },
    vcpTypedFieldOwnerMounted: { owner: 'typed-field-owners.js', cleanup: 'manual-retract' },
    vcpTypedForumFieldOwner: { owner: 'typed-field-owners.js + settings/autosave.js', cleanup: 'manual-retract' },
    vcpTypedForumFieldOwnerMounted: { owner: 'typed-field-owners.js', cleanup: 'manual-retract' },
    vcpSettingsDirty: { owner: 'settings/autosave.js + settingsManager', cleanup: 'business-contract' },
    vcpSettingsRevision: { owner: 'typed-field-owners.js', cleanup: 'business-contract' },
    vcpSettingsSource: { owner: 'typed-field-owners.js', cleanup: 'business-contract' },
    vcpAutosaveState: { owner: 'settings/autosave.js + settingsManager', cleanup: 'business-contract' },
    // Set by the autosave submit so the save handler keeps the dialog open
    // after success; consumed (deleted) by global-settings-manager.js.
    vcpKeepOpenAfterSave: { owner: 'settings/autosave.js + global-settings-manager.js', cleanup: 'business-contract' },
    globalSettingsSaving: { owner: 'settings/autosave.js', cleanup: 'business-contract' },
    vcpAutosaveMounted: { owner: 'settings/autosave.js', cleanup: 'manual-retract' },

    // agent-settings-bridge.js — configured via the private Input owner's
    // `marker` option and deleted with the owning presentation scope
    vcpTypedAgentIdentity: { owner: 'agent-settings-bridge.js', cleanup: 'scope-owned' },
    vcpTypedAgentModel: { owner: 'agent-settings-bridge.js', cleanup: 'scope-owned' },
    vcpTypedAgentTemperature: { owner: 'agent-settings-bridge.js', cleanup: 'scope-owned' },
    vcpTypedAgentContextLimit: { owner: 'agent-settings-bridge.js', cleanup: 'scope-owned' },
    vcpTypedAgentMaxOutput: { owner: 'agent-settings-bridge.js', cleanup: 'scope-owned' },
    vcpTypedAgentTopP: { owner: 'agent-settings-bridge.js', cleanup: 'scope-owned' },
    vcpTypedAgentTopK: { owner: 'agent-settings-bridge.js', cleanup: 'scope-owned' },
    vcpTypedAgentStreamChoice: { owner: 'agent-settings-bridge.js', cleanup: 'scope-owned' },
    vcpTypedAgentTtsSpeed: { owner: 'agent-settings-bridge.js', cleanup: 'scope-owned' },
    vcpTypedAgentDisclosure: { owner: 'settings/agent-disclosures.js', cleanup: 'scope-owned' },
});

export const SETTINGS_MARKERS = MARKERS;

export function isRegisteredSettingsMarker(name) {
    return Object.prototype.hasOwnProperty.call(MARKERS, name);
}

export function settingsMarkerCleanup(name) {
    return MARKERS[name]?.cleanup || null;
}
