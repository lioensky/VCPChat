// schema/kernel — 设置项 schema 的描述原语（实验分支 exp/settings-schema）。
// 目标架构：schema（key/类型/文案/依赖）→ 渲染 → uiux 原语 → dsw 单层级联。
// 这里只声明"业务语义"：控件的 key、类型、文案、约束与依赖；任何呈现层
// 的痕迹（行类名、data-vcp-style、data-visible-when 拼接）都由渲染器编译
// 产出，schema 本身保持与 DOM 无关。
//
// 字段描述符约定：
//   key          — 业务锚点，编译后同时是控件 id 与 name；
//   type         — textarea | number | switch | select；
//   label/hint   — 文案（含既有冒号等排版字符，保持像素一致）；
//   hintStyle    — 渲染器选择 small 标记时参考的呈现变体（默认 4）；
//   stacked      — 独占一行的纵向布局（textarea 场景）；
//   groupId      — 包裹行容器的业务 id（typed-field-owners 直写其可见性）；
//   rowId        — 行本身的业务 id（条件行锚点）；
//   when         — 依赖子句数组（'其他控件 id' 或 'id=值'），以 && 组合；
//   options      — select 选项；
//   其余（min/max/step/placeholder/rows/spellcheck/defaultValue）原样落到控件。

export function section(key, title, fields) {
    return Object.freeze({ kind: 'section', key, title, fields: Object.freeze(fields) });
}

export function textarea(key, options) {
    return Object.freeze({ kind: 'field', key, type: 'textarea', ...options });
}

export function number(key, options) {
    return Object.freeze({ kind: 'field', key, type: 'number', ...options });
}

export function switchField(key, options) {
    return Object.freeze({ kind: 'field', key, type: 'switch', ...options });
}

export function select(key, options) {
    return Object.freeze({ kind: 'field', key, type: 'select', ...options });
}

// 依赖子句的可读拼装：visibleWhen('a', 'b=value') → ['a', 'b=value']。
export function visibleWhen(...clauses) {
    return clauses;
}
