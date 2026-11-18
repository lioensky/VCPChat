// Bare http(s) URLs in AI-written HTML prose become links, the way marked already links them in Markdown text.
// Raw HTML blocks bypass Markdown's autolink rule, so "<p>主页：https://example.com</p>" stayed plain text.
// The link ends where markdownPolicy ends a bare Markdown link (Chinese punctuation, CJK in the host name).
// Clicks go through the existing delegated link handler on the chat list.
import { bareLinkEnd } from './markdownPolicy.js';

const URL_CANDIDATE = /https?:\/\/[^\s<>"'`]+/;
const SKIP = 'a, pre, code, button, script, style, textarea, input, select, option, svg, math, .katex, '
    + '[contenteditable], .vcp-tool-use-bubble, .vcp-tool-result-bubble, .vcp-tool-call-summary-bubble';

// Same trailing-punctuation rule as GFM: drop sentence punctuation, and a ')' only when it is unbalanced.
function trimTrailing(url) {
    let end = url.length;
    while (end > 0) {
        const char = url[end - 1];
        if (/[.,;:!?*_~]/.test(char)) { end -= 1; continue; }
        if (char === ')') {
            const part = url.slice(0, end);
            if ((part.match(/\(/g) || []).length < (part.match(/\)/g) || []).length) { end -= 1; continue; }
        }
        break;
    }
    return url.slice(0, end);
}

function isWebUrl(url) {
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
    } catch {
        return false;
    }
}

export function linkProseUrls(root) {
    const doc = root?.ownerDocument;
    if (!doc?.createTreeWalker || !root.textContent.includes('://')) return;
    const walker = doc.createTreeWalker(root, doc.defaultView.NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (/https?:\/\//i.test(node.nodeValue) && !node.parentElement?.closest(SKIP)) nodes.push(node);
    }
    for (const node of nodes) {
        const text = node.nodeValue;
        const fragment = doc.createDocumentFragment();
        const candidates = new RegExp(URL_CANDIDATE.source, 'gi');
        let cursor = 0;
        for (let match = candidates.exec(text); match; match = candidates.exec(text)) {
            const url = trimTrailing(match[0].slice(0, bareLinkEnd(match[0])));
            if (!isWebUrl(url)) continue;
            fragment.append(text.slice(cursor, match.index));
            const anchor = doc.createElement('a');
            anchor.href = url;
            anchor.textContent = url;
            fragment.append(anchor);
            cursor = match.index + url.length;
            // The next link may start right after this one's Chinese punctuation.
            candidates.lastIndex = cursor;
        }
        if (!cursor) continue;
        fragment.append(text.slice(cursor));
        node.replaceWith(fragment);
    }
}
