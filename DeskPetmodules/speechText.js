/* 桌宠朗读用的文字处理。不依赖 DOM，测试里可以直接载入。
 *
 * 回复是流式到达的。为了尽快开口、并让气泡跟着朗读进度走，原文边到边切成句子交给 TTS：
 * 切点放在原文（只追加不改写）里，偏移量不会因为 Markdown 整理而错位。 */
import { toBubbleText } from './bubbleText.js';

// 句末标点；后面紧跟的引号、括号、强调记号算在这一句里。
const SENTENCE_END = '。！？!?；;…\n';
const TRAILING = '”’"\'」』）)】》〉*_~`!！?？…。.';
// 太长又一直没有句末标点时，在这些地方断开。
const SOFT_BREAK = '，,、：: ';

/** 从一段 Markdown 原文得到念出来的文字：去掉 [代码]、[图片] 占位、列表圆点和只剩标点的碎片。 */
export function toSpeechText(markdown) {
    // 情绪标记、HTML 注释和 [[Flowlock::Start]] 这类控制标记不念（与主进程给主动搭话首句的清理同一规则）
    const plain = toBubbleText(String(markdown || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\[\[[A-Za-z]+::[^\]\n]*\]\]/g, ''))
        .replace(/\[(?:代码|图片)\]/g, ' ')
        .replace(/^[ \t]*•[ \t]*/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    // 一个字母、数字或汉字都没有（只有标点、表情符号）就不念
    return /[\p{L}\p{N}]/u.test(plain) ? plain : '';
}

function isBoundary(text, i, final) {
    const ch = text[i];
    if (SENTENCE_END.includes(ch)) return true;
    if (ch !== '.') return false;
    // 英文句号：后面是空白才算（3.5、a.b 不算）；流式时在末尾的句号要等下一个字才知道
    const next = text[i + 1];
    if (next === undefined) return final;
    return /\s/.test(next);
}

/**
 * 把只追加的原文切成句子。
 *   push(raw)   raw 是到目前为止的整条原文，返回新切出来的句子 [{ index, start, end, text }]
 *   finish(raw) 回复结束，剩下的也切出来
 * start/end 是这句在原文里的位置；text 是要念的文字，可能是空串（只有代码、图片），调用方跳过即可。
 * 太短的句子（「嗯。」）并到下一句里念，免得一字一顿；第一句门槛更低，让 TA 尽快开口。
 */
export function createSpeechChunker({ minChars = 5, firstMinChars = 3, maxChars = 90 } = {}) {
    let consumed = 0;
    let index = 0;

    function cut(raw, end) {
        const piece = raw.slice(consumed, end);
        const sentence = { index: index++, start: consumed, end, text: toSpeechText(piece) };
        consumed = end;
        return sentence;
    }

    function scan(raw, final) {
        const out = [];
        let i = consumed;
        while (i < raw.length) {
            if (!isBoundary(raw, i, final)) {
                // 一直没有句末标点：超长时在最近的逗号、空格处断开
                if (i - consumed >= maxChars) {
                    let at = -1;
                    for (let j = i; j > consumed + maxChars / 3; j -= 1) {
                        if (SOFT_BREAK.includes(raw[j])) { at = j + 1; break; }
                    }
                    out.push(cut(raw, at > 0 ? at : i));
                }
                i += 1;
                continue;
            }
            let end = i + 1;
            while (end < raw.length && TRAILING.includes(raw[end])) end += 1;
            // 流式时句末标点后面还没来字：可能还有「！！」「”」，等下一段再定
            if (end >= raw.length && !final) break;
            const need = index === 0 ? firstMinChars : minChars;
            if (toSpeechText(raw.slice(consumed, end)).length >= need || /\n/.test(raw[i])) {
                out.push(cut(raw, end));
            }
            i = end;
        }
        return out;
    }

    return {
        push(raw) { return scan(String(raw || ''), false); },
        finish(raw) {
            const text = String(raw || '');
            const out = scan(text, true);
            if (consumed < text.length) out.push(cut(text, text.length));
            return out;
        },
        get consumed() { return consumed; },
    };
}
