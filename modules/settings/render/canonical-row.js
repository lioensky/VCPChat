// render/canonical-row — canonical 行系统的共享机械层（M5-b）。
// 行语义类映射表（旧包裹类 → canonical 终态）：
//   .vcp-settings-row / .vcp-settings-control-row / .form-group /
//   .settings-form-group / .form-group-inline
//     → 移除，替换为 vcp-uiux-general-item vcp-uiux-general-row；
//   行上其余类（如 vcp-settings-row-stacked、settings-inline-number-row）
//     → 原样保留（preservedClasses）；
//   行属性（id、data-visible-when、data-vcp-style、hidden 等）→ 原样保留；
//   dataset 增补：settingPrimitive='general-item'（appearance 宿主内为
//     'appearance-row'）、settingsSectionKey、settingKey、canonicalRow='true'；
//   首个 title（label/span/strong/h4/h5）与 helper（small/p）收入
//     .vcp-uiux-row-copy 槽，控件排在槽后（composeCanonicalRowSlots）。
// 渲染器直出 canonical 行（分区声明 canonicalRows）与 canonical-rows
// 投影 pass 共用本模块，保证两条路径产出逐属性一致。
import { sectionKeyForRow } from '../../ui-system/settings/section-ownership.js';

// 与 canonical-rows 的候选选择器保持同一清单：只有旧包裹行才参与
// canonical 化，裸控件（radio label、独立按钮等）一律原样返回。
const CANONICAL_ROW_SELECTOR = '[data-vcp-settings-row], [data-vcp-settings-control-row], .vcp-settings-row, .vcp-settings-control-row, .settings-form-group, .form-group-inline, .form-group';
const DROPPED_ROW_CLASSES = [
    'settings-form-group', 'form-group-inline', 'vcp-settings-row', 'vcp-settings-control-row',
    'form-group',
];
const CONTROL_SELECTOR = 'input, select, textarea, button, [role="switch"]';
const APPEARANCE_ROW_ROOTS = '.appearance-settings-section, .appearance-sidebar-geometry-section, .appearance-home-tagline-setting, [data-settings-section-key="appearance-settings"]';

function composeCanonicalRowSlots(row) {
    if (!row || row.matches('label, fieldset') || row.querySelector(':scope > .vcp-uiux-row-copy')) return;
    const children = [...row.children];
    const controls = children.filter(node => node.matches('input, select, textarea, button, .switch, .model-input-container, .vcp-uiux-select, .vcp-uiux-input-wrap'));
    // A control that also matches the title selectors (label.switch) must not
    // be copied into the copy slot: append would move it, then the trailing
    // controls pass would move it back out, leaving an empty copy beside the
    // original title wrapper.
    const titles = children.filter(node => node.matches('label, span, strong, h4, h5') && !controls.includes(node));
    const helpers = children.filter(node => node.matches('small, p'));
    if (!controls.length || !titles.length) return;
    const copy = document.createElement('div');
    copy.className = 'vcp-uiux-row-copy';
    copy.dataset.settingPrimitive = 'row-copy';
    [...titles, ...helpers].forEach(node => copy.append(node));
    const remaining = children.filter(node => !copy.contains(node) && !controls.includes(node));
    row.replaceChildren(copy, ...remaining, ...controls);
}

// 单行 canonical 化：mountCanonicalSettingsRows 候选循环体与渲染器直出
// 共用的同一变换。sectionKey 由调用方显式提供（分区描述符的 key），
// 缺省时按 DOM 分区壳回查。
function canonicalizeRenderedRow(row, sectionKey = '') {
    if (!row || row.nodeType !== 1) return row;
    if (row.closest('.vcp-uiux-general-item')) return row;
    if (!row.matches(CANONICAL_ROW_SELECTOR)) return row;
    if (!row.querySelector(CONTROL_SELECTOR)) return row;
    const keyNode = row.querySelector('[name], [id]');
    const key = keyNode?.getAttribute('name') || keyNode?.id || '';
    const item = row.ownerDocument.createElement(row.tagName.toLowerCase());
    const preservedClasses = [...row.classList].filter(className => !DROPPED_ROW_CLASSES.includes(className));
    item.className = ['vcp-uiux-general-item', 'vcp-uiux-general-row', ...preservedClasses].join(' ');
    for (const attribute of row.attributes) {
        if (attribute.name === 'class' || attribute.name === 'style') continue;
        item.setAttribute(attribute.name, attribute.value);
    }
    item.dataset.settingPrimitive = 'general-item';
    const ownerKey = sectionKey || sectionKeyForRow(row);
    if (ownerKey) item.dataset.settingsSectionKey = ownerKey;
    // 阶段 3 扁平化后 appearance 分区整体是 feature-owned 行区；旧包裹类只
    // 兜底挂载时尚未盖 section key 的 DOM。M5-c pass6 起渲染器在行尚未挂载
    // 时就地 canonical 化（closest 查不到分区壳），appearance 归属由调用方
    // 显式传入的 sectionKey 直接判定。
    if (ownerKey === 'appearance-settings' || row.closest(APPEARANCE_ROW_ROOTS)) {
        item.dataset.settingPrimitive = 'appearance-row';
        item.classList.add('vcp-uiux-appearance-row');
    }
    if (key) item.dataset.settingKey = key;
    item.dataset.canonicalRow = 'true';
    row.replaceWith(item);
    item.append(...[...row.childNodes]);
    composeCanonicalRowSlots(item);
    return item;
}

export { composeCanonicalRowSlots, canonicalizeRenderedRow };
