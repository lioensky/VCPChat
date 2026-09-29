// 解析逗号分隔的短语列表
function parseCommaPhrases(phraseStr) {
    if (!phraseStr || typeof phraseStr !== 'string') return [];
    return phraseStr
        .split(/[,，]/)
        .map(s => s.trim())
        .filter(Boolean);
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 匹配文本中的控制短语：命中清空返回 CLEAR，命中发送返回 SEND 并剥离短语，未命中返回 NORMAL
function matchSpeechDirective(rawText, options = {}) {
    const text = String(rawText || '').trim();
    if (!text) {
        return { action: 'NORMAL', text: '' };
    }

    const clearDirectives = options.clearDirectives || [];
    const sendDirectives = options.sendDirectives || [];

    for (const phrase of clearDirectives) {
        if (!phrase) continue;
        if (new RegExp(escapeRegex(phrase), 'i').test(text)) {
            return { action: 'CLEAR', text: '' };
        }
    }

    for (const phrase of sendDirectives) {
        if (!phrase) continue;
        const escaped = escapeRegex(phrase);
        if (new RegExp(escaped, 'i').test(text)) {
            const stripRegex = new RegExp(`[，,。！!？?、；;~～\\s]*${escaped}[，,。！!？?、；;~～\\s]*`, 'ig');
            return { action: 'SEND', text: text.replace(stripRegex, ' ').trim() };
        }
    }

    return { action: 'NORMAL', text };
}

const SpeechDirectiveMatcher = {
    parseCommaPhrases,
    matchSpeechDirective,
};

if (typeof window !== 'undefined') {
    window.VcpVoice = Object.assign(window.VcpVoice || {}, { SpeechDirectiveMatcher });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseCommaPhrases,
        matchSpeechDirective,
    };
}
