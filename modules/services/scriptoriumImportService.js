'use strict';

const path = require('path');
const { marked } = require('marked');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const cheerio = require('cheerio');
const hljs = require('../../vendor/highlight.min.js');
const TurndownService = require('turndown');
const scriptoriumPptxImportService = require('./scriptoriumPptxImportService');

const IMPORTER_VERSION = 5;
const MARKDOWN_DOCUMENT_STYLE = `
.vdoc-markdown-table {
    width: 100%;
    margin: 1em 0;
    border: 1px solid currentColor;
    border-collapse: collapse;
    border-spacing: 0;
}
.vdoc-markdown-table th,
.vdoc-markdown-table td {
    min-width: 2em;
    padding: .45em .65em;
    border: 1px solid currentColor;
    text-align: left;
    vertical-align: top;
}
.vdoc-markdown-table th {
    font-weight: 600;
    background: rgba(127, 127, 127, .12);
}
.vdoc-code-block {
    margin: 1em 0;
    padding: 1em 1.15em;
    border: 1px solid #364150;
    border-radius: 6px;
    overflow: auto;
    color: #d8dee9;
    background: #20262e;
    font: 10.5pt/1.6 "Cascadia Code", "SFMono-Regular", Consolas, monospace;
    tab-size: 4;
    white-space: pre;
}
.vdoc-code-block code {
    font: inherit;
}
.vdoc-code-block .hljs-comment,
.vdoc-code-block .hljs-quote { color: #8290a3; font-style: italic; }
.vdoc-code-block .hljs-keyword,
.vdoc-code-block .hljs-selector-tag,
.vdoc-code-block .hljs-literal { color: #c792ea; }
.vdoc-code-block .hljs-string,
.vdoc-code-block .hljs-regexp,
.vdoc-code-block .hljs-addition,
.vdoc-code-block .hljs-attribute { color: #a3d98b; }
.vdoc-code-block .hljs-number,
.vdoc-code-block .hljs-symbol,
.vdoc-code-block .hljs-bullet { color: #f2b67a; }
.vdoc-code-block .hljs-title,
.vdoc-code-block .hljs-section,
.vdoc-code-block .hljs-function { color: #82cfff; }
.vdoc-code-block .hljs-built_in,
.vdoc-code-block .hljs-type,
.vdoc-code-block .hljs-class .hljs-title { color: #ffd580; }
.vdoc-code-block .hljs-variable,
.vdoc-code-block .hljs-template-variable,
.vdoc-code-block .hljs-params { color: #f3a6b7; }
.vdoc-code-block .hljs-meta,
.vdoc-code-block .hljs-doctag { color: #7fdbca; }
.vdoc-code-block .hljs-emphasis { font-style: italic; }
.vdoc-code-block .hljs-strong { font-weight: 700; }
.vdoc-code-block .hljs-deletion { color: #ff8f8f; }
`.trim();
const SUPPORTED_EXTENSIONS = new Set([
    '.html', '.htm', '.md', '.markdown', '.txt', '.rtf', '.docx', '.pptx',
]);

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (character) =>
        `&#${character.charCodeAt(0)};`
    );
}

function encodeAttribute(value) {
    return escapeHtml(encodeURIComponent(String(value || '')));
}

function createMathNode(latex, displayMode) {
    const tag = displayMode ? 'div' : 'span';
    const className = displayMode ? 'vdoc-math vdoc-math-display' : 'vdoc-math vdoc-math-inline';
    return `<${tag} class="${className}" data-vdoc-math="${encodeAttribute(latex.trim())}" data-vdoc-display="${displayMode}">${escapeHtml(latex.trim())}</${tag}>`;
}

function protectMarkdownMath(markdown) {
    const placeholders = new Map();
    let sequence = 0;
    const reserve = (latex, displayMode) => {
        const token = `VCPMATHPLACEHOLDER${sequence += 1}END`;
        placeholders.set(token, createMathNode(latex, displayMode));
        return token;
    };

    let protectedText = String(markdown || '');
    protectedText = protectedText.replace(/\$\$([\s\S]+?)\$\$/g, (_match, latex) => reserve(latex, true));
    protectedText = protectedText.replace(/\\\[([\s\S]+?)\\\]/g, (_match, latex) => reserve(latex, true));
    protectedText = protectedText.replace(/\\\(([\s\S]+?)\\\)/g, (_match, latex) => reserve(latex, false));
    protectedText = protectedText.replace(/(^|[^\\$])\$([^\n$]+?)\$/g, (_match, prefix, latex) =>
        `${prefix}${reserve(latex, false)}`
    );

    return { protectedText, placeholders };
}

