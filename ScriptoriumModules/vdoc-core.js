'use strict';

(() => {
    const FORMAT = 'vcp-vdocx';
    const VERSION = 2;
    const SOURCE_FORMATS = Object.freeze({
        MARKDOWN_HYBRID: 'markdown-hybrid',
        HTML_SCENE: 'html-scene',
    });
    const PROJECT_KINDS = Object.freeze({
        FLOW_DOCUMENT: 'flow-document',
        SLIDE_DECK: 'slide-deck',
    });
    const EDITABLE_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,td,th';
    const PRESERVED_CONTAINER_SELECTOR = 'article,main,section,header,footer,aside,nav,figure,table,thead,tbody,tfoot,tr,ul,ol';
    // script 由 ScriptoriumProgrammableContent 执行 warn/refuse 审查并显式激活；
    // 这里只移除可建立独立浏览上下文或插件执行环境的危险宿主元素。
    const BLOCKED_ELEMENTS = 'iframe,object,embed,applet,base,meta[http-equiv],link[rel="import"]';
    const URL_ATTRIBUTES = ['href', 'src', 'poster', 'action', 'formaction', 'xlink:href'];
    const FILE_SOURCE_ELEMENTS = new Set(['IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK']);

    function createId(prefix = 'node') {
        const uuid = globalThis.crypto?.randomUUID?.();
        return `${prefix}-${uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
    }

    function defaultMarkdown() {
        return `# 未命名文稿

> VCP SCRIPTORIUM

人类负责思想与创作，AI 负责润色与排版。请从这里开始共同书写。

## 第一章

在这里落下第一段文字。
`;
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

    function normalizeTransition(value) {
        const candidate = value && typeof value === 'object' && !Array.isArray(value)
            ? value.type ?? value.name ?? value.id ?? value.effect
            : value;
        const normalized = String(candidate || 'none').trim().toLowerCase();
        if (!normalized || normalized === '[object object]') return 'none';
        return /^[a-z][a-z0-9_-]{0,63}$/i.test(normalized) ? normalized : 'none';
    }

    function normalizeAspectRatio(value, fallback = '16 / 9') {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const width = Number(value.width ?? value.x ?? value.numerator);
            const height = Number(value.height ?? value.y ?? value.denominator);
            if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
                return `${width} / ${height}`;
            }
        }
        const normalized = String(value || fallback).trim();
        const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:\/|:)\s*(\d+(?:\.\d+)?)$/);
        if (!match) return fallback;
        const width = Number(match[1]);
        const height = Number(match[2]);
        return width > 0 && height > 0 ? `${width} / ${height}` : fallback;
    }

    function normalizePageLength(value, fallback) {
        if (value === undefined || value === null || value === '') return fallback;
        if (typeof value === 'number') {
            return Number.isFinite(value) && value > 0 ? `${value}px` : fallback;
        }
        const normalized = String(value).trim();
        return /^\d+(?:\.\d+)?$/.test(normalized)
            ? `${normalized}px`
            : normalized || fallback;
    }

    function normalizeTheme(value, fallback = '') {
        const normalized = String(value || fallback).trim();
        return /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(normalized) ? normalized : fallback;
    }

    function normalizeDefaultTransition(value, legacyTransition = 'none') {
        const candidate = value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : { type: value || legacyTransition };
        const duration = Number(candidate.duration ?? candidate.durationMs);
        return {
            type: normalizeTransition(candidate.type ?? candidate.name ?? legacyTransition),
            duration: Number.isFinite(duration) && duration >= 0
                ? Math.min(duration, 60000)
                : 0,
        };
    }

    function splitSlideSource(source) {
        const template = document.createElement('template');
        template.innerHTML = sanitizeHtml(source);
        const inlineScripts = [];
        const inlineStyles = [];
        template.content.querySelectorAll('style').forEach((style) => {
            inlineStyles.push(style.textContent || '');
            style.remove();
        });
        template.content.querySelectorAll('script').forEach((script) => {
            // src 依赖声明必须留在页面结构中，供本地化、审计和单文件导出使用；
            // 无 src 的脚本则交给 Scriptorium 受控生命周期运行时执行。
            if (script.getAttribute('src')
                || script.dataset.vdocLibrary
                || script.dataset.vdocIgnoredSrc
                || script.type === 'application/x-vdoc-ignored-external') {
                return;
            }
            inlineScripts.push(script.textContent || '');
            script.remove();
        });
        return {
            html: template.innerHTML,
            css: sanitizeCss(inlineStyles.join('\n\n')),
            script: inlineScripts.join('\n\n'),
            hadInlineStyle: inlineStyles.length > 0,
            hadInlineScript: inlineScripts.length > 0,
        };
    }

    function composeSlideSource(slide = {}) {
        return String(slide.source || '');
    }

    function normalizeCompleteSource(value, fallback) {
        // 完整源码本身就是唯一文档真相。仅做安全清理、编辑节点标记和
        // 可读格式化；绝不能抽取并重组 style/script，否则会改变标签属性、
        // 执行顺序、DOM 归属以及人类在源码面看到的内容。
        return formatHtml(ensureTextNodeIds(sanitizeHtml(value || fallback)));
    }

    function normalizeCompleteSlideSource(value) {
        return normalizeCompleteSource(value, defaultSlideHtml());
    }

    function normalizeCompleteDocumentSource(value) {
        return normalizeCompleteSource(value, `<style data-vdoc-document-style>
${defaultCss()}
</style>
${defaultHtml()}`);
    }

    function createSlide(input = {}, index = 0) {
        const candidate = input && typeof input === 'object' ? input : {};
        const runtimeTextOverrides = Array.isArray(candidate.runtimeTextOverrides)
            ? candidate.runtimeTextOverrides
                .filter((override) =>
                    override
                    && Array.isArray(override.path)
                    && override.path.every((part) =>
                        Number.isInteger(Number(part)) && Number(part) >= 0
                    )
                    && Number.isInteger(Number(override.textNodeIndex))
                    && Number(override.textNodeIndex) >= 0
                )
                .map((override) => ({
                    path: override.path.map(Number),
                    textNodeIndex: Number(override.textNodeIndex),
                    previousText: String(override.previousText ?? ''),
                    text: String(override.text ?? ''),
                }))
            : [];
        return {
            id: String(candidate.id || createId('slide')),
            name: String(candidate.name || `第 ${index + 1} 页`),
            source: normalizeCompleteSlideSource(candidate.source),
            transition: normalizeTransition(candidate.transition),
            duration: Number.isFinite(Number(candidate.duration))
                ? Math.max(0, Number(candidate.duration))
                : null,
            notes: String(candidate.notes || ''),
            resources: Array.isArray(candidate.resources)
                ? [...new Set(candidate.resources.map(String))]
                : [],
            // 脚本生成文字若无法安全反向定位源码，则以渲染路径覆盖持久化。
            // 该字段属于正式页模型，必须穿过 normalize/parse/serialize。
            runtimeTextOverrides,
            import: candidate.import && typeof candidate.import === 'object'
                ? candidate.import
                : null,
        };
    }

    function normalizeSlides(input) {
        const slides = Array.isArray(input) ? input : [];
        return (slides.length ? slides : [{}]).map(createSlide);
    }

    function splitDocumentSource(source) {
        const template = document.createElement('template');
        template.innerHTML = sanitizeHtml(source);
        return {
            html: template.innerHTML,
        };
    }

    function composeDocumentSource(documentModel = {}) {
        return String(documentModel.source?.content || '');
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
        const presentationInput = input.presentation
            && typeof input.presentation === 'object'
            ? input.presentation
            : {};
        const defaultTransition = normalizeDefaultTransition(
            presentationInput.defaultTransition,
            presentationInput.transition
        );
        return {
            kind,
            orientation: isDeck ? 'landscape' : 'portrait',
            page: {
                width: normalizePageLength(
                    input.page?.width,
                    isDeck ? '13.333in' : '210mm'
                ),
                height: normalizePageLength(
                    input.page?.height,
                    isDeck ? '7.5in' : '297mm'
                ),
                gap: normalizePageLength(input.page?.gap, '24px'),
            },
            pagination: {
                mode: isDeck ? 'explicit' : 'flow',
                keepHeadingsWithNext: !isDeck,
                widows: isDeck ? 1 : 2,
                orphans: isDeck ? 1 : 2,
            },
            presentation: {
                enabled: isDeck,
                navigation: presentationInput.navigation || 'linear',
                transition: defaultTransition.type,
                defaultTransition,
                theme: normalizeTheme(presentationInput.theme),
                loop: Boolean(presentationInput.loop),
                aspectRatio: isDeck
                    ? normalizeAspectRatio(presentationInput.aspectRatio)
                    : null,
            },
        };
    }

    function createDocument(options = {}) {
        const now = new Date().toISOString();
        const flowSource = options.source === undefined
            ? defaultMarkdown()
            : String(options.source);
        return normalizeDocument({
            format: FORMAT,
            version: VERSION,
            manifest: {
                id: createId('document'),
                title: options.title || '未命名文稿',
                language: options.language || 'zh-CN',
                sourceFormat: options.kind === PROJECT_KINDS.SLIDE_DECK
                    ? 'html-scene'
                    : SOURCE_FORMATS.MARKDOWN_HYBRID,
                createdAt: now,
                modifiedAt: now,
                generator: 'VCP Scriptorium',
                capabilities: {
                    scripts: true,
                    programmableContentReview: true,
                    localAnimationLibraries: ['anime', 'three'],
                    cssAnimations: true,
                    renderedTextEditing: true,
                    sceneDiffs: options.kind === PROJECT_KINDS.SLIDE_DECK,
                },
                fonts: [],
                resources: [],
                styleDependencies: [],
                embeddedStyles: [],
                programmableDependencies: [],
                scene: createSceneConfig({
                    kind: options.kind,
                    page: options.page,
                    presentation: options.presentation,
                }),
            },
            source: {
                format: options.kind === PROJECT_KINDS.SLIDE_DECK
                    ? 'html-scene'
                    : SOURCE_FORMATS.MARKDOWN_HYBRID,
                content: options.kind === PROJECT_KINDS.SLIDE_DECK
                    ? ''
                    : flowSource,
                documentCss: options.kind === PROJECT_KINDS.SLIDE_DECK
                    ? ''
                    : sanitizeCss(options.documentCss || defaultCss()),
                lineEnding: options.lineEnding || 'lf',
                deckCss: options.kind === PROJECT_KINDS.SLIDE_DECK
                    ? sanitizeCss(options.deckCss || '')
                    : '',
                slides: options.kind === PROJECT_KINDS.SLIDE_DECK
                    ? normalizeSlides(options.slides)
                    : [],
            },
            checkpoints: [],
        });
    }

    function allowsFileUrl(element, attributeName) {
        if (attributeName === 'poster') return element.tagName === 'VIDEO';
        return attributeName === 'src' && FILE_SOURCE_ELEMENTS.has(element.tagName);
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
                if (!URL_ATTRIBUTES.includes(name)) continue;
                if (/^(?:javascript|vbscript):/i.test(value)
                    || (/^file:/i.test(value) && !allowsFileUrl(element, name))) {
                    element.removeAttribute(attribute.name);
                }
            }
        });
        return template.innerHTML;
    }

    function sanitizeCss(css) {
        return String(css || '')
            .replace(/@import\s+[^;]+;?/gi, '')
            .replace(/url\(\s*(['"]?)\s*(?:javascript|vbscript):[\s\S]*?\1\s*\)/gi, 'none')
            .replace(/expression\s*\([\s\S]*?\)/gi, '');
    }

    function ensureTextNodeIds(html) {
        const template = document.createElement('template');
        template.innerHTML = sanitizeHtml(html);

        // data-vdoc-* 是渲染树定向回写源码的主键，不只是展示元数据。
        // 粘贴 HTML、手工复制源码或旧版导入都可能留下重复值；querySelector
        // 随后只会命中第一个节点，使另一个节点的编辑看似成功却无法保存。
        // 因此归一化既补齐缺失身份，也为重复身份重新签发 ID。
        const ensureUniqueAttribute = (elements, attribute, prefix) => {
            const seen = new Set();
            elements.forEach((element) => {
                const candidate = String(element.getAttribute(attribute) || '').trim();
                let identity = candidate;
                if (!identity || seen.has(identity)) {
                    do {
                        identity = createId(prefix);
                    } while (seen.has(identity));
                    element.setAttribute(attribute, identity);
                }
                seen.add(identity);
            });
        };

        const containers = [
            ...template.content.querySelectorAll(PRESERVED_CONTAINER_SELECTOR),
        ];
        ensureUniqueAttribute(containers, 'data-vdoc-container', 'container');
        containers.forEach((element) => {
            element.setAttribute('data-vdoc-preserve', 'true');
        });

        const editables = [...template.content.querySelectorAll(EDITABLE_SELECTOR)];
        ensureUniqueAttribute(editables, 'data-vdoc-text', 'text');
        ensureUniqueAttribute(editables, 'data-vdoc-block', 'block');
        editables.forEach((element) => {
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
        const deck = manifest.scene?.kind === PROJECT_KINDS.SLIDE_DECK;
        const storedVersion = Number(candidate.version || VERSION);
        if (storedVersion !== VERSION) {
            throw new Error(`不支持 VDOCX v${storedVersion}；当前内核只接受 v${VERSION}。`);
        }
        const expectedSourceFormat = deck
            ? SOURCE_FORMATS.HTML_SCENE
            : SOURCE_FORMATS.MARKDOWN_HYBRID;
        const suppliedSourceFormat = String(
            candidate.source?.format || manifest.sourceFormat || expectedSourceFormat
        );
        if (suppliedSourceFormat !== expectedSourceFormat) {
            throw new Error(
                `正文格式 ${suppliedSourceFormat} 不受支持；当前工程要求 ${expectedSourceFormat}。`
            );
        }
        const sourceFormat = expectedSourceFormat;
        const rawFlowSource = candidate.source?.content === undefined
            ? defaultMarkdown()
            : String(candidate.source.content);
        return {
            format: FORMAT,
            version: VERSION,
            manifest: {
                id: manifest.id || createId('document'),
                title: String(manifest.title || '未命名文稿'),
                language: String(manifest.language || 'zh-CN'),
                sourceFormat,
                createdAt: manifest.createdAt || now,
                modifiedAt: manifest.modifiedAt || now,
                generator: 'VCP Scriptorium',
                capabilities: {
                    scripts: true,
                    programmableContentReview: true,
                    localAnimationLibraries: ['anime', 'three'],
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
                programmableDependencies: Array.isArray(manifest.programmableDependencies)
                    ? [...new Set(
                        manifest.programmableDependencies
                            .map(String)
                            .filter((item) => ['anime', 'three'].includes(item))
                    )]
                    : [],
                scene: createSceneConfig(manifest.scene || {}),
                import: manifest.import || null,
            },
            source: {
                format: sourceFormat,
                content: deck ? '' : rawFlowSource,
                documentCss: deck
                    ? ''
                    : sanitizeCss(candidate.source?.documentCss || defaultCss()),
                lineEnding: ['lf', 'crlf', 'cr'].includes(candidate.source?.lineEnding)
                    ? candidate.source.lineEnding
                    : (rawFlowSource.includes('\r\n') ? 'crlf' : 'lf'),
                deckCss: deck
                    ? sanitizeCss(candidate.source?.deckCss || '')
                    : '',
                slides: deck
                    ? normalizeSlides(candidate.source?.slides)
                    : [],
            },
            anchors: Array.isArray(candidate.anchors) ? candidate.anchors : [],
            islands: Array.isArray(candidate.islands) ? candidate.islands : [],
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
        SOURCE_FORMATS,
        PROJECT_KINDS,
        EDITABLE_SELECTOR,
        PRESERVED_CONTAINER_SELECTOR,
        createSceneConfig,
        splitDocumentSource,
        composeDocumentSource,
        splitSlideSource,
        composeSlideSource,
        normalizeCompleteSource,
        normalizeCompleteSlideSource,
        normalizeCompleteDocumentSource,
        createSlide,
        normalizeSlides,
        normalizeTransition,
        normalizeAspectRatio,
        normalizePageLength,
        normalizeTheme,
        normalizeDefaultTransition,
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