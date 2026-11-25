/**
 * Read-only navigation text for mounted bodies and cold placeholders.
 * Weak keys are body instances, not message IDs: no cross-surface/topic reuse,
 * detached DOM retention, model writes or rendering is involved.
 */
const coldPreviews = new WeakMap();
const EXCLUDED = '.thinking-indicator, style, script, .vcp-tool-use-bubble, details';
const MAX_PREVIEW_CHARS = 223; // 220 displayed + paragraph separator allowance + overflow
const whitespace = /\s/u;

function readBodyText(content) {
    const { NodeFilter } = content.ownerDocument.defaultView;
    const walker = content.ownerDocument.createTreeWalker(content,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
                return node.matches(EXCLUDED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
            }
        });
    let text = '';
    let pendingSpace = false;
    let newlines = 0;
    let secondParagraph = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const data = node.data;
        for (let i = 0; i < data.length; i++) {
            const ch = data[i];
            if (whitespace.test(ch)) {
                if (!text) continue;
                pendingSpace = true;
                if (ch === '\n' && ++newlines === 2 && secondParagraph) return text;
                continue;
            }
            // Whitespace may span inline elements. Commit it only when followed by text.
            if (pendingSpace) {
                if (newlines >= 2) {
                    text += '\n\n';
                    secondParagraph = true;
                } else {
                    text += ' ';
                }
                pendingSpace = false;
                newlines = 0;
            }
            text += ch;
            if (text.length >= MAX_PREVIEW_CHARS) return text.slice(0, MAX_PREVIEW_CHARS);
        }
    }
    return text;
}

export function retainMessagePreview(content) {
    coldPreviews.set(content, readBodyText(content));
}

export function releaseMessagePreview(content) {
    if (content) coldPreviews.delete(content);
}

export function readMessagePreviewText(messageItem) {
    const content = messageItem.querySelector('.md-content');
    if (!content) return '';
    if (messageItem.dataset.vcpDomEvicted === 'true' && !content.hasChildNodes()) {
        return coldPreviews.get(content) || '';
    }
    return readBodyText(content);
}