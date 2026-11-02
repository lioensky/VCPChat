// 文坊的展示。都只动 .md 的阅读视图，源码不变：
// - 提示块：`> [!NOTE] 标题`（GitHub 写法：NOTE TIP IMPORTANT WARNING CAUTION；Obsidian 的 info、success、question、danger、example、quote 这些也认）
//   画成带标题和左边色条的块；`[!TIP]-` 折着、`[!TIP]+` 展开但能折，点标题开合。普通引用不动。
// - 图片放大：阅读视图里点图片，盖满窗口看（按比例放到最大），再点一下或 Esc 收起。链接里的图片照常当链接。
// - 放映：.md 用 `---`（分隔线）分页，没有分隔线就按二级标题分；盖满窗口一页一页放，→ 空格 PageDown 下一页，← PageUp 上一页，
//   Home End 第一页最后一页，Esc 退出。页面照这份文档的样式（把阅读视图影子根里的样式表搬过来），内容放不下就整页缩小。
//   独立窗口时顺便全屏；停在主窗口右栏时只盖满右栏。从文件菜单、命令面板开（文件菜单一行钩子在 uttu-scriptorium.js）。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const { make, setText } = UI;
    const session = () => window.UTTUScriptoriumSession;
    const isMarkdown = (doc) => Boolean(doc?.markdownFile) || /\.(md|markdown)$/i.test(String(doc?.filePath || ''));
    const runtimeOf = (root) => root?.querySelector?.('.vdoc-runtime') || null;

    // ---------- 提示块 ----------
    const KINDS = {
        note: ['note', '注意'], info: ['note', '说明'], todo: ['note', '待办'],
        tip: ['tip', '提示'], hint: ['tip', '提示'], success: ['tip', '成功'], check: ['tip', '完成'], done: ['tip', '完成'],
        important: ['important', '重要'], abstract: ['important', '摘要'], summary: ['important', '摘要'], tldr: ['important', '一句话'],
        warning: ['warning', '警告'], attention: ['warning', '留意'], question: ['warning', '问题'], help: ['warning', '问题'], faq: ['warning', '问答'],
        caution: ['caution', '小心'], danger: ['caution', '危险'], error: ['caution', '出错'], bug: ['caution', '毛病'], failure: ['caution', '失败'], fail: ['caution', '失败'],
        example: ['example', '例子'], quote: ['example', '引文'], cite: ['example', '引文'],
    };
    const MARKER = /^\s*\[!([A-Za-z]+)\]([+-]?)[ \t]*/;
    function calloutify(root) {
        const runtime = runtimeOf(root);
        if (!runtime) return;
        for (const quote of runtime.querySelectorAll('blockquote:not(.uttu-callout)')) {
            const first = quote.firstElementChild;
            if (first?.tagName !== 'P') continue;
            const textNode = first.firstChild;
            if (textNode?.nodeType !== Node.TEXT_NODE) continue;
            const match = MARKER.exec(textNode.nodeValue);
            if (!match) continue;
            const [kind, label] = KINDS[match[1].toLowerCase()] || ['note', match[1]];
            // 标题：标记后面同一行的字（到 <br> 为止），没写就用这一类的名字。
            textNode.nodeValue = textNode.nodeValue.slice(match[0].length);
            const titleParts = [];
            while (first.firstChild && first.firstChild.nodeName !== 'BR') {
                titleParts.push(first.firstChild);
                first.firstChild.remove();
            }
            if (first.firstChild?.nodeName === 'BR') first.firstChild.remove();
            const title = document.createElement('div');
            title.className = 'uttu-callout-title';
            if (titleParts.some((node) => node.textContent.trim())) title.append(...titleParts);
            else title.textContent = label;
            if (!first.childNodes.length || !first.textContent.trim() && !first.querySelector('img')) first.remove();
            const body = document.createElement('div');
            body.className = 'uttu-callout-body';
            body.append(...quote.childNodes);
            quote.append(title, body);
            quote.classList.add('uttu-callout');
            quote.dataset.kind = kind;
            if (match[2]) {
                quote.dataset.fold = match[2] === '-' ? 'closed' : 'open';
                body.hidden = match[2] === '-';
            }
        }
    }

    // 阅读视图影子根里的样式（和标签那张一样挂在影子根上）。颜色用界面的令牌（影子根里能继承到），底色是同色 8% 盖在纸上。
    let sheet = null;
    function styleRoot(root) {
        if (!sheet && typeof CSSStyleSheet === 'function') {
            sheet = new CSSStyleSheet();
            sheet.replaceSync(`
input[type="checkbox"] { accent-color: var(--uttu-terra, currentColor); }
blockquote.uttu-callout { --c: var(--uttu-link, currentColor); margin-inline: 0; padding: .7em 1em .75em; border: 0; border-left: 3px solid var(--c);
  border-radius: 0 var(--uttu-r-s, 4px) var(--uttu-r-s, 4px) 0; background: color-mix(in srgb, var(--c) 8%, transparent); font-style: normal; }
blockquote.uttu-callout[data-kind="tip"] { --c: var(--uttu-ok, currentColor); }
blockquote.uttu-callout[data-kind="important"] { --c: var(--uttu-terra, currentColor); }
blockquote.uttu-callout[data-kind="warning"] { --c: var(--uttu-mark, currentColor); }
blockquote.uttu-callout[data-kind="caution"] { --c: var(--uttu-bad, currentColor); }
blockquote.uttu-callout[data-kind="example"] { --c: color-mix(in srgb, currentColor 55%, transparent); }
.uttu-callout-title { font-weight: 700; color: color-mix(in srgb, var(--c) 70%, currentColor); }
.uttu-callout-body > :first-child { margin-top: .35em; }
.uttu-callout-body > :last-child { margin-bottom: 0; }
blockquote.uttu-callout[data-fold] > .uttu-callout-title { cursor: pointer; user-select: none; }
blockquote.uttu-callout[data-fold] > .uttu-callout-title::after { content: " ＋"; font-weight: 400; opacity: .6; }
blockquote.uttu-callout[data-fold="open"] > .uttu-callout-title::after { content: " －"; }
.vdoc-runtime img:not(a img) { cursor: zoom-in; }`);
        }
        if (sheet && root && !root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
    let observed = null;
    let timer = 0;
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => decorate(observed), 120); });
    function decorate(root) {
        if (!root || !isMarkdown(UI.doc())) return;
        styleRoot(root);
        calloutify(root);
    }
    function watch() {
        const root = session()?.readRoot?.();
        if (root && root !== observed) {
            observer.disconnect();
            observer.observe(root, { childList: true, subtree: true });
            observed = root;
        }
        decorate(root);
    }
    UI.on('document', watch);
    UI.on('view', watch);

    // 点提示块标题开合；点图片放大。阅读视图在影子根里，从 composedPath 找。
    document.addEventListener('click', (event) => {
        const path = event.composedPath();
        const title = path.find((node) => node?.classList?.contains?.('uttu-callout-title'));
        if (title) {
            const quote = title.parentElement;
            if (!quote?.dataset.fold) return;
            const open = quote.dataset.fold !== 'open';
            quote.dataset.fold = open ? 'open' : 'closed';
            const body = quote.querySelector(':scope > .uttu-callout-body');
            if (body) body.hidden = !open;
            return;
        }
        const img = path.find((node) => node?.tagName === 'IMG');
        if (!img || !observed || img.getRootNode() !== observed || img.closest('a') || !isMarkdown(UI.doc())) return;
        if (!img.closest('.vdoc-runtime')) return;
        event.preventDefault();
        event.stopPropagation();
        openLightbox(img);
    }, true);

    // ---------- 图片放大 ----------
    const lightbox = make('div', 'uttu-lightbox');
    lightbox.hidden = true;
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-label', '看大图');
    const big = make('img');
    big.alt = '';
    const caption = make('p', 'uttu-lightbox-cap');
    lightbox.append(big, caption);
    document.body.append(lightbox);
    function openLightbox(img) {
        big.src = img.currentSrc || img.src;
        setText(caption, img.alt || '');
        caption.hidden = !img.alt;
        lightbox.hidden = false;
    }
    const closeLightbox = () => { lightbox.hidden = true; big.removeAttribute('src'); };
    lightbox.addEventListener('click', closeLightbox);

    // ---------- 放映 ----------
    const show = make('div', 'uttu-show');
    show.hidden = true;
    show.setAttribute('role', 'dialog');
    show.setAttribute('aria-label', '放映');
    const stageHost = make('div', 'uttu-show-stage');
    const stageRoot = stageHost.attachShadow({ mode: 'open' });
    const counter = make('span', 'uttu-show-count');
    const hint = make('span', 'uttu-show-hint', '← → 翻页 · Esc 退出');
    show.append(stageHost, counter, hint);
    document.body.append(show);
    const W = 1280;
    const H = 720;
    let slides = [];
    let shell = null; // 阅读视图内容那一层的空壳（类名、属性）和里面的文档样式（<style>），每页都套上
    let at = 0;
    let wentFull = false;

    // 按 <hr> 分；没有分隔线按 h2 分（第一个 h2 前面的是封面）。空页不要。
    function split(runtime) {
        const nodes = [...runtime.childNodes].filter((node) => node.nodeType === Node.ELEMENT_NODE && !node.matches('table[data-vdoc-frontmatter], style, script'));
        const pages = [[]];
        const byRule = nodes.some((node) => node.tagName === 'HR');
        for (const node of nodes) {
            if (byRule && node.tagName === 'HR') { pages.push([]); continue; }
            if (!byRule && node.tagName === 'H2' && pages[pages.length - 1].length) pages.push([]);
            pages[pages.length - 1].push(node);
        }
        return pages.filter((page) => page.some((node) => node.textContent.trim() || node.querySelector?.('img, svg, canvas, iframe') || node.tagName === 'IMG'));
    }
    function play() {
        const root = session()?.readRoot?.();
        const runtime = runtimeOf(root);
        if (!runtime || !isMarkdown(UI.doc())) {
            UI.toast('放映只给 .md：先打开一份 Markdown。');
            return false;
        }
        decorate(root);
        slides = split(runtime);
        shell = runtime.cloneNode(false);
        shell.removeAttribute('style');
        // 文档主题的颜色、字体多是外面那层设的变量（--vdoc-*）：照阅读视图算出来的值抄一份。
        const computed = getComputedStyle(runtime);
        for (const name of computed) if (name.startsWith('--vdoc-') && name !== '--vdoc-zoom') shell.style.setProperty(name, computed.getPropertyValue(name));
        shell.append(...[...runtime.querySelectorAll(':scope > style')].map((node) => node.cloneNode(true)));
        if (!slides.length) {
            UI.toast('这份是空的，没什么可放。');
            return false;
        }
        // 样式照搬阅读视图的影子根：<style> 复制一份，挂着的样式表直接共用。
        stageRoot.replaceChildren(...[...root.querySelectorAll(':scope > style, :scope > link[rel="stylesheet"]')].map((node) => node.cloneNode(true)));
        stageRoot.adoptedStyleSheets = [...root.adoptedStyleSheets];
        const extra = document.createElement('style');
        extra.textContent = `:host { display: block; }
.uttu-slide { position: absolute; left: 50%; top: 50%; width: ${W}px; min-height: ${H}px; box-sizing: border-box; padding: 64px 96px; transform-origin: center center;
  display: flex; flex-direction: column; justify-content: center; font-size: 26px; }
.uttu-slide > .vdoc-runtime { width: 100%; }
.uttu-slide h1 { font-size: 2.2em; } .uttu-slide h2 { font-size: 1.6em; }
.uttu-slide img { max-width: 100%; max-height: ${H - 160}px; object-fit: contain; }`;
        stageRoot.append(extra);
        // 纸的颜色：阅读视图那张纸是什么色，放映的底就是什么色。
        const paper = getComputedStyle(runtime);
        let background = paper.backgroundColor;
        for (let node = runtime; node && (!background || /rgba\(0, 0, 0, 0\)|transparent/.test(background)); node = node.parentElement || node.getRootNode()?.host) {
            background = getComputedStyle(node).backgroundColor;
        }
        show.style.setProperty('--uttu-show-paper', background && !/rgba\(0, 0, 0, 0\)/.test(background) ? background : 'Canvas');
        show.style.setProperty('--uttu-show-ink', paper.color);
        at = 0;
        show.hidden = false;
        document.body.classList.add('uttu-showing');
        const embedded = new URLSearchParams(location.search).get('vcpEmbedded') === '1';
        wentFull = false;
        if (!embedded && !document.fullscreenElement && document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().then(() => { wentFull = true; }, () => {});
        }
        render();
        show.focus?.();
        return true;
    }
    function render() {
        const slide = document.createElement('div');
        slide.className = 'uttu-slide';
        const runtime = shell.cloneNode(true);
        runtime.append(...slides[at].map((node) => node.cloneNode(true)));
        slide.append(runtime);
        const keep = [...stageRoot.childNodes].filter((node) => node.nodeName === 'STYLE' || node.nodeName === 'LINK');
        stageRoot.replaceChildren(...keep, slide);
        fit(slide);
        setText(counter, `${at + 1} / ${slides.length}`);
    }
    // 整页按比例放进窗口；内容比一页高时再缩小，一页看完。
    function fit(slide = stageRoot.querySelector('.uttu-slide')) {
        if (!slide) return;
        const height = Math.max(H, slide.scrollHeight);
        const scale = Math.min(show.clientWidth / W, show.clientHeight / height);
        slide.style.transform = `translate(-50%, -50%) scale(${scale})`;
    }
    window.addEventListener('resize', () => { if (!show.hidden) fit(); });
    function go(step) {
        const next = Math.max(0, Math.min(slides.length - 1, at + step));
        if (next === at) return;
        at = next;
        render();
    }
    function stop() {
        if (show.hidden) return;
        show.hidden = true;
        document.body.classList.remove('uttu-showing');
        stageRoot.replaceChildren();
        if (wentFull && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        wentFull = false;
    }
    show.addEventListener('click', (event) => {
        if (event.target.closest?.('a')) return;
        const box = show.getBoundingClientRect();
        go(event.clientX < box.left + box.width / 4 ? -1 : 1); // 点左边四分之一往回，别处往后
    });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && wentFull) stop(); });
    window.addEventListener('keydown', (event) => {
        if (!lightbox.hidden && event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            closeLightbox();
            return;
        }
        if (show.hidden) return;
        const keys = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1, Enter: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1, Backspace: -1 };
        if (event.key === 'Escape') stop();
        else if (event.key === 'Home') { at = 0; render(); }
        else if (event.key === 'End') { at = slides.length - 1; render(); }
        else if (keys[event.key]) go(keys[event.key]);
        else return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);
    UI.on('document', () => { stop(); closeLightbox(); });

    window.UTTUScriptoriumShow = Object.freeze({
        play, stop,
        canPlay: () => isMarkdown(UI.doc()) && !UI.overlay?.(),
        _state: () => ({ showing: !show.hidden, at, count: slides.length, lightbox: !lightbox.hidden }),
    });
})();
