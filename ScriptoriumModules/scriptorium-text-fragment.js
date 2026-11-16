'use strict';

/**
 * Text-block codec, not a document parser or sanitizer.
 *
 * fromDOM(root) reads the root's contents without changing the live DOM. Its
 * immutable Fragment contains Text, Break, Inline, Atom, BlockLine and Unknown nodes.
 * Text lengths are UTF-16 code units; explicit BR and implied line boundaries
 * each occupy one unit. A DIV whose only content is one BR is an empty browser
 * line: that BR is a zero-length placeholder. No other BR is discarded.
 *
 * Only DIVs without attributes (apart from editor attributes, lang, dir and
 * whitelisted text styles) are browser lines. Layout, identity, classes, unknown
 * elements and unsupported namespaces fail closed. Original inline tags and
 * attributes survive. A generated terminal caret BR is explicitly marked and
 * occupies zero logical units; ordinary authored BRs always remain explicit.
 * BlockLine encodes as BR boundaries plus an inline style wrapper when needed.
 *
 * encode/toPlainText return null for unsupported fragments. Callers can retain
 * their source or use a separate lossless document path; never save that null.
 * The codec does not replace VDocCore.sanitizeHtml at the trust boundary.
 *
 * Position APIs use {offset, affinity:'upstream'|'downstream'}. At an implicit
 * break the same parent child boundary can mean either side, selected by
 * affinity. Adjacent styled runs similarly restore to the requested run side.
 * Mapping references the captured DOM; recapture after editing/replacing it.
 */
