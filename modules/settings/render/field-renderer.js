// render/field-renderer — 把 schema 描述符编译为现行呈现标记。
// 迁移契约：编译产物与 main.html 静态标记的结构逐一同构（行类名、
// data-vcp-style、data-visible-when、控件业务锚点全部保留），因此
// canonical-rows 之后的投影管线按原样工作，像素与行为等价由"同一管线
// 处理同一结构"保证。schema → 呈现标记的映射收敛在这里，分区退役
// data-vcp-style 时只需要改这一层；描述符可用 rowStyle/hintStyle 等
// 覆盖个别历史样式，默认值即各类型的现行标记。
//
// M5-b canonical 直出：分区声明 canonicalRows 后，本渲染器对每行就地
// canonical 化（render/canonical-row.js 的 canonicalizeRenderedRow，与
// canonical-rows 投影 pass 共用同一机械层），产出 vcp-uiux-general-item/
// general-row + row-copy 槽 + data-setting-primitive 挂点，旧包裹类
// （vcp-settings-row/form-group 等）不再出现在编译产物中；行语义类
// 映射表见 canonical-row.js 头注。
import { walkFields } from '../schema/kernel.js';
import { el } from './shared.js';
import { canonicalizeRenderedRow } from './canonical-row.js';
import { fieldProjection, fieldDescriptor } from '../../ui-system/settings/field-registry.js';

function applyRowAnchors(row, field) {
    if (field.rowId) row.id = field.rowId;
    if (field.groupId) row.id = field.groupId;
    if (field.rowClass) row.classList.add(...String(field.rowClass).split(' '));
    if (field.rowHidden) row.hidden = true;
    if (Array.isArray(field.when) && field.when.length) {
        row.setAttribute('data-visible-when', field.when.join(' && '));
    }
}

function buildLabel(doc, field, styleValue) {
    const label = el(doc, 'label', '', styleValue);
    if (field.type !== 'radioGroup' && field.type !== 'numberCells') label.setAttribute('for', field.key);
    if (field.labelTitle) label.setAttribute('title', field.labelTitle);
    label.textContent = field.label;
    return label;
}

function buildHint(doc, field, styleValue, force = false) {
    if (!field.hint) return null;
    const hint = el(doc, 'small', '', force ? (styleValue ?? null) : styleValue);
    hint.textContent = field.hint;
    return hint;
}

function buildInputBase(doc, field, styleValue) {
    const input = doc.createElement('input');
    input.type = field.inputType;
    input.id = field.key;
    input.name = field.name || field.key;
    if (styleValue !== undefined && styleValue !== null) input.setAttribute('data-vcp-style', String(styleValue));
    if (field.placeholder !== undefined) input.placeholder = field.placeholder;
    if (field.required) input.required = true;
    if (field.value !== undefined) input.value = String(field.value);
    if (field.maxLength !== undefined) input.setAttribute('maxlength', String(field.maxLength));
    return input;
}

// M5-c pass3：输入原语包裹直出——单行文本/数字输入在编译期就地产出
// uiux Input 原语（window.VCPUIUX.mountInput）的终态产品：span 包裹 +
// input.input 类 + 内联守卫样式（转录自原语挂载，锁进 settings-schema-render
// 直出结构断言），管线 uiux-inputs pass 退役。Input 样式表仍由真实原语
// 挂载方（typed owners / 收编路径）在同一管线 tick 注入。raw 投影字段
// （凭据/寄语/颜色对）的 chrome 归 typed owner 运行时挂载，这里不包裹。
const INPUT_GUARD_STYLES = [
    ['box-sizing', 'border-box'],
    ['height', '22px'],
    ['min-height', '0'],
    ['max-height', 'none'],
    ['border', '0'],
    ['border-radius', '0'],
    ['padding', '0 10px'],
    ['line-height', '22px'],
];

function isRawProjectionField(field) {
    return field?.key ? fieldProjection(field.key) === 'raw' : false;
}

export function buildInputPrimitiveWrap(doc, input) {
    input.classList.add('input');
    for (const [name, value] of INPUT_GUARD_STYLES) {
        input.style.setProperty(name, value, 'important');
    }
    const wrap = doc.createElement('span');
    wrap.className = 'vcp-uiux-input-wrap wrap vcp-uiux-input-fill';
    wrap.append(input);
    return wrap;
}

