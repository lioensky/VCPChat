// 文坊文档的版式、样式和起步模板。
// 编辑器外壳跟 VCP 主题走；文档内容用这里的样式库，一份文档选一个，写进它自己的 documentCss。
// 页面（uttu-scriptorium.js 的新建面板）和主进程（Agent 的 CreateProject）共用这一份，所以写成两边都能加载。
((root, factory) => {
    const library = factory();
    if (typeof module === 'object' && module.exports) module.exports = library;
    if (root) root.UTTUDocThemes = library;
})(typeof window !== 'undefined' ? window : globalThis, () => {
    'use strict';

    // 版式：长页不分纸张（屏幕阅读、讲解、图解）；文稿是 A4 纸（要打印、导出 PDF 的）；演示是 16:9 逐页。
    const LAYOUTS = Object.freeze([
        { id: 'long', name: '长页', note: '不分页，适合在屏幕上看' },
        { id: 'page', name: '文稿', note: 'A4 纸，可以打印和导出 PDF' },
        { id: 'deck', name: '演示', note: '16:9，一页一页放' },
    ].map(Object.freeze));

    // 正文字体：跟对话正文同一个令牌 --uttu-font-reading（10-21 用户嫌 MiSans 做正文“太肉”，对话改成了清晰的系统黑体，
    // 文坊当时没跟上）。设置里换“正文字体”，文坊的文档也跟着换；导出的网页、别的程序里没有这个令牌，退回同一套字体。
    const READING = 'var(--uttu-font-reading, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "MiSans", "Noto Sans SC", sans-serif)';

    // 共用的正文规则；各样式只换变量。--primary-text 是编辑面正文用的颜色，要跟着样式走。
    const BASE = `* { box-sizing: border-box; }
html, body {
    margin: 0;
    color: var(--vdoc-ink);
    background: var(--vdoc-paper);
    font-family: var(--vdoc-body);
    font-size: var(--vdoc-size);
    line-height: 1.85;
    text-autospace: normal;
}
h1, h2, h3, h4, h5, h6 {
    margin: 1.6em 0 .6em;
    color: var(--vdoc-ink);
    font-family: var(--vdoc-heading);
    font-weight: 600; /* 700 的中文黑体太厚；英文 Segoe UI 有半粗，中文系统黑体只有常规和粗，照样是粗 */
    line-height: 1.3;
    text-wrap: balance;
    break-after: avoid;
}
h1 { margin-top: 0; font-size: 2.1em; letter-spacing: -.01em; }
h2 { padding-bottom: .3em; border-bottom: 1px solid var(--vdoc-line); font-size: 1.45em; }
h3 { font-size: 1.15em; }
h4 { color: var(--vdoc-muted); font-size: 1em; }
p { margin: .75em 0; text-wrap: pretty; orphans: 2; widows: 2; }
a { color: var(--vdoc-accent); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--vdoc-accent) 40%, transparent); }
a.uttu-wiki { border-bottom-style: dashed; cursor: pointer; } /* [[双链]]（uttu-scriptorium-wiki.js），虚线和普通链接分开 */
a.uttu-flash { background: color-mix(in srgb, var(--vdoc-accent) 28%, transparent); } /* 从“链接”页跳过来的那一处闪一下 */
blockquote { margin: 1.2em 0; padding: .2em 0 .2em 1em; border-left: 2px solid var(--vdoc-accent); color: var(--vdoc-muted); }
code { padding: .1em .35em; border-radius: 4px; background: var(--vdoc-soft); font-family: var(--vdoc-mono); font-size: .9em; }
pre { padding: 1em 1.2em; overflow: auto; border: 1px solid var(--vdoc-line); border-radius: 8px; background: var(--vdoc-soft); font-size: .88em; line-height: 1.6; }
pre code { padding: 0; background: none; }
table { width: 100%; margin: 1.2em 0; border-collapse: collapse; font-size: .95em; }
th, td { padding: .55em .8em; border-bottom: 1px solid var(--vdoc-line); text-align: left; vertical-align: top; }
th { color: var(--vdoc-muted); font-weight: 600; }
hr { margin: 2em 0; border: 0; border-top: 1px solid var(--vdoc-line); }
ul, ol { padding-left: 1.4em; }
li { margin: .3em 0; }
li::marker { color: var(--vdoc-faint); }
img, svg, video { max-width: 100%; }
mark { background: color-mix(in srgb, var(--vdoc-accent) 24%, transparent); color: inherit; }
/* YAML 属性段画成的小表（uttu-frontmatter.js）。每条写两遍：文坊排版时外面有 .vdoc-runtime，
   它给表格的卡片样式（边框、底色、任意断行）优先级更高，要压过去；导出的网页里没有它。 */
table.vdoc-frontmatter, .vdoc-runtime table.vdoc-frontmatter { width: auto; min-width: 50%; margin: 0 0 1.8em; overflow: visible;
    border: 0; border-top: 1px solid var(--vdoc-line); border-radius: 0; background: none; font-size: .86em; }
.vdoc-frontmatter tr, .vdoc-runtime .vdoc-frontmatter tr { background: none; }
.vdoc-frontmatter th, .vdoc-frontmatter td, .vdoc-runtime .vdoc-frontmatter :is(th, td) { padding: .35em 1.2em .35em 0;
    border: 0; border-bottom: 1px solid var(--vdoc-line); background: none; }
.vdoc-frontmatter th, .vdoc-runtime .vdoc-frontmatter th { width: 1%; white-space: nowrap; overflow-wrap: normal; word-break: keep-all;
    color: var(--vdoc-faint); font-weight: 500; }
.vdoc-frontmatter td, .vdoc-runtime .vdoc-frontmatter td { color: var(--vdoc-muted); }
.vdoc-frontmatter-item { display: inline-block; margin: 0 .3em .15em 0; padding: 0 .5em; border-radius: 4px; background: var(--vdoc-soft); }
.vdoc-frontmatter-raw { margin: 0 0 1.8em; color: var(--vdoc-muted); font-size: .82em; }
/* 在格子里直接改（uttu-scriptorium-properties.js），控件只在文坊里加，导出的网页里没有。 */
.vdoc-runtime table.vdoc-frontmatter { position: relative; }
.vdoc-runtime .vdoc-frontmatter tr { position: relative; }
.vdoc-runtime .vdoc-frontmatter :is(th, td) { cursor: text; }
.vdoc-runtime .vdoc-frontmatter :is(th, td).uttu-prop-editing { outline: 0; color: var(--vdoc-ink); box-shadow: inset 0 -1px 0 var(--vdoc-accent); }
.vdoc-runtime .vdoc-frontmatter td.uttu-prop-editing { padding-right: 2.2em; white-space: pre-wrap; }
.vdoc-runtime .vdoc-frontmatter .uttu-prop-editing:empty::before { content: attr(data-hint); color: var(--vdoc-faint); }
.vdoc-runtime .vdoc-frontmatter .uttu-prop-tools { position: absolute; top: 0; right: 0; bottom: 0; display: flex; align-items: center; width: auto; padding: 0; border: 0; }
.uttu-prop-del { width: 1.6em; height: 1.6em; padding: 0; border: 0; border-radius: 0; background: none; color: var(--vdoc-faint); font: inherit; line-height: 1; }
.uttu-prop-del::before { content: "×"; }
.uttu-prop-del:hover { background: var(--vdoc-soft); color: var(--vdoc-ink); }
.vdoc-runtime .vdoc-frontmatter .uttu-prop-add { position: absolute; top: 100%; left: 0; padding: .15em .6em .15em 0; color: var(--vdoc-faint); font-size: .92em; text-align: left; white-space: nowrap; visibility: hidden; }
.uttu-prop-add::before { content: "+ 加一项"; }
.vdoc-runtime .vdoc-frontmatter:is(:hover, :has(.uttu-prop-editing)) .uttu-prop-add { visibility: visible; }
.uttu-prop-add:hover { color: var(--vdoc-ink); }
@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; }
}`;

    const THEMES = Object.freeze([
        {
            id: 'uttu-ink',
            name: '墨底',
            note: '深色，和 VCP 一致，适合屏幕',
            swatch: { paper: '#1b1814', ink: '#ece3d3', accent: '#c35f2c' },
            vars: {
                'color-scheme': 'dark',
                '--vdoc-paper': '#1b1814',
                '--vdoc-ink': '#ece3d3',
                '--vdoc-muted': '#b4a893',
                '--vdoc-faint': '#7d7262',
                '--vdoc-accent': '#db7a43',
                '--vdoc-line': '#3b342b',
                '--vdoc-soft': '#231f1a',
                '--vdoc-body': READING,
                '--vdoc-heading': `"PT Serif", ${READING}`, // 英文标题照旧 PT Serif，中文落到正文字体
                '--vdoc-size': '16px',
            },
        },
        {
            id: 'plain',
            name: '素白',
            note: '浅色无衬线，干净，适合屏幕',
            swatch: { paper: '#f7f5f0', ink: '#22201c', accent: '#b4532a' },
            vars: {
                'color-scheme': 'light',
                '--vdoc-paper': '#f7f5f0',
                '--vdoc-ink': '#22201c',
                '--vdoc-muted': '#6b655b',
                '--vdoc-faint': '#a39b8d',
                '--vdoc-accent': '#b4532a',
                '--vdoc-line': '#e3ddd2',
                '--vdoc-soft': '#efebe3',
                '--vdoc-body': READING,
                '--vdoc-heading': READING,
                '--vdoc-size': '16px',
            },
        },
        {
            id: 'paper',
            name: '纸本',
            note: '米白纸、宋体，适合打印',
            swatch: { paper: '#fffdf8', ink: '#1d2421', accent: '#8b5e34' },
            vars: {
                'color-scheme': 'light',
                '--vdoc-paper': '#fffdf8',
                '--vdoc-ink': '#1d2421',
                '--vdoc-muted': '#66706b',
                '--vdoc-faint': '#9aa29d',
                '--vdoc-accent': '#8b5e34',
                '--vdoc-line': '#e4ddd0',
                '--vdoc-soft': '#f4efe5',
                '--vdoc-body': '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
                '--vdoc-heading': '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
                '--vdoc-size': '12pt',
            },
            extra: 'p { text-align: justify; text-justify: inter-ideograph; }',
        },
    ].map(Object.freeze));

    // 起步：空白只有标题；其余给一副骨架，标题即段落的用途。建议的版式和样式在选中时带上，可以再改。
    const TEMPLATES = Object.freeze([
        {
            id: 'blank',
            name: '空白',
            note: '只有标题',
            title: '未命名文稿',
            source: (title) => `# ${title}\n\n`,
        },
        {
            id: 'explain',
            name: '讲解',
            note: '讲清一个项目或概念',
            layout: 'long',
            theme: 'uttu-ink',
            title: '讲解：',
            source: (title) => `# ${title}

> 一句话说清它是什么、解决什么问题。

## 先看全貌

它由哪几部分组成，各自负责什么。

## 关键流程

一件事从开始到结束经过哪些环节。

## 细节

值得单独讲的设计、约束和取舍。

## 要注意的地方

容易踩的坑、尚未解决的问题。
`,
        },
        {
            id: 'report',
            name: '报告与方案',
            note: '结论先行，要拍板的',
            layout: 'page',
            theme: 'paper',
            title: '报告：',
            source: (title) => `# ${title}

> 结论：一句话写清建议和理由。

## 背景

为什么要做这件事。

## 建议

具体怎么做，代价和收益。

## 依据

数据、事实和对比。

## 风险与待决

需要拍板的事，每件给出选项。

## 下一步

谁、什么时候、做什么。
`,
        },
        {
            id: 'review',
            name: '复盘',
            note: '一次事情做完之后',
            layout: 'long',
            theme: 'plain',
            title: '复盘：',
            source: (title) => `# ${title}

## 目标与结果

原本想要什么，最后得到什么。

## 过程

关键节点和当时的判断。

## 做得好的

## 问题与原因

## 改进
`,
        },
    ].map(Object.freeze));

    const byId = (list, id) => list.find((item) => item.id === id) || null;
    // 样式库那段的首尾标记：换样式时整段替换，Agent 补在后面的局部样式不动。
    // 开头必须直接是 :root {：文坊把它换成影子根的 :host 时，要求 :root 在开头或某个 } 之后，前面有注释就换不成，
    // 整组变量失效。所以标记放成 :root 里的一个自定义属性，不放注释。
    const START = ':root {\n    --uttu-doc-theme:';
    const END = '/* VCP 文档样式结束 */';

    function cssFor(themeId) {
        const theme = byId(THEMES, themeId) || THEMES[0];
        const vars = Object.entries(theme.vars).map(([key, value]) => `    ${key}: ${value};`).join('\n');
        return `${START} ${theme.id}; /* VCP 文档样式：${theme.name} */\n${vars}\n    --primary-text: var(--vdoc-ink);\n}\n`
            + `${BASE}\n${theme.extra || ''}\n${END}\n`;
    }

    // 文档 CSS 用的是哪套样式；没有样式库的标记时为 null（上游默认，或 Agent 自己写的）。
    function themeOf(css) {
        const match = String(css || '').match(/--uttu-doc-theme:\s*([a-z0-9-]+)/);
        return match ? match[1] : null;
    }

    // 给已有文档换样式：样式库那段整段换掉，Agent 补在后面的局部样式留着；上游默认样式整份换掉；
    // 别的自写样式保留，新样式放在前面（自写的规则仍然优先）。
    function restyleCss(css, themeId, defaultCss = '') {
        const source = String(css || '');
        const block = cssFor(themeId);
        const start = source.indexOf(START);
        const end = source.indexOf(END);
        if (start >= 0 && end > start) {
            return source.slice(0, start) + block + source.slice(end + END.length).replace(/^\n/, '');
        }
        const fallback = String(defaultCss || '').trim();
        if (fallback && source.trim().startsWith(fallback)) return block + source.trim().slice(fallback.length);
        return `${block}\n${source}`;
    }

    // 给 VDocCore.createDocument 的参数（演示不走这里）。
    function documentOptions({ layout = 'long', theme = 'uttu-ink', template = 'blank', title = '' } = {}) {
        const starter = byId(TEMPLATES, template) || TEMPLATES[0];
        const name = String(title || '').trim() || starter.title.replace(/：$/, '') || '未命名文稿';
        return {
            title: name,
            source: starter.source(starter.title.endsWith('：') && !title ? starter.title : name),
            documentCss: cssFor(theme),
            pagination: { mode: layout === 'page' ? 'flow' : 'continuous' },
        };
    }

    return Object.freeze({
        LAYOUTS,
        THEMES,
        TEMPLATES,
        theme: (id) => byId(THEMES, id),
        template: (id) => byId(TEMPLATES, id),
        cssFor,
        themeOf,
        restyleCss,
        documentOptions,
    });
});
