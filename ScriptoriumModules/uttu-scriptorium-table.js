// 文坊里看表格。
// .csv / .tsv / .xlsx：第一行当表头（可以关）、点表头排序、查找框筛出含这些字的行、点格子选中、Shift 点选一片、Ctrl C 复制（制表符分隔，
// 贴进 Excel 还是一格一格的）。.xlsx 有几张表，左栏“篇章”就列几张。
// 能改了：双击、Enter、F2 或直接打字进格子，Enter 下一行、Tab 下一格、Esc 不改；方向键走格子，Shift 扩选；
// Delete 清空，Ctrl V 粘贴一片，Ctrl Z / Y 撤销重做，Ctrl S 存（开着自动保存时停手 1.5 秒自动存）。.csv / .tsv 右键能插入、删除行列。
// .xlsx 只改格子的值，样式、合并、别的表都留着；文坊不算公式，Excel 打开时重算。有图表、透视表、宏的工作簿只看不改（主进程 lockReason）。
// 几万行也不卡：只画看得见的那几十行（每行一样高）。外面改了（切回窗口、开着时每 2.5 秒看一眼）就重新读，停在原来那张表、原来的位置。
// 和网页、PDF 一样盖在文稿上面（UI.registerOverlay）。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const { make, button, icon, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.UTTUScriptoriumSession;
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
    const drafts = new Map(); // 路径 → 切走时还没存的 T
    let numberWidth = 44;
    let autosaveTimer = 0;
    let editing = null; // { row, col, at, value }，row 是 rows 里的下标
    const editable = () => Boolean(T) && !T.lockReason;

    // ---------- 搭结构 ----------
    const work = make('div', 'uttu-table-work');
    work.hidden = true;
    work.setAttribute('aria-label', '表格');
    const head = make('div', 'uttu-pane-head uttu-table-head');
    const sheetButton = button('uttu-tb-drop', '', '', () => UI.toggleMenu(sheetButton, () => (T?.sheets || []).map((sheet, index) => ({
        label: sheet.name, check: index === sheetIndex, act: () => setSheet(index),
    }))));
    const info = make('span', 'uttu-table-info');
    const headerToggle = button('uttu-chk uttu-table-headerchk', '', `<span class="box">${icon('i-check')}</span><span>第一行是表头</span>`, () => {
        header = !header;
        sort = { col: -1, dir: 0 };
        rebuild();
    });
    headerToggle.setAttribute('role', 'checkbox');
    const findBox = make('span', 'uttu-pdf-find uttu-table-find');
    const findInput = make('input');
    findInput.type = 'search';
    findInput.placeholder = '筛出含有';
    findInput.setAttribute('aria-label', '只看含有这些字的行');
    const findCount = make('small');
    findBox.append(findInput, findCount);
    const pickStats = make('small', 'uttu-table-stats');
    const openDefault = button('uttu-btn ghost small', '', '用默认程序打开', () => void openWithDefault());
    const conflict = make('span', 'uttu-page-conflict');
    conflict.hidden = true;
    conflict.append(make('span', '', '文件在别处改过了'),
        button('uttu-btn ghost small', '', '用文件里的', () => void reload({ discard: true })),
        button('uttu-btn ghost small', '', '用我改的', () => void save({ force: true })));
    const Pick = window.UTTUScriptoriumPick;
    let picking = false;
    let marks = [];
    const pickTool = Pick.toolSeg('浏览', (mode) => { picking = mode === 'pick'; });
    head.append(sheetButton, info, pickTool, pickStats, make('span', 'grow'), conflict, headerToggle, findBox, openDefault);
    const scroller = make('div', 'uttu-table-scroll');
    scroller.tabIndex = 0;
    scroller.setAttribute('aria-label', '表格内容');
    const sizer = make('div', 'uttu-table-sizer');
    const headRow = make('div', 'uttu-table-row uttu-table-th');
    const body = make('div', 'uttu-table-body');
    const editor = make('textarea', 'uttu-table-editor');
    editor.rows = 1;
    editor.spellcheck = false;
    editor.hidden = true;
    editor.setAttribute('aria-label', '改这一格');
    sizer.append(headRow, body, editor);
    scroller.append(sizer);
    const empty = make('p', 'uttu-left-note uttu-table-empty');
    empty.hidden = true;
    work.append(head, scroller, empty);
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);

    // 左栏“篇章”：工作表列表（CSS 只在开着表格时摆出）。
    const sheetList = make('div', 'uttu-table-sheets');
    document.getElementById('outline-panel')?.append(sheetList);
    document.getElementById('outline-panel')?.append(make('p', 'uttu-left-note uttu-left-table-note', '开着的是表格：在上方的筛选框里找（Ctrl F）。'));

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
            UI.toast(`没打开这个表格：${result?.error || '读不到'}`, 'error', 5000);
            return false;
        }
        await saveBehind();
        remember();
        const back = remembered.get(norm(result.filePath));
        const draft = drafts.get(norm(result.filePath));
        drafts.delete(norm(result.filePath));
        show(draft || result, back || { sheet: 0, header: true, scroll: 0 });
        return true;
    }
    function show(result, place) {
        T = result.changes ? Object.assign(result, { generation: ++generation }) : {
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
        document.body.classList.add('uttu-table-mode');
        work.hidden = false;
        rebuild({ scroll: place.scroll || 0 });
        UI.syncTitle?.();
        UI.sync?.();
        outline();
    }
    function remember() {
        if (T) remembered.set(norm(T.filePath), { sheet: sheetIndex, header, sort, scroll: scroller.scrollTop });
    }
    function leave() {
        if (!T) return;
        finishEdit();
        clearTimeout(autosaveTimer);
        remember();
        if (T.dirty) drafts.set(norm(T.filePath), T);
        T = null;
        pick = null;
        document.body.classList.remove('uttu-table-mode');
        work.hidden = true;
        pickTool.setMode('browse');
        marks = [];
        body.replaceChildren();
        headRow.replaceChildren();
        sheetList.replaceChildren();
        UI.syncTitle?.();
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
    async function saveBehind() {
        if (T || welcomeShown() || !UI.autosaveOn?.()) return;
        const behind = session()?.current?.();
        if (!behind?.filePath || !behind.dirty) return;
        document.getElementById('save-btn')?.click();
        const started = Date.now();
        while (Date.now() - started < 4000 && session()?.current?.()?.dirty) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    async function close() {
        if (!T) return;
        finishEdit();
        if (T.dirty && !await save()) return;
        remembered.delete(norm(T.filePath));
        leave();
        if (session()?.current?.() && !welcomeShown()) document.getElementById('home-btn')?.click();
    }
    async function reload({ quiet = false, discard = false } = {}) {
        if (!T || (T.dirty && !discard)) return;
        const state = T;
        const result = await read(state.filePath);
        if (T !== state) return;
        if (!result?.success) {
            if (!quiet) UI.toast(`没重新读到：${result?.error || ''}`, 'error', 5000);
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
        measureContext.font = `${style.getPropertyValue('--uttu-fs-small').trim() || '12.5px'} ${style.fontFamily}`;
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
        work.style.setProperty('--uttu-table-n', `${numberWidth}px`);
        sizer.style.width = `${numberWidth + total}px`;
        sizer.style.height = `${ROW * (view.length + 1)}px`;
        drawHead();
        const count = widthOf();
        const label = sheet().rows.length ? `${rows.length.toLocaleString()} 行 · ${count} 列` : '这张表是空的';
        setText(info, `${label}${sheet().truncated ? '（太大，只读了前一部分）' : ''}${T.encoding ? ` · ${T.encoding}` : ''}${T.lockReason ? ` · ${T.lockReason}` : ''}`);
        setText(findCount, q ? (view.length ? `${view.length.toLocaleString()} 行` : '没有') : '');
        sheetButton.hidden = T.sheets.length < 2;
        sheetButton.innerHTML = `<span>${UI.escapeHtml(sheet().name)}</span>${icon('i-chevron')}`;
        empty.hidden = Boolean(sheet().rows.length);
        setText(empty, '这张表是空的。');
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
    // 批注记的是文件里的行、列，排序、筛选后还对得上。
    const fileRow = (index) => index + (header ? 2 : 1);
    const isMarked = (index, col) => marks.some(({ locator: spot }) => spot.sheet === sheet().name && fileRow(index) >= spot.top && fileRow(index) <= spot.bottom
        && col >= spot.left && col <= spot.right);
    const colName = (col) => {
        let name = '';
        for (let at = col + 1; at > 0; at = Math.floor((at - 1) / 26)) name = String.fromCharCode(65 + (at - 1) % 26) + name;
        return name;
    };
    Pick.register('table', { paint(list) {
        marks = list.filter((item) => item.state !== 'done' && item.locator?.type === 'cells');
        drawRows(true);
    } });
    function cellsTarget() {
        const range = pickRange();
        if (!range) return null;
        const rows = [fileRow(view[range.top]), fileRow(view[range.bottom])];
        const top = Math.min(...rows);
        const bottom = Math.max(...rows);
        const name = `${colName(range.left)}${top}${top === bottom && range.left === range.right ? '' : `:${colName(range.right)}${bottom}`}`;
        const cells = [...body.querySelectorAll('.c.on')].map((cell) => cell.getBoundingClientRect());
        if (!cells.length) return null;
        const box = { left: Math.min(...cells.map((r) => r.left)), top: Math.min(...cells.map((r) => r.top)), right: Math.max(...cells.map((r) => r.right)), bottom: Math.max(...cells.map((r) => r.bottom)) };
        return { box, target: { type: 'cells', label: `单元格 ${name}`, place: `工作表 ${sheet().name}，${name}`, text: pickText().replace(/\s+/g, ' ').trim().slice(0, 80),
            capture: { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top },
            locator: { type: 'cells', sheet: sheet().name, range: name, top, bottom, left: range.left, right: range.right } } };
    }
    function offerCells() {
        const found = cellsTarget();
        if (!found) return;
        Pick.offer({ ...found.target, capture: undefined }, { left: found.box.right + 6, top: found.box.top - 6, bottom: found.box.top - 6 }); // 放在选区右边，不盖住下面还要点的格子
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
            const row = make('div', 'uttu-table-row');
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
                if (isMarked(index, col)) cell.classList.add('marked');
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
        const row = event.target.closest('.uttu-table-row');
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
        if (picking) requestAnimationFrame(offerCells);
    });
    // 右键：选区里的就引用选区，选区外的引用这一格。
    body.addEventListener('contextmenu', (event) => {
        const cell = event.target.closest('.c');
        const row = event.target.closest('.uttu-table-row');
        if (!cell || !row) return;
        event.preventDefault();
        const at = [Number(row.dataset.at), Number(cell.dataset.col)];
        const range = pickRange();
        if (!range || at[0] < range.top || at[0] > range.bottom || at[1] < range.left || at[1] > range.right) {
            pick = { a: at, b: at };
            paintPick();
        }
        const found = cellsTarget();
        if (found) Pick.menu(found.target, { x: event.clientX, y: event.clientY }, { items: editItems() });
    });
    // 只换选中的样子，不重画（重画会把指针下的格子换掉，拖着选字就断了）。
    function paintPick() {
        const range = pickRange();
        body.querySelectorAll('.uttu-table-row').forEach((row) => {
            const at = Number(row.dataset.at);
            row.querySelectorAll('.c').forEach((cell) => {
                const col = Number(cell.dataset.col);
                cell.classList.toggle('on', Boolean(range) && at >= range.top && at <= range.bottom && col >= range.left && col <= range.right);
            });
        });
        drawn = '';
        paintStats(range);
    }
    // 选中几格时栏头写合计、平均，像 Excel 的状态栏。太大的一片不算。
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
        setText(pickStats, numbers ? `${count} 格 · 合计 ${plain(sum)} · 平均 ${plain(sum / numbers)}` : `${count} 格`);
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
        UI.toast(count > 1 ? `复制了 ${count} 格。` : '复制了。');
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
        scheduleAutosave();
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
        const row = event.target.closest('.uttu-table-row');
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
            { label: '在上面插入一行', act: () => insertRow(range.top) },
            { label: '在下面插入一行', act: () => insertRow(range.bottom + 1) },
            { label: range.bottom > range.top ? `删除这 ${range.bottom - range.top + 1} 行` : '删除这一行', act: () => deleteRows(range) },
            { sep: true },
            { label: '在左边插入一列', act: () => insertColumn(range.left) },
            { label: '在右边插入一列', act: () => insertColumn(range.right + 1) },
            { label: range.right > range.left ? `删除这 ${range.right - range.left + 1} 列` : '删除这一列', act: () => deleteColumns(range) }];
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
    function scheduleAutosave() {
        clearTimeout(autosaveTimer);
        if (!UI.autosaveOn?.()) return;
        autosaveTimer = setTimeout(() => { if (T?.dirty && conflict.hidden && !editing) void save(); }, 1500);
    }
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
        clearTimeout(autosaveTimer);
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
        else if (!result?.success) UI.toast(`没存上：${result?.error || '写不进去'}`, 'error', 5000);
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
                UI.toast('存好了。文坊不算公式，用 Excel 打开时会重算。');
            }
        }
        UI.sync?.();
        return Boolean(result?.success);
    }
    // 关掉没在看的标签：切走时留着的改动存回去。
    async function forget(path) {
        const draft = drafts.get(norm(path));
        if (!draft) return;
        drafts.delete(norm(path));
        try {
            await api().sheet('save', { path: draft.filePath, mtime: draft.mtime, force: true, ...savePayload(draft) });
        } catch (error) {
            UI.toast(`${draft.name} 没存上：${error.message}`, 'error', 5000);
        }
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

    // ---------- 左栏：工作表 ----------
    function outline() {
        if (!T) return;
        sheetList.replaceChildren(...T.sheets.map((item, index) => {
            const row = button('uttu-row', '', '', () => setSheet(index));
            row.append(make('span', 'nm', UI.escapeHtml(item.name)), make('small', '', `${Math.max(0, item.rows.length - 1).toLocaleString()} 行`));
            row.setAttribute('aria-current', String(index === sheetIndex));
            return row;
        }));
        if (document.body.dataset.uttuLeft === 'outline') UI.setLeftHead({ title: '工作表', count: `${T.sheets.length} 张`, tools: [] });
    }
    UI.on('left', ({ open: shown, key } = {}) => { if (shown && key === 'outline' && T) setTimeout(outline, 0); });

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
        if (document.querySelector('.uttu-dlg-scrim:not([hidden])')) return;
        const key = event.key.toLowerCase();
        const stop = () => { event.preventDefault(); event.stopImmediatePropagation(); };
        if (key === 'f') { stop(); findInput.focus(); findInput.select(); return; }
        if (key === 's') { stop(); void save(); return; }
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

    function fileItems({ openNewDialog, open: openFile, importFile }) {
        const has = Boolean(T);
        return [
            { label: '新建', k: 'Ctrl N', act: openNewDialog },
            { label: '打开文件', k: 'Ctrl O', act: openFile },
            { label: '打开文件夹', act: () => window.UTTUScriptoriumFolder?.choose?.() },
            { label: '导入', act: importFile },
            { label: '重新载入', k: 'F5', disabled: !has, act: () => void reload() },
            { label: '用默认程序打开', disabled: !has, act: () => void openWithDefault() },
            { label: '在文件夹里显示', disabled: !has, act: () => void api()?.files?.('reveal', { path: T?.filePath }).catch((error) => UI.toast(error.message, 'error')) },
            { label: '关闭', disabled: !has, act: () => close() },
        ];
    }

    const viewApi = Object.freeze({
        claims: isSheet,
        open,
        route,
        leave,
        close,
        forget,
        save,
        reload: () => reload(),
        fileItems,
        outline,
        active: () => Boolean(T),
        // 给 Agent（uttu-scriptorium-agent.js）：这张表的前 500 行，制表符分隔；后面还有多少写在最后一行。
        agent: Object.freeze({
            text: () => {
                const { name, rows } = sheet();
                const shown = rows.slice(0, 500).map((row) => row.join('\t'));
                if (rows.length > shown.length) shown.push(`（后面还有 ${rows.length - shown.length} 行）`);
                return `工作表 ${name}，${rows.length} 行\n${shown.join('\n')}`;
            },
            surface: () => scroller,
        }),
        doc: () => (T ? Object.freeze({ kind: 'table', filePath: T.filePath, name: T.name, generation: T.generation, dirty: T.dirty, saving: T.saving, revision: T.revision, readOnly: !editable() }) : null),
        // 冒烟用（scripts/smoke-scriptorium-table.cjs）
        _state: () => (T ? { filePath: T.filePath, sheets: T.sheets.map((item) => item.name), sheet: sheetIndex, header, sort: { ...sort },
            rows: view.length, columns: columns.map((column) => ({ ...column })), encoding: T.encoding } : null),
        _do: { setSheet, setQuery: (q) => { findInput.value = q; query = q; rebuild({ scroll: 0 }); }, checkDisk, pickText, editItems, undo, redo },
    });
    window.UTTUScriptoriumTable = viewApi;
    UI.registerOverlay?.(viewApi);
})();
