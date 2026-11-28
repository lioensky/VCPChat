import { composeToolBatchHtml } from './toolBatchDomains.js';
import { renderDailyNoteCard } from './dailyNoteCard.js';
import { sanitizeToolDataHtml } from './toolDataHtml.js';
import { escapeHtml } from '../ui-system/text-escape.js';

const textField = (...values) => values.find(value => typeof value === 'string' && value.trim()) ?? '';

function createHostedDailyNoteCard(document, call, args) {
    if (call.function.name !== 'vcptools' || textField(args?.tool_name).trim().toLowerCase() !== 'dailynote') return null;
    const command = textField(args.command).trim().toLowerCase();
    const content = textField(args.Content, args.content);
    const target = textField(args.target);
    const replace = typeof args.replace === 'string' ? args.replace : null;
    const update = command === 'update' || (!command && target && replace !== null);
    if (update ? !target || replace === null : !content || (command && command !== 'create')) return null;

    const template = document.createElement('template');
    const marked = document.defaultView?.marked;
    template.innerHTML = renderDailyNoteCard({
        command: update ? 'update' : 'create',
        maid: textField(args.maid, args.maidName),
        valet: textField(args.valet, args.valetName),
        date: textField(args.Date, args.date),
        fileName: textField(args.fileName),
        folder: textField(args.folder),
        content, tag: textField(args.Tag, args.tag), target, replace,
    }, text => {
        try {
            const html = marked?.parse?.(text, { mangle: false, headerIds: false });
            if (typeof html === 'string') return sanitizeToolDataHtml(html, document);
        } catch { /* Fall back to plain text if Markdown cannot be parsed. */ }
        return escapeHtml(text).replace(/\r\n?|\n/g, '<br>');
    });
    const card = template.content.firstElementChild;
    card.dataset.vcpToolCallId = call.id;
    return card;
}

export function createHostedToolCallCard(document, calls) {
    const batch = document.createElement('div');
    batch.className = 'vcp-hosted-tool-call-batch';
    for (const call of calls) {
        if (typeof call?.id !== 'string' || typeof call.function?.arguments !== 'string') continue;
        const details = document.createElement('div');
        details.className = 'vcp-hosted-tool-call vcp-tool-use-bubble';
        details.dataset.vcpBlockType = 'tool-use';
        details.dataset.vcpToolCallId = call.id;
        const summary = document.createElement('div');
        summary.className = 'vcp-tool-summary';
        let label = call.function.name;
        let payloadText = call.function.arguments;
        try {
            const args = JSON.parse(payloadText);
            const diary = createHostedDailyNoteCard(document, call, args);
            if (diary) {
                batch.append(diary);
                continue;
            }
            if (typeof args?.tool_name === 'string' && args.tool_name.trim()) label = args.tool_name.trim();
            if (args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length) {
                payloadText = Object.entries(args).map(([key, value]) => {
                    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
                    return `${key}: ${text.replace(/\r\n?/g, '\n').replace(/\n/g, '\n  ')}`;
                }).join('\n');
            }
        } catch { /* Keep the original text if it is not valid JSON. */ }
        const title = document.createElement('span');
        title.className = 'vcp-tool-name-highlight';
        title.textContent = label || '未命名';
        summary.append('函数调用 · ', title);
        const body = document.createElement('div');
        body.className = 'vcp-tool-details';
        const template = document.createElement('template');
        template.className = 'vcp-tool-details-template';
        const payload = document.createElement('pre');
        payload.textContent = payloadText;
        template.content.append(payload);
        details.append(summary, body, template);
        batch.append(details);
    }
    return batch;
}

export function renderHostedAssistantSegments(segments, renderText, document) {
    return composeToolBatchHtml(segments, segment => {
        if (Array.isArray(segment?.tool_calls)) return [...createHostedToolCallCard(document, segment.tool_calls).children].map(card => card.outerHTML).join('');
        return typeof segment?.content === 'string' && segment.content ? renderText(segment.content) : '';
    }, document);
}