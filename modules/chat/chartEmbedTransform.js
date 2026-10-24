import { replaceMarkdownCodeDomains } from '../renderer/markdownCodeDomainScanner.js';

const escape = value => String(value).replace(/[\u0026<>"']/g, char =>
    `\u0026#${char.charCodeAt(0)};`);

export function parseChartReference(body) {
    const fields = Object.create(null);
    for (const line of body.trim().split(/\r?\n/)) {
        const match = line.match(/^\s*(id|height|title)\s*:\s*(.*?)\s*$/);
        if (!match || Object.hasOwn(fields, match[1])) return null;
        fields[match[1]] = match[2];
    }
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(fields.id || '')) return null;
    const height = fields.height === undefined ? 360 : Number(fields.height);
    if (!Number.isInteger(height) || height < 180 || height > 900) return null;
    return { id: fields.id, height, title: (fields.title || fields.id).slice(0, 160) };
}

export function transformChartReferences(text) {
    return replaceMarkdownCodeDomains(String(text ?? ''), (domain, meta) => {
        if (meta.kind !== 'fence' || !meta.closed) return domain;
        const lines = domain.split('\n');
        if (!/^(`{3,}|~{3,})vcp-chart\s*\r?$/.test(lines[0])) return domain;
        while (lines.length && !lines.at(-1).trim()) lines.pop();
        const reference = parseChartReference(lines.slice(1, -1).join('\n'));
        if (!reference) return domain;
        const { id, height, title } = reference;
        return `\n\n<div class="vcp-chart-embed" data-vcp-block-type="chart-embed" data-vcp-preserve-children="true" data-chart-id="${escape(id)}" data-chart-height="${height}" data-chart-title="${escape(title)}" data-chart-reference="${escape(encodeURIComponent(domain))}" style="height:${height}px"></div>\n\n`;
    });
}