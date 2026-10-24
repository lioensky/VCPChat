import { findExplicitStablePrefix } from './streamStableBoundary.js';
import { collectToolResultRanges } from './toolResultRegions.js';
import { replaceToolRequestBlocks, findUnclosedToolRequest } from './toolRequestScanner.js';

// 只处理已经提交的完整稳定区；未闭合的隐藏结构在终态也不能泄漏到语音。
export function cleanSpeechSource(value) {
    let text = String(value || '');
    const ranges = collectToolResultRanges(text);
    for (let i = ranges.length - 1; i >= 0; i--) {
        text = text.slice(0, ranges[i].start) + '\n' + text.slice(ranges[i].end);
    }
    text = replaceToolRequestBlocks(text, () => '\n');
    const unclosed = findUnclosedToolRequest(text);
    if (unclosed != null) {
        const start = typeof unclosed === 'number' ? unclosed : unclosed.startIndex ?? unclosed.start;
        if (Number.isInteger(start)) text = text.slice(0, start);
    }
    return text
        .replace(/<<<\[ROLE_DIVIDE_(SYSTEM|USER)\]>>>[\s\S]*?(?:<<<\[END_ROLE_DIVIDE_\1\]>>>|$)/gi, '\n')
        .replace(/<<<\[(?:END_)?ROLE_DIVIDE_ASSISTANT\]>>>/gi, '\n')
        .replace(/\[本轮工具调用摘要:\][\s\S]*?(?:\[本轮工具调用摘要结束\]|$)/g, '\n')
        .replace(/<<<\[DESKTOP_PUSH\]>>>[\s\S]*?(?:<<<\[DESKTOP_PUSH_END\]>>>|$)/g, '\n')
        .replace(/<<<DailyNoteStart>>>[\s\S]*?(?:<<<DailyNoteEnd>>>|$)/g, '\n')
        .replace(/\[--- VCP元思考链[^\n]*[\s\S]*?(?:\[--- 元思考链结束 ---\]|$)/g, '\n')
        .replace(/<(think|thinking|style|script|pre|svg|iframe|canvas)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '\n')
        .replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[ \t]*(?:\n|$)|$(?![\s\S]))/gm, '\n')
        .replace(/<!--(?!\s*emo\s*[:：])[\s\S]*?(?:-->|$)/gi, '')
        .replace(/\[\[[A-Za-z]+::[^\]\n]*\]\]/g, '');
}

export function speechSourceToText(source, document) {
    let text = cleanSpeechSource(source)
        .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
        .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, ' ')
        .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
        .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '')
        .replace(/(\*\*|__|~~)([\s\S]*?)\1/g, '$2')
        .replace(/`([^`\n]+)`/g, '$1');
    if (document?.createElement) {
        const root = document.createElement('div');
        root.innerHTML = text;
        root.querySelectorAll('style, script, pre, svg, iframe, canvas, button, [data-vcp-block-type], .vcp-tool-use-bubble, .vcp-tool-result-bubble, .vcp-role-divider').forEach(node => node.remove());
        root.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
        root.querySelectorAll('p, div, li, h1, h2, h3, blockquote').forEach(node => node.append('\n'));
        text = root.textContent || '';
    } else {
        text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '');
    }
    return text.replace(/@!?[\u4e00-\u9fa5A-Za-z0-9_]+/g, '')
        .replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n').trim();
}

/** 每条生成独占一个实例；不依赖可见 DOM，也不受平滑显示队列影响。 */
export function createStableSpeechStream({ document, render } = {}) {
    let raw = '';
    let committed = 0;
    let sequence = 0;
    let closed = false;
    function commit(end) {
        if (end <= committed) return [];
        const start = committed;
        const original = raw.slice(start, end);
        committed = end;
        const cleaned = cleanSpeechSource(original);
        const rendered = render ? render(cleaned) : cleaned;
        // 保留情绪事件，但气泡/桌宠也只消费净化正文，避免再次按句切开 HTML。
        const source = cleaned.split(/(<!--\s*emo\s*[:：][\s\S]*?-->)/gi)
            .map(piece => /^<!--\s*emo\s*[:：]/i.test(piece)
                ? piece : speechSourceToText(render ? render(piece) : piece, document))
            .join('\n') + '\n\n';
        return [{ index: sequence++, start, end, source, text: speechSourceToText(rendered, document) }];
    }
    return Object.freeze({
        push(delta) {
            if (closed || typeof delta !== 'string') return [];
            raw += delta;
            return commit(findExplicitStablePrefix(raw, committed));
        },
        finish(fullText) {
            if (closed) return [];
            // 规范终稿可能追加尾部；已经提交的前缀不可改写或重播。
            if (typeof fullText === 'string' && fullText.startsWith(raw.slice(0, committed))) raw = fullText;
            closed = true;
            return commit(raw.length);
        },
        cancel() { closed = true; raw = ''; },
    });
}