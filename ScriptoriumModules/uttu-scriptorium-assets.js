// 往 .md 里粘贴、拖进图片。像 Typora、Obsidian：
// 图片存到这份 .md 旁边的 assets/ 文件夹（没有就建，主进程 modules/uttu/scriptoriumFiles 的 add-asset），文档里插相对链接 ![名字](assets/名字.png)，
// 存回 .md 后在 GitHub、VS Code 里一样显示。原来插图片走工程资源（vdoc-resource://），.md 存不下，保存时报错。
// - 粘贴：粘贴板里有图片（截图）、又没有文字时接住；有文字时照旧粘文字。
// - 拖进来：preloads/docx.js 在编辑栏里接到全是图片的拖放时发 uttu-drop-images（只在编辑 .md 时：页面在 body 上标 data-uttu-md-edit）。
//   图本来就在这份 .md 的文件夹里面时不复制，直接用相对路径。
// 插在哪：焦点在源码编辑器里就插在光标处，否则插在所见编辑面的光标那一段后面。只看预览时不接（没有光标）。
// 文稿工程（.vdocx）不管，照旧走上游的插图片。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const api = () => window.scriptoriumAPI;
    const session = () => window.UTTUScriptoriumSession;
    const isMarkdown = (doc) => doc?.kind !== 'web-page' && /\.(md|markdown)$/i.test(String(doc?.filePath || ''));
    const editing = () => isMarkdown(UI.doc()) && UI.view() !== 'preview';

    function mark() {
        if (editing()) document.body.dataset.uttuMdEdit = '1';
        else delete document.body.dataset.uttuMdEdit;
    }
    UI.on('document', mark);
    UI.on('view', mark);

    // Markdown 里的地址：空格、括号要转义，中文照原样（GitHub、VS Code 都认）。
    const ESCAPE = { ' ': '%20', '(': '%28', ')': '%29', '<': '%3C', '>': '%3E' }; // encodeURIComponent 不转括号
    const urlOf = (rel) => rel.split('/').map((part) => part.replace(/[ ()<>]/g, (c) => ESCAPE[c])).join('/');
    const altOf = (rel) => decodeURIComponent(rel.split('/').pop()).replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
    function insert(rels) {
        const markdown = rels.map((rel) => `![${altOf(rel)}](${urlOf(rel)})`).join('\n\n');
        const editor = session()?.sourceEditor?.();
        const inSource = editor && (UI.editorKind() === 'source' || document.activeElement?.closest?.('.CodeMirror'));
        if (inSource && editor.getWrapperElement?.()?.getClientRects().length) {
            editor.replaceSelection(markdown);
            editor.focus();
            return true;
        }
        return Boolean(session()?.insertMarkdown?.(markdown));
    }
    async function add(payloads) {
        const doc = UI.doc();
        if (!isMarkdown(doc)) return;
        const rels = [];
        for (const payload of payloads) {
            try {
                const result = await api().files('add-asset', { doc: doc.filePath, ...payload });
                if (result?.rel) rels.push(result.rel);
            } catch (error) {
                UI.toast(`图片没插上：${error.message}`, 'error', 5000);
            }
        }
        if (rels.length && !insert(rels)) UI.toast('图片存好了，但没找到光标；切到编辑再试一次。', 'error', 5000);
    }

    window.addEventListener('uttu-drop-images', (event) => {
        let paths = [];
        try { paths = JSON.parse(event.detail || '[]'); } catch (_) { paths = []; }
        if (!editing() || !paths.length) return;
        void add(paths.map((source) => ({ source })));
    });

    document.addEventListener('paste', (event) => {
        if (!editing()) return;
        const data = event.clipboardData;
        const text = data?.getData('text/plain') || '';
        const images = [...(data?.items || [])].filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
        if (!images.length || text.trim()) return;
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
            const payloads = [];
            for (const item of images) {
                const file = item.getAsFile();
                if (file) payloads.push({ bytes: new Uint8Array(await file.arrayBuffer()), type: file.type });
            }
            await add(payloads);
        })();
    }, true);

    // 插入菜单的“图片”：.md 时选本机图片，存到 assets/ 插相对链接；不是 .md 时回 false，交给上游（能插链接、装进工程）。
    function choose() {
        if (!isMarkdown(UI.doc())) return false;
        void api().files('choose-images').then((result) => {
            if (result?.paths?.length) return add(result.paths.map((source) => ({ source })));
            return null;
        }).catch((error) => UI.toast(`没选成：${error.message}`, 'error', 5000));
        return true;
    }

    window.UTTUScriptoriumAssets = Object.freeze({ add, insert, choose });
})();