// M5-c pass4：语言行直出——schema select 声明 languageRow 元数据后，编译期
// 就地产出 uiux LanguageRow 原语（window.VCPUIUX.mountLanguageRow）的终态
// 产品：行容器 + 标题/描述 + 胶囊触发按钮（首个子节点是标签文本节点，激活
// 期 sync 原位改写）+ 下拉箭头 svg，逐属性转录自 mountLanguageRow；行文案
// 以 schema 元数据为唯一来源（原 adapter 文案表退役）。管线 appearance-rows
// 步与 global-pill-steppers 的语言行部分退役，运行期只剩行为激活
// （global-language-rows.js → api.activateLanguageRow）。LanguageRow 样式表
// 仍由激活时的菜单挂载路径注入。
const LANGUAGE_ROW_CHEVRON_MARKUP =
    '<path d="M3 5L7 9L11 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';

export function buildLanguageRowStructure(doc, { title, description, options, activeId }) {
    const row = doc.createElement('div');
    row.className = 'vcp-uiux-language-row';
    const text = doc.createElement('div');
    text.className = 'vcp-uiux-language-row-text';
    const titleNode = doc.createElement('div');
    titleNode.className = 'vcp-uiux-language-row-title';
    titleNode.textContent = title ?? 'Language';
    text.append(titleNode);
    if (description) {
        const descriptionNode = doc.createElement('div');
        descriptionNode.className = 'vcp-uiux-language-row-description';
        descriptionNode.textContent = description;
        text.append(descriptionNode);
    }
    const trigger = doc.createElement('button');
    trigger.type = 'button';
    trigger.className = 'vcp-uiux-language-row-selector';
    const selected = (options || []).find(option => option.value === activeId);
    const label = doc.createTextNode(selected?.label || activeId || 'Select language');
    const chevron = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.classList.add('vcp-uiux-language-row-chevron');
    chevron.setAttribute('viewBox', '0 0 14 14');
    chevron.setAttribute('fill', 'none');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.setAttribute('focusable', 'false');
    chevron.innerHTML = LANGUAGE_ROW_CHEVRON_MARKUP;
    trigger.append(label, chevron);
    row.append(text, trigger);
    return row;
}

// M5-c pass4：字号行直出——appearanceFontScale 声明 fontSizeRow 后，编译期
// 就地产出 uiux FontSizeRow 原语（mountFontSizeRow）的终态产品：标题/描述 +
// 胶囊步进器（数值编辑器内联样式 + 上下箭头 svg + px 单位），业务 select 挂
// 进行内（与 mount 的 replaceChildren 终态一致）；行文案与量程转录自原语
// 挂载。运行期只剩行为激活（global-language-rows.js → api.activateFontSizeRow）。
const FONT_SIZE_ROW_ARROW_PATHS = Object.freeze({
    up: 'M2.15137 8.5L2.57617 8.07617L5.30273 5.34863C5.55843 5.09294 5.78438 4.86618 5.98828 4.70215C6.20088 4.53117 6.44405 4.38244 6.75 4.33398C6.91565 4.30778 7.08435 4.30778 7.25 4.33398C7.55595 4.38244 7.79912 4.53117 8.01172 4.70215C8.21561 4.86618 8.44157 5.09294 8.69727 5.34863L11.4238 8.07617L11.8486 8.5L11 9.34863L10.5762 8.92383L7.84863 6.19727C7.57405 5.92269 7.40124 5.75152 7.25977 5.6377C7.12709 5.53096 7.07728 5.52187 7.0625 5.51953C7.02105 5.51297 6.97895 5.51297 6.9375 5.51953C6.92272 5.52187 6.87291 5.53096 6.74023 5.6377C6.59876 5.75152 6.42595 5.92268 6.15137 6.19727L3.42383 8.92383L3 9.34863L2.15137 8.5Z',
    down: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
});

function buildFontSizeRowArrow(doc, path, ariaLabel) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '9');
    svg.setAttribute('height', '9');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const pathNode = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathNode.setAttribute('d', path);
    pathNode.setAttribute('fill', 'currentColor');
    svg.append(pathNode);
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'vcp-uiux-font-size-row-arrow';
    button.setAttribute('aria-label', ariaLabel);
    button.append(svg);
    return button;
}

