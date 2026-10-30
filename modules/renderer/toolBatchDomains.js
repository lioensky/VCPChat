import { collectToolBatchRanges } from './toolBatchRegions.js';

/** 源码分域，不修改原文。紧贴批次的后端角色外壳独立于正文语法。 */
export function splitToolBatchDomains(text) {
    const batches = collectToolBatchRanges(text);
    if (!batches.length) return [{ type: 'text', source: text, start: 0, end: text.length }];
    const domains = [];
    let cursor = 0;
    const append = (type, start, end) => {
        if (end > start) domains.push({ type, source: text.slice(start, end), start, end });
    };
    for (const batch of batches) {
        const before = text.slice(cursor, batch.start);
        const shell = before.match(/<<<\[ROLE_DIVIDE_USER\]>>>\s*$/);
        const shellStart = shell ? cursor + shell.index : batch.start;
        append('text', cursor, shellStart);
        append('role', shellStart, batch.start);
        append('batch', batch.start, batch.end);
        cursor = batch.end;
        if (shell && batch.closed) {
            const endShell = text.slice(cursor).match(/^\s*<<<\[END_ROLE_DIVIDE_USER\]>>>/);
            if (endShell) {
                append('role', cursor, cursor + endShell[0].length);
                cursor += endShell[0].length;
            }
        }
    }
    append('text', cursor, text.length);
    return domains;
}

/** 所有规则在同一正文域内顺序执行，不能改写批次或后端角色外壳。 */
export function transformToolBatchText(text, transform) {
    return splitToolBatchDomains(text).map(domain =>
        domain.type === 'text' ? transform(domain.source) : domain.source
    ).join('');
}

/**
 * 每个域先在独立 inert 模板内完成 HTML 建树，再组合节点。
 * 不把未闭合标签/注释的 tokenizer 状态传递给下一个域。
 */
export function composeToolBatchHtml(domains, render, document) {
    if (!document?.createElement) {
        throw new TypeError('Tool batch domain composition requires an owning document');
    }
    const output = document.createElement('template');
    for (const domain of domains) {
        const part = document.createElement('template');
        part.innerHTML = render(domain);
        // plaintext 的结束标签不被 HTML tokenizer 识别，不能序列化回活动 HTML。
        part.content.querySelectorAll('plaintext').forEach(node => {
            const pre = document.createElement('pre');
            pre.textContent = node.textContent;
            node.replaceWith(pre);
        });
        output.content.append(part.content);
    }
    return output.innerHTML;
}