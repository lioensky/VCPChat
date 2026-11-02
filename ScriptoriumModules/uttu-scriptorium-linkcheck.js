// 阅读视图里标出失效的链接。参照 Obsidian 的“未解析链接”：
// .md 的阅读面排好后，把相对链接（不带协议、不是 #锚点）交给主进程看文件在不在（markdownFiles 的 link-check），不在的打上
// data-uttu-missing：虚线下划线、后面淡字“找不到”。只改阅读面的 DOM，不碰源码；点它照旧提示“找不到这个文件”。
// 样式放进阅读面的影子根（adoptedStyleSheets，页面样式进不去）。颜色用 --uttu-bad（自定义属性能穿过影子根继承下去）。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.on) return;
    const session = () => window.UTTUScriptoriumSession;
    const api = () => window.scriptoriumAPI;
    const isMarkdown = (doc) => doc?.kind !== 'web-page' && /\.(md|markdown)$/i.test(String(doc?.filePath || ''));
    const relative = (href) => Boolean(href) && !href.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//');

    let sheet = null;
    function styleFor(root) {
        if (!sheet && typeof CSSStyleSheet === 'function') {
            sheet = new CSSStyleSheet();
            sheet.replaceSync(`a[data-uttu-missing] { text-decoration: underline dashed; text-decoration-color: var(--uttu-bad, currentColor); text-underline-offset: 3px; }
a[data-uttu-missing]::after { content: "找不到"; margin-left: .3em; font-size: .75em; color: var(--uttu-bad, currentColor); opacity: .85; }`);
        }
        if (sheet && root && !root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }

    let token = 0;
    async function check() {
        const doc = session()?.current?.();
        const root = session()?.readRoot?.();
        if (!isMarkdown(UI.doc()) || !root || !doc?.markdownFile?.dir) return;
        const anchors = [...root.querySelectorAll('a[href]')].filter((anchor) => relative(anchor.getAttribute('href').trim()));
        if (!anchors.length) return;
        const mine = ++token;
        const hrefs = [...new Set(anchors.map((anchor) => anchor.getAttribute('href').trim()))];
        let result;
        try { result = await api()?.markdownFolder?.('link-check', { dir: doc.markdownFile.dir, hrefs }); } catch (_) { return; }
        if (mine !== token) return;
        const missing = new Set(result?.missing || []);
        styleFor(root);
        for (const anchor of anchors) {
            if (missing.has(anchor.getAttribute('href').trim())) anchor.dataset.uttuMissing = '1';
            else delete anchor.dataset.uttuMissing;
        }
        UI.emit('links-checked', { missing: [...missing] });
    }

    // 阅读面重画（打开、外部改动、改了文字）后再查一遍；300 毫秒合成一次。
    let timer = 0;
    let observed = null;
    const observer = new MutationObserver(() => schedule());
    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(() => void check(), 300);
    }
    function watch() {
        const root = session()?.readRoot?.();
        if (root && root !== observed) {
            observer.disconnect();
            observer.observe(root, { childList: true, subtree: true });
            observed = root;
        }
        schedule();
    }
    UI.on('document', watch);
    UI.on('view', watch);
    UI.on('disk-check', schedule); // 切回窗口时（外面可能补上了文件）

    window.UTTUScriptoriumLinkCheck = Object.freeze({ check });
})();