export function buildFontSizeRowStructure(doc, field) {
    const row = doc.createElement('div');
    row.className = 'vcp-uiux-font-size-row';
    const text = doc.createElement('div');
    text.className = 'vcp-uiux-font-size-row-text';
    const title = doc.createElement('div');
    title.className = 'vcp-uiux-font-size-row-title';
    title.textContent = field.fontSizeRow?.title ?? '字号';
    const description = doc.createElement('div');
    description.className = 'vcp-uiux-font-size-row-description';
    description.textContent = field.fontSizeRow?.description ?? '调整界面文字大小';
    text.append(title, description);
    const control = doc.createElement('div');
    control.className = 'vcp-uiux-font-size-row-control';
    const stepper = doc.createElement('div');
    stepper.className = 'vcp-uiux-font-size-row-stepper';
    stepper.tabIndex = -1;
    const value = doc.createElement('input');
    value.type = 'number';
    value.className = 'vcp-uiux-font-size-row-value vcp-uiux-numeric-stepper-row-input';
    value.style.cssText = 'width:42px;min-width:42px;height:24px;padding:0;border:0;outline:0;background:transparent;color:inherit;text-align:center;font:inherit;appearance:textfield;-webkit-appearance:none;';
    value.min = '13';
    value.max = '16';
    value.step = '1';
    value.setAttribute('aria-label', '字号（13、14 或 16px）');
    value.dataset.vcpAppearanceDraftControl = 'true';
    const unit = doc.createElement('span');
    unit.className = 'vcp-uiux-font-size-row-unit';
    unit.textContent = 'px';
    const arrows = doc.createElement('span');
    arrows.className = 'vcp-uiux-font-size-row-arrows';
    const up = buildFontSizeRowArrow(doc, FONT_SIZE_ROW_ARROW_PATHS.up, '增大字号');
    const down = buildFontSizeRowArrow(doc, FONT_SIZE_ROW_ARROW_PATHS.down, '减小字号');
    arrows.append(up, down);
    stepper.append(value, arrows);
    control.append(stepper, unit);
    const select = buildSelect(doc, field);
    select.dataset.vcpAppearanceDraftControl = 'true';
    // Keep the native select connected as the sole business node (mount 的
    // replaceChildren 终态：select 移入行内，行是宿主的唯一子节点)。
    row.append(text, control, select);
    return row;
}

function buildTextarea(doc, field) {
    const node = doc.createElement('textarea');
    node.id = field.key;
    node.name = field.key;
    if (field.textareaStyle !== undefined && field.textareaStyle !== null) {
        node.setAttribute('data-vcp-style', String(field.textareaStyle));
    }
    if (field.placeholder !== undefined) node.placeholder = field.placeholder;
    if (field.rows !== undefined) node.setAttribute('rows', String(field.rows));
    if (field.spellcheck === false) node.setAttribute('spellcheck', 'false');
    node.textContent = field.defaultValue ?? '';
    return node;
}

function buildSwitchControl(doc, field) {
    const holder = doc.createElement('label');
    holder.className = 'switch';
    if (field.ariaLabel) holder.setAttribute('aria-label', field.ariaLabel);
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.id = field.key;
    input.name = field.key;
    if (field.checked) input.checked = true;
    const slider = doc.createElement('span');
    slider.className = 'slider round';
    // M5-c pass1：开关行直出 Toggle 原语 holder——mountToggle 的最终产物
    //（span.vcp-uiux-toggle 包裹 input + 内联隐藏旧 .slider）在编译期就地
    // 产出，管线 uiux-switches pass 退役（Toggle 样式表由真实原语挂载方
    // 首次挂载时注入，同一管线 tick 内完成）。typed toggle 收编字段（主页
    // 视觉双开关）仍由各自挂载方运行时收编，这里保持原语就绪裸结构。
    if (fieldProjection(field.key) !== 'toggle') {
        const wrap = doc.createElement('span');
        wrap.className = 'vcp-uiux-toggle';
        wrap.append(input);
        slider.style.display = 'none';
        holder.append(wrap, slider);
        return holder;
    }
    holder.append(input, slider);
    return holder;
}

