// render/shared — 渲染器与组件构建器共用的小工具。
// 统一 data-vcp-style 的落点：undefined/null 表示不加该属性
// （部分历史控件本就没有样式标记）。
export function el(doc, tag, className, styleValue) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (styleValue !== undefined && styleValue !== null) node.setAttribute('data-vcp-style', String(styleValue));
    return node;
}

// M5-c pass6：表单图标直出——vcp-ui-icon 节点是 form-icons 收编 pass 的
// 终态产品（原 pass 只做"内联 SVG → 图标名 span"的替换，图标本体由
// lucide-adapter 统一渲染）。渲染器直接产出该 span，pass 随之退役。
export function buildFormIcon(doc, lucideName) {
    const icon = el(doc, 'span', 'vcp-ui-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = lucideName;
    return icon;
}
