// value-semantics — M5-a 值链路合一：按字段描述符的 save 声明推导保存/回填。
// 保存链 collectSettings：遍历 SCHEMA_SECTIONS，产出与旧 handleSaveGlobalSettings
// 手写收集器逐键同形的 settings.json 全量载荷（等价性金测
// tests/settings-value-golden.test.mjs 是本模块的门禁）；回填链 applySettings：
// 同一批描述符对称写回控件，实际变化时派发 vcp-uiux-sync（收敛 M0 记录的
// 胶囊滞留怪癖）。
//
// save 选项语义（求值顺序即下述顺序，逐条对应旧保存链的特例）：
//   valuePath        — settings.json 持久化键，默认等于 key（支持 'a.b' 嵌套）；
//   value            — 常量值（载荷里没有对应控件的键，如 userUseThemeColorsInChat）；
//   trim / upper     — 字符串管道：去首尾空白 / 转大写；
//   parse            — 'int'（parseInt(v,10)）| 'float'（Number(v)）；
//   roundTo          — 解析为有限值后按步长取整（Math.round(v/roundTo)*roundTo）；
//   nanFallback      — 解析非有限时的取值（可为 (scope)=>value，如宽屏窄窗口
//                      宽度取自现值钳位）；
//   min / max        — 有限值钳位（先于 fallback，等价旧 Math.max/min 包裹）；
//   falsy            — '||' 语义：值 falsy 时替换（先于 currentFallback）；
//   currentFallback  — 仍 falsy 时取 currentSettings[currentFallback]；
//   fallback         — 仍 falsy 时的兜底（数值链覆盖 0 与 NaN，即旧 `||` 语义）；
//   slice            — 字符串截断（旧 .slice(0,n)）；
//   allowed          — 白名单数组，不在名单内取 fallback；
//   checkedValue / elseValue — 开关/单选的取值映射
//                      （checked ? checkedValue : elseValue ?? false）；
//   present          — 旧 `?.checked !== false` 语义（控件缺失视为 true）；
//   transform        — (value, scope) => value 收尾变换（如 completeVcpUrl）；
//   collect: false   — 仅回填不收集（复合键由分区 collect 钩子统一收集，
//                      单选组的各成员 radio 即属此类）。
// 分区描述符可用 collect(scope) 钩子收集复合载荷（appearanceProfile、
// networkNotesPaths、chatPresentationMode 等）；custom 组件内部控件用
// saveMap 按 captureKeys 逐键声明。save:false 表示该控件走独立保存通道
// （划词/论坛/头像），不进全量载荷，也不参与回填（通道清单见
// SAVE_CHANNEL_MANIFEST）。

import { walkFields } from './schema/kernel.js';

// 保存链里不属于任何分区控件、直接从现值透传的键（旧链手写直通）。
export const SAVE_PASSTHROUGH_KEYS = Object.freeze([
    'sidebarWidth',
    'notificationsSidebarWidth',
]);

// 独立保存通道登记簿：这些控件不进 settings.json 全量载荷，各有自己的
// 命令边界与所有者（M5-a 切换保存链时仅清单化，不改通道）。
export const SAVE_CHANNEL_MANIFEST = Object.freeze({
    avatar: Object.freeze({
        fields: Object.freeze(['userAvatarInput']),
        owner: 'handleSaveGlobalSettings 头像通道（chatAPI.saveUserAvatar）',
    }),
    forum: Object.freeze({
        fields: Object.freeze(['adminUsername', 'adminPassword']),
        owner: 'typed 论坛字段所有者；未挂载时由 handleSaveGlobalSettings 兜底保存',
    }),
    rust: Object.freeze({
        fields: Object.freeze([
            'rustDebugMode', 'rustUseAssistant', 'rustEnableCustomThresholds',
            'rustMinEventIntervalMs', 'rustMinDistance', 'rustScreenshotSuspendMs',
            'rustClipboardConflictSuspendMs', 'rustClipboardCheckIntervalMs',
            'rustRuleMode', 'rustWhitelistKeywords', 'rustBlacklistKeywords', 'rustScreenshotApps',
        ]),
        owner: 'handleSaveGlobalSettings rustConfigPatch → 划词独立 store',
    }),
});

function isCheckable(control) {
    return control?.type === 'checkbox' || control?.type === 'radio';
}

function findControl(scope, id) {
    return scope.form
        ? scope.form.querySelector(`#${id}`)
        : scope.doc?.getElementById(id);
}

function readControl(scope, id) {
    const control = findControl(scope, id);
    if (!control) return undefined;
    return isCheckable(control) ? control.checked : control.value;
}

