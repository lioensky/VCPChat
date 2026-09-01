// render/field-renderer — 把 schema 描述符编译为现行呈现标记。
// M0 迁移契约：编译产物与 main.html 静态标记的结构逐一同构（行类名、
// data-vcp-style、data-visible-when、控件业务锚点全部保留），因此
// canonical-rows 之后的投影管线按原样工作，像素与行为等价由"同一管线
// 处理同一结构"保证。schema → 呈现标记的映射收敛在这里，分区退役
// data-vcp-style 时只需要改这一层。
//
// 行形态映射（与静态标记一致）：
//   textarea(stacked) → .vcp-settings-row.vcp-settings-row-stacked [37]，
//                       textarea [38]，提示 [4]
//   number（无容器）  → .vcp-settings-row [37]，input [19]，提示 [4]
//   number（有容器）  → .form-group [41]，input [27]，提示 [4]
//   switch            → .vcp-settings-control-row [15]
//   select            → .form-group [34]，select（hidden），提示 [40]

function el(doc, tag, className, styleValue) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (styleValue !== undefined) node.setAttribute('data-vcp-style', String(styleValue));
    return node;
}

function applyVisibility(row, field) {
    if (Array.isArray(field.when) && field.when.length) {
        row.setAttribute('data-visible-when', field.when.join(' && '));
    }
}

function buildLabel(doc, field) {
    const label = doc.createElement('label');
    label.setAttribute('for', field.key);
    if (field.labelTitle) label.setAttribute('title', field.labelTitle);
    label.textContent = field.label;
    return label;
}

function buildHint(doc, field, styleValue) {
    if (!field.hint) return null;
    const hint = el(doc, 'small', '', styleValue);
    hint.textContent = field.hint;
    return hint;
}

function buildNumberInput(doc, field, styleValue) {
    const input = doc.createElement('input');
    input.type = 'number';
    input.id = field.key;
    input.name = field.key;
    input.setAttribute('data-vcp-style', String(styleValue));
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (field.step !== undefined) input.step = String(field.step);
    if (field.defaultValue !== undefined) input.value = String(field.defaultValue);
    return input;
}

function buildTextarea(doc, field) {
    const node = doc.createElement('textarea');
    node.id = field.key;
    node.name = field.key;
    node.setAttribute('data-vcp-style', '38');
    if (field.placeholder !== undefined) node.placeholder = field.placeholder;
    if (field.rows !== undefined) node.setAttribute('rows', String(field.rows));
    if (field.spellcheck === false) node.setAttribute('spellcheck', 'false');
    node.textContent = field.defaultValue ?? '';
    return node;
}

function buildSwitch(doc, field) {
    const holder = doc.createElement('label');
    holder.className = 'switch';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.id = field.key;
    input.name = field.key;
    const slider = doc.createElement('span');
    slider.className = 'slider round';
    holder.append(input, slider);
    return { holder, input };
}

function buildSelect(doc, field) {
    const node = doc.createElement('select');
    node.id = field.key;
    node.name = field.key;
    if (field.hidden) node.hidden = true;
    for (const option of field.options || []) {
        const optionNode = doc.createElement('option');
        optionNode.value = option.value;
        optionNode.textContent = option.label;
        node.append(optionNode);
    }
    return node;
}

export function renderSchemaField(doc, field) {
    if (field.type === 'textarea') {
        const row = el(doc, 'div', 'vcp-settings-row vcp-settings-row-stacked', 37);
        row.append(buildLabel(doc, field), buildTextarea(doc, field));
        const hint = buildHint(doc, field, 4);
        if (hint) row.append(hint);
        return row;
    }
    if (field.type === 'number') {
        if (field.groupId) {
            const row = el(doc, 'div', 'form-group', 41);
            row.id = field.groupId;
            applyVisibility(row, field);
            row.append(buildLabel(doc, field), buildNumberInput(doc, field, 27));
            const hint = buildHint(doc, field, 4);
            if (hint) row.append(hint);
            return row;
        }
        const row = el(doc, 'div', 'vcp-settings-row', 37);
        row.append(buildLabel(doc, field), buildNumberInput(doc, field, 19));
        const hint = buildHint(doc, field, 4);
        if (hint) row.append(hint);
        return row;
    }
    if (field.type === 'switch') {
        const row = el(doc, 'div', 'vcp-settings-control-row', 15);
        if (field.rowId) row.id = field.rowId;
        applyVisibility(row, field);
        row.append(buildLabel(doc, field));
        const { holder } = buildSwitch(doc, field);
        row.append(holder);
        return row;
    }
    if (field.type === 'select') {
        const row = el(doc, 'div', 'form-group', 34);
        if (field.groupId) row.id = field.groupId;
        applyVisibility(row, field);
        row.append(buildSelect(doc, field));
        const hint = buildHint(doc, field, 40);
        if (hint) row.append(hint);
        return row;
    }
    throw new Error(`field-renderer: 未支持的 schema 字段类型 "${field.type}"（key=${field.key}）`);
}

// 编译整个分区：标题 + 行序列。返回节点数组，由调用方决定挂载方式
// （M0 原地替换既有分区容器的子节点，保持分区元素身份稳定）。
export function renderSchemaSection(sectionDescriptor, doc) {
    const nodes = [];
    const title = doc.createElement('h3');
    title.className = 'settings-section-title';
    title.textContent = sectionDescriptor.title;
    nodes.push(title);
    for (const field of sectionDescriptor.fields) {
        nodes.push(renderSchemaField(doc, field));
    }
    return nodes;
}
