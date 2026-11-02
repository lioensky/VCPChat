// 文坊双栏看两份。
// 右边一栏只读地摆另一份文件：.md / .markdown / .txt 排成阅读样子，.html 照网页显示；左边照常编辑当前这份。
// 文坊的文档存储一次只装一份（上游），所以右边只能看；要改，点栏头“换到左边”：右边这份到左边打开，左边那份到右边。
// 打开：文件右键菜单“在右边打开”，或按住 Alt 点资源管理器里的文件、顶栏的标签。关：栏头 ×。窄（停在 Chat 右栏）和专注时不摆。
// 右边的链接：页内锚点滚过去；别的 .md、网页在右边接着看；其余交给主进程（和阅读视图一样，markdownFiles openLink）。
// 列宽：和左边对半分，拖中间的边界改，双击回到对半（记在本机）。不做开合动画。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    const stage = document.querySelector('.scriptorium-stage');
    if (!UI?.on || !stage) return;
    const { make, button, icon, escapeHtml } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.UTTUScriptoriumSession;
    const SIDE = /\.(md|markdown|txt|html?)$/i;
    const PAGE = /\.html?$/i;
    const TEXT = /\.txt$/i;
    const WIDTH_KEY = 'uttu.scriptorium.side.width';
    const norm = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);
    const nameOf = (path) => String(path || '').split(/[\\/]/).pop() || String(path || '');
    const fileUrl = (dir) => `file:///${encodeURI(String(dir).replace(/\\/g, '/').replace(/^\/+/, ''))}/`;

    const pane = make('aside', 'uttu-side');
    pane.hidden = true;
    pane.setAttribute('aria-label', '右边一栏');
    const head = make('div', 'uttu-pane-head uttu-side-head');
    const label = make('span', 'uttu-pane-label uttu-side-label');
    const swapButton = button('uttu-tb uttu-side-swap', '', '换到左边', () => void swap());
    const closeButton = button('uttu-tb', '关掉右边一栏', icon('i-x'), () => close());
    head.append(label, make('span', 'grow'), swapButton, closeButton);
    const body = make('div', 'uttu-side-body');
    const resize = make('div', 'uttu-panel-resize right uttu-side-resize');
    resize.setAttribute('aria-hidden', 'true');
    pane.append(resize, head, body);
    stage.insertBefore(pane, stage.querySelector('.uttu-insp'));

    let shown = null; // { path, dir }
    let round = 0;

    const setWidth = (value) => {
        if (value) document.body.style.setProperty('--uttu-side-open', value);
        else document.body.style.removeProperty('--uttu-side-open');
    };
    try { setWidth(localStorage.getItem(WIDTH_KEY) || ''); } catch (_) { /* 用对半 */ }

    function showPane(on) {
        pane.hidden = !on;
        document.body.classList.toggle('uttu-side-open', on);
    }

    async function open(path) {
        if (!SIDE.test(String(path || ''))) {
            UI.toast?.('右边一栏只摆 Markdown、纯文本和网页。');
            return false;
        }
        if (UI.narrow?.()) {
            UI.toast?.('这里太窄，摆不下两栏。');
            return false;
        }
        if (same(path, UI.doc()?.filePath)) {
            UI.toast?.('左边开着的就是这份。');
            return false;
        }
        const mine = ++round;
        label.innerHTML = `${escapeHtml(nameOf(path))}<small>只看</small>`;
        showPane(true);
        try {
            if (PAGE.test(path)) await showPage(path, mine);
            else await showText(path, mine);
        } catch (error) {
            if (mine !== round) return false;
            body.replaceChildren(make('p', 'uttu-left-note', escapeHtml(`没打开：${error.message || error}`)));
        }
        return mine === round;
    }

    async function showText(path, mine) {
        const result = await api()?.markdownFolder?.('side-text', { path });
        if (mine !== round) return;
        if (!result?.text && result?.text !== '') throw new Error('读不到');
        shown = { path: result.filePath || path, dir: result.dir || '' };
        const article = make('article', 'uttu-side-md');
        if (TEXT.test(path)) {
            const pre = make('pre', 'uttu-side-plain');
            pre.textContent = result.text;
            article.append(pre);
        } else {
            article.append(...render(result.text, result.dir));
        }
        body.replaceChildren(article);
        body.scrollTop = 0;
    }

    // Markdown 排成 HTML（页面里已有的 marked），再去掉能跑的东西：脚本、内嵌框、事件属性、javascript: 地址。相对的图片按文件所在目录找。
    function render(text, dir) {
        const html = window.marked?.parse ? window.marked.parse(String(text || '')) : `<pre>${escapeHtml(text)}</pre>`;
        const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
        parsed.querySelectorAll('script, iframe, frame, object, embed, link, meta, style, base, form').forEach((node) => node.remove());
        const base = dir ? fileUrl(dir) : '';
        for (const node of parsed.body.querySelectorAll('*')) {
            for (const attr of [...node.attributes]) {
                if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
                else if (/^(href|src|xlink:href|action|formaction)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value)) node.removeAttribute(attr.name);
            }
            if (node.tagName === 'IMG' && base) {
                const src = node.getAttribute('src') || '';
                if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//')) {
                    try { node.setAttribute('src', new URL(src, base).href); } catch (_) { /* 留原样 */ }
                }
            }
        }
        return [...parsed.body.childNodes].map((node) => document.adoptNode(node));
    }

    // 网页：和左边的网页视图一样从主进程拿 uttu-page:// 地址，放进只许跑脚本的沙盒框。
    async function showPage(path, mine) {
        const result = await api()?.page?.('read', { file: path });
        if (mine !== round) return;
        if (!result?.success) throw new Error(result?.error || '读不到');
        shown = { path: result.filePath || path, dir: '' };
        const frame = make('iframe', 'uttu-side-frame');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.setAttribute('aria-label', result.name || nameOf(path));
        const source = String(result.text || '');
        const meta = source.match(/<meta\b[^>]*\bname\s*=\s*["']color-scheme["'][^>]*>/i);
        const dark = meta ? /\bcontent\s*=\s*["']\s*dark\s*["']/i.test(meta[0]) : /(?<![\w-])color-scheme\s*:\s*dark\s*[;}]/i.test(source);
        if (dark) frame.dataset.scheme = 'dark';
        frame.src = `${result.url}?uttu-side=${Date.now()}`;
        body.replaceChildren(frame);
    }

    function close() {
        round += 1;
        shown = null;
        body.replaceChildren();
        showPane(false);
    }

    // 换到左边：右边这份到左边打开（固定成标签），左边原来那份能摆的话到右边。
    async function swap() {
        if (!shown) return;
        const right = shown.path;
        const left = UI.doc()?.filePath || '';
        window.UTTUScriptoriumTabs?.pinNext?.(right);
        const tabs = window.UTTUScriptoriumTabs;
        if (tabs?.switchTo) await tabs.switchTo(right); else await session()?.openPath?.(right);
        if (!same(UI.doc()?.filePath, right)) return; // 没换成（上游问存不存时选了取消）
        if (left && SIDE.test(left)) await open(left); else close();
    }

    // 右边的链接。在 window 的捕获阶段接住：阅读视图在 document 上也接链接（按住 Ctrl 时会在左边打开），右边的不交给它。
    window.addEventListener('click', (event) => {
        const anchor = event.target?.closest?.('a[href]');
        if (!anchor || !shown || !body.contains(anchor)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const href = anchor.getAttribute('href').trim();
        if (href.startsWith('#')) {
            const target = body.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
            target?.scrollIntoView({ block: 'start' });
            return;
        }
        if (!api()?.markdownOpenLink) return;
        void api().markdownOpenLink({ href, dir: shown.dir || '' }).then((result) => {
            if (result?.kind === 'markdown' || result?.kind === 'web-page') void open(result.path || result.filePath);
            else if (result?.kind === 'missing') UI.toast?.(`找不到这个文件：${result.path}`);
            else if (result?.kind === 'revealed') UI.toast?.('不是 Markdown 也不是网页，已在资源管理器里显示。');
        }).catch((error) => UI.toast?.(`打不开这个链接：${error.message}`));
    }, true);

    // 按住 Alt 点资源管理器里的文件、顶栏的标签：在右边打开（window 的捕获阶段先接住，单击打开那一下就不发生了）。
    window.addEventListener('click', (event) => {
        if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey || event.button !== 0) return;
        const row = event.target?.closest?.('.outline-panel [data-path], .uttu-tabs [data-path]');
        const kind = row?.dataset.kind || '';
        if (!row || /^(dir|root|recent-folder)$/.test(kind)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void open(row.dataset.path);
    }, true);

    // 左边换成了右边这一份：右边不再重复摆它。
    UI.on('document', (doc) => { if (shown && same(doc?.filePath, shown.path)) close(); });

    // 拖中间的边界改宽（右栏的宽度，像左右面板一样），双击回到对半。
    resize.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        resize.setPointerCapture(event.pointerId);
        document.body.classList.add('uttu-panel-resizing');
        const right = pane.getBoundingClientRect().right;
        const total = stage.getBoundingClientRect().width;
        const onMove = (move) => {
            const width = Math.round(Math.min(total * 0.75, Math.max(280, right - move.clientX)));
            setWidth(`${width}px`);
        };
        const onUp = () => {
            resize.removeEventListener('pointermove', onMove);
            document.body.classList.remove('uttu-panel-resizing');
            try { localStorage.setItem(WIDTH_KEY, document.body.style.getPropertyValue('--uttu-side-open') || ''); } catch (_) { /* 只这次 */ }
        };
        resize.addEventListener('pointermove', onMove);
        resize.addEventListener('pointerup', onUp, { once: true });
        resize.addEventListener('pointercancel', onUp, { once: true });
    });
    resize.addEventListener('dblclick', () => {
        setWidth('');
        try { localStorage.removeItem(WIDTH_KEY); } catch (_) { /* 只这次 */ }
    });

    window.UTTUScriptoriumSide = Object.freeze({
        open,
        close,
        swap,
        path: () => shown?.path || '',
        canShow: (path) => SIDE.test(String(path || '')),
    });
})();
