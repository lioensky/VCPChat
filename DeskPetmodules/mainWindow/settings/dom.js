// 桌宠设置面板各块共用的 DOM 小工具：建节点、建按钮、画图标、建下拉项。
// 只造结构，不碰状态；样式都在 DeskPetmodules/mainWindow/settings.css 里。

export function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function button(doc, className, text, attrs = {}) {
    const node = el(doc, 'button', className, text);
    node.type = 'button';
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
    edit: ['M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7', 'M18.4 2.6a2.1 2.1 0 0 1 3 3l-9 9a2 2 0 0 1-.9.5l-2.9.8.8-2.9a2 2 0 0 1 .5-.8Z'],
    voice: ['M4 10v4', 'M8 7v10', 'M12 4v16', 'M16 7v10', 'M20 10v4'],
    plus: ['M12 5v14', 'M5 12h14'],
    collapse: ['m6 9 6 6 6-6'],
    send: ['M12 19V5', 'm5 12 7-7 7 7'],
    refresh: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 4v5h-5'],
    none: ['M5 5l14 14', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z'],
};

export function icon(doc, name) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
        const path = doc.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.append(path);
    }
    return svg;
}

export function option(doc, value, text) {
    const node = el(doc, 'option', '', text);
    node.value = value;
    return node;
}

export function buildSwitchRow(doc, title, hint) {
    const row = el(doc, 'label', 'dps-row');
    const copy = el(doc, 'span', 'dps-row-copy');
    copy.append(el(doc, 'span', 'dps-row-title', title), el(doc, 'span', 'dps-row-hint', hint));
    const toggle = el(doc, 'span', 'dps-switch');
    const input = el(doc, 'input');
    input.type = 'checkbox';
    toggle.append(input, el(doc, 'span', 'dps-switch-knob'));
    row.append(copy, toggle);
    return { row, input };
}
