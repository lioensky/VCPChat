/**
 * Read-only navigation text for mounted bodies and cold placeholders.
 * Weak keys are body instances, not message IDs: no cross-surface/topic reuse,
 * detached DOM retention, model writes or rendering is involved.
 */
const coldPreviews = new WeakMap();
const EXCLUDED = '.thinking-indicator, style, script, .vcp-tool-use-bubble, details';
const MAX_COLD_PREVIEW_CHARS = 223; // 220 displayed + two paragraph separators + overflow

function readBodyText(content) {
    const clone = content.cloneNode(true);
    clone.querySelectorAll(EXCLUDED).forEach(node => node.remove());
    return clone.textContent || '';
}

export function retainMessagePreview(content) {
    // Match the navigator's paragraph/whitespace semantics before bounding storage.
    const text = readBodyText(content).trim().split(/\n\s*\n/u)
        .map(paragraph => paragraph.replace(/\s+/gu, ' ').trim())
        .filter(Boolean).slice(0, 2).join('\n\n');
    coldPreviews.set(content, text.slice(0, MAX_COLD_PREVIEW_CHARS));
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