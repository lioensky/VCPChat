// .md 里的 [[双链]]。
// 阅读视图里 [[名字]]、[[名字|显示的字]]、[[名字#标题]] 画成链接；代码、行内代码、已有的链接里的不算。编辑视图照原文，
// 不改源码：只在阅读面（session.readRoot 的影子根）上把文字换成 <a class="uttu-wiki">，排版重画后再换一遍。
// 链接不带 href，原来管 .md 链接的点击（uttu-scriptorium-markdown.js）不碰它们，这里自己处理：主进程 markdownFiles
// 的 wiki-resolve 在打开的文件夹（没有就是这份文件所在的仓库或文件夹）里按名字找，有 #标题 就打开后跳到那一节；
// 找不到就在链接下面问要不要在当前文件旁边新建（wiki-create），建好直接进编辑视图。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const session = () => window.UTTUScriptoriumSession;
    const api = () => window.scriptoriumAPI;
    const current = () => session()?.current?.() || null;
    const isMarkdown = (doc) => /\.(md|markdown)$/i.test(String(doc?.filePath || ''));
    const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const inside = (target, root) => Boolean(target && root) && (norm(target) === norm(root) || norm(target).startsWith(`${norm(root)}/`));
    const WIKI = /\[\[([^\[\]\n|#]+)(#[^\[\]\n|]*)?(?:\|([^\[\]\n]*))?\]\]/g;
    const SKIP = 'code, pre, a, kbd, script, style, textarea, .uttu-wiki, .vdoc-island, .katex';

    // ---------- 阅读面上把 [[ ]] 换成链接 ----------
    function wikify(root) {
        if (!root || !isMarkdown(current())) return 0;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => (node.nodeValue.includes('[[') && !node.parentElement?.closest(SKIP)
                ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
        });
        const nodes = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
        let made = 0;
        for (const node of nodes) {
            const text = node.nodeValue;
            WIKI.lastIndex = 0;
            if (!WIKI.test(text)) continue;
            WIKI.lastIndex = 0;
            const fragment = document.createDocumentFragment();
            let cursor = 0;
            for (const match of text.matchAll(WIKI)) {
                if (match.index > cursor) fragment.append(text.slice(cursor, match.index));
                const name = match[1].trim();
                const heading = (match[2] || '').slice(1).trim();
                const link = document.createElement('a');
                link.className = 'uttu-wiki';
                link.dataset.uttuWiki = name;
                if (heading) link.dataset.uttuHeading = heading;
                link.setAttribute('role', 'link');
                link.tabIndex = 0;
                link.textContent = (match[3] || '').trim() || (heading ? `${name} › ${heading}` : name);
                fragment.append(link);
                cursor = match.index + match[0].length;
                made += 1;
            }
            if (cursor < text.length) fragment.append(text.slice(cursor));
            node.replaceWith(fragment);
        }
        return made;
    }

    // 阅读面重画（打开、外部改动、整篇排好）后再换一遍；同一帧里合成一次。
    let observed = null;
    let observer = null;
    let frame = 0;
    const schedule = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; wikify(session()?.readRoot?.()); });
    };
    function watch() {
        const root = session()?.readRoot?.();
        if (!root) return;
        if (root === observed) { schedule(); return; }
        observer?.disconnect();
        observed = root;
        observer = new MutationObserver(schedule);
        observer.observe(root, { childList: true, subtree: true });
        schedule();
    }
    // 打开后除了看着变化，再补两次：同一份重新载入时阅读面可能整块换掉，看着的还是旧的那份。
    UI.on('document', () => { for (const delay of [0, 300, 1000]) setTimeout(watch, delay); });

    // ---------- 点链接 ----------
    function folderRoot(doc) {
        const folder = window.UTTUScriptoriumFolder?.current?.();
        return folder && inside(doc?.filePath, folder) ? folder : undefined;
    }
    async function waitFor(path) {
        const started = Date.now();
        while (Date.now() - started < 8000) {
            if (norm(current()?.filePath) === norm(path) && session()?.readRoot?.()?.querySelector('.vdoc-runtime')?.childElementCount) return true;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return false;
    }
    const slug = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
    // 跳过去以后整篇可能还在排（第一屏之后、图片撑开），停稳前再对几次。
    async function revealHeading(heading) {
        const find = () => [...(session()?.readRoot?.()?.querySelectorAll('h1, h2, h3, h4, h5, h6') || [])]
            .find((node) => node.textContent.trim() === heading || slug(node.textContent) === slug(heading));
        if (!find()) { UI.toast?.(`那份文件里没有“${heading}”这一节。`); return; }
        const host = document.getElementById('read-host');
        for (let round = 0; round < 6; round += 1) {
            const target = find();
            if (!target) return;
            const offset = host ? target.getBoundingClientRect().top - host.getBoundingClientRect().top : 0;
            if (round > 0 && Math.abs(offset) < 24) return;
            target.scrollIntoView({ block: 'start' });
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    async function follow(link) {
        const doc = current();
        if (!doc?.filePath) return;
        const name = link.dataset.uttuWiki;
        const heading = link.dataset.uttuHeading || '';
        let result;
        try {
            result = await api()?.markdownFolder?.('wiki-resolve', { name, from: doc.filePath, root: folderRoot(doc) });
        } catch (error) {
            UI.toast?.(`找不到这份：${error.message}`);
            return;
        }
        if (result?.path) {
            if (norm(result.path) !== norm(doc.filePath)) {
                void session()?.openPath?.(result.path);
                if (!await waitFor(result.path)) return;
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            if (heading) await revealHeading(heading);
            return;
        }
        if (!result?.suggest) { UI.toast?.(`没有“${name}”这一份。`); return; }
        const fileName = result.suggest.split(/[\\/]/).pop();
        UI.openMenu?.([
            { label: `新建 ${fileName}（在这份文件旁边）`, act: () => void createAndOpen(name, doc.filePath) },
            { label: '算了', act: () => UI.closeMenu?.() },
        ], link);
    }
    async function createAndOpen(name, from) {
        UI.closeMenu?.();
        try {
            const made = await api()?.markdownFolder?.('wiki-create', { name, from });
            const opener = window.UTTUScriptoriumMarkdown?.openForWriting;
            if (opener) opener(made.path); else void session()?.openPath?.(made.path);
        } catch (error) {
            UI.toast?.(/EEXIST|exist/i.test(error.message) ? '旁边已经有同名的文件了。' : `没建成：${error.message}`);
        }
    }
    document.addEventListener('click', (event) => {
        if (event.button !== 0 || !isMarkdown(current())) return;
        const link = event.composedPath().find((node) => node?.classList?.contains?.('uttu-wiki'));
        if (!link) return;
        event.preventDefault();
        event.stopPropagation();
        void follow(link);
    }, true);
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        const link = event.composedPath().find((node) => node?.classList?.contains?.('uttu-wiki'));
        if (!link) return;
        event.preventDefault();
        void follow(link);
    }, true);

    window.UTTUScriptoriumWiki = Object.freeze({ wikify, follow });
})();
