import { tokenizeVcpDocument } from './vcpDocumentScanner.js';

// Execution eligibility, not an HTML sanitizer or a security sandbox.
// Deliberately exclude optional-end-tag/table/form/foreign integration rules.
const CONTAINERS = new Set([
    'div', 'span', 'canvas', 'button', 'section', 'article', 'header', 'footer',
    'strong', 'em', 'b', 'i', 'label', 'svg', 'g', 'defs', 'path', 'circle',
    'rect', 'ellipse', 'line', 'polyline', 'polygon', 'lineargradient',
    'radialgradient', 'stop', 'filter', 'text', 'tspan', 'style', 'script',
]);
const VOID = new Set(['br', 'hr', 'img', 'input', 'wbr']);
const FOREIGN = new Set([
    'path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'stop',
]);
const MAX_CHARS = 256 * 1024;
const MAX_DEPTH = 128;

function tagAt(source, start) {
    const match = /^<(\/?)([a-z][a-z0-9:-]*)(?=[\s/>])((?:[^"'<>]|"[^"]*"|'[^']*')*)>/i.exec(source.slice(start));
    if (!match) return null;
    return {
        name: match[2].toLowerCase(), closing: Boolean(match[1]),
        selfClosing: /\/\s*$/.test(match[3]), end: start + match[0].length,
        raw: match[0],
    };
}

function scanIsland(source, start) {
    const stack = [];
    let cursor = start;
    let hasScript = false;
    while (cursor < source.length && cursor - start <= MAX_CHARS) {
        const next = source.indexOf('<', cursor);
        if (next < 0 || next - start > MAX_CHARS) return null;
        if (source.startsWith('<!--', next)) {
            const end = source.indexOf('-->', next + 4);
            if (end < 0) return null;
            cursor = end + 3;
            continue;
        }
        const tag = tagAt(source, next);
        if (!tag || tag.end - start > MAX_CHARS
            || (!CONTAINERS.has(tag.name) && !VOID.has(tag.name))) return null;
        if (!tag.closing && tag.name === 'button' && stack.includes('button')) return null;
        // Inline handlers bypass managed execution; leave them to the legacy path.
        if (/\son[a-z]+\s*=/i.test(tag.raw)) return null;
        cursor = tag.end;
        if (tag.closing) {
            if (!/^<\/[a-z][a-z0-9:-]*\s*>$/i.test(tag.raw)
                || stack.at(-1) !== tag.name) return null;
            stack.pop();
            if (!stack.length) return { start, end: cursor, hasScript };
            continue;
        }
        if (VOID.has(tag.name)) continue;
        if (tag.selfClosing) {
            if (!stack.includes('svg') || !FOREIGN.has(tag.name)) return null;
            continue;
        }
        stack.push(tag.name);
        if (stack.length > MAX_DEPTH) return null;
        if (tag.name === 'script' || tag.name === 'style') {
            const close = new RegExp('</' + tag.name + '\\s*>', 'ig');
            close.lastIndex = cursor;
            const end = close.exec(source);
            if (!end) return null;
            if (tag.name === 'script') hasScript = true;
            cursor = close.lastIndex;
            stack.pop();
        }
        if (cursor - start > MAX_CHARS) return null;
    }
    return null;
}

/**
 * Return only independent, strictly balanced, line-start DIV islands containing
 * scripts. Incomplete/ambiguous input has no execution side effects. Browser
 * auto-closing is never evidence of source closure.
 */
export function collectStrictAnimationIslands(source) {
    if (typeof source !== 'string' || !/<script\b/i.test(source)) return [];
    // These legacy domains have differing display rules. Fail conservatively
    // rather than promoting their payloads into executable islands.
    if (/<<<\[|<<<DailyNote|\[本轮工具调用摘要:|[「{]始(?:ESCAPE)?[」}]/i.test(source)) return [];
    const regions = tokenizeVcpDocument(source, { mode: 'stream' });
    const result = [];
    let consumed = 0;
    const outer = [];
    for (const region of regions) {
        if (region.start < consumed || region.kind !== 'html-tag') continue;
        const tag = tagAt(source, region.start);
        if (!tag) continue;
        if (!outer.length && tag.name === 'div' && !tag.closing
            && !tag.selfClosing
            && (region.start === 0 || source[region.start - 1] === '\n')) {
            const island = scanIsland(source, region.start);
            // Never recover a nested child of an ambiguous outer island.
            if (!island) break;
            consumed = island.end;
            if (island.hasScript) result.push(island);
            continue;
        }
        if (tag.closing) {
            if (outer.at(-1) !== tag.name) break;
            outer.pop();
        } else if (!VOID.has(tag.name) && !tag.selfClosing) {
            outer.push(tag.name);
        }
    }
    return result;
}