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
                row.append(buildLabel(doc, field, field.labelStyle), buildNumberInput(doc, field, field.controlStyle ?? 27));
                const hint = buildHint(doc, field, field.hintStyle ?? 4);
                if (hint) row.append(hint);
                return row;
            }
            const row = el(doc, 'div', 'vcp-settings-row', field.rowStyle ?? 37);
            applyRowAnchors(row, field);
            row.append(buildLabel(doc, field, field.labelStyle), buildNumberInput(doc, field, field.controlStyle ?? 19));
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
                row.append(span, buildInputBase(doc, field, field.controlStyle));
                return row;
            }
            const row = el(doc, 'div', 'vcp-settings-row' + (field.stacked ? ' vcp-settings-row-stacked' : ''), field.rowStyle);
            applyRowAnchors(row, field);
            row.append(buildLabel(doc, field, field.labelStyle), buildInputBase(doc, field, field.controlStyle));
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
                // 历史标记：裸 select 行——原语言行/字体行 passes 以
                // `#<key>Row` 为宿主自行重建可见 UI，静态只保留容器 + select。
                const row = el(doc, 'div', field.rowClass || '');
                applyRowAnchors(row, field);
                row.setAttribute('data-vcp-settings-row', '');
                row.append(buildSelect(doc, field));
                return row;
            }
            const row = el(doc, 'div', field.groupRowClass || 'form-group', field.rowStyle ?? (field.groupRowClass ? undefined : 34));
            applyRowAnchors(row, field);
            row.append(buildSelect(doc, field));
            const hint = buildHint(doc, field, field.hintStyle ?? 40);
            if (hint) row.append(hint);
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
                cell.append(buildLabel(doc, child, child.labelStyle ?? 18), buildNumberInput(doc, child, child.controlStyle ?? 19));
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
                cell.append(buildLabel(doc, child, child.labelStyle ?? 18), buildNumberInput(doc, child, child.controlStyle ?? 19));
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
    // M5-b：声明 canonicalRows 的分区直出 canonical 行，其余分区维持
    // 旧包裹类、由 canonical-rows pass 投影。
    const canonicalContext = sectionDescriptor.canonicalRows ? { sectionKey: sectionDescriptor.key } : null;
    for (const field of sectionDescriptor.fields) {
        nodes.push(field.kind === 'layout' ? renderSchemaLayout(doc, field, canonicalContext) : renderSchemaField(doc, field, canonicalContext));
    }
    return nodes;
}

// 供 schema-surface 做现值快照/回填的字段遍历。
export function forEachSchemaField(sectionDescriptor, visit) {
    walkFields(sectionDescriptor, visit);
}
