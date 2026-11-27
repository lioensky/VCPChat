// modules/lyrics/parserCore.js
// Universal Lyric Parser supporting YRC, QRC, KRC, TTML, and LRC
// Ported from Folia parserCore with CommonJS compatibility

const { decodeKrcLanguageTag } = require('./krcDecrypt');

const LRC_LINE_TIME_REGEX = /^\[(\d{2}):(\d{2})[.:](\d{2,3})\]/;
const GLOBAL_LRC_TIME_REGEX = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;
const GLOBAL_ANGLE_TIME_REGEX = /<(\d{2}):(\d{2})[.:](\d{2,3})>/g;

function isSourceMigrationArtifact(text) {
    return typeof text === 'string' && text.trim() === '//';
}

function createLyricData(lines, isWordByWord) {
    return {
        lines: (lines || []).filter(line => !isSourceMigrationArtifact(line?.fullText)),
        isWordByWord
    };
}

function parseTimestamp(minute, second, fraction) {
    const min = parseInt(minute, 10);
    const sec = parseInt(second, 10);
    const ms = parseFloat(`0.${fraction}`);
    return min * 60 + sec + ms;
}

/**
 * Splits plain text into simulated timed words based on CJK/Western weighting
 */
function buildTimedWords(text, startTime, endTime) {
    const duration = Math.max(endTime - startTime, 0.1);
    const rawTokens = text.split(/\s+/).filter(Boolean);
    const words = [];
    const tokens = [];
    let totalWeight = 0;

    rawTokens.forEach((token, tokenIndex) => {
        if (/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(token)) {
            token.split('').forEach(char => {
                const isPunctuation = /[，。！？、：；"'）\s]/.test(char);
                const weight = isPunctuation ? 0 : 1;
                tokens.push({ text: char, weight });
                totalWeight += weight;
            });
        } else {
            const weight = 1 + (token.length * 0.15);
            tokens.push({ text: token, weight });
            totalWeight += weight;
        }
        // 原文里词和词之间的空格留在前一个词的末尾（和网易云逐字歌词一样），英文逐字显示时才不会粘成一串
        if (tokenIndex < rawTokens.length - 1) tokens[tokens.length - 1].text += ' ';
    });

    if (totalWeight === 0) totalWeight = 1;

    const activeDuration = duration * 0.92;
    const timePerWeight = activeDuration / totalWeight;
    let currentWordStart = startTime;

    tokens.forEach(token => {
        const wordDuration = token.weight * timePerWeight;
        const finalDuration = Math.max(wordDuration, 0.04);

        words.push({
            text: token.text,
            startTime: Number(currentWordStart.toFixed(3)),
            endTime: Number((currentWordStart + finalDuration).toFixed(3))
        });

        if (token.weight > 0) {
            currentWordStart += wordDuration;
        } else {
            currentWordStart += 0.04;
        }
    });

    return words;
}

/**
 * Parses simple timed text from LRC line
 */
function parseSimpleTimedTextEntry(line) {
    const match = line.match(/^((?:\[(?:\d{2}):(?:\d{2})[.:](?:\d{2,3})\])+)(.*)$/);
    if (!match) return null;

    const firstTag = match[1].match(LRC_LINE_TIME_REGEX);
    if (!firstTag) return null;

    const text = match[2].trim();
    if (!text) return null;

    return {
        startTime: parseTimestamp(firstTag[1], firstTag[2], firstTag[3]),
        text
    };
}

/**
 * Extracts line timestamp map from LRC / translation text
 */
function parseTimedEntries(content) {
    if (!content) return [];
    const entries = [];
    const rawLines = content.replace(/^\uFEFF/, '').split(/\r?\n/);

    for (const rawLine of rawLines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('[ti:') || line.startsWith('[ar:') || line.startsWith('[al:')) continue;

        const entry = parseSimpleTimedTextEntry(line);
        if (entry && entry.text) {
            entries.push(entry);
        }
    }
    return entries.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Aligns a single lyric start time to the closest sorted translation entry (1.2s tolerance).
 * Preserves first-entry tie breaking when two entries are equidistant.
 */
function findClosestTimedText(startTime, entries) {
    const n = entries.length;
    if (n === 0) return undefined;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (entries[mid].startTime < startTime) lo = mid + 1;
        else hi = mid;
    }
    let bestEntry = undefined;
    let minDiff = 1.2; // 1.2s tolerance
    if (lo > 0) {
        let left = lo - 1;
        const leftTime = entries[left].startTime;
        while (left > 0 && entries[left - 1].startTime === leftTime) left--;
        const diff = Math.abs(leftTime - startTime);
        if (diff < minDiff) {
            minDiff = diff;
            bestEntry = entries[left].text;
        }
    }
    if (lo < n) {
        const diff = Math.abs(entries[lo].startTime - startTime);
        if (diff < minDiff) {
            bestEntry = entries[lo].text;
        }
    }
    return bestEntry;
}

