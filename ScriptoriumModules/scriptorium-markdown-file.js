// 从 .md 打开的文档：在原有的连续编辑、阅读预览、混合源码中编辑，保存回原文件（主进程 modules/scriptorium/markdownFiles）。
// - 相对图片：按 .md 所在文件夹换成本机地址（只换显示用的 HTML，正文不变）。可读取的范围是它所在的 Git 仓库，
//   不在仓库中时为它所在的文件夹；范围外的图片不加载。
// - 链接：网页地址交给系统浏览器；文内 #锚点 跳转到对应位置；相对 .md 在文坊中打开；相对 .html 在文坊中作为网页打开；
//   其他文件在资源管理器中显示。编辑面中点击链接只放置光标，按住 Ctrl 点击才打开；阅读预览中直接点击打开。
// - 外部修改：主进程监视当前这份 .md。本地没有修改时自动重新载入；本地也有未保存的修改时，在文档上方询问保留哪一边；
//   文件被删除或移走时提示，保存后会在原处重新写出。
(() => {
    'use strict';
    const UI = window.ScriptoriumFileViews;
    if (!UI?.on) return;
    const { make, button, escapeHtml } = UI;
    const api = () => window.scriptoriumAPI;
    const session = () => window.ScriptoriumFileSession;
    const current = () => session()?.current?.() || null;
    const isMarkdown = (doc) => /\.(md|markdown)$/i.test(String(doc?.filePath || ''));
    const samePath = (a, b) => Boolean(a && b) && String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();

    // ---------- 相对图片 ----------
    // 带协议（http:、data:、file:，以及 C: 这样的盘符）、以 / \ # 开头的地址不变。
    const absolute = (url) => /^([a-z][a-z0-9+.-]*:|[\\/#])/i.test(url);
    function resolvePath(dir, relative) {
        let rel = relative.split('#')[0].split('?')[0];
        try { rel = decodeURIComponent(rel); } catch (_) { /* 原样使用 */ }
        const parts = String(dir).replace(/\\/g, '/').replace(/\/$/, '').split('/');
        for (const segment of rel.replace(/\\/g, '/').split('/')) {
            if (!segment || segment === '.') continue;
            if (segment === '..') { if (parts.length > 1) parts.pop(); continue; }
            parts.push(segment);
        }
        return parts.join('/');
    }
    const inside = (target, root) => {
        const t = target.toLowerCase();
        const r = String(root).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
        return t === r || t.startsWith(`${r}/`);
    };
    const fileUrl = (target) => `file:///${target.split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')}`;
    const MEDIA = /(<(?:img|source|video|audio)\b[^>]*?\s(?:src|poster)\s*=\s*)(["'])([^"']*)\2/gi;
    function rewrite(html, markdownFile) {
        return String(html || '').replace(MEDIA, (match, head, quote, url) => {
            const raw = url.trim().replace(/&amp;/g, '&');
            if (!raw || absolute(raw)) return match;
            const target = resolvePath(markdownFile.dir, raw);
            if (!inside(target, markdownFile.root || markdownFile.dir)) return `${head}${quote}${quote} data-scriptorium-outside="${encodeURIComponent(raw)}"`;
            return `${head}${quote}${fileUrl(target)}${quote}`;
        });
    }
    // scriptorium.js 的资源解析先问这里。
    window.ScriptoriumMarkdownFile = Object.freeze({
        resolver(base) {
            const markdownFile = current()?.markdownFile;
            if (!markdownFile?.dir) return base;
            return { ...(base || {}), resolveHtml: (html) => rewrite(base?.resolveHtml?.(html) || String(html || ''), markdownFile) };
        },
        _rewrite: rewrite,
    });

    // ---------- 外部修改 ----------
    const bar = make('div', 'scriptorium-md-banner');
    bar.setAttribute('role', 'status');
    bar.hidden = true;
    const workspace = document.getElementById('document-workspace');
    (workspace?.parentElement || document.body).append(bar);
    function showBar(kind, text, actions) {
        bar.dataset.kind = kind;
        bar.replaceChildren(make('span', 'scriptorium-md-banner-text', escapeHtml(text)),
            ...actions.map(([label, primary, act]) => button(`scriptorium-file-button${primary ? ' primary' : ''}`, '', escapeHtml(label), act)));
        bar.hidden = false;
    }
    function hideBar() {
        bar.hidden = true;
        bar.dataset.kind = '';
    }
    // 原有的打开流程在有未保存的修改时显示“未保存”对话框；舍弃本地修改重新载入时，等对话框出现后选择“舍弃修改”。
    async function chooseDiscard() {
        const dialog = document.getElementById('unsaved-dialog');
        for (let tries = 0; tries < 60 && dialog?.hidden; tries += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
        if (dialog && !dialog.hidden) document.getElementById('unsaved-discard-btn')?.click();
    }
    async function reload(file, { discard = false } = {}) {
        const scrolled = ['read-host', 'render-host'].map((id) => document.getElementById(id)).filter(Boolean).map((node) => [node, node.scrollTop]);
        const opening = session()?.openPath?.(file);
        if (discard) await chooseDiscard();
        await opening;
        setTimeout(() => requestAnimationFrame(() => scrolled.forEach(([node, top]) => { node.scrollTop = top; })), 250);
    }
    let watched = '';
    UI.on('document', (doc) => {
        if (bar.dataset.kind) hideBar();
        const file = isMarkdown(doc) ? doc.filePath : '';
        if (file === watched || samePath(file, watched)) return;
        watched = file;
        void api()?.markdownFile?.('watch-file', { path: file || null }).catch(() => {});
    });
    api()?.onMarkdownEvent?.((event) => {
        const doc = current();
        if (!doc?.filePath || !samePath(event?.path, doc.filePath) || UI.overlay()) return;
        if (event.type === 'file-deleted') {
            showBar('deleted', '磁盘上已找不到这份文件（已被删除或移走）。保存后会在原处重新写出。', [['知道了', false, hideBar]]);
            return;
        }
        if (event.type !== 'file-changed') return;
        if (!doc.dirty) {
            void reload(doc.filePath);
            UI.toast('文件已在别处修改，已重新载入。');
            return;
        }
        showBar('conflict', '文件已在别处修改，本地也有未保存的修改。', [
            ['使用文件中的版本', false, () => { hideBar(); void reload(doc.filePath, { discard: true }); }],
            ['保留我的修改', true, async () => {
                hideBar();
                await api()?.markdownFile?.('accept-disk', { path: doc.filePath }).catch(() => {});
                document.getElementById('save-btn')?.click();
            }],
        ]);
    });
    // 窗口重新获得焦点或重新可见时，立即检查一次（补上监视遗漏的修改）。
    UI.on('disk-check', () => {
        const doc = current();
        if (isMarkdown(doc) && !UI.overlay()) void api()?.markdownFile?.('check-file', { path: doc.filePath }).catch(() => {});
    });

    // ---------- 链接 ----------
    const slug = (text) => String(text || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
    function scrollToAnchor(anchor, id) {
        const root = anchor.getRootNode();
        let wanted = id;
        try { wanted = decodeURIComponent(id); } catch (_) { /* 原样使用 */ }
        const target = root.getElementById?.(wanted) || root.querySelector?.(`[name="${CSS.escape(wanted)}"]`)
            || [...(root.querySelectorAll?.('h1, h2, h3, h4, h5, h6') || [])].find((heading) => slug(heading.textContent) === slug(wanted));
        if (target) target.scrollIntoView({ block: 'start' });
        else UI.toast(`文中没有“${wanted}”这一节。`);
    }
    // 链接到 .html：直接交给网页视图，以便带上 #锚点。
    function openPage({ path, hash }) {
        const page = window.ScriptoriumWebPage;
        return page?.open ? page.open(path, { hash }) : session()?.openPath?.(path);
    }
    document.addEventListener('click', (event) => {
        const doc = current();
        if (!isMarkdown(doc) || UI.overlay() || event.button !== 0) return;
        const anchor = event.composedPath().find((node) => node?.tagName === 'A' && node.hasAttribute?.('href'));
        if (!anchor) return;
        const inRead = Boolean(event.composedPath().find((node) => node?.id === 'read-host'));
        event.preventDefault();
        if (!inRead && !(event.ctrlKey || event.metaKey)) return;
        const href = anchor.getAttribute('href').trim();
        if (href.startsWith('#')) { scrollToAnchor(anchor, href.slice(1)); return; }
        if (!api()?.markdownOpenLink) return;
        void api().markdownOpenLink({ href, dir: doc.markdownFile?.dir || '' }).then(async (result) => {
            if (result?.kind === 'markdown') await session()?.openPath?.(result.path);
            else if (result?.kind === 'web-page') await openPage(result);
            else if (result?.kind === 'missing') UI.toast(`找不到这个文件：${result.path}`);
            else if (result?.kind === 'revealed') UI.toast('该文件不是 Markdown 或网页，已在资源管理器中显示。');
        }).catch((error) => UI.toast(`未能打开这个链接：${error.message}`));
    }, true);
})();