function restoreMarkdownMath(html, placeholders) {
    let restored = String(html || '');
    placeholders.forEach((node, token) => {
        restored = restored.replaceAll(token, node);
    });
    return restored;
}

function normalizeMarkdownDocumentHtml(html) {
    const $ = cheerio.load(
        `<main data-vdoc-markdown-root>${String(html || '')}</main>`,
        null,
        false
    );
    const root = $('main[data-vdoc-markdown-root]');
    let styledContent = false;

    root.find('table').each((_index, table) => {
        $(table).addClass('vdoc-markdown-table');
        styledContent = true;
    });

    root.find('pre > code').each((_index, code) => {
        const codeElement = $(code);
        const pre = codeElement.parent();
        const source = codeElement.text();
        const declaredLanguage = String(
            codeElement.attr('class')?.match(/(?:^|\s)language-([^\s]+)/)?.[1] || ''
        ).trim().toLowerCase();

        const supportedLanguage = declaredLanguage
            && hljs.getLanguage(declaredLanguage)
            ? declaredLanguage
            : 'plaintext';
        // 未声明或无法识别的围栏语言按纯文本处理。自动猜测会把普通文字
        // 误判为 SCSS、SQL 等语言，使同一源码在高亮库升级后产生不同结果。
        const highlighted = hljs.highlight(source, {
            language: supportedLanguage,
            ignoreIllegals: true,
        });
        const resolvedLanguage = supportedLanguage;
        pre.addClass('vdoc-code-block');
        pre.attr('data-vdoc-code-language', resolvedLanguage);
        codeElement
            .removeClass()
            .addClass(`hljs language-${resolvedLanguage}`)
            .attr('data-vdoc-code-language', resolvedLanguage)
            .html(highlighted.value);
        styledContent = true;
    });

    if (styledContent) {
        root.prepend(
            `<style data-vdoc-markdown-style>\n${MARKDOWN_DOCUMENT_STYLE}\n</style>`
        );
    }
    return root.html() || '';
}

function convertMarkdown(markdown) {
    const { protectedText, placeholders } = protectMarkdownMath(markdown);
    const html = marked.parse(protectedText, {
        gfm: true,
        breaks: false,
        async: false,
    });
    return normalizeMarkdownDocumentHtml(
        restoreMarkdownMath(html, placeholders)
    );
}

function convertPlainText(text) {
    const normalized = String(text || '').replace(/\r\n?/g, '\n');
    const blocks = normalized.split(/\n{2,}/);
    return blocks
        .map((block) => {
            const lines = block.split('\n');
            const content = lines.map(escapeHtml).join('<br>');
            return content.trim() ? `<p>${content}</p>` : '';
        })
        .filter(Boolean)
        .join('\n');
}

function normalizeDocxIndentForMarkdown(html) {
    const $ = cheerio.load(
        `<main data-vdoc-indent-root>${String(html || '')}</main>`,
        null,
        false
    );
    const root = $('main[data-vdoc-indent-root]');

    root.find('p[style]').each((_index, paragraph) => {
        const element = $(paragraph);
        const declarations = String(element.attr('style') || '')
            .split(';')
            .map((declaration) => declaration.trim())
            .filter(Boolean);
        if (declarations.length !== 1) return;

        const indent = declarations[0].match(
            /^text-indent\s*:\s*([+]?(?:\d+(?:\.\d+)?|\.\d+))(em|pt)$/i
        );
        if (!indent || Number(indent[1]) <= 0) return;

        // Markdown 行首四个 ASCII 空格表示代码块，不能用来模拟段落缩进。
        // 两个全角空格既能表达中文正文约两字符首行缩进，又允许 Turndown
        // 继续把段内 strong/em 等纯语义标签转换为 Markdown 标记。
        element.removeAttr('style');
        element.prepend('　　');
    });

    return root.html() || '';
}

