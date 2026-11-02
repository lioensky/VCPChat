'use strict';
// 网页元素直接改。
// 改动要落回源码：用 pick.js 的办法认出元素，只算“第几个字到第几个字换成什么”，别处一个字不动。
// 写进去由文坊页面做，走源码编辑器：能撤销，存法和手改源码一样。认不准的不改，脚本生成的元素文件里没有。
const { find } = require('./pick');

// 按分号切开 style，引号和括号里的分号不算。
function declarations(style) {
    const list = [];
    let part = '';
    let quote = '';
    let depth = 0;
    for (const ch of `${style};`) {
        if (quote) {
            if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '(') {
            depth += 1;
        } else if (ch === ')') {
            depth -= 1;
        } else if (ch === ';' && depth <= 0) {
            if (part.trim()) list.push(part.trim());
            part = '';
            continue;
        }
        part += ch;
    }
    return list;
}
const nameOf = (declaration) => declaration.slice(0, declaration.indexOf(':')).trim().toLowerCase();

function mergeStyle(style, props) {
    const list = declarations(style);
    for (const [name, value] of Object.entries(props)) {
        const index = list.findIndex((item) => nameOf(item) === name);
        if (!value) {
            if (index >= 0) list.splice(index, 1);
        } else if (index >= 0) {
            list[index] = `${name}: ${value}`;
        } else {
            list.push(`${name}: ${value}`);
        }
    }
    return list.join('; ');
}

function styleChange(text, node, props) {
    const start = node.sourceCodeLocation.startTag;
    const spot = start.attrs?.style;
    const current = node.attrs.find((item) => item.name === 'style')?.value || '';
    const merged = mergeStyle(current, props);
    const attribute = merged ? `style="${merged.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` : '';
    if (spot) {
        if (attribute) return { from: spot.startOffset, to: spot.endOffset, insert: attribute };
        let from = spot.startOffset;
        while (/\s/.test(text[from - 1])) from -= 1;
        return { from, to: spot.endOffset, insert: '' };
    }
    if (!attribute) return null;
    let at = start.endOffset - 1;
    if (text[at - 1] === '/') at -= 1;
    while (/\s/.test(text[at - 1])) at -= 1;
    return { from: at, to: at, insert: ` ${attribute}` };
}

function patch(text, picked, change) {
    const hit = find(text, picked);
    if (!hit || !hit.node.sourceCodeLocation.startTag) return { success: false, reason: 'generated' };
    if (!hit.exact) return { success: false, reason: 'ambiguous' };
    if (!change) return { success: true };
    const where = hit.node.sourceCodeLocation;
    if (change.kind === 'text') {
        const to = where.endTag ? where.endTag.startOffset : where.endOffset;
        return { success: true, from: where.startTag.endOffset, to, insert: String(change.html ?? '') };
    }
    if (change.kind === 'style') {
        const range = styleChange(text, hit.node, change.props || {});
        return range ? { success: true, ...range } : { success: true, from: 0, to: 0, insert: '' };
    }
    return { success: false, reason: 'unknown' };
}

module.exports = { patch };
