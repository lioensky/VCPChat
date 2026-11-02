// 文坊中的表格（主进程 modules/scriptorium/sheetFiles）。
// .csv / .tsv / .xlsx：第一行作为表头（可关闭）、点击表头排序、查找框筛选包含指定文字的行、点击单元格选中、Shift 点击选中区域、
// Ctrl C 复制（制表符分隔，粘贴到 Excel 仍按单元格分开）。.xlsx 有多张工作表时，“篇章”面板列出各张表。
// 编辑：双击、Enter、F2 或直接输入进入单元格，Enter 到下一行、Tab 到下一格、Esc 取消；方向键移动，Shift 扩展选区；
// Delete 清空，Ctrl V 粘贴一片，Ctrl Z / Y 撤销重做，保存使用保存按钮或 Ctrl S。.csv / .tsv 右键可插入、删除行列。
// .xlsx 只修改单元格的值，样式、合并和其他工作表保持不变；文坊不计算公式，由 Excel 打开时重新计算。
// 含有图表、透视表、宏的工作簿只查看、不修改（主进程 lockReason）。
// 数万行也不卡顿：只绘制可见的几十行（行高相同）。文件被外部修改时重新读取，停留在原来的工作表和位置。
(() => {
    'use strict';
    const UI = window.ScriptoriumFileViews;
    if (!UI?.on) return;
    const { make, button, icon, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.ScriptoriumFileSession;
    const isSheet = (file) => /\.(csv|tsv|xlsx|xlsm)$/i.test(String(file || ''));
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;
    const ROW = 28; // 每行的高（像素），和 CSS 一致
    const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/;
    const letters = (k) => {
        let name = '';
        for (let n = k + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
        return name;
    };

    let T = null; // { filePath, name, sheets, mtime, size, encoding, format, lockReason, generation, dirty, saving, revision, changes, past, undone }
    let generation = 0;
    let sheetIndex = 0;
    let header = true;
    let sort = { col: -1, dir: 0 };
    let query = '';
    let view = []; // 现在显示的行（在 rows 里的下标）
    let columns = []; // [{ width, num }]
    let pick = null; // { a: [行, 列], b: [行, 列] }，行是 view 里的位置
    const remembered = new Map(); // 路径 → { sheet, header, scroll }，切走再回来还在原处
    let numberWidth = 44;
    let editing = null; // { row, col, at, value }，row 是 rows 里的下标
    const editable = () => Boolean(T) && !T.lockReason;

    // ---------- 搭结构 ----------
    const work = make('div', 'scriptorium-table-work');
    work.hidden = true;
    work.setAttribute('aria-label', '表格');
    const head = make('div', 'scriptorium-pane-head scriptorium-table-head');
    const sheetButton = button('scriptorium-tb-drop', '', '', () => UI.toggleMenu(sheetButton, () => (T?.sheets || []).map((sheet, index) => ({
        label: sheet.name, check: index === sheetIndex, act: () => setSheet(index),
    }))));
    const info = make('span', 'scriptorium-table-info');
    const headerToggle = button('scriptorium-chk scriptorium-table-headerchk', '', `<span class="box">${icon('i-check')}</span><span>第一行是表头</span>`, () => {
        header = !header;
        sort = { col: -1, dir: 0 };
        rebuild();
    });
    headerToggle.setAttribute('role', 'checkbox');
    const findBox = make('span', 'scriptorium-pdf-find scriptorium-table-find');
    const findInput = make('input');
    findInput.type = 'search';
    findInput.placeholder = '筛选';
    findInput.setAttribute('aria-label', '只显示包含这些文字的行');
    const findCount = make('small');
    findBox.append(findInput, findCount);
    const pickStats = make('small', 'scriptorium-table-stats');
    const openDefault = button('scriptorium-file-button', '', '用默认程序打开', () => void openWithDefault());
    const conflict = make('span', 'scriptorium-file-conflict');
    conflict.hidden = true;
    conflict.append(make('span', '', '文件已在别处修改'),
        button('scriptorium-file-button', '', '使用文件中的版本', () => void reload({ discard: true })),
        button('scriptorium-file-button', '', '保留我的修改', () => void save({ force: true })));
    head.append(sheetButton, info, pickStats, make('span', 'grow'), conflict, headerToggle, findBox, openDefault);
    const scroller = make('div', 'scriptorium-table-scroll');
    scroller.tabIndex = 0;
    scroller.setAttribute('aria-label', '表格内容');
    const sizer = make('div', 'scriptorium-table-sizer');
    const headRow = make('div', 'scriptorium-table-row scriptorium-table-th');
    const body = make('div', 'scriptorium-table-body');
    const editor = make('textarea', 'scriptorium-table-editor');
    editor.rows = 1;
    editor.spellcheck = false;
    editor.hidden = true;
    editor.setAttribute('aria-label', '编辑单元格');
    sizer.append(headRow, body, editor);
    scroller.append(sizer);
    const empty = make('p', 'scriptorium-table-empty');
    empty.hidden = true;
    work.append(head, scroller, empty);
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);

    // “篇章”面板：工作表列表（只在打开表格时显示）。
    const sheetList = make('div', 'scriptorium-table-sheets');
    document.getElementById('outline-panel')?.append(sheetList);

    // ---------- 打开、离开 ----------
    async function read(file) {
        try {
            return await api().sheet('read', { path: file });
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    async function open(file) {
        if (!isSheet(file)) return false;
        if (T && same(T.filePath, file)) return true;
        const result = await read(file);
        if (!result?.success) {
            UI.toast(`未能打开这个表格：${result?.error || '读取失败'}`, 'error', 5000);
            return false;
        }
        remember();
        const back = remembered.get(norm(result.filePath));
        show(result, back || { sheet: 0, header: true, scroll: 0 });
        return true;
    }
    function show(result, place) {
        T = {
            filePath: result.filePath, name: result.name, sheets: result.sheets, mtime: result.mtime, size: result.size,
            encoding: result.encoding, format: result.format, lockReason: result.lockReason || '', generation: ++generation,
            dirty: false, saving: false, revision: 0, changes: new Map(), past: [], undone: [],
        };
        conflict.hidden = true;
        T.fileRows ??= T.sheets[0].rows.length;
        // 空的 .csv 给一行空格子，才有地方开始写。
        if (T.format && !T.lockReason && !T.sheets[0].rows.length) {
            T.sheets[0].rows.push(['', '', '']);
            place = { ...place, header: false };
        }
        sheetIndex = Math.min(place.sheet || 0, T.sheets.length - 1);
        header = place.header !== false;
        sort = place.sort || { col: -1, dir: 0 };
        document.body.classList.add('scriptorium-table-mode');
        work.hidden = false;
        rebuild({ scroll: place.scroll || 0 });
        UI.sync?.();
        outline();
    }
    function remember() {
        if (T) remembered.set(norm(T.filePath), { sheet: sheetIndex, header, sort, scroll: scroller.scrollTop });
    }
    function leave() {
        if (!T) return;
        finishEdit();
        remember();
        T = null;
        pick = null;
        document.body.classList.remove('scriptorium-table-mode');
        work.hidden = true;
        body.replaceChildren();
        headRow.replaceChildren();
        sheetList.replaceChildren();
        UI.sync?.();
    }
    function route(file) {
        if (isSheet(file)) return open(file);
        if (!T) return null;
        const behind = session()?.current?.();
        leave();
        const stale = /\.(md|markdown)$/i.test(String(file)) && !behind?.dirty;
        if (behind && !welcomeShown() && same(behind.filePath, file) && !stale) return Promise.resolve(true);
        return null;
    }
    async function reload({ quiet = false, discard = false } = {}) {
        if (!T || (T.dirty && !discard)) return;
        const state = T;
        const result = await read(state.filePath);
        if (T !== state) return;
        if (!result?.success) {
            if (!quiet) UI.toast(`未能重新读取：${result?.error || ''}`, 'error', 5000);
            return;
        }
        show(result, { sheet: sheetIndex, header, sort, scroll: scroller.scrollTop });
    }
    async function openWithDefault() {
        if (!T) return;
        try {
            await api().files('open-default', { path: T.filePath });
        } catch (error) {
            UI.toast(error.message, 'error', 5000);
        }
    }

    // ---------- 一张表 ----------
    const sheet = () => T?.sheets[sheetIndex] || { name: '', rows: [], truncated: false };
    const dataRows = () => (header ? sheet().rows.slice(1) : sheet().rows);
    const widthOf = () => Math.max(0, ...sheet().rows.slice(0, 2000).map((row) => row.length));
    function setSheet(index) {
        if (!T || index === sheetIndex) return;
        sheetIndex = index;
        sort = { col: -1, dir: 0 };
        pick = null;
        rebuild();
        outline();
    }
    // 列宽：按前 300 行最长的字量（每列 48 到 360 像素）；八成是数字的列靠右。
    const measureContext = document.createElement('canvas').getContext('2d');
    function measureColumns() {
        const style = getComputedStyle(work);
        measureContext.font = `${style.getPropertyValue('--scriptorium-fs-small').trim() || '12.5px'} ${style.fontFamily}`;
        const rows = sheet().rows.slice(0, 300);
        const count = widthOf();
        columns = [];
        for (let col = 0; col < count; col += 1) {
            let widest = measureContext.measureText(header ? String(rows[0]?.[col] ?? '') : letters(col)).width + 34;
            let numbers = 0;
            let filled = 0;
            for (const row of rows.slice(header ? 1 : 0)) {
                const value = String(row[col] ?? '');
                if (!value) continue;
                filled += 1;
                if (NUMBER.test(value.trim())) numbers += 1;
                widest = Math.max(widest, measureContext.measureText(value.split('\n')[0]).width + 30); // 留白 17，末尾渐隐 12
            }
            columns.push({ width: Math.round(Math.min(360, Math.max(48, widest))), num: filled > 0 && numbers / filled >= 0.8 });
        }
    }
    const numberOf = (value) => Number(String(value).replace(/[,%\s]/g, ''));
    function rebuild({ scroll = null } = {}) {
        if (!T) return;
        headerToggle.setAttribute('aria-checked', String(header));
        const rows = dataRows();
        measureColumns();
        const q = query.toLowerCase();
        view = [];
        for (let index = 0; index < rows.length; index += 1) {
            if (!q || rows[index].some((cell) => String(cell).toLowerCase().includes(q))) view.push(index);
        }
        if (sort.dir && sort.col >= 0) {
            const col = sort.col;
            const numeric = columns[col]?.num;
            const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
            view.sort((a, b) => {
                const x = rows[a][col] ?? '';
                const y = rows[b][col] ?? '';
                if (x === '' || y === '') return x === y ? 0 : (x === '' ? 1 : -1); // 空的总在最后
                const order = numeric ? numberOf(x) - numberOf(y) : collator.compare(String(x), String(y));
                return order * sort.dir;
            });
        }
        pick = null;
        const total = columns.reduce((sum, column) => sum + column.width, 0);
        numberWidth = Math.max(44, String(rows.length).length * 8 + 20);
        work.style.setProperty('--scriptorium-table-n', `${numberWidth}px`);
        sizer.style.width = `${numberWidth + total}px`;
        sizer.style.height = `${ROW * (view.length + 1)}px`;
        drawHead();
        const count = widthOf();
        const label = sheet().rows.length ? `${rows.length.toLocaleString()} 行 · ${count} 列` : '此工作表为空';
        setText(info, `${label}${sheet().truncated ? '（文件过大，仅读取了前一部分）' : ''}${T.encoding ? ` · ${T.encoding}` : ''}${T.lockReason ? ` · ${T.lockReason}` : ''}`);
        setText(findCount, q ? (view.length ? `${view.length.toLocaleString()} 行` : '无匹配') : '');
        sheetButton.hidden = T.sheets.length < 2;
        sheetButton.innerHTML = `<span>${UI.escapeHtml(sheet().name)}</span>${icon('i-chevron')}`;
        empty.hidden = Boolean(sheet().rows.length);
        setText(empty, '此工作表为空。');
        if (scroll !== null) scroller.scrollTop = scroll;
        drawRows(true);
    }
    function drawHead() {
        const rows = sheet().rows;
        const cells = [make('span', 'n')];
        columns.forEach((column, col) => {
            const label = header ? String(rows[0]?.[col] ?? '') || letters(col) : letters(col);
            const cell = make('span', `c${column.num ? ' num' : ''}`);
            cell.dataset.col = String(col);
            cell.style.width = `${column.width}px`;
            const arrow = sort.col === col && sort.dir ? (sort.dir > 0 ? ' ↑' : ' ↓') : '';
            cell.textContent = label + arrow;
            cells.push(cell);
        });
        headRow.replaceChildren(...cells);
    }
    let drawn = '';
    function drawRows(force = false) {
        if (!T) return;
        const rows = dataRows();
        const first = Math.max(0, Math.floor(scroller.scrollTop / ROW) - 10);
        const last = Math.min(view.length, first + Math.ceil((scroller.clientHeight || 600) / ROW) + 20);
        const key = `${first}:${last}:${view.length}:${pick ? JSON.stringify(pick) : ''}`;
        if (!force && key === drawn) return;
        drawn = key;
        const range = pickRange();
        const out = [];
        for (let at = first; at < last; at += 1) {
            const index = view[at];
            const row = make('div', 'scriptorium-table-row');
            row.style.top = `${ROW * (at + 1)}px`;
            row.dataset.at = String(at);
            const number = make('span', 'n', String(index + 1 + (header ? 1 : 0)));
            row.append(number);
            columns.forEach((column, col) => {
                const cell = make('span', `c${column.num ? ' num' : ''}`);
                cell.style.width = `${column.width}px`;
                cell.dataset.col = String(col);
                const value = String(rows[index][col] ?? '');
                const text = make('i'); // 放不下末尾渐隐：渐隐只盖字，不盖选中的底色
                text.textContent = value.includes('\n') ? value.replace(/\n/g, ' ⏎ ') : value;
                cell.append(text);
                if (range && at >= range.top && at <= range.bottom && col >= range.left && col <= range.right) cell.classList.add('on');
                row.append(cell);
            });
            out.push(row);
        }
        body.replaceChildren(...out);
    }
    scroller.addEventListener('scroll', () => requestAnimationFrame(() => drawRows()), { passive: true });
    if (window.ResizeObserver) new ResizeObserver(() => drawRows(true)).observe(scroller);

    // 点表头排序：升、降、不排。
    headRow.addEventListener('click', (event) => {
        const cell = event.target.closest('.c');
        if (!cell) return;
        const col = Number(cell.dataset.col);
        sort = sort.col !== col ? { col, dir: 1 } : sort.dir === 1 ? { col, dir: -1 } : { col: -1, dir: 0 };
        rebuild({ scroll: scroller.scrollTop });
    });
    // 选格子：点一格，Shift 点一片。
    function pickRange() {
        if (!pick) return null;
        return { top: Math.min(pick.a[0], pick.b[0]), bottom: Math.max(pick.a[0], pick.b[0]), left: Math.min(pick.a[1], pick.b[1]), right: Math.max(pick.a[1], pick.b[1]) };
    }
    body.addEventListener('mousedown', (event) => {
        const cell = event.target.closest('.c');
        const row = event.target.closest('.scriptorium-table-row');
        if (!cell || !row || event.button !== 0) return;
        const at = [Number(row.dataset.at), Number(cell.dataset.col)];
        if (event.shiftKey && pick) {
            event.preventDefault();
            pick = { a: pick.a, b: at };
        } else {
            pick = { a: at, b: at };
        }
        paintPick();
        scroller.focus({ preventScroll: true });
    });
    // 右键：在选区外点击时先选中这一格，再显示编辑菜单（清空、插入和删除行列）。
    body.addEventListener('contextmenu', (event) => {
        const cell = event.target.closest('.c');
        const row = event.target.closest('.scriptorium-table-row');
        if (!cell || !row) return;
        event.preventDefault();
        const at = [Number(row.dataset.at), Number(cell.dataset.col)];
        const range = pickRange();
        if (!range || at[0] < range.top || at[0] > range.bottom || at[1] < range.left || at[1] > range.right) {
            pick = { a: at, b: at };
            paintPick();
        }
        const items = editItems();
        if (items.length) UI.openMenu(items, { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY, width: 0, height: 0 });
    });
    // 只换选中的样子，不重画（重画会把指针下的格子换掉，拖着选字就断了）。
    function paintPick() {
        const range = pickRange();
        body.querySelectorAll('.scriptorium-table-row').forEach((row) => {
            const at = Number(row.dataset.at);
            row.querySelectorAll('.c').forEach((cell) => {
                const col = Number(cell.dataset.col);
                cell.classList.toggle('on', Boolean(range) && at >= range.top && at <= range.bottom && col >= range.left && col <= range.right);
            });
        });
        drawn = '';
        paintStats(range);
    }
    // 选中多个单元格时，栏头显示数量、合计和平均值（与 Excel 的状态栏相同）；选区过大时不计算。
    const STATS_CELLS = 200000;
    function paintStats(range) {
        const count = range ? (range.bottom - range.top + 1) * (range.right - range.left + 1) : 0;
        if (count < 2 || count > STATS_CELLS) { setText(pickStats, ''); return; }
        const rows = dataRows();
        let numbers = 0;
        let sum = 0;
        for (let at = range.top; at <= range.bottom; at += 1) {
            const row = rows[view[at]];
            for (let col = range.left; col <= range.right; col += 1) {
                const value = String(row?.[col] ?? '').replace(/,/g, '').trim();
                if (value === '' || !Number.isFinite(Number(value))) continue;
                numbers += 1;
                sum += Number(value);
            }
        }
        const plain = (value) => String(Number(value.toFixed(6)));
        setText(pickStats, numbers ? `${count} 个单元格 · 合计 ${plain(sum)} · 平均 ${plain(sum / numbers)}` : `${count} 个单元格`);
    }
    function pickText() {
        const range = pickRange();
        if (!range) return '';
        const rows = dataRows();
        const lines = [];
        for (let at = range.top; at <= range.bottom; at += 1) {
            const row = rows[view[at]];
            const cells = [];
            for (let col = range.left; col <= range.right; col += 1) {
                const value = String(row[col] ?? '');
                cells.push(/[\t\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
            }
            lines.push(cells.join('\t'));
        }
        return lines.join('\n');
    }
    // Ctrl C：没有选中文字、选了格子时，复制选中的格子（在 copy 事件里写剪贴板，不用另要权限）。
    document.addEventListener('copy', (event) => {
        if (!T || work.hidden || !pick || window.getSelection()?.toString() || event.target?.closest?.('input, textarea')) return;
        const range = pickRange();
        event.clipboardData.setData('text/plain', pickText());
        event.preventDefault();
        const count = (range.bottom - range.top + 1) * (range.right - range.left + 1);
        UI.toast(count > 1 ? `已复制 ${count} 个单元格。` : '已复制。');
    });

    // ---------- 改格子 ----------
    const realRow = (at) => view[at] + (header ? 1 : 0);
    const cellKey = (row, col) => `${row}:${col}`;
    const valueAt = (target, row, col) => target.formulas?.[cellKey(row, col)] ?? String(target.rows[row]?.[col] ?? '');
    function changed({ structure = false } = {}) {
        if (!T) return;
        T.dirty = true;
        T.revision += 1;
        if (structure || sort.dir || query) {
            const keep = pick;
            rebuild({ scroll: scroller.scrollTop });
            pick = keep;
        }
        drawRows(true);
        UI.sync?.();
    }
    function record(step) {
        T.past.push(step);
        if (T.past.length > 200) T.past.shift();
        T.undone = [];
    }
    function writeCells(target, list) {
        for (const { row, col, text } of list) {
            while (target.rows.length <= row) target.rows.push([]);
            while (target.rows[row].length < col) target.rows[row].push('');
            target.rows[row][col] = text;
            if (target.formulas) {
                if (text.startsWith('=')) target.formulas[cellKey(row, col)] = text;
                else delete target.formulas[cellKey(row, col)];
            }
            if (!T.format) T.changes.set(`${target.name}\n${row}\n${col}`, { sheet: target.name, row, col, text });
        }
    }
    function setCells(list) {
        const target = sheet();
        const moved = list.filter(({ row, col, text }) => valueAt(target, row, col) !== text);
        if (!moved.length) return;
        const before = moved.map(({ row, col }) => ({ row, col, text: valueAt(target, row, col) }));
        writeCells(target, moved);
        record({ undo: () => writeCells(target, before), redo: () => writeCells(target, moved) });
        changed();
    }
    function restructure(apply, revert) {
        apply();
        record({ undo: revert, redo: apply, structure: true });
        changed({ structure: true });
    }
    function travel(from, to, method) {
        if (!T || !from.length) return;
        const step = from.pop();
        step[method]();
        to.push(step);
        changed({ structure: step.structure });
    }
    const undo = () => T && travel(T.past, T.undone, 'undo');
    const redo = () => T && travel(T.undone, T.past, 'redo');

    function openEditor(at, col, text = null) {
        if (!T || at < 0 || at >= view.length) return;
        if (!editable()) {
            UI.toast(`这个文件只能看：${T.lockReason}。`);
            return;
        }
        showCell(at, col);
        const row = realRow(at);
        const value = valueAt(sheet(), row, col);
        editing = { row, col, at, value };
        const left = numberWidth + columns.slice(0, col).reduce((sum, column) => sum + column.width, 0);
        Object.assign(editor.style, { left: `${left}px`, top: `${ROW * (at + 1)}px`, width: `${Math.max(columns[col]?.width || 80, 120)}px` });
        editor.value = text ?? value;
        editor.hidden = false;
        editor.focus({ preventScroll: true });
        editor.setSelectionRange(editor.value.length, editor.value.length);
    }
    // 收起编辑框，改了的写进表里。
    function finishEdit({ cancel = false } = {}) {
        if (!editing) return;
        const { row, col, value } = editing;
        const text = editor.value;
        editing = null;
        editor.hidden = true;
        if (!cancel && text !== value) setCells([{ row, col, text }]);
    }
    function showCell(at, col) {
        const top = ROW * (at + 1);
        if (top < scroller.scrollTop + ROW) scroller.scrollTop = top - ROW;
        else if (top + ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW - scroller.clientHeight;
        const left = numberWidth + columns.slice(0, col).reduce((sum, column) => sum + column.width, 0);
        const right = left + (columns[col]?.width || 0);
        if (left < scroller.scrollLeft + numberWidth) scroller.scrollLeft = left - numberWidth;
        else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
        drawRows();
    }
    function goTo(at, col, extend = false) {
        const row = Math.max(0, Math.min(view.length - 1, at));
        const column = Math.max(0, Math.min(columns.length - 1, col));
        pick = { a: extend && pick ? pick.a : [row, column], b: [row, column] };
        showCell(row, column);
        paintPick();
    }
    function addRowAtEnd() {
        const target = sheet();
        const width = Math.max(1, columns.length);
        restructure(() => target.rows.push(new Array(width).fill('')), () => target.rows.pop());
    }
    // 写完一格往哪走：Enter 下一行（最后一行再按就加一行），Tab 下一格（到头换行）。
    function leaveCell(rowStep, colStep) {
        if (!editing) return;
        const { at, col } = editing;
        finishEdit();
        let nextCol = col + colStep;
        let nextAt = at + rowStep;
        if (nextCol >= columns.length) { nextCol = 0; nextAt += 1; }
        if (nextCol < 0) { nextCol = columns.length - 1; nextAt -= 1; }
        if (nextAt >= view.length) {
            if (rowStep > 0 && !query && !sort.dir) addRowAtEnd();
            else { nextAt = at; nextCol = col; } // Tab 到表尾停住，不加行
        }
        goTo(nextAt, nextCol);
        scroller.focus({ preventScroll: true });
    }
    editor.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.isComposing) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            finishEdit({ cancel: true });
            scroller.focus({ preventScroll: true });
        } else if (event.key === 'Enter' && event.altKey) {
            event.preventDefault();
            editor.setRangeText('\n', editor.selectionStart, editor.selectionEnd, 'end');
        } else if (event.key === 'Enter') {
            event.preventDefault();
            leaveCell(event.shiftKey ? -1 : 1, 0);
        } else if (event.key === 'Tab') {
            event.preventDefault();
            leaveCell(0, event.shiftKey ? -1 : 1);
        }
    });
    editor.addEventListener('blur', () => finishEdit());
    body.addEventListener('dblclick', (event) => {
        const cell = event.target.closest('.c');
        const row = event.target.closest('.scriptorium-table-row');
        if (cell && row) openEditor(Number(row.dataset.at), Number(cell.dataset.col));
    });
    scroller.addEventListener('keydown', (event) => {
        if (!T || event.target !== scroller || !pick || event.ctrlKey || event.metaKey) return;
        const [at, col] = pick.b;
        const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
        if (moves[event.key]) {
            event.preventDefault();
            goTo(at + moves[event.key][0], col + moves[event.key][1], event.shiftKey);
        } else if (event.key === 'Tab') {
            event.preventDefault();
            goTo(at, col + (event.shiftKey ? -1 : 1));
        } else if (event.key === 'Enter' || event.key === 'F2') {
            event.preventDefault();
            openEditor(at, col);
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            clearPicked();
        } else if (event.key === 'Process' || event.isComposing) {
            openEditor(at, col, ''); // 中文输入法：先把焦点给编辑框，字直接进去
        } else if (event.key.length === 1 && !event.altKey) {
            event.preventDefault();
            openEditor(at, col, event.key);
        }
    });
    function pickedCells(fill) {
        const range = pickRange();
        const list = [];
        for (let at = range.top; at <= range.bottom; at += 1) {
            for (let col = range.left; col <= range.right; col += 1) list.push({ row: realRow(at), col, text: fill });
        }
        return list;
    }
    function clearPicked() {
        if (!pickRange()) return;
        if (!editable()) {
            UI.toast(`这个文件只能看：${T.lockReason}。`);
            return;
        }
        setCells(pickedCells(''));
    }
    // 粘贴：制表符分隔、引号里能有换行（Excel 复制出来的样子）。
    function parseClipboard(text) {
        const rows = [[]];
        let cell = '';
        let quoted = false;
        for (let i = 0; i < text.length; i += 1) {
            const ch = text[i];
            if (quoted) {
                if (ch !== '"') cell += ch;
                else if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
            } else if (ch === '"' && cell === '') quoted = true;
            else if (ch === '\t') { rows[rows.length - 1].push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && text[i + 1] === '\n') i += 1;
                rows[rows.length - 1].push(cell);
                cell = '';
                rows.push([]);
            } else cell += ch;
        }
        if (cell !== '' || rows[rows.length - 1].length) rows[rows.length - 1].push(cell);
        else rows.pop();
        return rows;
    }
    document.addEventListener('paste', (event) => {
        if (!T || work.hidden || !pick || editing || !editable() || event.target?.closest?.('input, textarea')) return;
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return;
        event.preventDefault();
        const block = parseClipboard(text);
        const range = pickRange();
        // 一格的值贴到一片选区：每格都是它。
        if (block.length === 1 && block[0].length === 1) {
            setCells(pickedCells(block[0][0]));
            return;
        }
        const list = [];
        block.forEach((line, y) => line.forEach((value, x) => {
            const at = range.top + y;
            // 贴出了表尾：筛选、排序时不知道该加在哪，到头为止；没筛选时接着往下加行。
            if (at < view.length) list.push({ row: realRow(at), col: range.left + x, text: value });
            else if (!query && !sort.dir) list.push({ row: sheet().rows.length + at - view.length, col: range.left + x, text: value });
        }));
        const grows = list.some(({ row, col }) => row >= sheet().rows.length || col >= columns.length);
        setCells(list);
        if (grows) changed({ structure: true });
    });
    document.addEventListener('cut', (event) => {
        if (!T || work.hidden || !pick || editing || !editable() || event.target?.closest?.('input, textarea')) return;
        event.clipboardData.setData('text/plain', pickText());
        event.preventDefault();
        clearPicked();
    });

    // 右键：.csv / .tsv 能插入、删除行列（.xlsx 动行列会让公式错位，文坊又不算公式，不做）。
    function editItems() {
        if (!editable() || !pickRange()) return [];
        const items = [{ label: '清空', act: clearPicked }];
        if (!T.format) return items;
        const range = pickRange();
        return [...items, { sep: true },
            { label: '在上方插入行', act: () => insertRow(range.top) },
            { label: '在下方插入行', act: () => insertRow(range.bottom + 1) },
            { label: range.bottom > range.top ? `删除选中的 ${range.bottom - range.top + 1} 行` : '删除此行', act: () => deleteRows(range) },
            { sep: true },
            { label: '在左侧插入列', act: () => insertColumn(range.left) },
            { label: '在右侧插入列', act: () => insertColumn(range.right + 1) },
            { label: range.right > range.left ? `删除选中的 ${range.right - range.left + 1} 列` : '删除此列', act: () => deleteColumns(range) }];
    }
    function insertRow(at) {
        const target = sheet();
        const row = at < view.length ? realRow(at) : target.rows.length;
        const width = Math.max(1, columns.length);
        restructure(() => target.rows.splice(row, 0, new Array(width).fill('')), () => target.rows.splice(row, 1));
    }
    function deleteRows(range) {
        const target = sheet();
        const picked = [];
        for (let at = range.top; at <= range.bottom; at += 1) picked.push(realRow(at));
        const removed = picked.sort((a, b) => a - b).map((row) => [row, target.rows[row]]);
        pick = null;
        restructure(() => [...removed].reverse().forEach(([row]) => target.rows.splice(row, 1)),
            () => removed.forEach(([row, cells]) => target.rows.splice(row, 0, cells)));
    }
    function insertColumn(col) {
        const target = sheet();
        restructure(() => target.rows.forEach((row) => { if (row.length >= col) row.splice(col, 0, ''); }),
            () => target.rows.forEach((row) => { if (row.length > col) row.splice(col, 1); }));
    }
    function deleteColumns(range) {
        const target = sheet();
        const count = range.right - range.left + 1;
        const removed = target.rows.map((row) => row.slice(range.left, range.right + 1));
        pick = null;
        restructure(() => target.rows.forEach((row) => row.splice(range.left, count)),
            () => target.rows.forEach((row, index) => row.splice(range.left, 0, ...removed[index])));
    }

    // ---------- 存 ----------
    // Enter 在表尾加出来、没写字的行不写进文件。
    function rowsToWrite(state) {
        const { rows } = state.sheets[0];
        let end = rows.length;
        while (end > state.fileRows && rows[end - 1].every((cell) => cell === '')) end -= 1;
        return rows.slice(0, end);
    }
    const savePayload = (state) => (state.format ? { rows: rowsToWrite(state), format: state.format } : { changes: [...state.changes.values()] });
    async function save({ force = false } = {}) {
        if (!T || !editable()) return true;
        finishEdit();
        if (!T.dirty && !force) return true;
        const target = T;
        const revision = target.revision;
        target.saving = true;
        UI.sync?.();
        let result;
        try {
            result = await api().sheet('save', { path: target.filePath, mtime: target.mtime, force, ...savePayload(target) });
        } catch (error) {
            result = { success: false, error: error.message };
        }
        target.saving = false;
        if (result?.conflict) conflict.hidden = T !== target;
        else if (!result?.success) UI.toast(`未能保存：${result?.error || '写入失败'}`, 'error', 5000);
        else {
            target.mtime = result.mtime;
            target.size = result.size;
            if (target.revision === revision) {
                target.dirty = false;
                target.changes.clear();
            }
            if (T === target) conflict.hidden = true;
            if (!target.format && !target.toldFormulas && target.sheets.some((item) => Object.keys(item.formulas || {}).length)) {
                target.toldFormulas = true;
                UI.toast('已保存。文坊不计算公式，在 Excel 中打开时将重新计算。');
            }
        }
        UI.sync?.();
        return Boolean(result?.success);
    }

    // ---------- 查找（筛行） ----------
    let findTimer = 0;
    findInput.addEventListener('input', () => {
        clearTimeout(findTimer);
        findTimer = setTimeout(() => {
            query = findInput.value.trim();
            rebuild({ scroll: 0 });
        }, 150);
    });
    findInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            findInput.value = '';
            query = '';
            rebuild({ scroll: 0 });
            findInput.blur();
        }
        event.stopPropagation();
    });

    // ---------- “篇章”面板：工作表 ----------
    function outline() {
        if (!T) return;
        sheetList.replaceChildren(...T.sheets.map((item, index) => {
            const row = button('scriptorium-row', '', '', () => setSheet(index));
            row.append(make('span', 'nm', UI.escapeHtml(item.name)), make('small', '', `${Math.max(0, item.rows.length - 1).toLocaleString()} 行`));
            row.setAttribute('aria-current', String(index === sheetIndex));
            return row;
        }));
        UI.setLeftHead({ title: '工作表', count: `${T.sheets.length} 张` });
    }

    // ---------- 外面改了 ----------
    async function checkDisk() {
        if (!T || document.visibilityState === 'hidden') return;
        const state = T;
        let stat;
        try {
            stat = await api().sheet('stat', { path: state.filePath });
        } catch (_) {
            return;
        }
        if (T !== state || !stat || stat.missing) return;
        if (Math.abs(stat.mtime - state.mtime) <= 1 && stat.size === state.size) return;
        if (state.saving) return;
        if (state.dirty) conflict.hidden = false;
        else await reload({ quiet: true });
    }
    setInterval(() => void checkDisk(), 2500);
    UI.on('disk-check', () => void checkDisk());

    // ---------- 快捷键：开着表格时上游的 Ctrl S / Z / Y / F 不落到藏在后面的文稿上 ----------
    window.addEventListener('keydown', (event) => {
        if (!T || work.hidden || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        if (document.querySelector('.scriptorium-dlg-scrim:not([hidden])')) return;
        const key = event.key.toLowerCase();
        const stop = () => { event.preventDefault(); event.stopImmediatePropagation(); };
        if (key === 'f') { stop(); findInput.focus(); findInput.select(); return; }
        if (['z', 'y'].includes(key) && !event.target?.closest?.('input, textarea')) {
            stop();
            if (key === 'y' || event.shiftKey) redo(); else undo();
        }
    }, true);

    UI.on('start', () => {
        session()?.subscribe?.((event) => {
            if (T && event?.type === 'document-replaced' && !UI.replacedByLastOpen()) setTimeout(leave, 0);
        });
    });

    const viewApi = Object.freeze({
        claims: isSheet,
        open,
        route,
        leave,
        save: () => save(),
        reload: () => reload({ discard: true }),
        active: () => Boolean(T),
        // 供 Agent 读取：当前工作表的前 500 行（制表符分隔）与截图范围。
        agent: Object.freeze({
            text: () => {
                const { name, rows } = sheet();
                const shown = rows.slice(0, 500).map((row) => row.join('\t'));
                if (rows.length > shown.length) shown.push(`（其后还有 ${rows.length - shown.length} 行）`);
                return `工作表 ${name}，${rows.length} 行\n${shown.join('\n')}`;
            },
            surface: () => scroller,
        }),
        doc: () => (T ? Object.freeze({ kind: 'table', filePath: T.filePath, name: T.name, generation: T.generation, dirty: T.dirty, saving: T.saving, revision: T.revision, readOnly: !editable() }) : null),
        // 测试用
        _state: () => (T ? { filePath: T.filePath, sheets: T.sheets.map((item) => item.name), sheet: sheetIndex, header, sort: { ...sort },
            rows: view.length, columns: columns.map((column) => ({ ...column })), encoding: T.encoding } : null),
        _do: { setSheet, setQuery: (q) => { findInput.value = q; query = q; rebuild({ scroll: 0 }); }, checkDisk, pickText, editItems, undo, redo },
    });
    window.ScriptoriumTableView = viewApi;
    UI.registerOverlay?.(viewApi);
})();