function htmlToHybridMarkdown(html) {
    const turndown = new TurndownService({
        headingStyle: 'atx',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        strongDelimiter: '**',
    });
    // Markdown 无法无损表达的结构继续作为一等 HTML 源码域保留。
    turndown.keep([
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
        'style', 'script', 'svg', 'canvas', 'video', 'audio',
    ]);
    turndown.addRule('preserve-styled-layout', {
        filter(node) {
            if (!node?.getAttribute) return false;
            return Boolean(
                node.getAttribute('style')
                || node.getAttribute('class')
                || node.getAttribute('data-vdoc-island')
            );
        },
        replacement(_content, node) {
            return `\n\n${node.outerHTML}\n\n`;
        },
    });
    return turndown.turndown(normalizeDocxIndentForMarkdown(html));
}

function decodeRtfHex(source) {
    return source.replace(/\\'([0-9a-f]{2})/gi, (_match, hex) =>
        Buffer.from([Number.parseInt(hex, 16)]).toString('latin1')
    );
}

function convertRtf(rtf) {
    let source = decodeRtfHex(String(rtf || ''));
    source = source
        .replace(/\\u(-?\d+)\??/g, (_match, rawCode) => {
            let code = Number(rawCode);
            if (code < 0) code += 65536;
            return String.fromCharCode(code);
        })
        .replace(/\\par[d]?\b/g, '\n\n')
        .replace(/\\line\b/g, '\n')
        .replace(/\\tab\b/g, '\t')
        .replace(/\\emdash\b/g, '—')
        .replace(/\\endash\b/g, '–')
        .replace(/\\lquote\b/g, '‘')
        .replace(/\\rquote\b/g, '’')
        .replace(/\\ldblquote\b/g, '“')
        .replace(/\\rdblquote\b/g, '”')
        .replace(/\\~|\\ /g, ' ')
        .replace(/\\\{/g, '{')
        .replace(/\\\}/g, '}')
        .replace(/\\\\/g, '\\');

    source = source
        .replace(/\{\\fonttbl[\s\S]*?\}\s*/gi, '')
        .replace(/\{\\colortbl[\s\S]*?\}\s*/gi, '')
        .replace(/\{\\stylesheet[\s\S]*?\}\s*/gi, '')
        .replace(/\{\\info[\s\S]*?\}\s*/gi, '')
        .replace(/\{\\\*[\s\S]*?\}\s*/g, '')
        .replace(/\\[a-z]+-?\d*\s?/gi, '')
        .replace(/[{}]/g, '')
        .replace(/\n[ \t]+/g, '\n')
        .trim();

    return convertPlainText(source);
}

function decodeXml(value) {
    return String(value || '')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, "'")
        .replace(/&/g, '&');
}

function xmlAttribute(source, name) {
    const escapedName = name.replace(':', '\\:');
    const match = String(source || '').match(new RegExp(`\\b${escapedName}=(?:"([^"]*)"|'([^']*)')`, 'i'));
    return decodeXml(match?.[1] ?? match?.[2] ?? '');
}

function firstXmlElement(source, localName) {
    const match = String(source || '').match(
        new RegExp(`<w:${localName}\\b([^>]*)\\/?>`, 'i')
    );
    return match ? { attributes: match[1], value: xmlAttribute(match[1], 'w:val') } : null;
}

function docxLengthToCss(rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value === 0) return '';
    return `${Number((value / 20).toFixed(3))}pt`;
}

function docxCharacterIndentToCss(rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value === 0) return '';
    return `${Number((value / 100).toFixed(3))}em`;
}

function parseDocxParagraphFormat(paragraphProperties) {
    const alignmentValue = firstXmlElement(paragraphProperties, 'jc')?.value.toLowerCase() || '';
    const alignment = {
        left: 'left',
        start: 'start',
        center: 'center',
        right: 'right',
        end: 'end',
        both: 'justify',
        distribute: 'justify',
        thaiDistribute: 'justify',
    }[alignmentValue] || '';

    const indentation = firstXmlElement(paragraphProperties, 'ind')?.attributes || '';
    const firstLineChars = xmlAttribute(indentation, 'w:firstLineChars');
    const hangingChars = xmlAttribute(indentation, 'w:hangingChars');
    const firstLine = xmlAttribute(indentation, 'w:firstLine');
    const hanging = xmlAttribute(indentation, 'w:hanging');
    const textIndentExplicit = /\bw:(?:firstLineChars|hangingChars|firstLine|hanging)=/i
        .test(indentation);
    let textIndent = '';
    if (firstLineChars) textIndent = docxCharacterIndentToCss(firstLineChars);
    else if (hangingChars) {
        const value = docxCharacterIndentToCss(hangingChars);
        textIndent = value ? `-${value}` : '';
    } else if (firstLine) textIndent = docxLengthToCss(firstLine);
    else if (hanging) {
        const value = docxLengthToCss(hanging);
        textIndent = value ? `-${value}` : '';
    }

    return {
        textAlign: alignment,
        textIndent,
        textIndentExplicit,
        marginLeft: docxLengthToCss(
            xmlAttribute(indentation, 'w:start') || xmlAttribute(indentation, 'w:left')
        ),
        marginRight: docxLengthToCss(
            xmlAttribute(indentation, 'w:end') || xmlAttribute(indentation, 'w:right')
        ),
    };
}

