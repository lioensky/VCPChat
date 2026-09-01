// render/shared — 渲染器与组件构建器共用的小工具。
// 统一 data-vcp-style 的落点：undefined/null 表示不加该属性
// （部分历史控件本就没有样式标记）。
export function el(doc, tag, className, styleValue) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (styleValue !== undefined && styleValue !== null) node.setAttribute('data-vcp-style', String(styleValue));
    return node;
}