function buildSelect(doc, field) {
    const node = doc.createElement('select');
    node.id = field.key;
    node.name = field.key;
    if (field.selectStyle !== undefined && field.selectStyle !== null) {
        node.setAttribute('data-vcp-style', String(field.selectStyle));
    }
    if (field.ariaLabel) node.setAttribute('aria-label', field.ariaLabel);
    if (field.hidden !== false) node.hidden = true;
    for (const option of field.options || []) {
        const optionNode = doc.createElement('option');
        optionNode.value = option.value;
        optionNode.textContent = option.label;
        node.append(optionNode);
    }
    return node;
}

// canonicalContext = { sectionKey }（分区声明 canonicalRows 时由
// renderSchemaSection 传入）；行节点构建后就地 canonical 化，保证与
// canonical-rows pass 的产出逐属性一致。
export function renderSchemaField(doc, field, canonicalContext = null) {
    const node = buildSchemaFieldNode(doc, field, canonicalContext);
    return canonicalContext ? canonicalizeRenderedRow(node, canonicalContext.sectionKey) : node;
}

function buildSchemaFieldNode(doc, field, canonicalContext = null) {
    switch (field.type) {
        case 'textarea': {
            if (field.groupId || field.grouped) {
                const row = el(doc, 'div', 'form-group', field.rowStyle ?? 16);
                applyRowAnchors(row, field);
                row.append(buildLabel(doc, field, field.labelStyle), buildTextarea(doc, field));
                const hint = buildHint(doc, field, field.hintStyle ?? 4);
                if (hint) row.append(hint);
                return row;
            }
            const row = el(doc, 'div', 'vcp-settings-row' + (field.stacked ? ' vcp-settings-row-stacked' : ''), field.rowStyle ?? 37);
            applyRowAnchors(row, field);
            row.append(buildLabel(doc, field, field.labelStyle), buildTextarea(doc, field));
            const hint = buildHint(doc, field, field.hintStyle ?? 4);
            if (hint) row.append(hint);
            return row;
        }
        case 'number': {
            if (field.groupId || field.grouped) {
                const row = el(doc, 'div', 'form-group', field.rowStyle ?? 41);
                applyRowAnchors(row, field);
                const groupedInput = buildNumberInput(doc, field, field.controlStyle ?? 27);
                if (isStepperField(field)) {
                    // M5-c pass2：分组步进器行同样直出终态结构（旧挂载的
                    // replaceChildren 连 hint 一并替换，故此处不输出 hint）。
                    row.append(buildStepperControl(doc, field, groupedInput));
                    return row;
                }
                row.append(buildLabel(doc, field, field.labelStyle), buildInputPrimitiveWrap(doc, groupedInput));
                const hint = buildHint(doc, field, field.hintStyle ?? 4);
                if (hint) row.append(hint);
                return row;
            }
            const row = el(doc, 'div', 'vcp-settings-row', field.rowStyle ?? 37);
            applyRowAnchors(row, field);
            const plainInput = buildNumberInput(doc, field, field.controlStyle ?? 19);
            if (isStepperField(field)) {
                // M5-c pass2：步进器投影直出原语终态结构，行文案由原语自带的
                // title/description 承担（旧 label 会被挂载替换，不再输出）。
                row.append(buildStepperControl(doc, field, plainInput));
            } else {
                row.append(buildLabel(doc, field, field.labelStyle), buildInputPrimitiveWrap(doc, plainInput));
            }
            const hint = buildHint(doc, field, field.hintStyle ?? 4);
            if (hint) row.append(hint);
            return row;
        }
        case 'text': {
            if (field.rowAsLabel) {
                // 历史标记：整行就是一个 label（寄语内容行）。
                const row = doc.createElement('label');
                row.className = 'vcp-settings-row';
                row.setAttribute('for', field.key);
                const span = doc.createElement('span');
                span.textContent = field.label;
                const rowLabelInput = buildInputBase(doc, field, field.controlStyle);
                row.append(span, isRawProjectionField(field) ? rowLabelInput : buildInputPrimitiveWrap(doc, rowLabelInput));
                return row;
            }
            const row = el(doc, 'div', 'vcp-settings-row' + (field.stacked ? ' vcp-settings-row-stacked' : ''), field.rowStyle);
            applyRowAnchors(row, field);
            const textInput = buildInputBase(doc, field, field.controlStyle);
            row.append(buildLabel(doc, field, field.labelStyle), isRawProjectionField(field) ? textInput : buildInputPrimitiveWrap(doc, textInput));
            const hint = buildHint(doc, field, field.hintStyle ?? 4);
            if (hint) row.append(hint);
            return row;
        }
        case 'switch': {
            if (field.variant === 'homeVisual') {
                // 历史标记：主页视觉开关行（copy 文案 + label.switch）。
                const row = el(doc, 'div', 'appearance-home-visual-setting');
                row.setAttribute('data-vcp-settings-row', '');
                applyRowAnchors(row, field);
                const copy = el(doc, 'span', 'appearance-home-visual-copy');
                const strong = doc.createElement('strong');
                strong.textContent = field.label;
                const small = doc.createElement('small');
                small.textContent = field.description;
                copy.append(strong, small);
                row.append(copy, buildSwitchControl(doc, field));
                return row;
            }
            const row = el(doc, 'div', 'vcp-settings-control-row', field.rowStyle ?? 15);
            applyRowAnchors(row, field);
            if (field.hintInsideWrapper) {
                // 历史标记：label 与提示同处一个包裹 div（compose 不拆分）。
                const wrapper = doc.createElement('div');
                wrapper.append(buildLabel(doc, field, field.labelStyle));
                const hint = buildHint(doc, field, field.hintStyle ?? 4);
                if (hint) wrapper.append(hint);
                row.append(wrapper, buildSwitchControl(doc, field));
                return row;
            }
            row.append(buildLabel(doc, field, field.labelStyle), buildSwitchControl(doc, field));
            if (field.extra) {
                for (const node of field.extra(doc)) row.append(node);
            }
            return row;
        }
        case 'select': {
            if (field.bareRow) {
                // 历史标记：裸 select 行——M5-c pass4 起语言行/字号行结构在此
                // 直出（声明 languageRow/fontSizeRow 元数据的字段），未声明的
                // 裸行仍只保留容器 + select。
                const row = el(doc, 'div', field.rowClass || '');
                applyRowAnchors(row, field);
                row.setAttribute('data-vcp-settings-row', '');
                if (field.fontSizeRow) {
                    row.append(buildFontSizeRowStructure(doc, field));
                } else {
                    const select = buildSelect(doc, field);
                    row.append(select);
                    if (field.languageRow) {
                        row.append(buildLanguageRowStructure(doc, {
                            title: field.languageRow.title,
                            description: field.languageRow.description,
                            options: field.options,
                            activeId: select.value,
                        }));
                    }
                }
                return row;
            }
            const row = el(doc, 'div', field.groupRowClass || 'form-group', field.rowStyle ?? (field.groupRowClass ? undefined : 34));
            applyRowAnchors(row, field);
            const select = buildSelect(doc, field);
            row.append(select);
            const hint = buildHint(doc, field, field.hintStyle ?? 40);
            if (hint) row.append(hint);
            if (field.languageRow) {
                row.append(buildLanguageRowStructure(doc, {
                    title: field.languageRow.title,
                    description: field.languageRow.description,
                    options: field.options,
                    activeId: select.value,
                }));
            }
            return row;
        }
        case 'radio': {
            const holder = el(doc, 'label', '', field.labelStyle ?? 14);
            holder.setAttribute('for', field.key);
            const input = doc.createElement('input');
            input.type = 'radio';
            input.id = field.key;
            input.name = field.name;
            input.value = field.value;
            if (field.checked) input.checked = true;
            const span = doc.createElement('span');
            span.textContent = field.label;
            holder.append(input, span);
            return holder;
        }
        case 'range': {
            if (field.geometry) {
                // 历史标记：外观几何滑杆（label 整行 + heading 内嵌 output）。
                const row = doc.createElement('label');
                row.className = 'vcp-settings-row appearance-geometry-control';
                row.setAttribute('for', field.key);
                const heading = doc.createElement('span');
                heading.className = 'appearance-range-heading';
                const title = doc.createElement('span');
                title.textContent = field.label;
                const output = doc.createElement('output');
                output.id = `${field.key}Value`;
                output.setAttribute('for', field.key);
                output.textContent = field.outputText ?? '';
                heading.append(title, output);
                row.append(heading, buildRangeInput(doc, field));
                if (field.helper) {
                    const small = doc.createElement('small');
                    small.className = 'appearance-geometry-helper';
                    small.textContent = field.helper;
                    row.append(small);
                }
                return row;
            }
            const row = el(doc, 'div', 'vcp-settings-row', field.rowStyle);
            applyRowAnchors(row, field);
            const container = doc.createElement('div');
            container.className = 'slider-container';
            const input = buildRangeInput(doc, field);
            if (isStepperField(field)) {
                // M5-c pass2：步进器投影直出后 output 由原语胶囊取代（与旧
                // 挂载的 replaceChildren 终态一致）。
                container.append(buildStepperControl(doc, field, input));
                row.append(container);
                return row;
            }
            container.append(input);
            const output = doc.createElement('output');
            output.id = field.outputId;
            if (field.outputFor) output.setAttribute('for', field.outputFor);
            output.textContent = field.outputText ?? '';
            container.append(output);
            row.append(container);
            return row;
        }
        case 'button': {
            const node = el(doc, 'button', field.className, field.rowStyle);
            node.type = 'button';
            node.id = field.key;
            node.textContent = field.label;
            return node;
        }
        case 'card': {
            const cardNode = el(doc, 'div', 'vcp-settings-card');
            cardNode.dataset.vcpSettingsCard = field.cardKey;
            const toggle = doc.createElement('button');
            toggle.type = 'button';
            toggle.className = 'vcp-settings-card-toggle';
            toggle.setAttribute('aria-expanded', 'true');
            const bodyId = `${field.key}CardBody`;
            toggle.setAttribute('aria-controls', bodyId);
            const heading = doc.createElement('span');
            heading.className = 'vcp-settings-card-heading';
            const title = doc.createElement('strong');
            title.className = 'vcp-settings-card-title';
            title.textContent = field.title;
            const description = doc.createElement('small');
            description.className = 'vcp-settings-card-description';
            description.textContent = field.description;
            heading.append(title, description);
            toggle.append(heading, buildCardChevron(doc));
            const body = doc.createElement('div');
            body.className = 'vcp-settings-card-body';
            body.id = bodyId;
            for (const child of field.fields) {
                body.append(child.kind === 'layout' ? renderSchemaLayout(doc, child, canonicalContext) : renderSchemaField(doc, child, canonicalContext));
            }
            cardNode.append(toggle, body);
            return cardNode;
        }
        case 'radioGroup': {
            const row = el(doc, 'div', 'form-group', field.rowStyle ?? 32);
            row.dataset.settingKey = field.key;
            applyRowAnchors(row, field);
            row.append(buildLabel(doc, { ...field, type: 'radioGroup' }, field.labelStyle ?? 11));
            const innerRow = el(doc, 'div', 'vcp-settings-control-row', field.innerRowStyle ?? 13);
            for (const radioField of field.fields) {
                innerRow.append(renderSchemaField(doc, radioField, canonicalContext));
            }
            // M5-c pass5：分段（Choice）直出——内层控制行与 radio 标签在编译期
            // 就地获得 mountChoice 的终态类，dataset.value 取编译期 checked 值；
            // 运行期只由 activateChoice 绑定 change/vcp-uiux-sync 重推导。
            innerRow.classList.add('vcp-uiux-choice');
            const checkedRadio = field.fields.find(radioField => radioField.checked);
            if (checkedRadio) innerRow.dataset.value = checkedRadio.value;
            innerRow.querySelectorAll('label').forEach(label => {
                if (label.querySelector('input[type="radio"]')) label.classList.add('vcp-uiux-choice-option');
            });
            row.append(innerRow);
            const hint = buildHint(doc, field, field.hintStyle ?? 4);
            if (hint) row.append(hint);
            return row;
        }
        case 'inlineNumbers': {
            const row = el(doc, 'div', 'form-group settings-inline-number-row', field.rowStyle);
            applyRowAnchors(row, field);
            for (const child of field.fields) {
                const cell = doc.createElement('div');
                const cellInput = buildNumberInput(doc, child, child.controlStyle ?? 19);
                if (isStepperField(child)) {
                    cell.append(buildStepperControl(doc, child, cellInput));
                } else {
                    cell.append(buildLabel(doc, child, child.labelStyle ?? 18), buildInputPrimitiveWrap(doc, cellInput));
                }
                row.append(cell);
            }
            return row;
        }
        case 'numberCells': {
            const row = el(doc, 'div', 'vcp-settings-control-row', field.rowStyle ?? 17);
            applyRowAnchors(row, field);
            row.append(buildLabel(doc, field, field.labelStyle ?? 11));
            for (const child of field.fields) {
                const cell = doc.createElement('div');
                const cellInput = buildNumberInput(doc, child, child.controlStyle ?? 19);
                cell.append(buildLabel(doc, child, child.labelStyle ?? 18), buildInputPrimitiveWrap(doc, cellInput));
                row.append(cell);
            }
            const hint = buildHint(doc, field, field.hintStyle ?? 4);
            if (hint) row.append(hint);
            return row;
        }
        case 'custom': {
            const node = field.build(doc);
            return node;
        }
        default:
            throw new Error(`field-renderer: 未支持的 schema 字段类型 "${field.type}"（key=${field.key}）`);
    }
}