function parseDocxStyles(stylesXml) {
    const styles = new Map();
    const pattern = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/gi;
    let match;
    while ((match = pattern.exec(String(stylesXml || '')))) {
        if (xmlAttribute(match[1], 'w:type') !== 'paragraph') continue;
        const id = xmlAttribute(match[1], 'w:styleId');
        if (!id) continue;
        const paragraphProperties = match[2].match(
            /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/i
        )?.[1] || '';
        styles.set(id, {
            id,
            name: firstXmlElement(match[2], 'name')?.value || id,
            basedOn: firstXmlElement(match[2], 'basedOn')?.value || '',
            outlineLevel: Number.parseInt(firstXmlElement(match[2], 'outlineLvl')?.value, 10),
            paragraphFormat: parseDocxParagraphFormat(paragraphProperties),
        });
    }
    return styles;
}

function headingLevelFromName(value) {
    const normalized = String(value || '').trim();
    if (/^(?:title|标题)$/i.test(normalized)) return 1;
    const match = normalized.match(/^(?:heading|标题)\s*([1-6])$/i);
    return match ? Number(match[1]) : null;
}

function headingLevelFromText(value) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (/^第\s*[〇零一二三四五六七八九十百千万两\d]+\s*[章节篇部卷](?:\s|[：:、.．—-]|$)/.test(normalized)) {
        return 1;
    }
    return null;
}

function resolveStyleHeadingLevel(styleId, styles, visited = new Set()) {
    if (!styleId || visited.has(styleId)) return null;
    visited.add(styleId);
    const style = styles.get(styleId);
    if (!style) return headingLevelFromName(styleId);
    if (Number.isInteger(style.outlineLevel) && style.outlineLevel >= 0 && style.outlineLevel <= 5) {
        return style.outlineLevel + 1;
    }
    return headingLevelFromName(style.name)
        || headingLevelFromName(style.id)
        || resolveStyleHeadingLevel(style.basedOn, styles, visited);
}

function mergeParagraphFormats(base = {}, override = {}) {
    const meaningful = (format) => Object.fromEntries(
        Object.entries(format).filter(([key, value]) =>
            value || (key === 'textIndentExplicit' && value === true)
        )
    );
    return {
        ...meaningful(base),
        ...meaningful(override),
    };
}

function resolveStyleParagraphFormat(styleId, styles, visited = new Set()) {
    if (!styleId || visited.has(styleId)) return {};
    visited.add(styleId);
    const style = styles.get(styleId);
    if (!style) return {};
    const inherited = resolveStyleParagraphFormat(style.basedOn, styles, visited);
    return mergeParagraphFormats(inherited, style.paragraphFormat);
}

function paragraphText(paragraphXml) {
    const parts = [];
    const pattern = /<w:(t|tab|br)\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:\1>)/gi;
    let match;
    while ((match = pattern.exec(String(paragraphXml || '')))) {
        if (match[1].toLowerCase() === 'tab') parts.push('\t');
        else if (match[1].toLowerCase() === 'br') parts.push('\n');
        else parts.push(decodeXml(match[2] || ''));
    }
    return parts.join('');
}

function hasExplicitDocxPageBreak(paragraphXml) {
    // lastRenderedPageBreak 只是 Word 在特定字体、打印机和页面设置下的
    // 上次自动分页缓存，并非作者插入的硬分页。导入后排版环境改变，
    // 若继续套用会在标题或段落下制造大块空白，因此只保留显式分页。
    return /<w:pageBreakBefore\b/i.test(paragraphXml)
        || /<w:br\b[^>]*\bw:type=(?:"page"|'page')/i.test(paragraphXml);
}

