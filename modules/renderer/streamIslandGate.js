import { tokenizeVcpDocument } from './vcpDocumentScanner.js';
import { collectMarkdownCodeDomains } from './markdownCodeDomainScanner.js';

// Scheduling hint only. Never grants HTML/script execution privileges.
export const STREAM_ISLAND_COMMIT_INTERVAL_MS = 650;
const MAX_ISLAND_CHARS = 256 * 1024;
const MAX_DIV_DEPTH = 128;
const RAW_TAGS = new Set(['script', 'style', 'pre', 'code', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

function tagAt(source, start) {
    let quote = null;
    for (let end = start + 1; end < source.length; end++) {
        const char = source[end];
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '>') {
            const raw = source.slice(start, end + 1);
            const match = /^<(\/?)([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(raw);
            return { end: end + 1, name: match?.[2].toLowerCase(),
                closing: match?.[1] === '/', selfClosing: /\/>$/.test(raw) };
        }
    }
    return null;
}

// Additional display/protocol domains not yet represented by document regions.
// Deliberately conservative: an ambiguous marker disables this optimization.
function extraOpaqueRanges(source) {
    const ranges = [];
    const pairs = [
        [/[「{]始(?:ESCAPE)?[」}]/gi, marker => marker.replace('始', '末')],
        [/<<<\[ROLE_DIVIDE_(SYSTEM|ASSISTANT|USER)\]>>>/g,
            marker => marker.replace('ROLE_DIVIDE_', 'END_ROLE_DIVIDE_')],
        [/<<<DailyNoteStart>>>/g, () => '<<<DailyNoteEnd>>>'],
        [/\[本轮工具调用摘要:\]/g, () => '[本轮工具调用摘要结束]'],
    ];
    for (const [opening, closing] of pairs) {
        let match;
        while ((match = opening.exec(source))) {
            const token = closing(match[0]);
            const end = source.indexOf(token, opening.lastIndex);
            ranges.push({ start: match.index, end: end < 0 ? source.length : end + token.length });
            if (end < 0) break;
            opening.lastIndex = end + token.length;
        }
    }
    const displays = /<(pre|code|textarea|title|xmp|iframe|noembed|noframes)\b/gi;
    let display;
    while ((display = displays.exec(source))) {
        const token = tagAt(source, display.index);
        if (!token) {
            ranges.push({ start: display.index, end: source.length });
            break;
        }
        const closing = new RegExp('</' + display[1] + '\\s*>', 'ig');
        closing.lastIndex = token.end;
        const end = closing.exec(source);
        ranges.push({ start: display.index, end: end ? closing.lastIndex : source.length });
        if (!end) break;
        displays.lastIndex = closing.lastIndex;
    }
    return ranges;
}

/**
 * Incremental HTML traversal inside a confirmed island. Outside islands, reuse
 * the existing opaque-domain policies only when a zero-indent candidate exists.
 * A source epoch/visible rollback resets this scheduling state, not render state.
 */
export function createStreamIslandGate() {
    let epoch = null;
    let length = 0;
    let cursor = 0;
    let island = null;
    let raw = null;
    let lastCommitAt = -Infinity;
    let committedLength = -1;
    let owner = null;

    function reset() {
        cursor = 0;
        island = null;
        raw = null;
        lastCommitAt = -Infinity;
        committedLength = -1;
    }

    return {
        update(source, options = {}) {
            const revised = epoch !== options.epoch || source.length < length;
            const ownerChanged = owner !== options.owner;
            if (revised) reset();
            epoch = options.epoch;
            owner = options.owner;
            length = source.length;
            let force = revised || ownerChanged;
            let safeLength = source.length;
            let regions = null;
            let opaque = null;

            while (cursor < source.length) {
                if (!island) {
                    const candidates = /^<div(?=[\s>])/gim;
                    candidates.lastIndex = cursor;
                    let candidate;
                    while ((candidate = candidates.exec(source))) {
                        regions ||= tokenizeVcpDocument(source, { mode: 'stream' });
                        opaque ||= extraOpaqueRanges(source);
                        const index = candidate.index;
                        if (index > 0 && source[index - 1] !== '\n') continue;
                        const region = regions.find(entry => entry.start <= index && entry.end > index);
                        if (region?.kind !== 'html-tag' || region.start !== index
                            || opaque.some(entry => entry.start <= index && entry.end > index)) continue;
                        const token = tagAt(source, index);
                        if (!token) break;
                        if (token.selfClosing) continue;
                        island = { start: index, stack: [{ hasDivChild: false }] };
                        cursor = token.end;
                        force = true; // Leading commit.
                        break;
                    }
                    if (!island) {
                        // Revisit only the unfinished physical line on append.
                        cursor = Math.max(cursor, source.lastIndexOf('\n') + 1);
                        break;
                    }
                }

                if (source.length - island.start > MAX_ISLAND_CHARS) {
                    // Fail open: malformed/oversized cards must not pin prose.
                    island = null;
                    raw = null;
                    cursor = source.length;
                    force = true;
                    break;
                }

                if (raw) {
                    const close = new RegExp('</' + raw.name + '\\s*>', 'ig');
                    close.lastIndex = cursor;
                    const match = close.exec(source);
                    if (!match) {
                        if (raw.blocking) safeLength = raw.start;
                        // Keep a possible split closing token, including arbitrarily
                        // long whitespace before its final angle bracket.
                        cursor = Math.max(cursor, source.lastIndexOf('<'));
                        break;
                    }
                    cursor = match.index + match[0].length;
                    force ||= raw.blocking;
                    raw = null;
                    continue;
                }

                const feature = /[<`~]/g;
                feature.lastIndex = cursor;
                const start = feature.exec(source)?.index ?? -1;
                if (start < 0) {
                    cursor = source.length;
                    break;
                }
                if (source[start] !== '<') {
                    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
                    const before = source.slice(lineStart, start);
                    const prefix = /^[ \t]{0,3}$/.test(before) ? before : 'x';
                    const code = collectMarkdownCodeDomains(prefix + source.slice(start), {
                        includeUnclosedInline: true,
                    }).find(entry => entry.start === prefix.length);
                    if (code) {
                        if (!code.closed || (code.kind === 'fence'
                            && start + code.end - prefix.length === source.length
                            && !source.endsWith('\n'))) {
                            cursor = start;
                            break;
                        }
                        cursor = start + code.end - prefix.length;
                    } else {
                        cursor = start + 1;
                    }
                    continue;
                }
                if (source.startsWith('<!--', start)) {
                    const end = source.indexOf('-->', start + 4);
                    if (end < 0) {
                        cursor = start;
                        safeLength = start;
                        break;
                    }
                    cursor = end + 3;
                    continue;
                }
                const token = tagAt(source, start);
                if (!token) {
                    cursor = start;
                    safeLength = start;
                    break;
                }
                cursor = token.end;
                if (RAW_TAGS.has(token.name) && !token.closing) {
                    raw = { name: token.name, start,
                        blocking: token.name === 'script' || token.name === 'style' };
                    continue;
                }
                if (token.name !== 'div') continue;
                if (!token.closing) {
                    if (token.selfClosing) continue;
                    island.stack.at(-1).hasDivChild = true;
                    island.stack.push({ hasDivChild: false });
                    if (island.stack.length > MAX_DIV_DEPTH) {
                        island = null;
                        cursor = source.length;
                        force = true;
                        break;
                    }
                } else {
                    const closed = island.stack.pop();
                    if (!closed.hasDivChild) force = true; // Innermost completed card.
                    if (!island.stack.length) {
                        // Even a noncanonical closer releases the scheduling hint.
                        island = null;
                        force = true; // Trailing commit.
                    }
                }
            }

            if (raw?.blocking) safeLength = Math.min(safeLength, raw.start);
            const changed = safeLength !== committedLength;
            const remaining = STREAM_ISLAND_COMMIT_INTERVAL_MS - (options.now - lastCommitAt);
            const commit = changed && (force || !island || remaining <= 0);
            if (commit) {
                lastCommitAt = options.now;
                committedLength = safeLength;
            }
            return {
                commit: commit || ownerChanged || revised || (!island && !changed),
                length: safeLength,
                delay: changed && island && !raw?.blocking && !commit ? Math.max(0, remaining) : null,
                active: Boolean(island),
            };
        },
    };
}