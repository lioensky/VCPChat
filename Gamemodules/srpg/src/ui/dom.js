// DOM 小工具 + 棋盘渲染

/**
 * h('div.cls#id', {onclick, style:{}, ...attrs}, ...children)
 */
export function h(sel, attrs, ...children) {
    if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
        children.unshift(attrs);
        attrs = {};
    }
    const [, tag = 'div', rest = ''] = sel.match(/^([a-z0-9]*)(.*)$/i);
    const el = document.createElement(tag || 'div');
    for (const part of rest.match(/[.#][^.#]+/g) || []) {
        if (part[0] === '.') el.classList.add(part.slice(1));
        else el.id = part.slice(1);
    }
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'class') el.className += ` ${v}`;
        else if (k === 'value') el.value = v;
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
        if (c == null || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

/** 在面板内弹出一个文本框对话框 */
export function textDialog(container, title, text, { note, buttons = [] } = {}) {
    const ta = h('textarea.text_pole.tsrpg-preview-text', { rows: 18, readOnly: true, value: text });
    const overlay = h('div.tsrpg-overlay',
        h('div.tsrpg-dialog',
            h('div.tsrpg-section-title', title),
            note ? h('div.tsrpg-muted', note) : null,
            ta,
            h('div.tsrpg-row',
                buttons,
                button('复制', () => { navigator.clipboard?.writeText(ta.value); toast('success', '已复制'); }, { icon: 'fa-copy' }),
                button('关闭', () => overlay.remove(), { icon: 'fa-xmark' })),
        ));
    container.append(overlay);
    return overlay;
}

/** append 的安全版本：跳过 null / false，展开数组（直接 append(null) 会显示出 "null" 文字） */
export function add(parent, ...children) {
    for (const c of children.flat(Infinity)) {
        if (c == null || c === false) continue;
        parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return parent;
}

/**
 * 把「分节标题 + 后面的内容」包成卡片（.tsrpg-group），表单不必逐个改结构。
 * 自带标题的子块（第一个子元素就是分节标题）本身作为一张卡片。
 */
export function groupSections(el) {
    let group = null;
    for (const child of [...el.children]) {
        if (child.classList.contains('tsrpg-section-title')) {
            group = h('section.tsrpg-group');
            el.insertBefore(group, child);
            group.append(child);
        } else if (child.firstElementChild?.classList.contains('tsrpg-section-title')) {
            child.classList.add('tsrpg-group');
            group = null;
        } else if (group) {
            group.append(child);
        }
    }
    return el;
}

export function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
}

export function toast(type, msg) {
    const toastr = globalThis.window?.toastr;
    if (toastr?.[type]) toastr[type](msg, 'Tavern-SRPG');
    else console.log(`[Tavern-SRPG] ${msg}`);
}

/** 带标签的表单行 */
export function field(label, input, hint) {
    return h('label.tsrpg-field', h('span.tsrpg-label', label), input, hint ? h('small.tsrpg-hint', hint) : null);
}

export function numInput(value, onchange, { min, max, step = 1 } = {}) {
    return h('input.text_pole', {
        type: 'number', value: String(value ?? 0), min, max, step,
        onchange: e => onchange(Number(e.target.value) || 0),
    });
}

export function textInput(value, onchange, placeholder = '') {
    return h('input.text_pole', { type: 'text', value: value ?? '', placeholder, onchange: e => onchange(e.target.value) });
}

export function textArea(value, onchange, rows = 3, placeholder = '') {
    return h('textarea.text_pole', { rows, placeholder, value: value ?? '', onchange: e => onchange(e.target.value) });
}

export function checkbox(label, checked, onchange, hint) {
    return h('label.tsrpg-check', { title: hint || '' },
        h('input', { type: 'checkbox', checked: !!checked, onchange: e => onchange(e.target.checked) }),
        h('span', label));
}

export function select(options, value, onchange) {
    const el = h('select.text_pole', { onchange: e => onchange(e.target.value) },
        options.map(([v, label]) => h('option', { value: v }, label)));
    el.value = value ?? '';
    return el;
}

export function button(label, onclick, { icon, cls = '', title, disabled } = {}) {
    return h(`button.menu_button.tsrpg-btn${cls ? '.' + cls.split(' ').join('.') : ''}`, { onclick, title: title || '', disabled: !!disabled, type: 'button' },
        icon ? h(`i.fa-solid.${icon}`) : null, label ? h('span', label) : null);
}

/** 根据背景色选择可读的文字颜色 */
export function contrast(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#000';
    const n = parseInt(m[1], 16);
    const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#111' : '#f5f5f5';
}

const SIDE_COLORS = { player: '#2f6fd6', enemy: '#c62828', ally: '#2e9d4a' };

/**
 * 渲染棋盘
 * @param {object} o
 * @param {number} o.w
 * @param {number} o.h
 * @param {string[]} o.tiles
 * @param {(id:string)=>object} o.terrain
 * @param {object[]} o.units {x,y,icon,color,side,hp,maxHp,acted,uid,name}
 * @param {Map<string,string[]>} [o.marks] "x,y" -> class 列表
 * @param {number} o.cell
 * @param {(x:number,y:number,e:MouseEvent)=>void} [o.onCell]
 * @param {(x:number,y:number,e:MouseEvent)=>void} [o.onHover]
 * @param {(x:number,y:number,e:MouseEvent)=>void} [o.onContext]
 * @param {string} [o.selected] 选中单位 uid
 * @param {Map<string,number>} [o.preview] 预计 HP（uid -> 结算后 HP），在棋子血条上闪烁显示损失
 */
export function renderBoard(o) {
    const grid = h('div.tsrpg-board', {
        style: { gridTemplateColumns: `repeat(${o.w}, ${o.cell}px)`, gridAutoRows: `${o.cell}px`, '--cell': `${o.cell}px` },
    });
    const byPos = new Map((o.units || []).map(u => [`${u.x},${u.y}`, u]));
    for (const effect of o.effects || []) {
        if (effect.cls !== 'm-acting' && effect.cls !== 'm-lunge') continue;
        const actor = (o.units || []).find(u => u.uid === effect.uid);
        if (actor) byPos.set(`${actor.x},${actor.y}`, actor);
    }
    for (let y = 0; y < o.h; y++) {
        for (let x = 0; x < o.w; x++) {
            const t = o.terrain(o.tiles[y * o.w + x]);
            const key = `${x},${y}`;
            const cell = h('div.tsrpg-cell', {
                'data-x': x, 'data-y': y,
                title: `(${x + 1},${y + 1}) ${t.name}${Number(t.enterDamage) || Number(t.enterDamagePct) ? ` · 落脚伤害 ${Number(t.enterDamage) || 0} + ${Number(t.enterDamagePct) || 0}%最大HP` : ''}${Number(t.turnDamage) || Number(t.turnDamagePct) ? ` · 回合伤害 ${Number(t.turnDamage) || 0} + ${Number(t.turnDamagePct) || 0}%最大HP` : ''}`,
                style: { background: t.color, color: contrast(t.color) },
            }, t.symbol ? h('span.tsrpg-sym', t.symbol) : null);
            for (const m of o.marks?.get(key) || []) cell.classList.add(m);
            if (o.area?.some(([ax, ay]) => ax === x && ay === y)) cell.classList.add('m-area');
            let drainFrom = null;
            for (const effect of o.effects || []) {
                if (effect.x !== x || effect.y !== y) continue;
                if (effect.cls) cell.classList.add(effect.cls);
                if (effect.ko) cell.classList.add('m-ko');
                if (effect.lx != null) { cell.style.setProperty?.('--lx', effect.lx); cell.style.setProperty?.('--ly', effect.ly); }
                if (effect.hpFrom != null) drainFrom = effect.hpFrom;
                if (effect.text) cell.append(h(`span.tsrpg-damage-number.${numberKind(effect.text)}`, effect.text));
            }
            const u = byPos.get(key);
            if (u) cell.append(renderToken(u, u.uid && u.uid === o.selected, { drainFrom, previewHp: o.preview?.get(u.uid) }));
            grid.append(cell);
        }
    }
    const pick = (e) => {
        const c = e.target.closest('.tsrpg-cell');
        return c ? [Number(c.dataset.x), Number(c.dataset.y)] : null;
    };
    if (o.onCell) grid.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        const p = pick(e); if (p) o.onCell(p[0], p[1], e);
    });
    if (o.onHover) grid.addEventListener('mouseover', e => {
        const p = pick(e); if (p) o.onHover(p[0], p[1], e);
    });
    if (o.onContext) grid.addEventListener('contextmenu', e => {
        const p = pick(e); if (p) { e.preventDefault(); o.onContext(p[0], p[1], e); }
    });
    return grid;
}