function buildRangeInput(doc, field) {
    const input = doc.createElement('input');
    input.type = 'range';
    input.id = field.key;
    input.name = field.key;
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (field.step !== undefined) input.step = String(field.step);
    if (field.value !== undefined) input.value = String(field.value);
    return input;
}

// M5-c pass2：步进器投影字段（field-registry projection==='stepper'）直出
// NumericStepperRow 终态结构——与 uiux/generated/primitives/numeric-stepper-row.js
// 的 mount 产物逐属性一致（text/control 胶囊、编辑器内联守卫样式、箭头
// svg、单位），业务 input 保持原位作为步进行最后一个子节点；运行期只剩
// activateNumericStepperRow 绑行为。结构是 mount 产物的转录，两者以
// settings-schema-render 的直出结构断言锁定。
const STEPPER_EDITOR_GUARD_STYLES = [
    ['appearance', 'textfield'],
    ['-webkit-appearance', 'none'],
    ['background', 'transparent'],
    ['border', '0'],
    ['box-shadow', 'none'],
    ['outline', 'none'],
    ['width', '42px'],
    ['height', '24px'],
    ['padding', '0'],
    ['margin', '0'],
    ['text-align', 'center'],
];
const STEPPER_ARROW_PATHS = {
    up: 'M2.15137 8.5L2.57617 8.07617L5.30273 5.34863C5.55843 5.09294 5.78438 4.86618 5.98828 4.70215C6.20088 4.53117 6.44405 4.38244 6.75 4.33398C6.91565 4.30778 7.08435 4.30778 7.25 4.33398C7.55595 4.38244 7.79912 4.53117 8.01172 4.70215C8.21561 4.86618 8.44157 5.09294 8.69727 5.34863L11.4238 8.07617L11.8486 8.5L11 9.34863L10.5762 8.92383L7.84863 6.19727C7.57405 5.92269 7.40124 5.75152 7.25977 5.6377C7.12709 5.53096 7.07728 5.52187 7.0625 5.51953C7.02105 5.51297 6.97895 5.51297 6.9375 5.51953C6.92272 5.52187 6.87291 5.53096 6.74023 5.6377C6.59876 5.75152 6.42595 5.92268 6.15137 6.19727L3.42383 8.92383L3 9.34863L2.15137 8.5Z',
    down: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
};

