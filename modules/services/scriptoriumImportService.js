'use strict';

const path = require('path');
const { marked } = require('marked');
const mammoth = require('mammoth');

const IMPORTER_VERSION = 1;
const SUPPORTED_EXTENSIONS = new Set(['.html', '.htm', '.md', '.markdown', '.txt', '.rtf', '.docx']);

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

function convertMarkdown(markdown) {
    const { protectedText, placeholders } = protectMarkdownMath(markdown);
    const html = marked.parse(protectedText, {
        gfm: true,
        breaks: false,
        async: false,
    });
    return restoreMarkdownMath(html, placeholders);
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

function normalizeMammothHtml(html) {
    return String(html || '')
        .replace(/<p><strong>([^<]{1,120})<\/strong><\/p>/g, '<h2>$1</h2>')
        .replace(/<p>\s*<\/p>/g, '');
}

async function convertDocx(buffer) {
    const result = await mammoth.convertToHtml(
        { buffer },
        {
            styleMap: [
                "p[style-name='Title'] => h1:fresh",
                "p[style-name='标题'] => h1:fresh",
                "p[style-name='Heading 1'] => h1:fresh",
                "p[style-name='标题 1'] => h1:fresh",
                "p[style-name='Heading 2'] => h2:fresh",
                "p[style-name='标题 2'] => h2:fresh",
                "p[style-name='Heading 3'] => h3:fresh",
                "p[style-name='标题 3'] => h3:fresh",
                "p[style-name='Heading 4'] => h4:fresh",
                "p[style-name='标题 4'] => h4:fresh",
                "p[style-name='Heading 5'] => h5:fresh",
                "p[style-name='标题 5'] => h5:fresh",
                "p[style-name='Heading 6'] => h6:fresh",
                "p[style-name='标题 6'] => h6:fresh",
            ],
            includeDefaultStyleMap: true,
            ignoreEmptyParagraphs: true,
        }
    );
    return {
        html: normalizeMammothHtml(result.value),
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
    let warnings = [];
    if (kind === 'docx') {
        const converted = await convertDocx(buffer);
        html = converted.html;
        warnings = converted.warnings;
    } else {
        const text = Buffer.from(buffer).toString('utf8').replace(/^\uFEFF/, '');
        if (kind === 'markdown') html = convertMarkdown(text);
        else if (kind === 'text') html = convertPlainText(text);
        else if (kind === 'rtf') html = convertRtf(text);
        else html = text;
    }

    return {
        kind,
        html,
        importMetadata: {
            sourceFormat: kind,
            sourceName: path.basename(filePath),
            importedAt: new Date().toISOString(),
            importer: `scriptorium-semantic-import-v${IMPORTER_VERSION}`,
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
    convertMarkdown,
    convertPlainText,
    convertRtf,
    convertDocx,
    importBuffer,
};