function normalizeComparableText(value) {
    return String(value || '').replace(/\s+/g, '').trim();
}

function leadingTabCount(value) {
    return String(value || '').match(/^\t+/)?.[0].length || 0;
}

function removeLeadingTabsFromElement(element, count) {
    let remaining = Math.max(0, Number(count) || 0);
    const visit = (node) => {
        if (!node || remaining <= 0) return;
        if (node.type === 'text') {
            const match = String(node.data || '').match(/^\t+/);
            if (!match) return;
            const removed = Math.min(remaining, match[0].length);
            node.data = match[0].slice(removed) + String(node.data || '').slice(match[0].length);
            remaining -= removed;
            return;
        }
        for (const child of node.children || []) {
            if (remaining <= 0) break;
            if (child.type === 'text' && !String(child.data || '').length) continue;
            visit(child);
            if (child.type === 'text' && String(child.data || '').replace(/^\t+/, '').length) break;
        }
    };
    visit(element);
    return count - remaining;
}

function isNaturalLeftAlignedDocxParagraph(paragraph) {
    const format = paragraph.paragraphFormat || {};
    return !paragraph.headingLevel
        && !paragraph.hasNumbering
        && !paragraph.hasLeadingWhitespace
        && ['', 'left', 'start', 'justify'].includes(format.textAlign || '');
}

function applyDominantDocxTextIndent(paragraphs) {
    const frequencies = new Map();
    paragraphs.forEach((paragraph) => {
        const format = paragraph.paragraphFormat || {};
        if (!isNaturalLeftAlignedDocxParagraph(paragraph) || !format.textIndent) {
            return;
        }
        frequencies.set(format.textIndent, (frequencies.get(format.textIndent) || 0) + 1);
    });
    const dominant = [...frequencies.entries()]
        .sort((left, right) => right[1] - left[1])[0];
    // 少量特殊段落不能定义整篇正文的排版习惯。真实长文中至少三个
    // 一致缩进才作为缺省正文缩进，显式零缩进仍保持无缩进。
    if (!dominant || dominant[1] < 3) return paragraphs;

    paragraphs.forEach((paragraph) => {
        const format = paragraph.paragraphFormat || {};
        if (!isNaturalLeftAlignedDocxParagraph(paragraph)
            || format.textIndentExplicit
            || format.textIndent) {
            return;
        }
        paragraph.paragraphFormat = {
            ...format,
            textIndent: dominant[0],
            textIndentInferred: true,
        };
    });
    return paragraphs;
}

function parseDocxParagraphs(documentXml, styles) {
    const paragraphs = [];
    const pattern = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi;
    let pendingPageBreak = false;
    let match;
    while ((match = pattern.exec(String(documentXml || '')))) {
        const xml = match[1];
        const text = paragraphText(xml);
        const paragraphProperties = xml.match(
            /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/i
        )?.[1] || '';
        const styleId = firstXmlElement(paragraphProperties, 'pStyle')?.value || '';
        const directOutlineLevel = Number.parseInt(
            firstXmlElement(paragraphProperties, 'outlineLvl')?.value,
            10
        );
        const explicitHeadingLevel = Number.isInteger(directOutlineLevel)
            && directOutlineLevel >= 0
            && directOutlineLevel <= 5
            ? directOutlineLevel + 1
            : null;
        const pageBreak = hasExplicitDocxPageBreak(xml);
        if (!normalizeComparableText(text)) {
            pendingPageBreak ||= pageBreak;
            continue;
        }
        const inheritedFormat = resolveStyleParagraphFormat(styleId, styles);
        const directFormat = parseDocxParagraphFormat(paragraphProperties);
        const tabsAtStart = leadingTabCount(text);
        const paragraphFormat = mergeParagraphFormats(inheritedFormat, directFormat);
        // Word 的段首 w:tab 是显式排版操作。HTML 会折叠它，使其既不可见又
        // 阻断编辑器的段首判断，因此转换为稳定的 CSS 首行缩进。
        if (tabsAtStart && !paragraphFormat.textIndentExplicit) {
            paragraphFormat.textIndent = `${tabsAtStart * 2}em`;
            paragraphFormat.textIndentExplicit = true;
            paragraphFormat.textIndentFromLeadingTabs = true;
        }
        paragraphs.push({
            text,
            comparableText: normalizeComparableText(text),
            leadingTabCount: tabsAtStart,
            hasLeadingWhitespace: /^[\s\u00a0\u3000]/u.test(text),
            hasNumbering: /<w:numPr\b/i.test(paragraphProperties),
            headingLevel: explicitHeadingLevel
                || resolveStyleHeadingLevel(styleId, styles)
                || headingLevelFromText(text),
            paragraphFormat,
            pageBreakBefore: pendingPageBreak || /<w:pageBreakBefore\b/i.test(xml),
            pageBreakAfter: pageBreak && !/<w:pageBreakBefore\b/i.test(xml),
        });
        pendingPageBreak = false;
    }
    return applyDominantDocxTextIndent(paragraphs);
}