// 单键收集：按 save 选项把控件现值归一化为持久化值。分区 collect 钩子
// 也通过它复用同一套值语义（如用户名折叠区里的控件没有独立字段描述符）。
export function collectKey(scope, id, save = {}) {
    let value = save.value !== undefined ? save.value : readControl(scope, id);
    if (value === undefined) {
        if (save.present) return true;
        if (save.absentValue !== undefined) value = save.absentValue;
        else return undefined;
    }
    if (save.present) return value !== false;
    if (save.checkedValue !== undefined) {
        return value === true ? save.checkedValue : (save.elseValue ?? false);
    }
    if (typeof value === 'string' && save.trim) value = value.trim();
    if (save.parse) {
        value = save.parse === 'int' ? parseInt(value, 10) : Number(value);
        if (Number.isFinite(value)) {
            if (save.roundTo) value = Math.round(value / save.roundTo) * save.roundTo;
        } else if (save.nanFallback !== undefined) {
            value = typeof save.nanFallback === 'function' ? save.nanFallback(scope) : save.nanFallback;
        }
    }
    if ((save.min !== undefined || save.max !== undefined) && Number.isFinite(value)) {
        if (save.min !== undefined) value = Math.max(save.min, value);
        if (save.max !== undefined) value = Math.min(save.max, value);
    }
    if (save.falsy !== undefined && !value) value = save.falsy;
    if (save.currentFallback && !value) value = scope.currentSettings?.[save.currentFallback];
    if (save.fallback !== undefined && !value) value = save.fallback;
    if (save.allowed && !save.allowed.includes(value)) value = save.fallback;
    if (typeof value === 'string' && save.slice) value = value.slice(0, save.slice);
    if (save.upper) value = String(value).toUpperCase();
    if (save.transform) value = save.transform(value, scope);
    return value;
}

function assignPayload(payload, path, value) {
    if (value === undefined) return;
    const keys = String(path).split('.');
    let target = payload;
    for (let index = 0; index < keys.length - 1; index += 1) {
        const key = keys[index];
        if (typeof target[key] !== 'object' || target[key] === null || Array.isArray(target[key])) target[key] = {};
        target = target[key];
    }
    target[keys[keys.length - 1]] = value;
}

function collectField(field, scope, payload) {
    if (field.type === 'button') return;
    if (field.save === false) return;
    if (field.type === 'custom') {
        for (const id of field.captureKeys || []) {
            const save = field.saveMap?.[id];
            if (save && save.collect !== false) {
                assignPayload(payload, save.valuePath || id, collectKey(scope, id, save));
            }
        }
        return;
    }
    const save = field.save || {};
    if (save.collect === false) return;
    assignPayload(payload, save.valuePath || field.key, collectKey(scope, field.key, save));
}

// 保存链入口：遍历全部分区，产出与旧手写收集器逐键同形的载荷。
// scope 上下文：{ form?, doc?, currentSettings, settingsManager, getAppearance,
// normalizeChatPresentationMode }；未传 form 时按 document.getElementById 读取
// （与旧链一致）。
export function collectSettings(sections, scope = {}) {
    const ctx = { ...scope, form: scope.form || null, doc: scope.doc || (typeof document !== 'undefined' ? document : undefined) };
    const payload = {};
    for (const sectionDescriptor of sections) {
        walkFields(sectionDescriptor, field => collectField(field, ctx, payload));
        if (typeof sectionDescriptor.collect === 'function') {
            Object.assign(payload, sectionDescriptor.collect(ctx) || {});
        }
    }
    for (const key of SAVE_PASSTHROUGH_KEYS) {
        const value = ctx.currentSettings?.[key];
        if (value !== undefined) payload[key] = value;
    }
    return payload;
}

function resolvePath(settings, path) {
    return String(path).split('.').reduce((current, key) => current?.[key], settings);
}

function dispatchSync(control) {
    const EventCtor = control.ownerDocument?.defaultView?.CustomEvent ?? CustomEvent;
    control.dispatchEvent(new EventCtor('vcp-uiux-sync'));
}

// 回填链入口：与 collectSettings 对称，按同一批描述符把持久值写回控件。
// 写值只在实际变化时生效并派发 vcp-uiux-sync（挂载的原语据此同步呈现）；
// undefined/null 跳过（不覆盖控件默认值），与旧快照投影契约一致。
export function applySettings(sections, form, settings) {
    if (!form || !settings) return 0;
    let writes = 0;
    const write = (control, id, save) => {
        const value = resolvePath(settings, save?.valuePath || id);
        if (value === undefined || value === null) return;
        if (control.type === 'radio') {
            const expected = save?.checkedValue !== undefined ? save.checkedValue : control.value;
            const next = save?.checkedValue !== undefined ? value === save.checkedValue : String(value) === expected;
            if (control.checked !== next) {
                control.checked = next;
                dispatchSync(control);
                writes += 1;
            }
            return;
        }
        if (control.type === 'checkbox') {
            const next = Boolean(value);
            if (control.checked !== next) {
                control.checked = next;
                dispatchSync(control);
                writes += 1;
            }
            return;
        }
        const next = String(value);
        if (control.value !== next) {
            control.value = next;
            dispatchSync(control);
            writes += 1;
        }
    };
    for (const sectionDescriptor of sections) {
        walkFields(sectionDescriptor, field => {
            if (field.type === 'button' || field.save === false) return;
            if (field.type === 'custom') {
                for (const id of field.captureKeys || []) {
                    const save = field.saveMap?.[id];
                    if (!save) continue;
                    const control = form.querySelector(`#${id}`);
                    if (control) write(control, id, save);
                }
                return;
            }
            const control = form.querySelector(`#${field.key}`);
            if (control) write(control, field.key, field.save);
        });
    }
    return writes;
}

// 旧链 clampBubbleWidthPercent 的可复用形态（parseInt 非有限取兜底，
// 再钳位 50-98）；宽屏窄窗口宽度的 nanFallback 声明引用它钳现值。
export function clampBubbleWidthPercent(rawValue, fallback) {
    const parsed = parseInt(rawValue, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(98, Math.max(50, parsed));
}
