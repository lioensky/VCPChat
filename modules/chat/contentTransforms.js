/** Pure content transforms used by ContentRuntime; no DOM or Electron access. */
import { collectMarkdownCodeDomains } from '../renderer/markdownCodeDomainScanner.js';

const HTML_ENTITIES = Object.freeze({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" });
const CODE_ATTR_PATTERN = '((?:"[^"]*"|\'[^\']*\'|[^\'">])*)';
const MERMAID_CLASS_ATTR_RE = /\bclass\s*=\s*(?:"[^"]*\b(?:language-)?mermaid\b[^"]*"|'[^']*\b(?:language-)?mermaid\b[^']*')/i;
const GRAPH_DIAGRAM_BODY_RE = /^(?:TD|TB|LR|RL|BT)\b[^\n]*(?:\r?\n|;|-->|---|-\.-|==>)|\r?\n[\s\S]*\S/i;

const PRE_WRAPPED_CODE_PREFIX_RE = new RegExp(`(<pre(?:\\s[^>]*)?>\\s*)?<code${CODE_ATTR_PATTERN}>\\s*(flowchart|graph|mermaid)(\\s+)([\\s\\S]*?)<\\/code>(\\s*<\\/pre>)?`, 'gi');
const PRE_WRAPPED_CODE_LANG_CLASS_RE = new RegExp(`(<pre(?:\\s[^>]*)?>\\s*)?<code(${CODE_ATTR_PATTERN}\\bclass\\s*=\\s*(?:"[^"]*\\b(?:language-)?mermaid\\b[^"]*"|'[^']*\\b(?:language-)?mermaid\\b[^']*')${CODE_ATTR_PATTERN})>([\\s\\S]*?)<\\/code>(\\s*<\\/pre>)?`, 'gi');

export function decodeHtmlEntities(value) {
    return String(value ?? '').replace(/&(?:amp|lt|gt|quot|#39|apos);|&#x[0-9a-f]+;|&#\d+;/gi, token => {
        if (HTML_ENTITIES[token]) return HTML_ENTITIES[token];
        const code = token.toLowerCase().startsWith('&#x')
            ? Number.parseInt(token.slice(3, -1), 16)
            : Number.parseInt(token.slice(2, -1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : token;
    });
}

export function shouldTreatCodeTagAsMermaid(attrs, keyword, innerBody) {
    if (MERMAID_CLASS_ATTR_RE.test(String(attrs || ''))) return true;
    const lowerKw = String(keyword || '').toLowerCase();
    if (lowerKw === 'mermaid') return true;
    if (lowerKw === 'flowchart' || lowerKw === 'graph') {
        const decoded = decodeHtmlEntities(innerBody).trim();
        return GRAPH_DIAGRAM_BODY_RE.test(decoded);
    }
    return false;
}

function encodeMermaidDataAttribute(rawCode) {
    // Also percent-encode RFC3986 unreserved Markdown emphasis/delimiter marks
    // (*, _, ~, !, ', (, )) so downstream pipeline passes (e.g. bold boundary fixes)
    // can never inject HTML comments or formatting tokens inside data-mermaid-code.
    return encodeURIComponent(String(rawCode ?? '').trim())
        .replace(/[*_~!()']/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildMermaidPlaceholderDiv(rawCode) {
    return `<div class="mermaid-placeholder" data-vcp-block-type="mermaid" data-vcp-preserve-children="true" data-mermaid-code="${encodeMermaidDataAttribute(rawCode)}"></div>`;
}

function extractFencedMermaidBody(slice) {
    const firstNewline = slice.indexOf('\n');
    if (firstNewline === -1) return null;
    const openingLine = slice.slice(0, firstNewline).replace(/\r$/, '');
    const openMatch = openingLine.match(/^[ \t]{0,3}(`{3,}|~{3,})([^\S\n]*)(mermaid|flowchart|graph)[^\S\n]*$/i);
    if (!openMatch) return null;

    const rest = slice.slice(firstNewline + 1);
    const closingMatch = rest.match(/\r?\n[ \t]*(?:`{3,}|~{3,})[ \t]*\r?\n?$/);
    if (!closingMatch) return null;
    return rest.slice(0, rest.length - closingMatch[0].length);
}

function appendBlankLineIfNeeded(div, segment, matchStart, matchLength) {
    const before = segment.slice(0, matchStart);
    const atLineStart = /(?:^|\n)[ \t]*$/.test(before);
    if (!atLineStart) return div;
    const rest = segment.slice(matchStart + matchLength);
    const singleNewlineThenContent = rest.match(/^(\r?\n)(?=[ \t]*\S)/);
    return singleNewlineThenContent ? `${div}${singleNewlineThenContent[1]}` : div;
}

function transformInlineAndPlainCodeSegments(segment) {
    const sourceText = String(segment ?? '');
    let result = sourceText
        .replace(PRE_WRAPPED_CODE_PREFIX_RE, (fullMatch, preOpen, attrs, keyword, ws, code, preClose, offset) => {
            if (!shouldTreatCodeTagAsMermaid(attrs, keyword, code)) {
                return fullMatch;
            }
            const source = keyword.toLowerCase() === 'mermaid' ? code : `${keyword}${ws}${code}`;
            const div = buildMermaidPlaceholderDiv(decodeHtmlEntities(source));
            if (preOpen && preClose) return appendBlankLineIfNeeded(div, sourceText, offset, fullMatch.length);
            return `${preOpen || ''}${appendBlankLineIfNeeded(div, sourceText, offset, fullMatch.length)}${preClose || ''}`;
        });
    result = result.replace(PRE_WRAPPED_CODE_LANG_CLASS_RE, (fullMatch, preOpen, _allAttrs, _a1, _a2, code, preClose, offset) => {
        const cleaned = decodeHtmlEntities(code).replace(/^\s*mermaid\s+/i, '');
        const div = buildMermaidPlaceholderDiv(cleaned);
        if (preOpen && preClose) return appendBlankLineIfNeeded(div, result, offset, fullMatch.length);
        return `${preOpen || ''}${appendBlankLineIfNeeded(div, result, offset, fullMatch.length)}${preClose || ''}`;
    });
    return result;
}

export function createMermaidPlaceholderTransform() {
    return text => {
        const source = String(text ?? '');
        if (!source) return source;

        const domains = collectMarkdownCodeDomains(source);
        if (domains.length === 0) {
            return transformInlineAndPlainCodeSegments(source);
        }

        let output = '';
        let cursor = 0;
        for (const domain of domains) {
            if (domain.start > cursor) {
                output += transformInlineAndPlainCodeSegments(source.slice(cursor, domain.start));
            }
            const slice = source.slice(domain.start, domain.end);
            if (domain.kind === 'fence' && domain.closed) {
                const body = extractFencedMermaidBody(slice);
                if (body !== null) {
                    const trailingBreak = slice.match(/\r?\n$/)?.[0] || '';
                    const rest = source.slice(domain.end);
                    // CommonMark Type-6 <div> HTML blocks require a blank line before
                    // subsequent headings, lists, or bold text parse as Markdown.
                    const needsBlankLine = Boolean(trailingBreak && rest.length > 0 && !/^[ \t]*\r?\n/.test(rest));
                    const separator = needsBlankLine ? `${trailingBreak}${trailingBreak}` : trailingBreak;
                    output += buildMermaidPlaceholderDiv(body) + separator;
                    cursor = domain.end;
                    continue;
                }
            }
            output += slice;
            cursor = domain.end;
        }
        if (cursor < source.length) {
            output += transformInlineAndPlainCodeSegments(source.slice(cursor));
        }
        return output;
    };
}
