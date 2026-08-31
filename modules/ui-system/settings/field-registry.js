// field-registry — the single descriptor table for settings fields that
// adapters special-case by id.  Before this registry the same knowledge lived as
// string comparisons scattered across the bridge and the settings modules
// (an exclusion list in mountUiuxInputs, STEPPER_FIELDS here, skip ids in
// mountUiuxSwitches).  Adapters consult the table instead of hardcoding
// ids; ownership of each field stays with its dedicated mount function.
//
// 阶段 4 裁剪版 schema（对齐 uiux §2.3；不引入 schemastery/cordis）：
//   domain      — 归属分区 key（阶段 1 的 section-key 解耦）；
//   type        — 业务类型：number | text | secret | toggle | shortcut；
//   projection  — 呈现 chrome 归属，见下方 projection 注释块；
//   restore     — 快照 → 控件值的恢复钩子 (settings => value)；typed field
//                 owner 的投影对已注册字段走这里，未注册 restore 的字段仍由
//                 各自的投影函数本地回退；
//   validation  — 可选 { min, max, integer, clampTo, message }；越界收敛
//                 pass 按描述符收敛，不再散落硬编码；
//   redaction   — 'omit-log' 预留给 API key / 凭据类字段的日志脱敏；本阶段
//                 只登记描述符，消费方随 redaction 专项接入；
//   revision    — 并发写接口预留：需要 compare-and-set 语义的字段将来在此
//                 声明，本阶段不占用任何键。
//
// projection names who owns a field's presentation chrome:
//   'stepper' — NumericStepperRow adopts the host wholesale (host.replaceChildren)
//               and exposes the value through the stepper capsule; an Input wrap
//               around the native input would become the stepper's mount host
//               and collapse the row layout.
//   'raw'     — the typed field owner keeps the bare native control it listens
//               on; a generic Input wrap would draw a second frame around it.
//   'toggle'  — a typed toggle adapter owns the switch; the generic switch pass
//               must leave it alone.
//   'input'   — the generic Uiux Input primitive may wrap it (default for
//               fields absent from the table).
const DEFAULT_HOME_TAGLINE = '语义级打穿 AI、UI/UX、APP 与人类想象力的边界';

const FIELDS = Object.freeze({
    minChunkBufferSize: { domain: 'render-settings', type: 'number', projection: 'stepper', validation: { min: 1, integer: true }, title: '最小渲染 Chunk 字数', description: '达到该字数才触发一次渲染（≥1）', unit: '字' },
    smoothStreamIntervalMs: { domain: 'render-settings', type: 'number', projection: 'stepper', validation: { min: 1, integer: true }, title: '最小刷新间隔', description: '两次流式渲染之间的最小间隔（≥1）', unit: 'ms' },
    streamAnimationDurationMs: { domain: 'render-settings', type: 'number', projection: 'stepper', validation: { min: 1, integer: true }, title: '动画时长', description: '流式内容进场动画时长', unit: 'ms' },
    middleClickAdvancedDelay: { domain: 'advanced-features', type: 'number', projection: 'stepper', validation: { min: 1000, clampTo: 1000, message: '快捷环出现延迟不能小于1000ms，已自动调整' }, title: '快捷环出现延迟', description: '按住中键后延迟出现快捷环（1000-5000ms）', unit: 'ms' },
    homeVisualTagline: { domain: 'appearance-settings', type: 'text', projection: 'raw', restore: settings => settings?.homeVisualTagline || DEFAULT_HOME_TAGLINE },
    userAvatarBorderColorText: { domain: 'user-identity', type: 'text', projection: 'raw', restore: settings => settings?.userAvatarBorderColor || '#3d5a80' },
    userNameTextColorText: { domain: 'user-identity', type: 'text', projection: 'raw', restore: settings => settings?.userNameTextColor || '#ffffff' },
    adminUsername: { domain: 'server-connection', type: 'text', projection: 'raw' },
    adminPassword: { domain: 'server-connection', type: 'secret', projection: 'raw', redaction: 'omit-log' },
    showHomeVisualBrand: { domain: 'appearance-settings', type: 'toggle', projection: 'toggle' },
    showHomeVisualTagline: { domain: 'appearance-settings', type: 'toggle', projection: 'toggle' },
    voiceInputShortcut: { domain: 'voice-settings', type: 'shortcut', projection: 'input', restore: settings => settings?.voiceInputShortcut || 'F7' },
});

function fieldProjection(id) {
    return FIELDS[id]?.projection || '';
}

function fieldDescriptor(id) {
    return FIELDS[id] || null;
}

// Snapshot → control value for descriptors that register a restore hook;
// undefined means the caller keeps its local projection.
function fieldRestore(id, settings) {
    const restore = FIELDS[id]?.restore;
    return restore ? restore(settings) : undefined;
}

// Stepper descriptors in registry order; mountGlobalSteppers consumes the
// title/description/unit fields verbatim.
const STEPPER_FIELDS = Object.freeze(
    Object.entries(FIELDS)
        .filter(([, field]) => field.projection === 'stepper')
        .map(([id, field]) => Object.freeze({ id, title: field.title, description: field.description, unit: field.unit })),
);

export { FIELDS, STEPPER_FIELDS, fieldProjection, fieldDescriptor, fieldRestore };
