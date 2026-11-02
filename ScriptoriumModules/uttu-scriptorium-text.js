// 文坊里的文本和代码文件。主进程 modules/uttu/viewFiles。
// .txt 和常见代码文件就地打开、改、存回原文件。语言跟着扩展名走（modules/uttu/scriptoriumTypes.js），不让人手选；
// 代码高亮只在要用时载入对应的 CodeMirror 模式。和网页一样盖在文稿上面（UI.registerOverlay），自动保存、外面改了自己刷新、
// 两边都改了在栏头问用哪份，切走时没存的修改留在内存里。这里不做语言服务和调试：工程级开发是 VS Code 和 Agent 的事。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    const Types = window.UTTUScriptoriumTypes;
    if (!UI?.on || !Types) return;
    const { make, button, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.UTTUScriptoriumSession;
    const isText = (file) => Types.kindOf(file) === 'text';
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;

    let file = null; // { filePath, name, eol, bom, mtime, generation, saving }
    let generation = 0;
    let clean = 0;
    let editor = null;
    let loading = false;
    let autosaveTimer = 0;
    const drafts = new Map();
    const loadedModes = new Map();

    const work = make('div', 'uttu-text-work');
    work.hidden = true;
    work.setAttribute('aria-label', '文本');
    const head = make('div', 'uttu-pane-head');
    const label = make('span', 'uttu-pane-label', '<span></span><small></small>');
    const conflict = make('span', 'uttu-page-conflict');
    conflict.hidden = true;
    conflict.append(make('span', '', '文件在别处改过了'),
        button('uttu-btn ghost small', '', '用文件里的', () => void reload({ discard: true })),
        button('uttu-btn ghost small', '', '用我改的', () => void save({ force: true })));
    const Pick = window.UTTUScriptoriumPick;
    let picking = false;
    const pickTool = Pick.toolSeg('编辑', (mode) => { picking = mode === 'pick'; });
    const foldNote = make('small', 'uttu-text-note');
    foldNote.hidden = true;
    head.append(label, pickTool, foldNote, make('span', 'grow'), conflict);
    const host = make('div', 'uttu-pane-body uttu-text-source');
    work.append(head, host);
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);

    function ensureEditor() {
        if (editor || !window.CodeMirror) return editor;
        editor = window.CodeMirror(host, { value: '', theme: 'uttu-code', lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false,
            autoCloseBrackets: true, viewportMargin: 20 });
        editor.on('change', () => {
            if (loading || !file) return;
            UI.sync?.();
            scheduleAutosave();
        });
        return editor;
    }
    const dirty = () => Boolean(file && editor && !editor.isClean(clean));
    // 批注：工具切到“批注”后选中一段，出浮条。
    host.addEventListener('mouseup', () => setTimeout(() => {
        if (!picking || !editor?.somethingSelected()) return;
        const quote = editor.getSelection();
        const from = editor.getCursor('from');
        const to = editor.getCursor('to');
        const lines = from.line === to.line ? `第 ${from.line + 1} 行` : `第 ${from.line + 1}–${to.line + 1} 行`;
        const end = editor.cursorCoords(to, 'window');
        Pick.offer({ type: 'text', label: lines, place: lines, text: quote.replace(/\s+/g, ' ').trim().slice(0, 80),
            locator: { type: 'text', quote: quote.slice(0, 400), startLine: from.line + 1, endLine: to.line + 1 } }, { left: end.left, top: end.top, bottom: end.bottom });
    }, 0));
    // 右键：有选中的引用选中的，没有就引用这一行。
    host.addEventListener('contextmenu', (event) => {
        if (!editor || !file) return;
        event.preventDefault();
        const hit = editor.coordsChar({ left: event.clientX, top: event.clientY }, 'window');
        const from = editor.somethingSelected() ? editor.getCursor('from') : hit;
        const to = editor.somethingSelected() ? editor.getCursor('to') : hit;
        const quote = editor.somethingSelected() ? editor.getSelection() : editor.getLine(hit.line);
        const lines = from.line === to.line ? `第 ${from.line + 1} 行` : `第 ${from.line + 1}–${to.line + 1} 行`;
        const start = editor.charCoords({ line: from.line, ch: 0 }, 'window');
        const end = editor.charCoords({ line: to.line, ch: 0 }, 'window');
        const box = host.getBoundingClientRect();
        Pick.menu({ type: 'text', label: lines, place: lines, text: quote.replace(/\s+/g, ' ').trim().slice(0, 80),
            locator: { type: 'text', quote: quote.slice(0, 400), startLine: from.line + 1, endLine: to.line + 1 },
            capture: { x: box.left, y: start.top, width: box.width, height: end.bottom - start.top } }, { x: event.clientX, y: event.clientY });
    }, true);
    let lineMarks = [];
    Pick.register('text', { paint(list) {
        if (!editor) return;
        lineMarks.forEach((line) => editor.removeLineClass(line, 'background', 'uttu-pick-line'));
        lineMarks = [];
        for (const item of list) {
            if (item.state === 'done' || !item.locator?.startLine) continue;
            for (let line = item.locator.startLine - 1; line < item.locator.endLine; line += 1) {
                lineMarks.push(editor.addLineClass(line, 'background', 'uttu-pick-line'));
            }
        }
    } });
    function setSource(text, { keepView = false } = {}) {
        const cm = ensureEditor();
        if (!cm) return;
        const cursor = keepView ? cm.getCursor() : null;
        const scroll = keepView ? cm.getScrollInfo() : null;
        loading = true;
        cm.setValue(text);
        cm.clearHistory();
        loading = false;
        clean = cm.changeGeneration();
        if (cursor) cm.setCursor(cursor);
        if (scroll) cm.scrollTo(scroll.left, scroll.top);
    }
    const refresh = () => requestAnimationFrame(() => { try { editor?.refresh(); } catch (_) { /* 藏着 */ } });

    // CodeMirror 排不动一行几百 KB 的文件：压在一行的 5 MB JSON 打开卡 2 秒，打一个字卡 1 秒。30 MB 的普通文件没事，慢的只是长行。
    // 这种文件展开显示，只看不改：JSON 格式化，别的按固定宽度折开。文件本身不动。
    const LONG_LINE = 200000;
    const FOLD_AT = 2000;
    function hasLongLine(text) {
        for (let at = 0; at < text.length;) {
            const next = text.indexOf('\n', at);
            const end = next < 0 ? text.length : next;
            if (end - at >= LONG_LINE) return true;
            at = end + 1;
        }
        return false;
    }
    function unfolded(text, path) {
        if (!hasLongLine(text)) return null;
        if (/\.json$/i.test(path)) {
            try { return { text: JSON.stringify(JSON.parse(text), null, 2), note: '压成一行的 JSON，已展开显示，只读' }; } catch (_) { /* 不是合法的 JSON，按折行来 */ }
        }
        return { text: text.replace(new RegExp(`[^\\n]{${FOLD_AT}}`, 'g'), '$&\n'), note: '有很长的行，已折开显示，只读' };
    }
    function showFile(result) {
        const shown = unfolded(result.text, result.filePath);
        file.readOnly = Boolean(shown);
        setText(foldNote, shown?.note || '');
        foldNote.hidden = !shown;
        setSource(shown?.text ?? result.text, { keepView: false });
        editor?.setOption('readOnly', Boolean(shown));
        if (!shown) detectIndent();
    }
    // 缩进跟着文件走，原来一律四个空格，两个空格的 JS、用 Tab 的文件回车后缩进就乱了。
    function detectIndent() {
        if (!editor) return;
        let tabs = 0;
        let twos = 0;
        let fours = 0;
        for (let line = 0, last = Math.min(editor.lineCount(), 400); line < last; line += 1) {
            const lead = /^(\t+| +)\S/.exec(editor.getLine(line))?.[1];
            if (!lead) continue;
            if (lead[0] === '\t') tabs += 1;
            else if (lead.length % 4 === 2) twos += 1;
            else if (lead.length % 4 === 0) fours += 1;
        }
        const useTabs = tabs > twos + fours;
        const unit = !useTabs && twos * 3 >= fours && twos > 0 ? 2 : 4;
        editor.setOption('indentWithTabs', useTabs);
        editor.setOption('indentUnit', unit);
        editor.setOption('tabSize', unit);
    }

    // 只载入用到的语言；javascript、css、xml 页面本来就有。script 是数组时按顺序载（PHP 要先有 htmlmixed 和 clike）。
    async function loadMode(script) {
        if (Array.isArray(script)) {
            for (const item of script) await loadMode(item);
            return;
        }
        if (!script || window.CodeMirror?.modes?.[script]) return;
        if (!loadedModes.has(script)) {
            loadedModes.set(script, new Promise((resolve) => {
                const tag = document.createElement('script');
                tag.src = `../node_modules/codemirror/mode/${script}/${script}.js`;
                tag.onload = resolve;
                tag.onerror = resolve; // 载不到就当纯文本，不挡打开
                document.head.append(tag);
            }));
        }
        return loadedModes.get(script);
    }
    async function applyLanguage(path) {
        const language = Types.languageOf(path);
        setText(label.firstElementChild, language.name);
        editor?.setOption('lineWrapping', !language.script);
        await loadMode(language.script);
        if (file && same(file.filePath, path)) editor?.setOption('mode', language.mode);
    }

    function enter() {
        document.body.classList.add('uttu-text-mode');
        work.hidden = false;
        setText(label.lastElementChild, { gb18030: 'GB18030', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16' }[file.encoding] || '');
        UI.syncTitle?.();
    }
    function stash() {
        if (!file || !dirty()) return;
        drafts.set(norm(file.filePath), { text: editor.getValue(), mtime: file.mtime, eol: file.eol, bom: file.bom, encoding: file.encoding });
    }
    function leave() {
        if (!file) return;
        clearTimeout(autosaveTimer);
        stash();
        file = null;
        document.body.classList.remove('uttu-text-mode');
        work.hidden = true;
        pickTool.setMode('browse');
        lineMarks = [];
        conflict.hidden = true;
        void api()?.view?.('watch', { file: null }).catch(() => {});
        UI.syncTitle?.();
        UI.sync?.();
    }
    async function read(path) {
        try {
            return await api().view('read', { file: path });
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    async function open(path) {
        if (!isText(path)) return false;
        if (file && same(file.filePath, path)) return true;
        const result = await read(path);
        if (!result?.success) {
            UI.toast(`没打开这个文件：${result?.error || '读不到'}`, 'error', 5000);
            return false;
        }
        await saveBehind();
        clearTimeout(autosaveTimer);
        stash();
        const draft = drafts.get(norm(result.filePath));
        drafts.delete(norm(result.filePath));
        file = { filePath: result.filePath, name: result.name, eol: result.eol, bom: result.bom, encoding: result.encoding, mtime: result.mtime,
            generation: ++generation, saving: false };
        conflict.hidden = true;
        enter();
        showFile(result);
        if (draft) {
            loading = true;
            editor?.setValue(draft.text);
            loading = false;
            if (Math.abs(draft.mtime - result.mtime) > 1) conflict.hidden = false;
        }
        await applyLanguage(result.filePath);
        void api().view('watch', { file: result.filePath }).catch(() => {});
        UI.sync?.();
        refresh();
        return true;
    }
    function route(path) {
        if (isText(path)) return open(path);
        if (!file) return null;
        const behind = session()?.current?.();
        leave();
        const stale = /\.(md|markdown)$/i.test(String(path)) && !behind?.dirty;
        if (behind && !welcomeShown() && same(behind.filePath, path) && !stale) return Promise.resolve(true);
        return null;
    }
    async function saveBehind() {
        if (file || welcomeShown() || !UI.autosaveOn?.()) return;
        const behind = session()?.current?.();
        if (!behind?.filePath || !behind.dirty) return;
        document.getElementById('save-btn')?.click();
        const started = Date.now();
        while (Date.now() - started < 4000 && session()?.current?.()?.dirty) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    async function close() {
        if (!file) return;
        if (dirty() && !await save()) return;
        leave();
        if (session()?.current?.() && !welcomeShown()) document.getElementById('home-btn')?.click();
    }
    async function forget(path) {
        const draft = drafts.get(norm(path));
        if (!draft) return;
        drafts.delete(norm(path));
        try {
            await api().view('save', { file: path, text: draft.text, mtime: draft.mtime, eol: draft.eol, bom: draft.bom, encoding: draft.encoding, force: true });
        } catch (error) {
            UI.toast(`${path.split(/[\\/]/).pop()} 没存上：${error.message}`, 'error', 5000);
        }
    }

    async function save({ force = false } = {}) {
        if (!file || !editor) return false;
        if (!dirty() && !force) return true;
        clearTimeout(autosaveTimer);
        const target = file;
        const text = editor.getValue();
        const generationAtSave = editor.changeGeneration();
        target.saving = true;
        UI.sync?.();
        let result;
        try {
            result = await api().view('save', { file: target.filePath, text, mtime: target.mtime, eol: target.eol, bom: target.bom, encoding: target.encoding, force });
        } catch (error) {
            result = { success: false, error: error.message };
        }
        target.saving = false;
        if (file !== target) return Boolean(result?.success);
        if (result?.conflict) {
            conflict.hidden = false;
            UI.sync?.();
            return false;
        }
        if (!result?.success) {
            UI.toast(`没存上：${result?.error || '写不进去'}`, 'error', 5000);
            UI.sync?.();
            return false;
        }
        file.mtime = result.mtime;
        clean = generationAtSave;
        conflict.hidden = true;
        UI.sync?.();
        return true;
    }
    function scheduleAutosave() {
        clearTimeout(autosaveTimer);
        if (!UI.autosaveOn?.()) return;
        autosaveTimer = setTimeout(() => { if (dirty() && conflict.hidden) void save(); }, 1500);
    }
    async function reload({ discard = false } = {}) {
        if (!file || (dirty() && !discard)) return;
        const result = await read(file.filePath);
        if (!file || !result?.success) {
            if (result && !result.success) UI.toast(`没重新读到：${result.error || ''}`, 'error', 5000);
            return;
        }
        Object.assign(file, { mtime: result.mtime, eol: result.eol, bom: result.bom, encoding: result.encoding });
        conflict.hidden = true;
        if (file.readOnly || hasLongLine(result.text)) showFile(result);
        else setSource(result.text, { keepView: true });
        UI.sync?.();
    }
    api()?.onViewChanged?.((payload) => {
        if (!file || !same(payload?.file, file.filePath) || Math.abs(Number(payload.mtime) - file.mtime) <= 1) return;
        if (dirty()) {
            conflict.hidden = false;
            return;
        }
        const path = file.filePath;
        const before = editor?.getValue() ?? '';
        void reload().then(() => {
            const after = editor?.getValue() ?? '';
            void api().view('history-add', { file: path, before, after }).then(() => UI.emit('view-file-changed'));
        });
    });

    // 开着文本时上游的 Ctrl S / Z / Y 不能落到藏在后面的文稿上。
    window.addEventListener('keydown', (event) => {
        if (!file || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === 's') {
            event.preventDefault();
            event.stopImmediatePropagation();
            void save();
        } else if (['z', 'y'].includes(key) && !work.contains(event.target)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    work.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) event.stopPropagation();
    });
    if (window.ResizeObserver) new ResizeObserver(() => { if (file) refresh(); }).observe(host);

    UI.on('start', () => {
        session()?.subscribe?.((event) => {
            if (file && event?.type === 'document-replaced' && !UI.replacedByLastOpen()) setTimeout(leave, 0);
        });
    });

    function fileItems({ openNewDialog, open: openFile }) {
        const has = Boolean(file);
        return [
            { label: '新建', k: 'Ctrl N', act: openNewDialog },
            { label: '打开文件', k: 'Ctrl O', act: openFile },
            { label: '打开文件夹', act: () => window.UTTUScriptoriumFolder?.choose?.() },
            { sep: true },
            { label: '保存', k: 'Ctrl S', disabled: !has || !dirty(), act: () => void save() },
            { label: '重新载入', k: 'F5', hint: dirty() ? '放弃没存的修改' : '', disabled: !has,
                act: () => {
                    const shared = window.UTTUScriptoriumMarkdown?.reloadFromDisk;
                    if (shared) shared(); else void reload({ discard: true });
                } },
            { label: '在文件夹里显示', disabled: !has, act: () => void api()?.files?.('reveal', { path: file?.filePath }).catch(() => {}) },
            { label: '关闭', disabled: !has, act: () => void close() },
        ];
    }

    const view = Object.freeze({
        claims: isText,
        open,
        route,
        leave,
        close,
        forget,
        save: () => save(),
        reload: () => reload({ discard: true }),
        fileItems,
        active: () => Boolean(file),
        find: Object.freeze({ editor: () => editor }), // 左栏“查找”（uttu-scriptorium-panels.js）
        agent: Object.freeze({ text: () => editor?.getValue() ?? '', source: () => editor?.getValue() ?? '', surface: () => work }),
        doc: () => (file ? Object.freeze({ kind: 'text', filePath: file.filePath, name: file.name, generation: file.generation,
            dirty: dirty(), saving: file.saving, readOnly: Boolean(file.readOnly), revision: 0 }) : null),
        _state: () => ({ file: file && { ...file }, dirty: dirty(), language: file ? Types.languageOf(file.filePath).name : '', mode: editor?.getOption('mode') ?? null }),
    });
    window.UTTUScriptoriumText = view;
    UI.registerOverlay?.(view);
})();
