/** Pure content transforms used by ContentRuntime; no DOM or Electron access. */
const HTML_ENTITIES = Object.freeze({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" });

export function decodeHtmlEntities(value) {
    return String(value ?? '').replace(/&(?:amp|lt|gt|quot|#39|apos);|&#x[0-9a-f]+;|&#\d+;/gi, token => {
        if (HTML_ENTITIES[token]) return HTML_ENTITIES[token];
        const code = token.toLowerCase().startsWith('&#x')
            ? Number.parseInt(token.slice(3, -1), 16)
            : Number.parseInt(token.slice(2, -1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : token;
    });
}

export function createMermaidPlaceholderTransform() {
    const mermaidCodeRegex = /<code.*?>\s*(flowchart|graph|mermaid)\s+([\s\S]*?)<\/code>/gi;
    const mermaidFenceRegex = /```(mermaid|flowchart|graph)[^\S\n]*\n([\s\S]*?)```/gi;
    return text => String(text ?? '')
        .replace(mermaidCodeRegex, (_match, _lang, code) => `<div class="mermaid-placeholder" data-vcp-block-type="mermaid" data-vcp-preserve-children="true" data-mermaid-code="${encodeURIComponent(decodeHtmlEntities(code).trim())}"></div>`)
        // encodeURIComponent 已足以安全承载双引号 HTML 属性值；不能先做 HTML
        // 转义，否则 Mermaid 箭头 "-->" 会变成 "-->" 并导致语法解析失败。
        .replace(mermaidFenceRegex, (_match, _lang, code) => `<div class="mermaid-placeholder" data-vcp-block-type="mermaid" data-vcp-preserve-children="true" data-mermaid-code="${encodeURIComponent(code.trim())}"></div>`);
}
