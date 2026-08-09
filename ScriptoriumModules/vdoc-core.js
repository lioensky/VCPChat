'use strict';

(() => {
    const FORMAT = 'vcp-vdocx';
    const VERSION = 1;
    const PROJECT_KINDS = Object.freeze({
        FLOW_DOCUMENT: 'flow-document',
        SLIDE_DECK: 'slide-deck',
    });
    const EDITABLE_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,td,th';
    const PRESERVED_CONTAINER_SELECTOR = 'article,main,section,header,footer,aside,nav,figure,table,thead,tbody,tfoot,tr,ul,ol';
    const BLOCKED_ELEMENTS = 'script,iframe,object,embed,applet,base,meta[http-equiv],link[rel="import"]';
    const URL_ATTRIBUTES = ['href', 'src', 'poster', 'action', 'formaction', 'xlink:href'];

    function createId(prefix = 'node') {
        const uuid = globalThis.crypto?.randomUUID?.();
        return `${prefix}-${uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
    }

    function defaultHtml() {
        return `<article class="vdoc-manuscript">
    <header class="vdoc-hero">
        <p class="vdoc-eyebrow">VCP SCRIPTORIUM</p>
        <h1>未命名文稿</h1>
        <p class="vdoc-lead">人类负责思想与创作，AI 负责润色与排版。请从这里开始共同书写。</p>
    </header>
    <section>
        <h2>第一章</h2>
        <p>在这里落下第一段文字。</p>
    </section>
</article>`;
    }

    function defaultSlideHtml() {
        return `<section class="vdoc-slide-scene">
    <div class="vdoc-slide-title">
        <p class="vdoc-eyebrow">VCP SCRIPTORIUM</p>
        <h1>未命名演示</h1>
        <p>人类构建内容与基础布局，AI 继续完成每一页的视觉、动画与交互。</p>
    </div>
</section>`;
    }

    function createSlide(input = {}, index = 0) {
        const candidate = input && typeof input === 'object' ? input : {};
        return {
            id: String(candidate.id || createId('slide')),
            name: String(candidate.name || `第 ${index + 1} 页`),
            html: formatHtml(ensureTextNodeIds(candidate.html || defaultSlideHtml())),
            css: sanitizeCss(candidate.css || ''),
            script: String(candidate.script || ''),
            transition: String(candidate.transition || 'none'),
            duration: Number.isFinite(Number(candidate.duration))
                ? Math.max(0, Number(candidate.duration))
                : null,
            notes: String(candidate.notes || ''),
            resources: Array.isArray(candidate.resources)
                ? [...new Set(candidate.resources.map(String))]
                : [],
            import: candidate.import && typeof candidate.import === 'object'
                ? candidate.import
                : null,
        };
    }

    function normalizeSlides(input) {
        const slides = Array.isArray(input) ? input : [];
        return (slides.length ? slides : [{}]).map(createSlide);
    }

    function defaultCss() {
        return `:root {
    color-scheme: light;
    --vdoc-ink: #1d2421;
    --vdoc-muted: #66706b;
    --vdoc-accent: #8b5e34;
    --vdoc-paper: #fffdf8;
    --vdoc-serif: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif;
}
* { box-sizing: border-box; }
html, body {
    margin: 0;
    color: var(--vdoc-ink);
    background: transparent;
    font-family: var(--vdoc-serif);
    font-size: 12pt;
    line-height: 1.8;
    text-autospace: normal;
}
.vdoc-manuscript { width: 100%; max-width: 100%; }
.vdoc-hero { padding: 22mm 0 16mm; border-bottom: 1px solid rgba(139, 94, 52, .28); }
.vdoc-eyebrow { color: var(--vdoc-accent); font: 700 9pt/1.4 system-ui, sans-serif; letter-spacing: .22em; }
h1, h2, h3, h4, h5, h6 {
    margin: 1.5em 0 .65em;
    line-height: 1.28;
    text-wrap: balance;
    break-after: avoid;
}
h1 { margin-top: 0; font-size: 32pt; letter-spacing: -.03em; }
h2 { font-size: 21pt; }
h3 { font-size: 16pt; }
p { margin: .7em 0; text-align: justify; text-justify: inter-ideograph; text-wrap: pretty; orphans: 2; widows: 2; }
.vdoc-lead { color: var(--vdoc-muted); font-size: 14pt; }
[data-vdoc-text] { outline: none; }
[data-vdoc-text]:focus { border-radius: 3px; box-shadow: 0 0 0 3px rgba(139, 94, 52, .13); }
@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; }
}`;
    }

    function createSceneConfig(input = {}) {
        const kind = input.kind === PROJECT_KINDS.SLIDE_DECK
            ? PROJECT_KINDS.SLIDE_DECK
            : PROJECT_KINDS.FLOW_DOCUMENT;
        const isDeck = kind === PROJECT_KINDS.SLIDE_DECK;
        return {
            kind,
            orientation: isDeck ? 'landscape' : 'portrait',
            page: {
                width: String(input.page?.width || (isDeck ? '13.333in' : '210mm')),
                height: String(input.page?.height || (isDeck ? '7.5in' : '297mm')),
                gap: String(input.page?.gap || '24px'),
            },
            pagination: {
                mode: isDeck ? 'explicit' : 'flow',
                keepHeadingsWithNext: !isDeck,
                widows: isDeck ? 1 : 2,
                orphans: isDeck ? 1 : 2,
            },
            presentation: {
                enabled: isDeck,
                navigation: input.presentation?.navigation || 'linear',
                transition: input.presentation?.transition || 'none',
                loop: Boolean(input.presentation?.loop),
                aspectRatio: input.presentation?.aspectRatio || (isDeck ? '16 / 9' : null),
            },
        };
    }

    function createDocument(options = {}) {
        const now = new Date().toISOString();
        return normalizeDocument({
            format: FORMAT,
            version: VERSION,
            manifest: {
                id: createId('document'),
                title: options.title || '未命名文稿',
                language: options.language || 'zh-CN',
                createdAt: now,
                modifiedAt: now,
                generator: 'VCP Scriptorium',
                capabilities: {
                    scripts: options.kind === PROJECT_KINDS.SLIDE_DECK,
                    cssAnimations: true,
                    renderedTextEditing: true,
                    sceneDiffs: options.kind === PROJECT_KINDS.SLIDE_DECK,
                },
                fonts: [],
                resources: [],
                styleDependencies: [],
                embeddedStyles: [],
                scene: createSceneConfig({
                    kind: options.kind,
                    page: options.page,
                    presentation: options.presentation,
                }),
            },
            source: {
                html: options.kind === PROJECT_KINDS.SLIDE_DECK
                    ? ''
                    : options.html || defaultHtml(),
                css: options.css || defaultCss(),
                slides: options.kind === PROJECT_KINDS.SLIDE_DECK
                    ? normalizeSlides(options.slides || (options.html ? [{
                        html: options.html,
                        name: '第 1 页',
                    }] : null))
                    : [],
            },
            checkpoints: [],
        });
    }

    function sanitizeHtml(html) {
        const template = document.createElement('template');
        template.innerHTML = String(html || '');
        template.content.querySelectorAll(BLOCKED_ELEMENTS).forEach((element) => element.remove());

        template.content.querySelectorAll('*').forEach((element) => {
            for (const attribute of [...element.attributes]) {
                const name = attribute.name.toLowerCase();
                const value = attribute.value.trim();
                if (name.startsWith('on')) {
                    element.removeAttribute(attribute.name);
                    continue;
                }
                if (URL_ATTRIBUTES.includes(name) && /^(?:javascript|vbscript|file):/i.test(value)) {
                    element.removeAttribute(attribute.name);
                }
            }
        });
        return template.innerHTML;
    }

    function sanitizeCss(css) {
        return String(css || '')
            .replace(/@import\s+[^;]+;?/gi, '')
            .replace(/url\(\s*(['"]?)\s*(?:javascript|vbscript|file):[\s\S]*?\1\s*\)/gi, 'none')
            .replace(/expression\s*\([\s\S]*?\)/gi, '');
    }

    function ensureTextNodeIds(html) {
        const template = document.createElement('template');
        template.innerHTML = sanitizeHtml(html);
        template.content.querySelectorAll(PRESERVED_CONTAINER_SELECTOR).forEach((element) => {
            if (!element.hasAttribute('data-vdoc-container')) {
                element.setAttribute('data-vdoc-container', createId('container'));
            }
            element.setAttribute('data-vdoc-preserve', 'true');
        });
        template.content.querySelectorAll(EDITABLE_SELECTOR).forEach((element) => {
            if (!element.hasAttribute('data-vdoc-text')) {
                element.setAttribute('data-vdoc-text', createId('text'));
            }
            if (!element.hasAttribute('data-vdoc-block')) {
                element.setAttribute('data-vdoc-block', createId('block'));
            }
            element.setAttribute('data-vdoc-removable', 'true');
        });
        return template.innerHTML;
    }

    function escapeText(value) {
        return String(value || '').replace(/[&<>]/g, (character) =>
            `&#${character.charCodeAt(0)};`
        );
    }

    function serializeOpeningTag(element) {
        const attributes = [...element.attributes]
            .map((attribute) => ` ${attribute.name}="${String(attribute.value)
                .replace(/[&"]/g, (character) => `&#${character.charCodeAt(0)};`)}"`)
            .join('');
        return `<${element.tagName.toLowerCase()}${attributes}>`;
    }

    function formatHtml(html, indentText = '    ') {
        const template = document.createElement('template');
        template.innerHTML = sanitizeHtml(html);
        const blockTags = new Set([
            'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET',
            'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
            'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
            'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
        ]);
        const voidTags = new Set([
            'AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT',
            'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR',
        ]);
        const whitespaceSensitiveTags = new Set(['PRE', 'CODE', 'TEXTAREA', 'SCRIPT', 'STYLE']);

        const formatElement = (element, depth) => {
            const indent = indentText.repeat(depth);
            if (whitespaceSensitiveTags.has(element.tagName)) {
                return `${indent}${element.outerHTML}`;
            }
            if (voidTags.has(element.tagName)) {
                return `${indent}${element.outerHTML}`;
            }

            const blockChildren = [...element.children].filter((child) => blockTags.has(child.tagName));
            if (!blockChildren.length) {
                return `${indent}${element.outerHTML}`;
            }

            const lines = [`${indent}${serializeOpeningTag(element)}`];
            let inlineBuffer = '';
            const flushInline = () => {
                if (!inlineBuffer.trim()) {
                    inlineBuffer = '';
                    return;
                }
                lines.push(`${indentText.repeat(depth + 1)}${inlineBuffer.trim()}`);
                inlineBuffer = '';
            };

            element.childNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE && blockTags.has(node.tagName)) {
                    flushInline();
                    lines.push(formatElement(node, depth + 1));
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    inlineBuffer += node.outerHTML;
                } else if (node.nodeType === Node.TEXT_NODE) {
                    inlineBuffer += escapeText(node.nodeValue);
                } else if (node.nodeType === Node.COMMENT_NODE) {
                    flushInline();
                    lines.push(`${indentText.repeat(depth + 1)}<!--${node.nodeValue}-->`);
                }
            });
            flushInline();
            lines.push(`${indent}</${element.tagName.toLowerCase()}>`);
            return lines.join('\n');
        };

        const lines = [];
        template.content.childNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
                lines.push(formatElement(node, 0));
            } else if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim()) {
                lines.push(escapeText(node.nodeValue.trim()));
            } else if (node.nodeType === Node.COMMENT_NODE) {
                lines.push(`<!--${node.nodeValue}-->`);
            }
        });
        return lines.join('\n');
    }

    function normalizeDocument(input) {
        const candidate = input && typeof input === 'object' ? input : {};
        const now = new Date().toISOString();
        const manifest = candidate.manifest && typeof candidate.manifest === 'object'
            ? candidate.manifest
            : {};
        return {
            format: FORMAT,
            version: VERSION,
            manifest: {
                id: manifest.id || createId('document'),
                title: String(manifest.title || '未命名文稿'),
                language: String(manifest.language || 'zh-CN'),
                createdAt: manifest.createdAt || now,
                modifiedAt: manifest.modifiedAt || now,
                generator: 'VCP Scriptorium',
                capabilities: {
                    scripts: manifest.scene?.kind === PROJECT_KINDS.SLIDE_DECK,
                    cssAnimations: true,
                    renderedTextEditing: true,
                    sceneDiffs: manifest.scene?.kind === PROJECT_KINDS.SLIDE_DECK,
                },
                fonts: Array.isArray(manifest.fonts) ? manifest.fonts : [],
                resources: Array.isArray(manifest.resources) ? manifest.resources : [],
                styleDependencies: Array.isArray(manifest.styleDependencies)
                    ? [...new Set(manifest.styleDependencies.map(String))]
                    : [],
                embeddedStyles: Array.isArray(manifest.embeddedStyles)
                    ? manifest.embeddedStyles
                    : [],
                scene: createSceneConfig(manifest.scene || {}),
                import: manifest.import || null,
            },
            source: {
                html: manifest.scene?.kind === PROJECT_KINDS.SLIDE_DECK
                    ? ''
                    : formatHtml(ensureTextNodeIds(candidate.source?.html || defaultHtml())),
                css: sanitizeCss(candidate.source?.css || defaultCss()),
                slides: manifest.scene?.kind === PROJECT_KINDS.SLIDE_DECK
                    ? normalizeSlides(
                        candidate.source?.slides
                        || (candidate.source?.html ? [{
                            html: candidate.source.html,
                            name: '第 1 页',
                        }] : null)
                    )
                    : [],
            },
            checkpoints: Array.isArray(candidate.checkpoints) ? candidate.checkpoints : [],
        };
    }

    function parse(bytesOrText) {
        let text = bytesOrText;
        if (bytesOrText instanceof Uint8Array || bytesOrText instanceof ArrayBuffer) {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytesOrText);
        }
        const parsed = JSON.parse(String(text || ''));
        if (parsed?.format !== FORMAT) throw new Error('这不是有效的 VDOCX 文档。');
        return normalizeDocument(parsed);
    }

    function serialize(documentModel) {
        const normalized = normalizeDocument(documentModel);
        normalized.manifest.modifiedAt = new Date().toISOString();
        return JSON.stringify(normalized, null, 2);
    }

    function extractOutline(html) {
        const template = document.createElement('template');
        template.innerHTML = sanitizeHtml(html);
        const items = [];
        template.content.querySelectorAll(EDITABLE_SELECTOR).forEach((element, ordinal) => {
            const text = (element.textContent || '').trim();
            const headingMatch = /^H([1-6])$/.exec(element.tagName);
            items.push({
                id: element.dataset.vdocText || createId('text'),
                ordinal,
                text,
                kind: headingMatch ? 'heading' : 'paragraph',
                level: headingMatch ? Number(headingMatch[1]) : null,
            });
        });
        return items;
    }

    function extensionForKind(kind) {
        return kind === PROJECT_KINDS.SLIDE_DECK ? '.vpptx' : '.vdocx';
    }

    window.VDocCore = Object.freeze({
        FORMAT,
        VERSION,
        PROJECT_KINDS,
        EDITABLE_SELECTOR,
        PRESERVED_CONTAINER_SELECTOR,
        createSceneConfig,
        createSlide,
        normalizeSlides,
        extensionForKind,
        createDocument,
        normalizeDocument,
        parse,
        serialize,
        sanitizeHtml,
        sanitizeCss,
        ensureTextNodeIds,
        formatHtml,
        extractOutline,
    });
})();