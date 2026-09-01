// schema/kernel — 设置项 schema 的描述原语（实验分支 exp/settings-schema）。
// 目标架构：schema（key/类型/文案/依赖）→ 渲染 → uiux 原语 → dsw 单层级联。
// 这里只声明"业务语义"：控件的 key、类型、文案、约束与依赖；呈现标记
// （行类名、data-vcp-style、data-visible-when 拼接）由渲染器按类型的
// 默认样式编译，个别历史样式差异用显式覆盖（rowStyle/hintStyle 等）表达，
// 迁移完成后这些覆盖随 dsw 单层级联一并退役。
//
// 描述符分类：
//   kind 'section' — 分区（key/title/fields）；
//   kind 'layout'  — 纯布局容器（card/radioGroup/inlineNumbers），自身无值，
//                    children 递归参与取值/回填；
//   kind 'field'   — 可取值控件（key 即控件 id/name）；
//   type 'custom'  — 特例挂载点：build(doc) 直接构建专属组件标记（头像卡、
//                    折叠样式块、动画预览等），待后续阶段组件化后收编。
//
// 字段通用属性：
//   key          — 业务锚点，编译后同时是控件 id 与 name；
//   label/hint   — 文案（含既有冒号等排版字符，保持像素一致）；
//   when         — 依赖子句数组（'其他控件 id' 或 'id=值'），以 && 组合；
//   rowId/groupId— 行/容器业务 id（typed-field-owners 等按 id 直写的锚点）；
//   rowStyle/rowClass/rowHidden/controlStyle/hintStyle/labelStyle/
//   textareaStyle/selectStyle — 现行标记的显式样式覆盖；
//   capture:false — 该控件不参与现值快照（file 输入、动态容器等）。

export function section(key, title, fields, options = {}) {
    return Object.freeze({
        kind: 'section', key, title,
        fields: Object.freeze(fields),
        // 渲染替换时需要整体保留节点身份（而非仅迁移现值）的控件 id：
        // 动态选项的 select、动态追加子行的容器等。
        adoptNodeIds: Object.freeze(options.adoptNodeIds || []),
    });
}

export function textarea(key, options) {
    return Object.freeze({ kind: 'field', key, type: 'textarea', ...options });
}

export function number(key, options) {
    return Object.freeze({ kind: 'field', key, type: 'number', ...options });
}

export function text(key, options) {
    return Object.freeze({ kind: 'field', key, type: 'text', inputType: 'text', ...options });
}

export function switchField(key, options) {
    return Object.freeze({ kind: 'field', key, type: 'switch', ...options });
}

export function select(key, options) {
    return Object.freeze({ kind: 'field', key, type: 'select', ...options });
}

export function radio(key, options) {
    return Object.freeze({ kind: 'field', key, type: 'radio', ...options });
}

export function range(key, options) {
    return Object.freeze({ kind: 'field', key, type: 'range', ...options });
}

export function button(key, options) {
    return Object.freeze({ kind: 'field', key, type: 'button', ...options });
}

export function custom(key, build, captureKeys = []) {
    return Object.freeze({ kind: 'field', key, type: 'custom', build, captureKeys: Object.freeze(captureKeys) });
}

export function card(key, { title, description, cardKey, fields }) {
    return Object.freeze({
        kind: 'layout', key, type: 'card', title, description, cardKey,
        fields: Object.freeze(fields),
    });
}

export function radioGroup(key, { label, labelStyle, innerRowStyle, hint, hintStyle, rowStyle, radios }) {
    return Object.freeze({
        kind: 'layout', key, type: 'radioGroup', label, labelStyle, innerRowStyle, hint, hintStyle, rowStyle,
        fields: Object.freeze(radios),
    });
}

export function inlineNumbers(key, fields) {
    return Object.freeze({ kind: 'layout', key, type: 'inlineNumbers', fields: Object.freeze(fields) });
}

// 行标题 + 若干"标签+数字"单元格 + 行尾提示的控制行（宽屏自定义宽度等）。
export function numberCells(key, { label, hint, items, ...rest }) {
    return Object.freeze({
        kind: 'layout', key, type: 'numberCells', label, hint, ...rest,
        fields: Object.freeze(items),
    });
}

// 依赖子句的可读拼装：visibleWhen('a', 'b=value') → ['a', 'b=value']。
export function visibleWhen(...clauses) {
    return clauses;
}

// 深度遍历全部 field 描述符（布局容器的 children 递归展开）。
export function walkFields(descriptor, visit) {
    for (const child of descriptor.fields || []) {
        if (child.kind === 'layout') walkFields(child, visit);
        else visit(child);
    }
}