function buildStepperArrow(doc, path, title) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'vcp-uiux-numeric-stepper-row-arrow';
    button.setAttribute('aria-label', title);
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '9');
    svg.setAttribute('height', '9');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('aria-hidden', 'true');
    const p = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    p.setAttribute('fill', 'currentColor');
    svg.append(p);
    button.append(svg);
    return button;
}

function buildStepperControl(doc, field, input) {
    const descriptor = fieldDescriptor(field.key) || {};
    const title = descriptor.title || field.label;
    const row = doc.createElement('div');
    row.className = 'vcp-uiux-numeric-stepper-row';
    const text = doc.createElement('div');
    text.className = 'vcp-uiux-numeric-stepper-row-text';
    const titleNode = doc.createElement('div');
    titleNode.className = 'vcp-uiux-numeric-stepper-row-title';
    titleNode.textContent = title;
    const desc = doc.createElement('div');
    desc.className = 'vcp-uiux-numeric-stepper-row-description';
    desc.textContent = descriptor.description ?? field.description ?? '';
    text.append(titleNode, desc);
    const control = doc.createElement('div');
    control.className = 'vcp-uiux-numeric-stepper-row-control';
    const stepper = doc.createElement('div');
    stepper.className = 'vcp-uiux-numeric-stepper-row-stepper';
    const editor = doc.createElement('input');
    editor.type = 'number';
    editor.className = 'vcp-uiux-numeric-stepper-row-input';
    // Inline guards keep the editable proxy neutral even when legacy settings
    // input rules load after the primitive stylesheet (transcribed from the
    // primitive mount so the rendered structure is its final product).
    for (const [name, value] of STEPPER_EDITOR_GUARD_STYLES) {
        editor.style.setProperty(name, value, 'important');
    }
    editor.setAttribute('aria-label', title);
    editor.min = input.min;
    editor.max = input.max;
    editor.step = input.step || '1';
    const arrows = doc.createElement('span');
    arrows.className = 'vcp-uiux-numeric-stepper-row-arrows';
    arrows.append(
        buildStepperArrow(doc, STEPPER_ARROW_PATHS.up, `增大${title}`),
        buildStepperArrow(doc, STEPPER_ARROW_PATHS.down, `减小${title}`),
    );
    stepper.append(editor, arrows);
    const unit = doc.createElement('span');
    unit.className = 'vcp-uiux-numeric-stepper-row-unit';
    unit.textContent = descriptor.unit ?? 'px';
    control.append(stepper, unit);
    row.append(text, control, input);
    return row;
}

