// 文坊中的文本与代码文件（主进程 modules/scriptorium/viewFiles）。
// .txt 和常见代码文件原位打开、编辑并保存回原文件。语言由扩展名决定（modules/scriptorium/fileTypes.js），
// 代码高亮只在需要时载入对应的 CodeMirror 模式。显示在文档区域的位置上（ScriptoriumFileViews.registerOverlay）；
// 文件被外部修改时自动刷新，两边都修改过时在栏头询问保留哪一边。
(() => {
    'use strict';
    const UI = window.ScriptoriumFileViews;
    const Types = window.ScriptoriumFileTypes;
    if (!UI?.on || !Types) return;
    const { make, button, setText } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.ScriptoriumFileSession;
    const isText = (file) => Types.kindOf(file) === 'text';
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const welcomeShown = () => document.getElementById('welcome-state')?.hidden === false;

    let file = null; // { filePath, name, eol, bom, encoding, mtime, generation, saving, readOnly }
    let generation = 0;
    let clean = 0;
    let editor = null;
    let loading = false;
    const loadedModes = new Map();

    const work = make('div', 'scriptorium-text-work');
    work.hidden = true;
    work.setAttribute('aria-label', '文本');
    const head = make('div', 'scriptorium-pane-head');
    const label = make('span', 'scriptorium-pane-label', '<span></span><small></small>');
    const conflict = make('span', 'scriptorium-file-conflict');
    conflict.hidden = true;
    conflict.append(make('span', '', '文件已在别处修改'),
        button('scriptorium-file-button', '', '使用文件中的版本', () => void reload({ discard: true })),
        button('scriptorium-file-button', '', '保留我的修改', () => void save({ force: true })));
    const foldNote = make('small', 'scriptorium-text-note');
    foldNote.hidden = true;
    head.append(label, foldNote, make('span', 'grow'), conflict);
    const host = make('div', 'scriptorium-pane-body scriptorium-text-source source-editor-shell');
    work.append(head, host);
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(work);

    function ensureEditor() {
        if (editor || !window.CodeMirror) return editor;
        editor = window.CodeMirror(host, { value: '', theme: 'material-darker', lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false,
            autoCloseBrackets: true, viewportMargin: 20 });
        editor.on('change', () => {
            if (loading || !file) return;
            UI.sync?.();
        });
        return editor;
    }
    const dirty = () => Boolean(file && editor && !editor.isClean(clean));
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
    // 刚显示时刷新两次：第一次在下一帧，此时行号栏的偏移有时仍按显示前计算（行号压住每行开头），稍后再刷新一次。
    let refreshTimer = 0;
    const refreshNow = () => { try { editor?.refresh(); } catch (_) { /* 视图隐藏中 */ } };
    const refresh = () => {
        requestAnimationFrame(refreshNow);
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refreshNow, 250);
    };

    // CodeMirror 难以处理单行数百 KB 的文件（例如压成一行的 5 MB JSON，打开需数秒，每输入一个字都会卡顿）。
    // 这类文件展开后只读显示：JSON 格式化，其他按固定宽度折行。文件本身不变。
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
            try { return { text: JSON.stringify(JSON.parse(text), null, 2), note: '单行 JSON 已展开显示，只读' }; } catch (_) { /* 不是有效的 JSON，按折行处理 */ }
        }
        return { text: text.replace(new RegExp(`[^\\n]{${FOLD_AT}}`, 'g'), '$&\n'), note: '含有超长的行，已折行显示，只读' };
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
    // 缩进按文件本身的写法设置（两个空格、四个空格或 Tab）。
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

    // 只载入用到的语言模式（javascript、css、xml 页面已载入）。script 为数组时按顺序载入（PHP 需要先有 htmlmixed 和 clike）。
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
                tag.onerror = resolve; // 载入失败时按纯文本显示，不影响打开
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
        document.body.classList.add('scriptorium-text-mode');
        work.hidden = false;
        setText(label.lastElementChild, { gb18030: 'GB18030', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16' }[file.encoding] || '');
        UI.sync?.();
    }
    function leave() {
        if (!file) return;
        file = null;
        document.body.classList.remove('scriptorium-text-mode');
        work.hidden = true;
        conflict.hidden = true;
        void api()?.view?.('watch', { file: null }).catch(() => {});
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
            UI.toast(`未能打开这个文件：${result?.error || '读取失败'}`, 'error', 5000);
            return false;
        }
        file = { filePath: result.filePath, name: result.name, eol: result.eol, bom: result.bom, encoding: result.encoding, mtime: result.mtime,
            generation: ++generation, saving: false };
        conflict.hidden = true;
        enter();
        showFile(result);
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

    async function save({ force = false } = {}) {
        if (!file || !editor) return false;
        if (!dirty() && !force) return true;
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
            UI.toast(`未能保存：${result?.error || '写入失败'}`, 'error', 5000);
            UI.sync?.();
            return false;
        }
        file.mtime = result.mtime;
        clean = generationAtSave;
        conflict.hidden = true;
        UI.sync?.();
        return true;
    }
    async function reload({ discard = false } = {}) {
        if (!file || (dirty() && !discard)) return;
        const result = await read(file.filePath);
        if (!file || !result?.success) {
            if (result && !result.success) UI.toast(`未能重新读取：${result.error || ''}`, 'error', 5000);
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
        void reload();
    });
    UI.on('disk-check', () => { if (file) void api()?.view?.('check').catch(() => {}); });

    // 打开文本时，撤销、重做不能作用到后面的文稿上（保存由 scriptorium-file-views.js 统一处理）。
    window.addEventListener('keydown', (event) => {
        if (!file || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        if (['z', 'y'].includes(event.key.toLowerCase()) && !work.contains(event.target)) {
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

    const view = Object.freeze({
        claims: isText,
        open,
        route,
        leave,
        save: () => save(),
        reload: () => reload({ discard: true }),
        active: () => Boolean(file),
        // 供 Agent 读取（scriptorium-file-agent.js）：当前内容（含未保存的修改）与截图范围。
        agent: Object.freeze({ text: () => editor?.getValue() ?? '', source: () => editor?.getValue() ?? '', surface: () => work }),
        doc: () => (file ? Object.freeze({ kind: 'text', filePath: file.filePath, name: file.name, generation: file.generation,
            dirty: dirty(), saving: file.saving, readOnly: Boolean(file.readOnly), revision: 0 }) : null),
        _state: () => ({ file: file && { ...file }, dirty: dirty(), language: file ? Types.languageOf(file.filePath).name : '', mode: editor?.getOption('mode') ?? null }),
    });
    window.ScriptoriumTextView = view;
    UI.registerOverlay?.(view);
})();
