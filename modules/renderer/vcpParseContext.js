import { createVcpSourceIndex } from './vcpDocumentScanner.js';

const TOKEN_PATTERN = /<!--VCP_(?:THOUGHT_CHAIN|TOOL_RESULT|TOOL_REQUEST|RAW_SCRIPT)_\d+-->|__VCP_CODE_BLOCK_PLACEHOLDER_\d+__/g;
const TOKEN_NAMES = Object.freeze({
    thought: 'THOUGHT_CHAIN',
    result: 'TOOL_RESULT',
    request: 'TOOL_REQUEST',
    script: 'RAW_SCRIPT',
    code: 'CODE_BLOCK_PLACEHOLDER',
});
const identity = value => value;

function tokenFor(kind, id) {
    if (!Object.hasOwn(TOKEN_NAMES, kind)) throw new TypeError('Unknown placeholder kind');
    const name = TOKEN_NAMES[kind];
    return kind === 'code' ? `__VCP_${name}_${id}__` : `<!--VCP_${name}_${id}-->`;
}

/**
 * Parse-local registration and reference recognition, NOT a recovery scheduler.
 * Keep legacy token shapes for existing injected consumers, but never allocate a
 * token already present anywhere in the input (including opaque field payloads).
 * A replacement consumes a snapshot; inserted payloads are never recursively read.
 */
export function createVcpPlaceholderRegistry(source = '') {
    const reserved = new Set(source.match(TOKEN_PATTERN) || []);
    const entries = new Map();
    const maps = new Map();
    const counters = new Map();
    let revision = 0;
    let referenceText = null;
    let referenceRevision = -1;
    let referencesByKind = new Map();
    const stats = { scans: 0, inputChars: 0, hits: 0,
        reservationInputChars: source.length, sourceLiteralTokens: reserved.size };
    const map = kind => {
        if (!Object.hasOwn(TOKEN_NAMES, kind)) throw new TypeError('Unknown placeholder kind');
        if (!maps.has(kind)) maps.set(kind, new Map());
        return maps.get(kind);
    };
    const references = (text, kind) => {
        if (referenceText !== text || referenceRevision !== revision) {
            referencesByKind = new Map();
            for (const match of text.matchAll(TOKEN_PATTERN)) {
                const entry = entries.get(match[0]);
                if (!entry) continue;
                const entryKind = typeof entry === 'string' ? entry : entry.kind;
                const refs = referencesByKind.get(entryKind) || [];
                refs.push(Object.freeze({ token: match[0], kind: entryKind,
                    start: match.index, end: match.index + match[0].length }));
                referencesByKind.set(entryKind, refs);
            }
            for (const [key, refs] of referencesByKind) referencesByKind.set(key, Object.freeze(refs));
            referenceText = text;
            referenceRevision = revision;
            stats.scans++;
            stats.inputChars += text.length;
        } else {
            stats.hits++;
        }
        return referencesByKind.get(kind) || EMPTY;
    };
    return Object.freeze({
        map,
        register(kind, value, metadata = null) {
            let id = counters.get(kind) || 0;
            let token;
            do { token = tokenFor(kind, id++); } while (reserved.has(token));
            counters.set(kind, id);
            // Counters are monotonic per kind, so only original source literals
            // need reservation. Avoid another growing set of generated tokens.
            entries.set(token, metadata === null ? kind : Object.freeze({ kind, metadata }));
            map(kind).set(token, value);
            revision++;
            return token;
        },
        references,
        replace(text, kind, replacer = identity, { unwrapParagraph = false } = {}) {
            const values = maps.get(kind);
            if (!values?.size) return text;
            // Plain value restoration can recognize and compose in one traversal.
            // Still index ALL registered kinds so later consumers of this exact
            // text reuse the same references. Custom callbacks keep the snapshot
            // path below: they may register entries or render nested payloads.
            if (replacer === identity && !unwrapParagraph
                && (referenceText !== text || referenceRevision !== revision)) {
                const byKind = new Map();
                const result = text.replace(TOKEN_PATTERN, (token, start) => {
                    const entry = entries.get(token);
                    if (!entry) return token;
                    const entryKind = typeof entry === 'string' ? entry : entry.kind;
                    const refs = byKind.get(entryKind) || [];
                    refs.push(Object.freeze({ token, kind: entryKind, start, end: start + token.length }));
                    byKind.set(entryKind, refs);
                    return entryKind === kind ? values.get(token) ?? token : token;
                });
                for (const [key, refs] of byKind) byKind.set(key, Object.freeze(refs));
                referencesByKind = byKind;
                referenceText = text;
                referenceRevision = revision;
                stats.scans++;
                stats.inputChars += text.length;
                return result;
            }
            let result = '';
            let cursor = 0;
            for (const ref of references(text, kind)) {
                let { start, end } = ref;
                if (unwrapParagraph) {
                    let left = start;
                    let right = end;
                    while (left > cursor && /\s/.test(text[left - 1])) left--;
                    while (right < text.length && /\s/.test(text[right])) right++;
                    if (text.slice(left - 3, left) === '<p>' && left - 3 >= cursor
                        && text.startsWith('</p>', right)) {
                        start = left - 3;
                        end = right + 4;
                    }
                }
                result += text.slice(cursor, start)
                    + (replacer(map(kind).get(ref.token), ref) ?? text.slice(start, end));
                cursor = end;
            }
            return result + text.slice(cursor);
        },
        releaseReferences() {
            referenceText = null;
            referencesByKind = new Map();
        },
        getDiagnostics: () => ({ ...stats, entries: entries.size,
            retainedReferenceChars: referenceText?.length || 0 }),
    });
}

const EMPTY = Object.freeze([]);

/** Only the latest source is retained. Changed strings rebuild lazily, even at equal length. */
export function createVcpParseContext(source, { mode = 'final' } = {}) {
    let current = null;
    const operations = Object.create(null);
    const stats = { versions: 0, invalidations: 0, indexHits: 0 };
    const invalidationReasons = { sameLengthSourceChanged: 0, sourceLengthChanged: 0 };
    const placeholders = createVcpPlaceholderRegistry(source);
    return Object.freeze({
        mode,
        placeholders,
        index(text) {
            if (current?.source === text) {
                stats.indexHits++;
                return current;
            }
            if (current) {
                stats.invalidations++;
                const reason = current.source.length === text.length
                    ? 'sameLengthSourceChanged' : 'sourceLengthChanged';
                invalidationReasons[reason]++;
            }
            stats.versions++;
            current = createVcpSourceIndex(text, {
                mode,
                onWork({ operation, reused, inputChars }) {
                    const entry = operations[operation] ||= { scans: 0, hits: 0, inputChars: 0 };
                    if (reused) entry.hits++;
                    else { entry.scans++; entry.inputChars += inputChars; }
                },
            });
            return current;
        },
        release() {
            current = null;
            placeholders.releaseReferences();
        },
        getDiagnostics: () => ({ ...stats,
            invalidationReasons: { ...invalidationReasons },
            retainedSourceChars: current?.source.length || 0,
            operations: Object.fromEntries(Object.entries(operations).map(([key, value]) => [key, { ...value }])),
            placeholders: placeholders.getDiagnostics(),
        }),
    });
}