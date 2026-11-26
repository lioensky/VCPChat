import { escapeHtml } from '../ui-system/text-escape.js';

export function renderDailyNoteCard(note, renderBody) {
    const { command, maid, valet, date, fileName, folder, content, tag, target, replace } = note;
    const update = command === 'update';
    const kind = update ? 'diary-update' : 'diary';
    const agent = valet || maid;
    const role = valet ? 'valet' : 'maid';
    const label = valet ? 'Valet' : 'Maid';
    const name = agent ? `<span class="diary-maid-name">${escapeHtml(agent)}</span>` : '';
    const folderName = folder ? `<span class="diary-folder-name">${escapeHtml(folder)}</span>` : '';
    const separator = name && folderName ? ' <span class="diary-meta-separator">·</span> ' : '';
    const start = `<div class="maid-${kind}-bubble ${role}-${kind}-bubble" data-vcp-block-type="maid-${kind}" data-agent-gender="${valet ? 'male' : 'female'}" data-vcp-preserve-children="true">`;

    if (update) {
        const meta = name || folderName ? `<span class="diary-update-meta">${name}${separator}${folderName}</span>` : '';
        const side = (sideName, letter, text, fallback) => `<div class="diary-update-side diary-update-${sideName}"><div class="diary-update-label">${letter}</div><div class="diary-update-content">${text?.trim() ? renderBody(text) : fallback}</div></div>`;
        return `${start}<div class="diary-update-header"><span class="diary-update-title">DailyNote Update</span>${meta}</div><div class="diary-update-body">${side('before', 'A', target, '<em>原文解析失败</em>')}<div class="diary-update-arrow" aria-hidden="true">→</div>${side('after', 'B', replace, '<em>替换内容解析失败</em>')}</div></div>`;
    }

    const title = escapeHtml(fileName || `${label}'s Diary`);
    const dateHtml = date ? `<span class="diary-date">${escapeHtml(date)}</span>` : '';
    const meta = name || folderName ? `<div class="diary-maid-info">${name ? `<span class="diary-maid-label">${label}:</span> ${name}` : ''}${separator}${folderName ? `<span class="diary-folder-label">Folder:</span> ${folderName}` : ''}</div>` : '';
    const body = (content || '[日记内容解析失败]') + (tag ? `\n\nTag:${tag}` : '');
    return `${start}<div class="diary-header"><span class="diary-title">${title}</span>${dateHtml}</div>${meta}<div class="diary-content">${renderBody(body)}</div></div>`;
}