// 写 .md 时的链接补全。参照 Obsidian 打 [[ 出文件列表、VS Code 打 ]( 补路径：
// - 打出 [[ ：弹出 Ctrl P 那个框选文件（uttu-scriptorium-quickopen.js 的 pickFile），选好插“文件名]]”（.md 不写扩展名，和双链一样）；
// - 打出 ]( ：选好插相对这份 .md 的路径和右括号（空格、括号转义）；Esc 不选就什么都不插，接着打字。
// - 源码、所见两个编辑面都管（所见 ）；中文输入法打出来的【【和】（一样，选好换成半角。
// - 插入菜单（空行打 /）的“链接到文件”：所见、源码都能用，插一段 [文件名](相对路径)。
// 只在 .md 里管；文稿工程没有“所在文件夹”，相对路径没意义。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const session = () => window.UTTUScriptoriumSession;
    const isMarkdown = (doc) => doc?.kind !== 'web-page' && /\.(md|markdown)$/i.test(String(doc?.filePath || ''));
    const ESCAPE = { ' ': '%20', '(': '%28', ')': '%29', '<': '%3C', '>': '%3E' };
    const parts = (file) => String(file || '').replace(/\\/g, '/').split('/').filter(Boolean);

    // 从这份 .md 所在的文件夹到 target 的相对路径（/ 分隔）；不在同一个盘上就给 file:/// 绝对地址。
    function relativeTo(fromFile, target) {
        const from = parts(fromFile).slice(0, -1);
        const to = parts(target);
        if (!from.length || !to.length || from[0].toLowerCase() !== to[0].toLowerCase()) {
            return `file:///${to.join('/')}`;
        }
        let common = 0;
        while (common < from.length && common < to.length - 1 && from[common].toLowerCase() === to[common].toLowerCase()) common += 1;
        return [...Array(from.length - common).fill('..'), ...to.slice(common)].join('/');
    }
    const urlOf = (rel) => rel.split('/').map((part) => part.replace(/[ ()<>]/g, (c) => ESCAPE[c])).join('/');
    const titleOf = (file) => parts(file).pop().replace(/\.(md|markdown)$/i, '');
    const TRIGGERS = { '[[': '[[', '【【': '[[', '](': '](', '】（': '](' };
    const placeholderOf = (wiki) => (wiki ? '链到哪份文件（双链）' : '链到哪份文件（相对路径）');
    // 后面已经有右括号（自动补的，或在改一条旧链接）：只插名字，光标跳过它。
    function linkTail(doc, path, wiki, after) {
        const close = wiki ? ']]' : ')';
        const closed = after.startsWith(close);
        return {
            text: (wiki ? titleOf(path) : urlOf(relativeTo(doc.filePath, path))) + (closed ? '' : close),
            skip: closed ? close.length : 0,
        };
    }

    async function choose(placeholder) {
        if (!UI.pickFile) return null;
        return UI.pickFile({ placeholder });
    }

    // 源码编辑器：打出 [[ 或 ]( 就问。
    const bound = new WeakSet();
    let asking = false;
    function bind() {
        const editor = session()?.sourceEditor?.();
        if (!editor || bound.has(editor)) return;
        bound.add(editor);
        // 用 change 不用 inputRead：自动补括号的插件按键时直接改文字，不走输入事件（打 [ 变成 []，光标在中间）。
        editor.on('change', (cm, change) => {
            const doc = UI.doc();
            const typed = (change.text || []).join('\n');
            if (!isMarkdown(doc) || !['[', '[]', '(', '()', '【', '（'].includes(typed) || ['setValue', 'undo', 'redo'].includes(change.origin)) return;
            if (asking) return;
            const cursor = cm.getCursor();
            const before = cm.getRange({ line: cursor.line, ch: Math.max(0, cursor.ch - 2) }, cursor);
            const trigger = TRIGGERS[before];
            if (!trigger) return;
            const wiki = trigger === '[[';
            asking = true;
            void choose(placeholderOf(wiki)).then((item) => {
                asking = false;
                cm.focus();
                if (!item?.path) return;
                const at = cm.getCursor();
                if (before !== trigger) cm.replaceRange(trigger, { line: at.line, ch: at.ch - 2 }, at);
                const after = cm.getRange(cm.getCursor(), { line: cm.getCursor().line, ch: cm.getCursor().ch + 2 });
                const { text, skip } = linkTail(doc, item.path, wiki, after);
                cm.replaceSelection(text);
                const end = cm.getCursor();
                cm.setCursor({ line: end.line, ch: end.ch + skip });
            }, () => { asking = false; });
        });
    }
    UI.on('view', bind);
    UI.on('document', bind);
    // 源码编辑器是切到源码时才建的（建好时不一定有 view 事件）：焦点进来时再挂一次。
    document.addEventListener('focusin', (event) => { if (event.target?.closest?.('.CodeMirror')) bind(); }, true);

    // 所见编辑面：编辑中的那一段就是 Markdown 原文，打的字直接进源码。选文件时焦点离开、这一段收起，所以选好后改源码，再把光标放回去。
    function checkTyped() {
        const doc = UI.doc();
        const root = session()?.editRoot?.();
        if (asking || !root || !isMarkdown(doc) || UI.editorKind() !== 'wysiwyg' || UI.view() === 'preview') return;
        const selection = root.getSelection?.() || document.getSelection();
        const node = selection?.anchorNode;
        if (!selection?.isCollapsed || node?.nodeType !== Node.TEXT_NODE || !root.contains(node) || node.parentElement?.closest('pre')) return;
        const before = node.textContent.slice(Math.max(0, selection.anchorOffset - 2), selection.anchorOffset);
        const trigger = TRIGGERS[before];
        if (!trigger) return;
        const wiki = trigger === '[[';
        const offset = Number(session().insertionOffset());
        if (!Number.isFinite(offset)) return;
        asking = true;
        void choose(placeholderOf(wiki)).then((item) => {
            asking = false;
            const api = session();
            const source = api?.source?.();
            if (UI.doc()?.filePath !== doc.filePath || typeof source !== 'string') return;
            if (!item?.path || source.slice(offset - 2, offset) !== before) {
                api.focusOffset(offset);
                return;
            }
            const { text, skip } = linkTail(doc, item.path, wiki, source.slice(offset, offset + 2));
            const head = `${source.slice(0, offset - 2)}${trigger}${text}`;
            api.replaceSource(`${head}${source.slice(offset)}`, 'uttu-link');
            api.focusOffset(head.length + skip);
        }, () => { asking = false; });
    }
    // 这两个事件在捕获阶段先到这里：等上游处理完这一下，再让选文件框抢焦点。
    document.addEventListener('input', (event) => {
        if (event.inputType === 'insertText' && !event.isComposing) setTimeout(checkTyped);
    }, true);
    document.addEventListener('compositionend', () => setTimeout(checkTyped), true);

    // 链接浮条的“选文件”：给相对这份 .md 的地址。
    async function pickUrl() {
        const doc = UI.doc();
        if (!isMarkdown(doc)) return null;
        const item = await choose('链到哪份文件');
        return item?.path ? urlOf(relativeTo(doc.filePath, item.path)) : null;
    }

    // 插入菜单的“链接到文件”。
    async function insertLink(replaceBefore = '') {
        const doc = UI.doc();
        if (!isMarkdown(doc)) {
            UI.toast('只有 .md 能链到别的文件（相对路径要有所在的文件夹）。', 'error', 4000);
            return;
        }
        const editor = session()?.sourceEditor?.();
        const inSource = UI.editorKind() === 'source' && editor;
        const item = await choose('链到哪份文件');
        if (!item?.path) return;
        const markdown = `[${titleOf(item.path)}](${urlOf(relativeTo(doc.filePath, item.path))})`;
        if (inSource) {
            editor.replaceSelection(markdown);
            editor.focus();
        } else {
            session()?.insertMarkdown?.(markdown, replaceBefore ? { replaceBefore } : {});
        }
    }

    window.UTTUScriptoriumLinkPick = Object.freeze({ insertLink, relativeTo, pickUrl, isMarkdown });
})();