/** 伤害数字的样式：伤害 / 回复 / 未命中 / 其他 */
function numberKind(text) {
    return text.startsWith('+') ? 'heal' : text.startsWith('−') ? 'dmg' : text === 'MISS' ? 'miss' : 'info';
}

const hpPct = (u, hp) => `${Math.max(0, Math.min(100, (hp / Math.max(1, u.maxHp)) * 100))}%`;

/**
 * @param {{drainFrom?: number|null, previewHp?: number}} [fx]
 *   drainFrom：回放时扣血前的 HP，血条显示掉血动画；previewHp：预计结算后的 HP，闪烁显示将损失的部分
 */
export function renderToken(u, selected = false, fx = {}) {
    const color = u.color || SIDE_COLORS[u.side] || '#666';
    const el = h(`div.tsrpg-token.side-${u.side}`, {
        'data-uid': u.uid || '',
        style: { background: color, color: contrast(color) },
        title: u.name + (u.maxHp ? ` HP ${u.hp}/${u.maxHp}` : ''),
    }, h('span.tsrpg-token-icon', u.icon || (u.name || '?').slice(0, 1)));
    if (u.maxHp) {
        const bar = h('div.tsrpg-hpbar', h('div.fill', { style: { width: hpPct(u, u.hp) } }));
        const from = fx.drainFrom;
        if (from != null && from > u.hp) bar.append(h('div.trail', { style: { left: hpPct(u, u.hp), width: hpPct(u, from - u.hp) } }));
        if (from != null && from < u.hp) bar.append(h('div.gain', { style: { left: hpPct(u, from), width: hpPct(u, u.hp - from) } }));
        el.append(bar);
        setTokenPreview(el, u, fx.previewHp);
    }
    if (u.kind === 'object' || u.object) el.classList.add('object');
    if (u.ghost) el.classList.add('ghost');
    if (u.keyTarget) el.append(h('span.tsrpg-key', { title: '关键目标' }, '★'));
    const st = u.statuses || [];
    if (st.length) {
        const icons = [];
        if (st.some(x => x.type === 'taunt')) icons.push(h('i.fa-solid.fa-bullhorn', { title: '嘲讽' }));
        if (st.some(x => x.type === 'stun')) icons.push(h('i.fa-solid.fa-face-dizzy', { title: '眩晕' }));
        if (st.some(x => x.type === 'poison')) icons.push(h('i.fa-solid.fa-skull-crossbones', { title: '中毒' }));
        if (st.some(x => /_up$|regen/.test(x.type))) icons.push(h('span.up', '▲'));
        if (st.some(x => /_down$/.test(x.type))) icons.push(h('span.down', '▼'));
        el.append(h('span.tsrpg-status', icons));
    }
    if (u.acted) el.classList.add('acted');
    if (selected) el.classList.add('selected');
    return el;
}

/** 在棋子血条上标出预计损失 / 回复（闪烁）；hp 为 null 时清除。预计被击败的棋子会发出红光 */
export function setTokenPreview(token, u, hp) {
    const bar = token.querySelector?.('.tsrpg-hpbar') ?? token.children?.find?.(c => c.classes?.has('tsrpg-hpbar'));
    bar?.querySelectorAll?.('.ghost').forEach(g => g.remove());
    token.classList.remove('preview-ko');
    if (!bar || hp == null || hp === u.hp) return;
    const next = Math.max(0, Math.min(u.maxHp, hp));
    const lo = Math.min(next, u.hp), hi = Math.max(next, u.hp);
    bar.append(h(`div.ghost.${next < u.hp ? 'loss' : 'gain'}`, { style: { left: hpPct(u, lo), width: hpPct(u, hi - lo) } }));
    if (next <= 0) token.classList.add('preview-ko');
}
