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
    // canonical 行/分区身份（M5-c pass6 起由渲染器直出 + render/canonical-row.js
    // 机械层盖章；canonical-rows 投影 pass 已退役，vcpCanonicalRowsMounted
    // 随之注销）
    vcpSettingsRow: { owner: 'render/widgets.js + typed-field-owners.js', cleanup: 'persistent' },
    canonicalRow: { owner: 'render/canonical-row.js（渲染器直出共用机械层）', cleanup: 'persistent' },
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
    // Choice 原语的分段值镜像（checked radio 的 value）。M5-c pass5 起 schema
    // 面的初值由 field-renderer 的 radioGroup 直出、激活后由行为重推导，属于
    // 直出结构的一部分，有意跨 teardown 存续；agent 设置面的 mount 语义
    // （choice.js）在 dispose 时删除它。
    value: { owner: 'generated Choice primitive (choice.js) + field-renderer radioGroup 直出', cleanup: 'persistent' },
    // M5-c pass6 起 settingPrimitive 的写入方全部是直出/渲染层：canonical-row
    // 机械层（row-copy/general-item/appearance-row）、widgets.js 与 agent 面
    // （disclosure）、settings-bridge（section）；settings/canonical-rows.js 已删。
    settingPrimitive: { owner: 'render/canonical-row.js + render/widgets.js + settings-bridge.js + agent-settings-bridge.js', cleanup: 'manual-retract' },
    // M5-c pass5 retired the schema-surface select-projection step; the
    // module (and this marker) survives for the agent settings surface.
    vcpSelectRebuilding: { owner: 'settings/select-projection.js (agent surface)', cleanup: 'scope-owned' },
    vcpTypedPrimitiveMounted: { owner: 'all generated-primitive mount sites', cleanup: 'scope-owned' },
    vcpUiuxInputPrimitive: { owner: 'settings/global-input-upgrades.js compatibility text inputs', cleanup: 'scope-owned' },
    // M5-c pass6 retired the form-icons step: the three inline Lucide SVGs are
    // direct-rendered vcp-ui-icon nodes, so vcpSettingsIconsNormalized (and
    // its teardown restoration) is deregistered with the mechanism.
    // fail-closed 降级标记：投影失败后 classic 层接管，标记 sticky 到 teardown。
    vcpSurfaceProjectionFailed: { owner: 'settings-bridge.js fail-closed fallback', cleanup: 'manual-retract' },
    // Appearance stepper/font-size editors are draft surfaces: the marker on
    // the editor and its business control makes settings/autosave.js skip
    // them; the primitive's scope disposer deletes it from the business node.
    // M5-c pass4 起 font-size-row 的标记随直出结构由渲染器就地产出
    // （field-renderer buildFontSizeRowStructure），mount 路径保持原样。
    vcpAppearanceDraftControl: { owner: 'generated primitives (numeric-stepper-row/font-size-row) + field-renderer.js (static) + settings/autosave.js', cleanup: 'scope-owned' },
    // Icon name carried by injected icon hosts for the lucide adapter to
    // render; the host element's lifetime is the presentation scope's.
    // M5-c pass6 起 schema 面表单图标改由 buildFormIcon 直出 vcp-ui-icon 节点
    // （类名承载图标名，不走该标记）；vcpIcon 只剩 settings-bridge 的搜索/
    // 关闭图标宿主与 lucide-adapter 的转绘读取。
    vcpIcon: { owner: 'settings-bridge.js (search/close hosts) + lucide-adapter.js', cleanup: 'persistent' },

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
    vcpSettingsOperationId: { owner: 'settings/save-coordinator.js', cleanup: 'business-contract' },
    vcpSettingsSource: { owner: 'typed-field-owners.js', cleanup: 'business-contract' },
    vcpAutosaveState: { owner: 'settings/autosave.js + settingsManager', cleanup: 'business-contract' },
    // Set by the autosave submit so the save handler keeps the dialog open
    // after success; consumed (deleted) by global-settings-manager.js.
    vcpKeepOpenAfterSave: { owner: 'settings/autosave.js + global-settings-manager.js', cleanup: 'business-contract' },
    globalSettingsSaving: { owner: 'settings/autosave.js', cleanup: 'business-contract' },
    vcpAutosaveMounted: { owner: 'settings/autosave.js', cleanup: 'manual-retract' },
    vcpSettingsConflictActions: { owner: 'settings-bridge.js conflict action bar', cleanup: 'scope-owned' },
    vcpSettingsConflict: { owner: 'typed-field-owners.js external reconciliation', cleanup: 'business-contract' },

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