/**
 * Aligns translation text with lyric start times
 */
function matchTranslations(startTimes, entries) {
    if (startTimes.length === 0 || entries.length === 0) return startTimes.map(() => undefined);
    return startTimes.map(startTime => findClosestTimedText(startTime, entries));
}

/**
 * Parses NetEase YRC lyric string
 * Format: [start_ms, duration_ms](word_start_ms, word_duration_ms, 0)word_text...
 */
function parseYRC(yrcString, translationString = '', romanizationString = '') {
    const lines = [];
    const rawLines = yrcString.replace(/^\uFEFF/, '').split(/\r?\n/);
    const translationEntries = parseTimedEntries(translationString);
    const romanizationEntries = parseTimedEntries(romanizationString);

    for (const rawLine of rawLines) {
        const lineMatch = rawLine.match(/^\[(\d+),(\d+)\](.*)/);
        if (!lineMatch) continue;

        const lineStartTimeMs = parseInt(lineMatch[1], 10);
        const lineDurationMs = parseInt(lineMatch[2], 10);
        const rest = lineMatch[3];
        const lineStartTime = lineStartTimeMs / 1000;
        const lineEndTime = (lineStartTimeMs + lineDurationMs) / 1000;

        const words = [];
        let fullText = '';

        const wordRegex = /\((\d+),(\d+),(\d+)\)([^\(]*)/g;
        let wordMatch;

        while ((wordMatch = wordRegex.exec(rest)) !== null) {
            const wordStartMs = parseInt(wordMatch[1], 10);
            const wordDurationMs = parseInt(wordMatch[2], 10);
            const text = wordMatch[4];

            words.push({
                text,
                startTime: Number((wordStartMs / 1000).toFixed(3)),
                endTime: Number(((wordStartMs + wordDurationMs) / 1000).toFixed(3))
            });
            fullText += text;
        }

        if (words.length > 0) {
            lines.push({
                words,
                startTime: Number(lineStartTime.toFixed(3)),
                endTime: Number(lineEndTime.toFixed(3)),
                fullText
            });
        }
    }

    lines.sort((a, b) => a.startTime - b.startTime);
    const translations = matchTranslations(lines.map(l => l.startTime), translationEntries);
    const romanizations = matchTranslations(lines.map(l => l.startTime), romanizationEntries);

    lines.forEach((line, idx) => {
        if (translations[idx]) line.translation = translations[idx];
        if (romanizations[idx]) line.romanization = romanizations[idx];
    });

    return createLyricData(lines, true);
}

/**
 * Parses QQ Music QRC lyric string
 * Format: [start_ms, duration_ms](word_start_ms, word_duration_ms)word_text... or with tags
 */
function parseQRC(qrcString, translationString = '', romanizationString = '') {
    const lines = [];
    const rawLines = qrcString.replace(/^\uFEFF/, '').split(/\r?\n/);
    const translationEntries = parseTimedEntries(translationString);
    const romanizationEntries = parseTimedEntries(romanizationString);

    for (const rawLine of rawLines) {
        const lineMatch = rawLine.match(/^\[(\d+),(\d+)\](.*)/);
        if (!lineMatch) continue;

        const lineStartTimeMs = parseInt(lineMatch[1], 10);
        const lineDurationMs = parseInt(lineMatch[2], 10);
        const rest = lineMatch[3];
        const lineStartTime = lineStartTimeMs / 1000;
        const lineEndTime = (lineStartTimeMs + lineDurationMs) / 1000;

        const words = [];
        let fullText = '';
        const tagRegex = /\((\d+),(\d+)(?:,\d+)?\)/g;
        const tags = [];
        let tagMatch;

        while ((tagMatch = tagRegex.exec(rest)) !== null) {
            tags.push({
                startMs: parseInt(tagMatch[1], 10),
                durationMs: parseInt(tagMatch[2], 10),
                tagStart: tagMatch.index,
                tagEnd: tagMatch.index + tagMatch[0].length,
            });
        }

        if (tags.length === 0) continue;

        const textChunks = [];
        let cursor = 0;
        for (const tag of tags) {
            textChunks.push(rest.slice(cursor, tag.tagStart));
            cursor = tag.tagEnd;
        }
        textChunks.push(rest.slice(cursor));

        const prefersLeadingText = textChunks[0].trim().length > 0 && textChunks[textChunks.length - 1].trim().length === 0;

        for (let index = 0; index < tags.length; index += 1) {
            const tag = tags[index];
            const leadingText = textChunks[index] ?? '';
            const trailingText = textChunks[index + 1] ?? '';
            let text = prefersLeadingText ? leadingText : (trailingText || leadingText);
            if (!text) continue;

            words.push({
                text,
                startTime: Number((tag.startMs / 1000).toFixed(3)),
                endTime: Number(((tag.startMs + tag.durationMs) / 1000).toFixed(3))
            });
            fullText += text;
        }

        if (words.length > 0) {
            lines.push({
                words,
                startTime: Number(lineStartTime.toFixed(3)),
                endTime: Number(lineEndTime.toFixed(3)),
                fullText
            });
        }
    }

    lines.sort((a, b) => a.startTime - b.startTime);
    const translations = matchTranslations(lines.map(l => l.startTime), translationEntries);
    const romanizations = matchTranslations(lines.map(l => l.startTime), romanizationEntries);

    lines.forEach((line, idx) => {
        if (translations[idx]) line.translation = translations[idx];
        if (romanizations[idx]) line.romanization = romanizations[idx];
    });

    return createLyricData(lines, true);
}

/**
 * Parses Kugou KRC lyric string
 * Format: [start_ms, duration_ms]<offset_ms, duration_ms, 0>word_text...
 */
function parseKRC(krcString, translationString = '', romanizationString = '') {
    const lines = [];
    const { translations: embeddedTranslations, romanizations: embeddedRomanizations } = decodeKrcLanguageTag(krcString);
    const translationEntries = parseTimedEntries(translationString);
    const romanizationEntries = parseTimedEntries(romanizationString);
    const rawLines = krcString.replace(/^\uFEFF/, '').split(/\r?\n/);

    for (const rawLine of rawLines) {
        const lineMatch = rawLine.match(/^\[(\d+),(\d+)\](.*)/);
        if (!lineMatch) continue;

        const lineStartTimeMs = parseInt(lineMatch[1], 10);
        const lineDurationMs = parseInt(lineMatch[2], 10);
        const rest = lineMatch[3];
        const lineStartTime = lineStartTimeMs / 1000;
        const lineEndTime = (lineStartTimeMs + lineDurationMs) / 1000;

        const words = [];
        let fullText = '';
        const wordRegex = /<(\d+),(\d+)(?:,\d+)?>([^<]*)/g;
        let wordMatch;

        while ((wordMatch = wordRegex.exec(rest)) !== null) {
            const wordOffsetMs = parseInt(wordMatch[1], 10);
            const wordDurationMs = parseInt(wordMatch[2], 10);
            const text = wordMatch[3];
            const wordStartMs = lineStartTimeMs + wordOffsetMs;

            words.push({
                text,
                startTime: Number((wordStartMs / 1000).toFixed(3)),
                endTime: Number(((wordStartMs + wordDurationMs) / 1000).toFixed(3))
            });
            fullText += text;
        }

        if (words.length === 0 && rest.trim() && !rest.startsWith('[')) {
            words.push(...buildTimedWords(rest.trim(), lineStartTime, lineEndTime));
            fullText = rest.trim();
        }

        if (words.length > 0) {
            lines.push({
                words,
                startTime: Number(lineStartTime.toFixed(3)),
                endTime: Number(lineEndTime.toFixed(3)),
                fullText
            });
        }
    }

    lines.sort((a, b) => a.startTime - b.startTime);
    lines.forEach((line, idx) => {
        let trans = embeddedTranslations[idx];
        let roma = embeddedRomanizations[idx];
        if (!trans && translationEntries.length > 0) {
            trans = findClosestTimedText(line.startTime, translationEntries);
        }
        if (!roma && romanizationEntries.length > 0) {
            roma = findClosestTimedText(line.startTime, romanizationEntries);
        }
        if (trans) line.translation = trans;
        if (roma) line.romanization = roma;
    });

    return createLyricData(lines, true);
}

/**
 * Parses Apple Music-like TTML xml text
 * Format: <p begin="00:01.000" end="00:05.000"><span begin="00:01.000" end="00:02.000">Word</span>...</p>
 */
/*
 * TTML（Apple Music / AMLL 的逐字歌词格式）。不用 DOM，按标签顺序走一遍：
 *   - <p begin end> 是一行，带 begin/end 的 <span> 是一个词；词与词之间的空白算进前一个词（英文才不粘连）；
 *   - <span ttm:role="x-translation"> / "x-roman" 是这一行的翻译 / 罗马音；"x-bg" 是和声，放在主唱后面、加括号；
 *   - 头部 <iTunesMetadata> 里按 itunes:key 对行的 <translation>/<transliteration> 也认（有中文优先用中文）；
 *   - &amp; 之类的实体、"12.5s" / "1:02.3" / "00:01:02.300" 这几种时间写法都认。
 */
const TTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeXmlText(text) {
    return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
        if (name[0] === '#') {
            const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
        }
        const hit = TTML_ENTITIES[name.toLowerCase()];
        return hit === undefined ? all : hit;
    });
}
function parseTtmlTime(str) {
    const text = String(str || '').trim();
    if (!text) return NaN;
    let m = /^(-?\d+(?:\.\d+)?)(h|m|s|ms)$/i.exec(text);
    if (m) {
        const v = parseFloat(m[1]);
        const unit = m[2].toLowerCase();
        return unit === 'h' ? v * 3600 : unit === 'm' ? v * 60 : unit === 'ms' ? v / 1000 : v;
    }
    const parts = text.split(':');
    if (parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) return NaN;
    return parts.reduce((sum, part) => sum * 60 + parseFloat(part), 0);
}
const TTML_ATTR_RE_CACHE = new Map();
function ttmlAttr(attrs, name) {
    if (!attrs) return '';
    let re = TTML_ATTR_RE_CACHE.get(name);
    if (!re) {
        re = new RegExp('(?:^|\\s)(?:[\\w-]+:)?' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i');
        TTML_ATTR_RE_CACHE.set(name, re);
    }
    const m = re.exec(attrs);
    return m ? decodeXmlText(m[2] !== undefined ? m[2] : m[3]) : '';
}
function ttmlHeadTexts(ttmlString, tag) {
    // <translation xml:lang="zh-Hans"><text for="L1">…</text></translation>；有几种语言时中文优先
    const blocks = [];
    const blockRe = new RegExp('<' + tag + '\\b([^>]*)>([\\s\\S]*?)</' + tag + '>', 'gi');
    let m;
    while ((m = blockRe.exec(ttmlString)) !== null) blocks.push({ lang: ttmlAttr(m[1], 'lang'), body: m[2] });
    if (!blocks.length) return new Map();
    const pick = blocks.find(b => /^zh/i.test(b.lang)) || blocks[0];
    const out = new Map();
    const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    while ((m = textRe.exec(pick.body)) !== null) {
        const key = ttmlAttr(m[1], 'for');
        const value = decodeXmlText(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        if (key && value) out.set(key, value);
    }
    return out;
}

function parseTTML(ttmlString) {
    const source = String(ttmlString || '');
    const lines = [];
    const headTranslations = ttmlHeadTexts(source, 'translation');
    const headRomanizations = ttmlHeadTexts(source, 'transliteration');
    const body = source.replace(/<head\b[\s\S]*?<\/head>/i, '');
    const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    const tokenRe = /<(\/?)([\w:-]+)\b([^>]*?)(\/?)>|([^<]+)/g;

    let pMatch;
    while ((pMatch = pRegex.exec(body)) !== null) {
        const lineStart = parseTtmlTime(ttmlAttr(pMatch[1], 'begin'));
        const lineEndRaw = parseTtmlTime(ttmlAttr(pMatch[1], 'end'));
        if (!Number.isFinite(lineStart)) continue;
        const key = ttmlAttr(pMatch[1], 'key');

        const main = [];
        const background = [];
        let translation = '';
        let romanization = '';
        let plain = '';
        const stack = []; // 每层 span：{ role, word }
        let tm;
        tokenRe.lastIndex = 0;
        while ((tm = tokenRe.exec(pMatch[2])) !== null) {
            if (tm[5] !== undefined) {
                const text = decodeXmlText(tm[5]);
                let isTrans = false, isRoman = false, isBg = false, wordFrame = null;
                for (let si = stack.length - 1; si >= 0; si--) {
                    const frame = stack[si];
                    if (frame.role === 'x-translation') isTrans = true;
                    else if (frame.role === 'x-roman') isRoman = true;
                    else if (frame.role === 'x-bg') isBg = true;
                    if (!wordFrame && frame.word) wordFrame = frame;
                }
                if (isTrans) { translation += text; continue; }
                if (isRoman) { romanization += text; continue; }
                const target = isBg ? background : main;
                if (wordFrame && wordFrame.word) wordFrame.word.text += text;
                else if (/^\s+$/.test(text)) {
                    // 词之间的空格保留；带换行的是排版缩进（美化过的文件），不算
                    if (!/[\r\n]/.test(text) && target.length) target[target.length - 1].text += ' ';
                }
                else plain += text; // 没有逐字时间的字：整行退回按字均分
                continue;
            }
            const closing = tm[1] === '/';
            const tag = tm[2].toLowerCase().replace(/^.*:/, '');
            if (tag === 'br' && !closing) { if (main.length) main[main.length - 1].text += ' '; continue; }
            if (tag !== 'span') continue;
            if (closing) { stack.pop(); continue; }
            const attrs = tm[3];
            const role = ttmlAttr(attrs, 'role');
            const begin = parseTtmlTime(ttmlAttr(attrs, 'begin'));
            const end = parseTtmlTime(ttmlAttr(attrs, 'end'));
            let word = null;
            if (!role && Number.isFinite(begin)) {
                word = { text: '', startTime: begin, endTime: Number.isFinite(end) && end >= begin ? end : begin };
                (stack.some(f => f.role === 'x-bg') ? background : main).push(word);
            }
            if (tm[4] === '/') continue; // <span/> 自闭合
            stack.push({ role, word });
        }

        let words = main.filter(w => w.text !== '');
        const bg = background.filter(w => w.text.trim() !== '');
        if (!words.length) {
            const cleanText = plain.replace(/\s+/g, ' ').trim();
            const end = Number.isFinite(lineEndRaw) ? lineEndRaw : lineStart + 4;
            if (cleanText) words = buildTimedWords(cleanText, lineStart, end);
        }
        if (bg.length) {
            if (words.length && !/\s$/.test(words[words.length - 1].text)) words[words.length - 1].text += ' ';
            bg[0].text = '(' + bg[0].text.replace(/^\s+/, '');
            bg[bg.length - 1].text = bg[bg.length - 1].text.replace(/\s+$/, '') + ')';
            words = words.concat(bg);
        }
        if (!words.length) continue;
        const last = words[words.length - 1];
        last.text = last.text.replace(/\s+$/, '');
        words = words.map(w => ({ text: w.text, startTime: Number(w.startTime.toFixed(3)), endTime: Number(w.endTime.toFixed(3)) }));
        const lineEnd = Number.isFinite(lineEndRaw) ? lineEndRaw : Math.max(lineStart, ...words.map(w => w.endTime));
        const line = {
            words,
            startTime: Number(lineStart.toFixed(3)),
            endTime: Number(Math.max(lineStart, lineEnd).toFixed(3)),
            fullText: words.map(w => w.text).join('')
        };
        const tr = (translation.replace(/\s+/g, ' ').trim()) || (key && headTranslations.get(key)) || '';
        const ro = (romanization.replace(/\s+/g, ' ').trim()) || (key && headRomanizations.get(key)) || '';
        if (tr) line.translation = tr;
        if (ro) line.romanization = ro;
        lines.push(line);
    }

    lines.sort((a, b) => a.startTime - b.startTime);
    return createLyricData(lines, true);
}

/**
 * Parses standard LRC lyrics with optional translation string
 */
function parseLRC(lrcString, translationString = '', romanizationString = '') {
    const rawLines = lrcString.replace(/^\uFEFF/, '').split(/\r?\n/);
    const rawEntries = [];
    const translationEntries = parseTimedEntries(translationString);
    const romanizationEntries = parseTimedEntries(romanizationString);

    for (const rawLine of rawLines) {
        const entry = parseSimpleTimedTextEntry(rawLine);
        if (entry && entry.text) rawEntries.push(entry);
    }

    rawEntries.sort((a, b) => a.startTime - b.startTime);
    const lines = [];

    for (let index = 0; index < rawEntries.length; index++) {
        const current = rawEntries[index];
        const next = rawEntries[index + 1];
        let duration = next ? next.startTime - current.startTime : 5.0;
        const estReading = current.text.length * 0.45;
        if (duration > estReading + 2 && duration > 5) {
            duration = Math.min(duration, estReading + 2);
        }
        const endTime = current.startTime + duration;

        lines.push({
            words: buildTimedWords(current.text, current.startTime, endTime),
            startTime: Number(current.startTime.toFixed(3)),
            endTime: Number(endTime.toFixed(3)),
            fullText: current.text
        });
    }

    const translations = matchTranslations(lines.map(l => l.startTime), translationEntries);
    const romanizations = matchTranslations(lines.map(l => l.startTime), romanizationEntries);

    lines.forEach((line, idx) => {
        if (translations[idx]) line.translation = translations[idx];
        if (romanizations[idx]) line.romanization = romanizations[idx];
    });

    return createLyricData(lines, false);
}

/**
 * Converts structured LyricData back to standard LRC string format
 */
function convertToLrcString(lyricData) {
    if (!lyricData || !Array.isArray(lyricData.lines)) return '';

    const formatTime = (seconds) => {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 100);
        return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}]`;
    };

    const out = [];
    for (const line of lyricData.lines) {
        const tag = formatTime(line.startTime);
        out.push(`${tag}${line.fullText}`);
        if (line.translation) {
            out.push(`${tag}${line.translation}`);
        }
    }
    return out.join('\n');
}

module.exports = {
    parseYRC,
    parseQRC,
    parseKRC,
    parseTTML,
    parseLRC,
    convertToLrcString
};