function buildDocxStyleMap(styles) {
    const mappings = [];
    styles.forEach((style) => {
        const level = resolveStyleHeadingLevel(style.id, styles);
        if (!level) return;
        const escapedId = style.id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const escapedName = style.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        mappings.push(`p[style-id='${escapedId}'] => h${level}:fresh`);
        if (style.name) mappings.push(`p[style-name='${escapedName}'] => h${level}:fresh`);
    });
    return [...new Set(mappings)];
}

function applyDocxParagraphSemantics(html, paragraphs) {
    const $ = cheerio.load(`<main data-vdoc-import-root>${String(html || '')}</main>`, null, false);
    const candidates = $('main[data-vdoc-import-root]').find('p,h1,h2,h3,h4,h5,h6,li,blockquote');
    let paragraphIndex = 0;
    candidates.each((_index, element) => {
        const comparableText = normalizeComparableText($(element).text());
        if (!comparableText) return;

        let matchIndex = -1;
        const searchEnd = Math.min(paragraphs.length, paragraphIndex + 12);
        for (let index = paragraphIndex; index < searchEnd; index += 1) {
            const sourceText = paragraphs[index].comparableText;
            if (sourceText === comparableText
                || sourceText.includes(comparableText)
                || comparableText.includes(sourceText)) {
                matchIndex = index;
                break;
            }
        }
        if (matchIndex < 0) return;

        const semantic = paragraphs[matchIndex];
        paragraphIndex = matchIndex + 1;
        if (semantic.leadingTabCount) {
            removeLeadingTabsFromElement(element, semantic.leadingTabCount);
        }
        if (semantic.headingLevel && !/^(?:li|blockquote)$/i.test(element.tagName)) {
            element.tagName = `h${semantic.headingLevel}`;
            element.name = element.tagName;
        }
        const format = semantic.paragraphFormat || {};
        const inferredIndentAllowed = !/^(?:li|blockquote)$/i.test(element.tagName);
        const declarations = [
            format.textAlign ? `text-align:${format.textAlign}` : '',
            format.textIndent && (!format.textIndentInferred || inferredIndentAllowed)
                ? `text-indent:${format.textIndent}`
                : '',
            format.marginLeft ? `margin-left:${format.marginLeft}` : '',
            format.marginRight ? `margin-right:${format.marginRight}` : '',
        ].filter(Boolean);
        if (declarations.length) {
            const existingStyle = String($(element).attr('style') || '').trim();
            $(element).attr(
                'style',
                `${existingStyle}${existingStyle && !existingStyle.endsWith(';') ? ';' : ''}${
                    declarations.join(';')
                }`
            );
        }
        if (semantic.pageBreakBefore) $(element).attr('data-vdoc-page-break-before', 'true');
        if (semantic.pageBreakAfter) $(element).attr('data-vdoc-page-break-after', 'true');
    });
    return $('main[data-vdoc-import-root]').html() || '';
}

function normalizeMammothHtml(html) {
    // Mammoth 对 Word 空段落输出空的 <p></p>。保留其文档顺序，并加入 BR
    // 作为 contenteditable 的稳定占位；带显式 w:br 的段落本身已有内容，
    // 不会命中这里，也就不会被误标记为空白行。
    return String(html || '').replace(
        /<p(?:\s[^>]*)?>\s*<\/p>/gi,
        '<p data-vdoc-empty-line="true"><br></p>'
    );
}

