import { composeToolBatchHtml } from './toolBatchDomains.js';

export function createHostedToolCallCard(document, calls) {
    const batch = document.createElement('div');
    batch.className = 'vcp-hosted-tool-call-batch';
    for (const call of calls) {
        if (typeof call?.id !== 'string' || typeof call.function?.arguments !== 'string') continue;
        const details = document.createElement('details');
        details.className = 'vcp-hosted-tool-call';
        details.dataset.vcpToolCallId = call.id;
        const summary = document.createElement('summary');
        let label = call.function.name;
        try {
            const args = JSON.parse(call.function.arguments);
            if (typeof args?.tool_name === 'string' && args.tool_name.trim()) label = args.tool_name.trim();
        } catch { /* Show raw arguments below. */ }
        summary.textContent = `函数调用 · ${label || '未命名'}`;
        const payload = document.createElement('pre');
        payload.textContent = call.function.arguments;
        details.append(summary, payload);
        batch.append(details);
    }
    return batch;
}

export function renderHostedAssistantSegments(segments, renderText, document) {
    return composeToolBatchHtml(segments, segment => {
        if (Array.isArray(segment?.tool_calls)) return createHostedToolCallCard(document, segment.tool_calls).outerHTML;
        return typeof segment?.content === 'string' && segment.content ? renderText(segment.content) : '';
    }, document);
}