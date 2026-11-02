// 文坊的标签。整理知识库用，参照 Obsidian 的标签面板。
// 标签写在文件里（正文 #标签、属性段 tags:），不另存；认法在主进程 markdownFiles/tags.js。
// - 资源管理器里一块“标签”（第一次出现时折着）：工作区和笔记里的全部标签和份数，点一个在下面列出带它的文件，点文件打开。
// - 阅读视图里正文的 #标签 画成小签（只改阅读面的 DOM，源码不动），点了左栏切到资源管理器、在“标签”里选中它。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const { make, button, icon, escapeHtml, session } = UI;
    const api = () => window.scriptoriumAPI;
    const norm = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const isMarkdown = (doc) => doc?.kind !== 'web-page' && /\.(md|markdown)$/i.test(String(doc?.filePath || ''));

    // ---------- 资源管理器里的“标签” ----------
    let state = { tags: null, truncated: false, at: 0, loading: null, selected: '' };
    let section = null;
    function roots() {
        const folder = window.UTTUScriptoriumFolder;
        return [...(folder?.roots?.() || []), folder?.notesPath?.()].filter(Boolean);
    }
    function load(force = false) {
        if (state.loading) return state.loading;
        if (!force && state.tags && Date.now() - state.at < 30000) return Promise.resolve();
        state.loading = Promise.resolve(api()?.markdownFolder?.('tags', { roots: roots() }))
            .then((result) => { state = { ...state, tags: result?.tags || [], truncated: Boolean(result?.truncated), at: Date.now(), error: '' }; })
            .catch((error) => { state = { ...state, tags: [], error: error.message, at: Date.now() }; })
            .finally(() => { state.loading = null; section?.refresh(); });
        return state.loading;
    }
    async function render(body) {
        if (!state.tags) {
            body.replaceChildren(make('p', 'uttu-left-note', '正在找标签'));
            await load();
            return; // load 完会再 refresh
        }
        section.setCount(state.tags.length ? String(state.tags.length) : '');
        if (!state.tags.length) {
            body.replaceChildren(make('p', 'uttu-left-note', state.error ? `没找成：${state.error}`
                : '还没有标签。正文里写 #标签，或者在属性段写 tags: [甲, 乙]，这里就会列出来。'));
            return;
        }
        const chips = make('div', 'uttu-tag-cloud');
        for (const tag of state.tags) {
            const chip = button('uttu-tag-chip', `${tag.name}，${tag.files.length} 份`,
                `<span>#${escapeHtml(tag.name)}</span><small>${tag.files.length}</small>`, () => select(state.selected === tag.name.toLowerCase() ? '' : tag.name));
            chip.setAttribute('aria-pressed', String(state.selected === tag.name.toLowerCase()));
            chips.append(chip);
        }
        const nodes = [chips];
        const picked = state.tags.find((tag) => tag.name.toLowerCase() === state.selected);
        if (picked) {
            const current = UI.doc()?.filePath;
            const files = make('div', 'uttu-tag-files');
            files.append(make('div', 'uttu-folder-grp', `#${escapeHtml(picked.name)}`));
            for (const file of picked.files) {
                const row = button('uttu-row uttu-recent-row', file.rel, `<span class="nm">${escapeHtml(file.rel.split('/').pop())}</span><small>${escapeHtml(file.rel.split('/').slice(0, -1).join(' / '))}</small>`,
                    () => { if (!same(file.path, UI.doc()?.filePath)) void session()?.openPath?.(file.path); if (UI.narrow()) UI.setLeft(false); });
                row.dataset.path = file.path;
                row.dataset.kind = 'file';
                row.setAttribute('aria-current', String(same(file.path, current)));
                files.append(row);
            }
            nodes.push(files);
        }
        if (state.truncated) nodes.push(make('p', 'uttu-left-note', '文件很多，只找了一部分。'));
        body.replaceChildren(...nodes);
    }
    function select(name) {
        state.selected = String(name || '').toLowerCase();
        section?.refresh();
    }
    function install() {
        const explorer = window.UTTUScriptoriumExplorer;
        if (!explorer) return;
        section = explorer.section('tags', {
            title: '标签',
            page: 'notes',
            order: 5,
            collapsed: true,
            render: (body) => void render(body),
        });
    }
    install();
    UI.on('disk-check', () => { state.at = 0; });
    UI.on('doc-event', (event) => { if (event?.type === 'saved') state.at = 0; });
    window.scriptoriumAPI?.onMarkdownEvent?.((event) => { if (event?.type === 'folder-changed') state.at = 0; });

    // ---------- 阅读视图里的 #标签 ----------
    const INLINE = /(^|[\s（(，。；：、“”‘’！？,;:!?])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
    const SKIP = 'code, pre, a, kbd, script, style, textarea, .uttu-tag, .vdoc-island, .katex, table[data-vdoc-frontmatter]';
    let sheet = null;
    function tagify(root) {
        if (!root || !isMarkdown(UI.doc())) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => (node.nodeValue.includes('#') && !node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
        });
        const nodes = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
        for (const node of nodes) {
            const text = node.nodeValue;
            INLINE.lastIndex = 0;
            if (!INLINE.test(text)) continue;
            INLINE.lastIndex = 0; // matchAll 从 lastIndex 接着找，test 之后要归零，不然漏掉第一个
            const fragment = document.createDocumentFragment();
            let cursor = 0;
            for (const match of text.matchAll(INLINE)) {
                const start = match.index + match[1].length;
                if (start > cursor) fragment.append(text.slice(cursor, start));
                const name = match[2].replace(/[/-]+$/, '');
                const link = document.createElement('a');
                link.className = 'uttu-tag';
                link.dataset.uttuTag = name;
                link.setAttribute('role', 'link');
                link.textContent = `#${name}`;
                fragment.append(link);
                cursor = start + 1 + name.length;
            }
            if (cursor < text.length) fragment.append(text.slice(cursor));
            node.replaceWith(fragment);
        }
        if (!sheet && typeof CSSStyleSheet === 'function') {
            sheet = new CSSStyleSheet();
            sheet.replaceSync(`a.uttu-tag { padding: 0 .35em; border-radius: var(--uttu-r-xs, 0); background: color-mix(in srgb, currentColor 10%, transparent);
  color: var(--vdoc-accent, currentColor); text-decoration: none; cursor: pointer; font-size: .92em; }
a.uttu-tag:hover { background: color-mix(in srgb, currentColor 18%, transparent); }`);
        }
        if (sheet && !root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
    let observed = null;
    let timer = 0;
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => tagify(observed), 150); });
    function watch() {
        const root = session()?.readRoot?.();
        if (root && root !== observed) {
            observer.disconnect();
            observer.observe(root, { childList: true, subtree: true });
            observed = root;
        }
        tagify(root);
    }
    UI.on('document', watch);
    UI.on('view', watch);
    document.addEventListener('click', (event) => {
        const tag = event.composedPath().find((node) => node?.classList?.contains?.('uttu-tag'));
        if (!tag) return;
        event.preventDefault();
        event.stopPropagation();
        state.selected = tag.dataset.uttuTag.toLowerCase();
        window.UTTUScriptoriumExplorer?.open?.('tags');
        void load().then(() => section?.refresh());
    }, true);

    window.UTTUScriptoriumTags = Object.freeze({ load: () => load(true), select, state: () => state });
})();
