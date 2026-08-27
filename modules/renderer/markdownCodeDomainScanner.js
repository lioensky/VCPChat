/**
 * Markdown code-domain scanner shared by render-time HTML/CSS isolation.
 *
 * The scanner deliberately does not parse HTML. Its only responsibility is to
 * identify fenced code blocks and inline code spans before downstream HTML
 * scanners see tag-looking literals such as `<style>`, `<div>`, or `</div>`.
 */

function countRun(source, index, marker) {
    let cursor = index;
    while (cursor < source.length && source[cursor] === marker) cursor += 1;
    return cursor - index;
}

function findLineEnd(source, startIndex) {
    const newlineIndex = source.indexOf('\n', startIndex);
    return newlineIndex === -1 ? source.length : newlineIndex;
}

function lineStartAt(source, index) {
    return index === 0 ? 0 : source.lastIndexOf('\n', index - 1) + 1;
}

function isFenceOpening(source, index, marker, runLength) {
    if ((marker !== '`' && marker !== '~') || runLength < 3) return false;

    const lineStart = lineStartAt(source, index);
    const prefix = source.slice(lineStart, index);
    if (!/^[ \t]{0,3}$/.test(prefix)) return false;

    // CommonMark fence info strings opened with backticks may not contain a
    // backtick. Rejecting this shape prevents an inline span at line start
    // from being misclassified as a fenced block.
    const lineEnd = findLineEnd(source, index + runLength);
    const infoString = source.slice(index + runLength, lineEnd);
    return marker !== '`' || !infoString.includes('`');
}

function findFenceClose(source, contentStart, marker, openingLength) {
    let lineStart = contentStart;

    while (lineStart <= source.length) {
        const lineEnd = findLineEnd(source, lineStart);
        let markerStart = lineStart;
        let indentation = 0;

        while (
            markerStart < lineEnd
            && indentation < 3
            && (source[markerStart] === ' ' || source[markerStart] === '\t')
        ) {
            markerStart += 1;
            indentation += 1;
        }

        if (source[markerStart] === marker) {
            const closingLength = countRun(source, markerStart, marker);
            const trailing = source.slice(markerStart + closingLength, lineEnd);
            if (closingLength >= openingLength && /^[ \t]*$/.test(trailing)) {
                return lineEnd < source.length ? lineEnd + 1 : lineEnd;
            }
        }

        if (lineEnd >= source.length) break;
        lineStart = lineEnd + 1;
    }

    return -1;
}

function findInlineClose(source, contentStart, openingLength) {
    let cursor = contentStart;

    while (cursor < source.length) {
        const nextBacktick = source.indexOf('`', cursor);
        if (nextBacktick === -1) return -1;

        const closingLength = countRun(source, nextBacktick, '`');
        if (closingLength === openingLength) {
            return nextBacktick + closingLength;
        }

        cursor = nextBacktick + closingLength;
    }

    return -1;
}

/**
 * Replaces Markdown code domains while preserving every non-code byte.
 *
 * Fenced domains support backtick and tilde markers, variable marker lengths,
 * legal line indentation, matching marker characters, and unclosed stream
 * tails. Inline domains support variable-length backtick delimiters. During
 * streaming, an unclosed inline delimiter conservatively owns the current tail
 * so tag-looking partial content cannot trigger HTML/CSS side effects.
 *
 * @param {string} source Markdown source.
 * @param {(domain: string, metadata: {
 *   kind: 'fence'|'inline',
 *   marker: '`'|'~',
 *   length: number,
 *   closed: boolean,
 *   start: number,
 *   end: number
 * }) => string} replacer Domain replacement callback.
 * @param {{includeUnclosedInline?: boolean}} options
 * @returns {string}
 */
export function replaceMarkdownCodeDomains(source, replacer, options = {}) {
    if (typeof source !== 'string' || source.length === 0) return source;
    if (typeof replacer !== 'function') {
        throw new TypeError('replaceMarkdownCodeDomains requires a replacer');
    }

    let result = '';
    let cursor = 0;
    let plainStart = 0;

    while (cursor < source.length) {
        const marker = source[cursor];
        if (marker !== '`' && marker !== '~') {
            cursor += 1;
            continue;
        }

        const runLength = countRun(source, cursor, marker);

        if (isFenceOpening(source, cursor, marker, runLength)) {
            const openingLineEnd = findLineEnd(source, cursor + runLength);
            const contentStart = openingLineEnd < source.length
                ? openingLineEnd + 1
                : source.length;
            const closingEnd = findFenceClose(source, contentStart, marker, runLength);
            const end = closingEnd === -1 ? source.length : closingEnd;

            result += source.slice(plainStart, cursor);
            result += String(replacer(source.slice(cursor, end), {
                kind: 'fence',
                marker,
                length: runLength,
                closed: closingEnd !== -1,
                start: cursor,
                end,
            }));
            cursor = end;
            plainStart = end;
            continue;
        }
        
        if (marker === '`') {
            const closingEnd = findInlineClose(source, cursor + runLength, runLength);
            if (closingEnd === -1 && options.includeUnclosedInline !== true) {
                // 静态/终态 Markdown 中孤立反引号是普通文本，不能让它拥有后续
                // 整个文档并借此隐藏真实 HTML/style。只有流式中间态显式开启保护。
                cursor += runLength;
                continue;
            }
            const end = closingEnd === -1 ? source.length : closingEnd;

            result += source.slice(plainStart, cursor);
            result += String(replacer(source.slice(cursor, end), {
                kind: 'inline',
                marker: '`',
                length: runLength,
                closed: closingEnd !== -1,
                start: cursor,
                end,
            }));
            cursor = end;
            plainStart = end;
            continue;
        }

        cursor += runLength;
    }

    result += source.slice(plainStart);
    return result;
}

/**
 * Collects immutable source ranges for every Markdown code domain.
 * Consumers that must preserve original offsets (for example stream stable
 * detectors) can skip these ranges without introducing placeholders.
 *
 * @param {string} source
 * @returns {ReadonlyArray<Readonly<{
 *   kind: 'fence'|'inline',
 *   marker: '`'|'~',
 *   length: number,
 *   closed: boolean,
 *   start: number,
 *   end: number
 * }>>}
 */
export function collectMarkdownCodeDomains(source, options = {}) {
    const ranges = [];
    replaceMarkdownCodeDomains(source, (domain, metadata) => {
        ranges.push(Object.freeze({ ...metadata }));
        return domain;
    }, options);
    return Object.freeze(ranges);
}