async function inspectDocx(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const [stylesXml, documentXml] = await Promise.all([
        zip.file('word/styles.xml')?.async('string') || '',
        zip.file('word/document.xml')?.async('string') || '',
    ]);
    const styles = parseDocxStyles(stylesXml);
    return {
        styleMap: buildDocxStyleMap(styles),
        paragraphs: parseDocxParagraphs(documentXml, styles),
    };
}

async function convertDocx(buffer) {
    const inspection = await inspectDocx(buffer);
    const result = await mammoth.convertToHtml(
        { buffer },
        {
            styleMap: inspection.styleMap,
            includeDefaultStyleMap: true,
            // 空段落是作者实际留下的垂直节奏，不应在语义导入时丢弃。
            ignoreEmptyParagraphs: false,
            // Word 自动分页位置依赖原机器的字体和打印布局；导入后重新流排。
            ignoreLastRenderedPageBreaks: true,
        }
    );
    return {
        html: applyDocxParagraphSemantics(
            normalizeMammothHtml(result.value),
            inspection.paragraphs
        ),
        warnings: result.messages.map((message) => ({
            type: message.type || 'warning',
            message: message.message || String(message),
        })),
    };
}

function kindForExtension(extension) {
    if (extension === '.md' || extension === '.markdown') return 'markdown';
    if (extension === '.txt') return 'text';
    if (extension === '.rtf') return 'rtf';
    if (extension === '.docx') return 'docx';
    if (extension === '.pptx') return 'pptx';
    if (extension === '.html' || extension === '.htm') return 'html';
    return null;
}

async function importBuffer(filePath, buffer) {
    const extension = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
        throw new Error(`不支持的导入格式：${extension || '未知格式'}`);
    }

    const kind = kindForExtension(extension);
    let html = '';
    let source = '';
    let sourceFormat = kind === 'pptx' ? 'html-scene' : 'markdown-hybrid';
    let lineEnding = 'lf';
    let slides = [];
    let page = null;
    let warnings = [];
    if (kind === 'docx') {
        const converted = await convertDocx(buffer);
        source = htmlToHybridMarkdown(converted.html);
        warnings = converted.warnings;
    } else if (kind === 'pptx') {
        const converted = await scriptoriumPptxImportService.convertPptx(buffer);
        slides = converted.slides;
        page = converted.page;
        warnings = converted.warnings;
    } else {
        const text = Buffer.from(buffer).toString('utf8').replace(/^\uFEFF/, '');
        lineEnding = text.includes('\r\n') ? 'crlf'
            : text.includes('\r') ? 'cr' : 'lf';
        if (kind === 'markdown') {
            // 不编译、不格式化、不统一换行：解码后的 Markdown 原文直接入库。
            source = text;
        } else if (kind === 'text') {
            source = String(text);
        } else if (kind === 'rtf') {
            source = htmlToHybridMarkdown(convertRtf(text));
        } else {
            // HTML 本身是 markdown-hybrid 中正式的一等源码域，无需旧格式包装。
            source = text;
        }
    }

    return {
        kind,
        html,
        source,
        sourceFormat,
        lineEnding,
        slides,
        page,
        importMetadata: {
            sourceFormat: kind,
            documentSourceFormat: sourceFormat,
            sourceName: path.basename(filePath),
            importedAt: new Date().toISOString(),
            importer: kind === 'markdown'
                ? `scriptorium-original-source-import-v${IMPORTER_VERSION + 1}`
                : `scriptorium-semantic-import-v${IMPORTER_VERSION}`,
            lineEnding: kind === 'markdown' ? lineEnding : null,
            warnings,
        },
    };
}

module.exports = {
    IMPORTER_VERSION,
    SUPPORTED_EXTENSIONS,
    escapeHtml,
    protectMarkdownMath,
    restoreMarkdownMath,
    normalizeMarkdownDocumentHtml,
    convertMarkdown,
    convertPlainText,
    normalizeDocxIndentForMarkdown,
    htmlToHybridMarkdown,
    convertRtf,
    parseDocxStyles,
    parseDocxParagraphFormat,
    leadingTabCount,
    removeLeadingTabsFromElement,
    isNaturalLeftAlignedDocxParagraph,
    applyDominantDocxTextIndent,
    resolveStyleHeadingLevel,
    resolveStyleParagraphFormat,
    headingLevelFromText,
    parseDocxParagraphs,
    inspectDocx,
    convertDocx,
    importBuffer,
};