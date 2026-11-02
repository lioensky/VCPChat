// VCP : 在属性小表里改属性。
// 不再开小框。.md 开头的 YAML 属性段画成小表（uttu-frontmatter.js、混合编译器），
// 点值或属性名，那一格就地变成可编辑的，光标落在点的地方，长值照常折行。列表编辑时写成“甲, 乙”，存完变回小块。
// 回车或点别处存，Esc 放弃，Tab 到下一项，输入法选字时的回车不算。编辑时这一行末尾有 ×；鼠标在表上时表下面的空白里有“加一项”，新行也在表里填。
// 这几样控件只在运行时加进页面，不进编译结果，导出的文件里没有。
// 写回走 UTTUScriptoriumSession.replaceSource：记进撤销、算改动、照常存回原文件；保留原来的写法（uttu-frontmatter.js setValue）。
// 看不懂的属性段（嵌套、多行字符串）原样显示，不能在这里改，到源码面去改。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    const Front = window.UTTUFrontmatter;
    if (!UI?.make || !Front) return;
    const { make } = UI;
    const session = () => window.UTTUScriptoriumSession;
    const HOSTS = ['read-host', 'render-host'];
    // 编辑时这些事件不让文稿自己的编辑逻辑和快捷键看见。
    const QUIET_EVENTS = ['keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'copy', 'compositionstart', 'compositionupdate', 'compositionend'];
    const PASSED_CTRL = new Set(['z', 'y', 'a', 'c', 'v', 'x']); // 这几个留给格子本身，别的 Ctrl 组合键（保存、快速打开）照常

    let active = null; // { kind: 'value' | 'key' | 'new', cell, row, hostId, index, html, text }

    const clean = (text) => String(text || '').replace(/\s*\n\s*/g, ' ').trim();
    function apply(change) {
        const api = session();
        const source = api?.source?.() || '';
        let next;
        try {
            next = change(source);
        } catch (error) {
            UI.toast?.(error.message);
            return false;
        }
        if (next === source) return false;
        api?.replaceSource?.(next, 'uttu-properties');
        return true;
    }
    function tableOf(hostId) {
        const host = document.getElementById(hostId);
        for (const node of host?.querySelectorAll('*') || []) {
            const table = node.shadowRoot?.querySelector('table[data-vdoc-frontmatter="table"]');
            if (table) return table;
        }
        return null;
    }
    const rowOf = (hostId, index) => tableOf(hostId)?.querySelector(`tr[data-vdoc-frontmatter-index="${index}"]`) || null;
    const entryAt = (index) => {
        const front = Front.scan(session()?.source?.() || '');
        return front ? Front.entries(front.yaml).list[index] || null : null;
    };

    function makeEditable(cell, hint) {
        cell.contentEditable = 'plaintext-only';
        cell.spellcheck = false;
        cell.dataset.hint = hint;
        cell.classList.add('uttu-prop-editing');
    }
    function makePlain(cell) {
        cell.removeAttribute('contenteditable');
        cell.removeAttribute('data-hint');
        cell.classList.remove('uttu-prop-editing');
    }
    function selectAll(cell) {
        cell.focus();
        window.getSelection()?.selectAllChildren(cell);
    }

    function beginValue(cell, hostId) {
        const row = cell.closest('tr');
        const index = Number(row.getAttribute('data-vdoc-frontmatter-index'));
        const entry = entryAt(index);
        if (!entry) return false;
        const text = Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value ?? '');
        active = { kind: 'value', cell, row, hostId, index, html: cell.innerHTML, text };
        if (Array.isArray(entry.value)) cell.textContent = text;
        makeEditable(cell, entry.style === 'scalar' ? '值' : '用逗号隔开，比如：计划, 文坊');
        const tools = make('td', 'uttu-prop-tools');
        const remove = make('button', 'uttu-prop-del');
        remove.type = 'button';
        remove.setAttribute('aria-label', `删掉 ${entry.key}`);
        tools.append(remove);
        row.append(tools);
        return true;
    }
    function beginKey(cell, hostId) {
        const row = cell.closest('tr');
        const index = Number(row.getAttribute('data-vdoc-frontmatter-index'));
        const text = cell.textContent;
        active = { kind: 'key', cell, row, hostId, index, html: cell.innerHTML, text };
        makeEditable(cell, '属性名');
        return true;
    }
    function beginNew(hostId) {
        const table = tableOf(hostId);
        if (!table) return;
        const row = make('tr', 'uttu-prop-new');
        const name = make('th');
        const value = make('td');
        row.append(name, value);
        table.tBodies[0].append(row);
        makeEditable(name, '属性名');
        makeEditable(value, '值');
        active = { kind: 'new', cell: name, row, hostId, name, value };
        name.focus();
    }

    // 收尾。回 true 表示写了源码，表马上会重画。
    function finish({ save = true } = {}) {
        const state = active;
        if (!state) return false;
        active = null;
        if (state.kind === 'new') {
            const name = clean(state.name.textContent);
            const value = clean(state.value.textContent);
            state.row.remove();
            return save && Boolean(name) && apply((source) => Front.addEntry(source, name, value));
        }
        const { cell, row, index } = state;
        const text = clean(cell.textContent);
        makePlain(cell);
        row.querySelector('.uttu-prop-tools')?.remove();
        const changed = save && text !== state.text && (state.kind === 'key'
            ? Boolean(text) && apply((source) => Front.setKey(source, index, text))
            : apply((source) => Front.setValue(source, index, text)));
        if (!changed) cell.innerHTML = state.html;
        return changed;
    }

    // 写了源码之后表会重画，等新的一行出来再接着编辑。
    async function editAfterRedraw(hostId, index, begin) {
        const old = rowOf(hostId, index);
        for (let tries = 0; tries < 40; tries += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            const row = rowOf(hostId, index);
            if (row && row !== old) break;
        }
        begin();
    }
    function nextValue(hostId, index) {
        const cell = rowOf(hostId, index)?.querySelector('td');
        if (cell && !active && beginValue(cell, hostId)) selectAll(cell);
    }
    function move(direction) {
        const { hostId, index } = active;
        const target = index + direction;
        const exists = Boolean(rowOf(hostId, target));
        const changed = finish();
        if (!exists) return;
        if (changed) void editAfterRedraw(hostId, target, () => nextValue(hostId, target));
        else nextValue(hostId, target);
    }

    const hostOf = (path) => path.find((node) => HOSTS.includes(node?.id))?.id || '';
    document.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const path = event.composedPath();
        if (active && (path.includes(active.cell) || (active.kind === 'new' && path.includes(active.row)))) return;
        const hostId = hostOf(path);
        const remove = path.find((node) => node?.classList?.contains('uttu-prop-del'));
        if (remove && active) {
            event.preventDefault();
            const { index } = active;
            finish({ save: false });
            apply((source) => Front.removeEntry(source, index));
            return;
        }
        const row = path.find((node) => node?.tagName === 'TR' && node.hasAttribute?.('data-vdoc-frontmatter-index'));
        const add = path.find((node) => node?.classList?.contains('uttu-prop-add'));
        const cell = row && path.find((node) => node?.tagName === 'TD' || node?.tagName === 'TH');
        const changed = finish();
        if (!hostId || (!add && !cell)) return;
        const index = row ? Number(row.getAttribute('data-vdoc-frontmatter-index')) : -1;
        const isKey = cell?.tagName === 'TH';
        const begin = () => {
            if (add) { beginNew(hostId); return; }
            const fresh = rowOf(hostId, index)?.querySelector(isKey ? 'th' : 'td');
            if (fresh && (isKey ? beginKey(fresh, hostId) : beginValue(fresh, hostId))) selectAll(fresh);
        };
        if (add) event.preventDefault();
        if (changed) {
            event.preventDefault();
            void editAfterRedraw(hostId, index, begin);
        } else if (add) {
            begin();
        } else if (isKey ? beginKey(cell, hostId) : beginValue(cell, hostId)) {
            // 格子此刻已经可编辑，浏览器接下来按平常的点击把光标放到点的地方。
            setTimeout(() => { if (active?.cell === cell && cell.getRootNode().activeElement !== cell) cell.focus(); }, 0);
        }
    }, true);

    document.addEventListener('focusout', (event) => {
        if (!active) return;
        const target = event.composedPath()[0];
        if (target !== active.cell && !(active.kind === 'new' && active.row.contains(target))) return;
        // 新行里在两格之间移动不算离开。
        if (active.kind === 'new' && active.row.contains(event.relatedTarget)) return;
        if (document.hasFocus()) finish();
    }, true);

    window.addEventListener('keydown', (event) => {
        if (!active) return;
        if (event.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
        if (event.key === 'Escape') {
            // preventDefault：这一下已经用掉了，外层不再处理。
            event.preventDefault();
            event.stopPropagation();
            finish({ save: false });
            return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            event.stopPropagation();
            if (active.kind === 'new') {
                if (active.cell === active.name) {
                    active.cell = active.value;
                    active.value.focus();
                } else {
                    finish();
                }
            } else if (event.key === 'Tab' && active.kind === 'value') {
                move(event.shiftKey ? -1 : 1);
            } else {
                finish();
            }
            return;
        }
        if (!(event.ctrlKey || event.metaKey) || PASSED_CTRL.has(event.key.toLowerCase())) event.stopPropagation();
    }, true);
    for (const type of QUIET_EVENTS) {
        window.addEventListener(type, (event) => { if (active) event.stopPropagation(); }, true);
    }

    // 鼠标到表上时补上“加一项”。放在表下面原有的空白里，不占版面，文字在样式里，读页面文字时读不到它。
    // 用 pointermove：表重画后鼠标还在同一格里，不会再有 pointerover。
    document.addEventListener('pointermove', (event) => {
        const path = event.composedPath();
        const table = path.find((node) => node?.tagName === 'TABLE' && node.dataset?.vdocFrontmatter === 'table');
        if (!table || table.querySelector(':scope > .uttu-prop-add') || !hostOf(path)) return;
        const add = make('caption', 'uttu-prop-add');
        add.setAttribute('role', 'button');
        add.setAttribute('aria-label', '加一项');
        table.prepend(add);
    }, true);

    UI.on?.('document', () => finish({ save: false }));
})();