((root, factory) => {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root?.document) root.ScriptoriumTextFragment = api;
})(typeof window === 'object' ? window : globalThis, () => {
    const INLINE_TAGS = new Set([
        'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN',
        'EM', 'FONT', 'I', 'INS', 'KBD', 'MARK', 'Q', 'RP', 'RT', 'RUBY', 'S',
        'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME',
        'TT', 'U', 'VAR', 'WBR',
    ]);
    const INLINE_ATOMS = new Set(['IMG']);
    const EDITOR_ATTRIBUTES = new Set([
        'contenteditable', 'spellcheck', 'data-vdoc-editor-selected',
    ]);
    const TEXT_STYLES = new Set([
        'color', 'background-color', 'font', 'font-family', 'font-size',
        'font-style', 'font-weight', 'font-stretch', 'font-variant',
        'font-variant-caps', 'font-variant-ligatures', 'font-feature-settings',
        'font-kerning', 'font-variation-settings', 'letter-spacing',
        'word-spacing', 'line-height', 'text-decoration', 'text-decoration-line',
        'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness',
        'text-transform', 'text-shadow', 'direction', 'unicode-bidi',
        'white-space', 'tab-size',
    ]);
    const PLACEHOLDER = 'data-vdoc-caret-placeholder';
    const snapshots = new WeakMap();
    const affinityOf = value => value === 'upstream' || value === 'downstream';
    const escapeText = value => value.replace(/[&<>\r\u00a0]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '\r': '&#13;', '\u00a0': '&nbsp;',
    })[character]);
    const escapeAttribute = value => escapeText(value).replace(/"/g, '&quot;');
    const openingTag = (tag, attributes) => `<${tag}${attributes.map(({ name, value }) =>
        ` ${name}="${escapeAttribute(value)}"`).join('')}>`;

    function fromDOM(root, options = {}) {
        if (!root || ![1, 11].includes(root.nodeType) || !root.ownerDocument) {
            throw new TypeError('A text-block element or DocumentFragment is required.');
        }
        const issues = [];
        const sources = new WeakMap();
        const stripEditorAttributes = options.stripEditorAttributes !== false;
        const attributesOf = element => [...element.attributes]
            .filter(attribute => !stripEditorAttributes || !EDITOR_ATTRIBUTES.has(attribute.name))
            .map(({ name, value }) => Object.freeze({ name, value }));
        const unknown = (node, reason) => {
            const result = { type: 'Unknown', tag: node.nodeName.toLowerCase(), reason };
            issues.push(Object.freeze({ tag: result.tag, reason }));
            return result;
        };
        const isTerminal = node => {
            for (let current = node; current && current !== root; current = current.parentNode) {
                if (current.nextSibling) return false;
            }
            return true;
        };
        const read = node => {
            let result;
            if (node.nodeType === 3) {
                result = { type: 'Text', value: node.data };
            } else if (node.nodeType !== 1 || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
                result = unknown(node, 'unsupported-node');
            } else {
                const tag = node.tagName;
                const attributes = attributesOf(node);
                if (tag === 'BR') {
                    const placeholder = node.getAttribute(PLACEHOLDER) === 'true' && isTerminal(node);
                    result = { type: 'Break', attributes, placeholder,
                        generated: node.getAttribute(PLACEHOLDER) === 'true' };
                } else if (tag === 'DIV') {
                    const invalidAttribute = attributes.some(attribute =>
                        !['style', 'lang', 'dir'].includes(attribute.name));
                    // Check declaration names too: CSSOM can silently omit unknown properties.
                    const declarations = (node.getAttribute('style') || '').split(';').filter(x => x.trim());
                    const invalidStyle = declarations.some(declaration => {
                        const colon = declaration.indexOf(':');
                        return colon < 0 || !TEXT_STYLES.has(declaration.slice(0, colon).trim().toLowerCase());
                    });
                    result = invalidAttribute || invalidStyle
                        ? unknown(node, 'non-text-line-div')
                        : { type: 'BlockLine', attributes, children: [...node.childNodes].map(read) };
                    if (result.type === 'BlockLine') {
                        const significant = result.children.filter(child => child.type !== 'Text' || child.value.length);
                        if (significant.length === 1 && significant[0].type === 'Break'
                            && significant[0].attributes.length === 0) {
                            significant[0].placeholder = true;
                        }
                    }
                } else if (INLINE_ATOMS.has(tag)) {
                    result = { type: 'Atom', tag: tag.toLowerCase(), attributes };
                } else if (INLINE_TAGS.has(tag)) {
                    // Existing block-displayed SPANs retain their tags via the caller's
                    // lossless path. Treating their layout as an inline run loses lines.
                    const display = node.style.display;
                    result = display && !['inline', 'contents'].includes(display)
                        ? unknown(node, 'inline-layout')
                        : { type: 'Inline', tag: tag.toLowerCase(), attributes, children: [...node.childNodes].map(read) };
                } else {
                    result = unknown(node, 'unsupported-element');
                }
            }
            sources.set(result, node);
            return result;
        };
        const children = [...root.childNodes].map(read);
        const records = new WeakMap();
        const segments = [];
        const endpoints = new Map();
        const html = [];
        const text = [];
        const expectedDOM = root.ownerDocument.createElement('p');
        let outputParent = expectedDOM;
        const outputElement = (tag, attributes = []) => {
            const element = root.ownerDocument.createElement(tag);
            for (const { name, value } of attributes) element.setAttribute(name, value);
            outputParent.appendChild(element);
            return element;
        };
        let length = 0;
        let lineOccupied = false;
        let pendingBlockEnd = false;
        const emitBreak = () => {
            html.push('<br>');
            outputElement('br');
            text.push('\n');
            length++;
            lineOccupied = false;
            pendingBlockEnd = false;
        };
        const boundary = () => {
            if (lineOccupied) emitBreak();
            pendingBlockEnd = false;
        };
        const write = semantic => {
            const node = sources.get(semantic);
            if (semantic.type === 'BlockLine') boundary();
            else if (pendingBlockEnd && (semantic.type !== 'Text' || semantic.value.length)) boundary();
            const start = length;
            if (semantic.type === 'Text') {
                html.push(escapeText(semantic.value));
                outputParent.appendChild(root.ownerDocument.createTextNode(semantic.value));
                text.push(semantic.value);
                length += semantic.value.length;
                if (semantic.value.length) lineOccupied = true;
                segments.push({ node, start, end: length });
            } else if (semantic.type === 'Break') {
                if (semantic.placeholder && isTerminal(node)) {
                    const attributes = semantic.attributes.filter(attribute => attribute.name !== PLACEHOLDER)
                        .concat({ name: PLACEHOLDER, value: 'true' });
                    html.push(openingTag('br', attributes));
                    outputElement('br', attributes);
                } else if (!semantic.placeholder) {
                    const attributes = semantic.generated
                        ? semantic.attributes.filter(attribute => attribute.name !== PLACEHOLDER)
                        : semantic.attributes;
                    html.push(openingTag('br', attributes));
                    outputElement('br', attributes);
                    text.push('\n');
                    length++;
                    lineOccupied = false;
                }
            } else if (semantic.type === 'Atom') {
                html.push(openingTag(semantic.tag, semantic.attributes));
                outputElement(semantic.tag, semantic.attributes);
            } else if (semantic.type === 'Inline' || semantic.type === 'BlockLine') {
                const wrap = semantic.type === 'Inline' || semantic.attributes.length > 0;
                const tag = semantic.type === 'Inline' ? semantic.tag : 'span';
                const parent = outputParent;
                if (wrap) {
                    html.push(openingTag(tag, semantic.attributes));
                    outputParent = outputElement(tag, semantic.attributes);
                }
                for (const child of semantic.children) write(child);
                outputParent = parent;
                if (wrap && tag !== 'wbr') html.push(`</${tag}>`);
                if (semantic.type === 'BlockLine') {
                    if (length === start) lineOccupied = true;
                    pendingBlockEnd = true;
                }
            }
            records.set(node, { start, end: length, children: [...node.childNodes], value: node.nodeType === 3 ? node.data : null });
        };
        if (!issues.length) children.forEach(write);
        records.set(root, { start: 0, end: length, children: [...root.childNodes] });

        const addEndpoint = (position, node, offset, affinity, rank) => {
            let entry = endpoints.get(position);
            if (!entry) endpoints.set(position, entry = {});
            if (!entry[affinity] || entry[affinity].rank < rank) {
                entry[affinity] = { node, offset, affinity, rank };
            }
        };
        const index = (node, depth = 0, childOffset = 0) => {
            const record = records.get(node);
            if (!record) return;
            if (node.nodeType === 3) {
                addEndpoint(record.start, node, 0, 'downstream', 1000 + depth);
                addEndpoint(record.end, node, record.value.length, 'upstream', 1000 + depth);
                return;
            }
            if (node.nodeName === 'BR') {
                const parent = node.parentNode;
                addEndpoint(record.start, parent, childOffset, 'downstream', 500 + depth);
                addEndpoint(record.end, parent, childOffset + 1, 'upstream', 500 + depth);
                return;
            }
            for (let offset = 0; offset <= record.children.length; offset++) {
                const before = offset ? records.get(record.children[offset - 1]).end : record.start;
                const after = offset < record.children.length ? records.get(record.children[offset]).start : record.end;
                const rank = (record.children.length ? 0 : 100) + depth;
                addEndpoint(before, node, offset, 'upstream', rank);
                addEndpoint(after, node, offset, 'downstream', rank);
            }
            record.children.forEach((child, offset) => index(child, depth + 1, offset));
        };
        if (!issues.length) index(root);
        const freezeNode = node => {
            if (node.children) {
                node.children.forEach(freezeNode);
                Object.freeze(node.children);
            }
            if (node.attributes) Object.freeze(node.attributes);
            return Object.freeze(node);
        };
        const fragment = Object.freeze({
            type: 'Fragment',
            children: Object.freeze(children.map(freezeNode)),
            supported: issues.length === 0,
            issues: Object.freeze(issues),
            length: issues.length ? null : length,
        });
        expectedDOM.normalize();
        snapshots.set(fragment, { root, records, segments, endpoints, expectedDOM, html: html.join(''), text: text.join('') });
        return fragment;
    }

    function encode(fragment) {
        const snapshot = snapshots.get(fragment);
        if (!snapshot || !fragment.supported) return null;
        // Full P parsing catches invalid programmatic nesting (e.g. nested A),
        // parser recovery and text normalization before a caller overwrites source.
        const template = snapshot.root.ownerDocument.createElement('template');
        template.innerHTML = `<p>${snapshot.html}</p>`;
        const paragraph = template.content.firstChild;
        return template.content.childNodes.length === 1 && paragraph?.nodeName === 'P'
            && paragraph.isEqualNode(snapshot.expectedDOM) ? snapshot.html : null;
    }

    function toPlainText(fragment) {
        const snapshot = snapshots.get(fragment);
        return snapshot && fragment.supported ? snapshot.text : null;
    }

    function domToLogical(fragment, node, offset, affinity = 'downstream') {
        const snapshot = snapshots.get(fragment);
        const record = snapshot?.records.get(node);
        if (!fragment?.supported || !record || !Number.isInteger(offset) || offset < 0 || !affinityOf(affinity)) return null;
        if (node.nodeType === 3) {
            if (node.data !== record.value || offset > record.value.length) return null;
            return { offset: record.start + offset, affinity };
        }
        if (offset > record.children.length || node.childNodes.length !== record.children.length
            || (offset && node.childNodes[offset - 1] !== record.children[offset - 1])
            || (offset < record.children.length && node.childNodes[offset] !== record.children[offset])) return null;
        if (node.nodeName === 'BR') return { offset: record.start, affinity };
        const before = offset ? snapshot.records.get(record.children[offset - 1]).end : record.start;
        const after = offset < record.children.length ? snapshot.records.get(record.children[offset]).start : record.end;
        return { offset: affinity === 'upstream' ? before : after, affinity };
    }

    function logicalToDOM(fragment, position) {
        const snapshot = snapshots.get(fragment);
        const offset = position?.offset;
        const affinity = position?.affinity ?? 'downstream';
        if (!snapshot || !fragment.supported || !Number.isInteger(offset)
            || offset < 0 || offset > fragment.length || !affinityOf(affinity)) return null;
        // Interior positions need no per-code-unit table, even for long paragraphs.
        let low = 0;
        let high = snapshot.segments.length - 1;
        while (low <= high) {
            const middle = (low + high) >>> 1;
            const segment = snapshot.segments[middle];
            if (offset <= segment.start) high = middle - 1;
            else if (offset >= segment.end) low = middle + 1;
            else return segment.node.data === snapshot.records.get(segment.node).value
                ? { node: segment.node, offset: offset - segment.start, affinity } : null;
        }
        const entry = snapshot.endpoints.get(offset);
        const candidate = entry?.[affinity] || entry?.[affinity === 'upstream' ? 'downstream' : 'upstream'];
        if (!candidate) return null;
        // A boundary represented only on one side must retain its own affinity.
        const check = domToLogical(fragment, candidate.node, candidate.offset, candidate.affinity);
        return check?.offset === offset
            ? { node: candidate.node, offset: candidate.offset, affinity: candidate.affinity } : null;
    }

    return Object.freeze({ fromDOM, encode, toPlainText, domToLogical, logicalToDOM });
});
