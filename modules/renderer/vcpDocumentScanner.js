import { collectToolDataRanges, collectToolResultRanges, collectCodeDomainsOutsideToolResults } from './toolResultRegions.js';
import { collectMarkdownCodeDomains } from './markdownCodeDomainScanner.js';
import { collectToolBatchRanges } from './toolBatchRegions.js';
import { scanToolRequestEnd } from './toolRequestScanner.js';

/**
 * One exact source/mode identity. Laziness matters: a tool-only consumer must not
 * pay for HTML or Markdown scanning. Policies deliberately retain legacy semantic
 * differences. No payload copies, global cache, rendering or recovery side effects.
 * onWork reports input extents, NOT actual character visits inside legacy scanners.
 */
export function createVcpSourceIndex(source, { mode = 'final', onWork = () => {} } = {}) {
    if (typeof source !== 'string') throw new TypeError('Source index requires a string');
    if (mode !== 'final' && mode !== 'stream') throw new TypeError('Unknown source index mode');
    const cache = new Map();
    const memo = (key, build, scan = true) => {
        if (cache.has(key)) {
            onWork({ operation: key, reused: true, inputChars: 0 });
            return cache.get(key);
        }
        const built = build();
        const result = Object.isFrozen(built) ? built
            : Object.freeze(built.map(region => Object.isFrozen(region) ? region : Object.freeze(region)));
        cache.set(key, result);
        onWork({ operation: key, reused: false, inputChars: scan ? source.length : 0 });
        return result;
    };
    const batches = () => memo('tool-batches', () => collectToolBatchRanges(source));
    const toolData = () => memo('tool-data', () => collectToolDataRanges(source, batches()));
    const toolResults = () => batches().length
        ? memo('tool-results', () => collectToolResultRanges(source, batches()))
        : toolData();
    const codes = (policy = 'document') => {
        if (!['document', 'protocol', 'markdown'].includes(policy)) throw new TypeError('Unknown code policy');
        if (policy === 'protocol' && !/[`~]/.test(source)) {
            return memo('code-protocol', () => [], false);
        }
        if (policy === 'protocol') return memo('code-protocol', () =>
            codeBase(false).filter(range => range.kind === 'fence'
                || !source.slice(range.start, range.end).includes('\n')), false);
        if (policy === 'markdown') return memo('code-markdown', () => collectMarkdownCodeDomains(source));
        return codeBase(mode === 'stream');
    };
    const codeBase = stream => memo(`code-data-${stream ? 'stream' : 'final'}`, () =>
        collectCodeDomainsOutsideToolResults(source, toolData(), { includeUnclosedInline: stream }));
    // Keep the cap in the key: document isolation stops at authoritative data,
    // while a legacy protocol consumer may deliberately use the whole source.
    const requestEnd = (contentStart, limit = source.length) => {
        if (!Number.isInteger(contentStart) || !Number.isInteger(limit)
            || contentStart < 0 || limit < contentStart || limit > source.length) {
            throw new RangeError('Invalid request source extent');
        }
        const key = `request-end:${contentStart}:${limit}`;
        if (cache.has(key)) {
            onWork({ operation: 'request-end', reused: true, inputChars: 0 });
            return cache.get(key);
        }
        const scan = scanToolRequestEnd(limit === source.length ? source : source.slice(0, limit), contentStart);
        const result = Object.freeze({ ...scan,
            ...(scan.field ? { field: Object.freeze({ ...scan.field }) } : {}),
        });
        cache.set(key, result);
        onWork({ operation: 'request-end', reused: false, inputChars: limit - contentStart });
        return result;
    };
    const regions = () => memo('document-regions', () =>
        scanDocumentRegions(source, toolData(), codes(), requestEnd));
    return Object.freeze({
        source, mode, toolData, toolResults, batches, codes, regions, requestEnd,
        ofKind: kind => memo(`kind:${kind}`, () => regions().filter(region => region.kind === kind), false),
    });
}

/**
 * Source-offset domain contract. Tool data has absolute priority; code, comments
 * and protocol payloads are opaque. This first migration deliberately delegates
 * mature pairing rules: it is NOT yet a single-pass or incremental lexer.
 * Regions partition the source without placeholders or copied payload strings.
 */
export function tokenizeVcpDocument(source, { mode = 'final' } = {}) {
    if (typeof source !== 'string' || !source.length) return [];
    return createVcpSourceIndex(source, { mode }).regions();
}

function scanDocumentRegions(source, tools, codes, requestEnd) {
    const regions = [];
    let cursor = 0;
    let plainStart = 0;
    let toolIndex = 0;
    let codeIndex = 0;
    const nextFeature = /[<\n]/g;
    const emit = region => {
        if (plainStart < region.start) regions.push({
            kind: 'markdown', start: plainStart, end: region.start, closed: true,
        });
        regions.push(region);
        cursor = region.end;
        plainStart = cursor;
        if (region.kind !== 'code-fence' && region.kind !== 'inline-code') {
            while (codes[codeIndex]?.start >= region.start
                && codes[codeIndex]?.start < cursor) codeIndex++;
        }
    };
    while (cursor < source.length) {
        while (tools[toolIndex]?.end <= cursor) toolIndex++;
        while (codes[codeIndex]?.end <= cursor) codeIndex++;
        const tool = tools[toolIndex];
        if (tool && cursor >= tool.start) {
            emit({ ...tool, kind: tool.batchId !== undefined ? 'tool-batch' : 'tool-result' });
            continue;
        }
        const code = codes[codeIndex];
        if (code && cursor >= code.start) {
            const end = Math.min(code.end, tool?.start ?? source.length);
            emit({ ...code, start: cursor, end, closed: code.closed && end === code.end,
                kind: code.kind === 'fence' ? 'code-fence' : 'inline-code' });
            continue;
        }
        // No lower-priority domain may consume an authoritative tool receipt.
        const limit = tool?.start ?? source.length;
        if (source.startsWith('<!--', cursor)) {
            const close = source.indexOf('-->', cursor + 4);
            emit({ kind: 'comment', start: cursor,
                end: close < 0 || close + 3 > limit ? limit : close + 3,
                closed: close >= 0 && close + 3 <= limit });
            continue;
        }
        if (source.startsWith('<<<[TOOL_REQUEST]>>>', cursor) && source[cursor - 1] !== '`') {
            const scan = requestEnd(cursor + '<<<[TOOL_REQUEST]>>>'.length, limit);
            emit({ kind: 'tool-request', start: cursor,
                end: scan.endIndex < 0 ? limit : scan.endIndex, closed: scan.endIndex >= 0 });
            continue;
        }
        if (source.startsWith('<<<[DESKTOP_PUSH]>>>', cursor) && source[cursor - 1] !== '`') {
            const close = source.slice(0, limit).indexOf('<<<[DESKTOP_PUSH_END]>>>', cursor + '<<<[DESKTOP_PUSH]>>>'.length);
            emit({ kind: 'desktop-push', start: cursor,
                end: close < 0 ? limit : close + '<<<[DESKTOP_PUSH_END]>>>'.length, closed: close >= 0 });
            continue;
        }
        if (cursor === 0 || source[cursor - 1] === '\n') {
            const opening = /^[ \t]*(?:\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\]|<(?:think(?:ing)?|thought(?:s)?)>)[ \t]*\r?\n/i.exec(source.slice(cursor, limit));
            if (opening) {
                const custom = opening[0].trimStart().startsWith('[');
                const closing = custom
                    ? /^[ \t]*\[--- 元思考链结束 ---\][ \t]*(?:\r?\n|$)/gm
                    : /^[ \t]*<\/(?:think(?:ing)?|thought(?:s)?)>[ \t]*(?:\r?\n|$)/gim;
                closing.lastIndex = cursor + opening[0].length;
                const match = closing.exec(source.slice(0, limit));
                emit({ kind: 'thought-chain', start: cursor,
                    end: match ? match.index + match[0].length : limit, closed: Boolean(match) });
                continue;
            }
        }
        if (source[cursor] === '<') {
            const open = /^<(style|script)\b[^>]*>/i.exec(source.slice(cursor, limit));
            if (open) {
                const close = new RegExp('</' + open[1] + '\\s*>', 'ig');
                close.lastIndex = cursor + open[0].length;
                const match = close.exec(source.slice(0, limit));
                emit({ kind: open[1].toLowerCase(), start: cursor,
                    end: match ? match.index + match[0].length : limit, closed: Boolean(match) });
                continue;
            }
            // Consume quoted attributes as one token; tag-looking attribute
            // values cannot open CSS or protocol domains.
            const tag = /^<\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/.exec(source.slice(cursor, limit));
            if (tag) {
                emit({ kind: 'html-tag', start: cursor, end: cursor + tag[0].length, closed: true });
                continue;
            }
        }
        if (source[cursor] === '\n') {
            cursor++;
        } else {
            nextFeature.lastIndex = cursor + 1;
            cursor = Math.min(
                nextFeature.exec(source)?.index ?? source.length,
                codes[codeIndex]?.start > cursor ? codes[codeIndex].start : source.length,
                tools[toolIndex]?.start > cursor ? tools[toolIndex].start : source.length,
            );
        }
    }
    if (plainStart < source.length) regions.push({
        kind: 'markdown', start: plainStart, end: source.length, closed: true,
    });
    return regions;
}

/** Only ordinary prose is mutable; opaque domains retain every original byte. */
export function transformVcpMarkdown(source, transform, options) {
    return tokenizeVcpDocument(source, options).map(region => {
        const text = source.slice(region.start, region.end);
        return region.kind === 'markdown' ? transform(text) : text;
    }).join('');
}