function isStepperField(field) {
    return field?.key ? fieldProjection(field.key) === 'stepper' : false;
}

function buildNumberInput(doc, field, styleValue) {
    const input = doc.createElement('input');
    input.type = 'number';
    input.id = field.key;
    input.name = field.name || field.key;
    if (styleValue !== undefined && styleValue !== null) input.setAttribute('data-vcp-style', String(styleValue));
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (field.step !== undefined) input.step = String(field.step);
    if (field.defaultValue !== undefined) input.value = String(field.defaultValue);
    if (field.placeholder !== undefined) input.placeholder = field.placeholder;
    return input;
}

function buildCardChevron(doc) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'vcp-settings-card-chevron');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M3.5 6l4.5 4.5L12.5 6');
    svg.append(path);
    return svg;
}

function renderSchemaLayout(doc, descriptor, canonicalContext = null) {
    if (descriptor.type === 'card' || descriptor.type === 'radioGroup' || descriptor.type === 'inlineNumbers' || descriptor.type === 'numberCells') {
        return renderSchemaField(doc, descriptor, canonicalContext);
    }
    throw new Error(`field-renderer: 未支持的布局类型 "${descriptor.type}"`);
}

// 编译整个分区：标题 + 行序列。返回节点数组，由调用方决定挂载方式
// （M0 起原地替换既有分区容器的子节点，保持分区元素身份稳定）。
export function renderSchemaSection(sectionDescriptor, doc) {
    const nodes = [];
    const title = doc.createElement('h3');
    title.className = 'settings-section-title';
    title.textContent = sectionDescriptor.title;
    nodes.push(title);
    // M5-c pass6：全部分区直出 canonical 行（M5-b 试点通过后的全量铺开），
    // canonical-rows 投影 pass 随之空转退役。
    const canonicalContext = { sectionKey: sectionDescriptor.key };
    for (const field of sectionDescriptor.fields) {
        nodes.push(field.kind === 'layout' ? renderSchemaLayout(doc, field, canonicalContext) : renderSchemaField(doc, field, canonicalContext));
    }
    return nodes;
}

// 供 schema-surface 做现值快照/回填的字段遍历。
export function forEachSchemaField(sectionDescriptor, visit) {
    walkFields(sectionDescriptor, visit);
}
