// modules/lyrics/parserCore.js
// Universal Lyric Parser supporting YRC, QRC, KRC, TTML, and LRC
// Ported from Folia parserCore with CommonJS compatibility

const { decodeKrcLanguageTag } = require('./krcDecrypt');

const GLOBAL_LRC_TIME_REGEX = /\[(\d{1,3}):(\d{2})[.:](\d{2,3})\]/g;
const LRC_MULTI_TIME_LINE_REGEX = /^((?:\[(?:\d{1,3}):(?:\d{2})[.:](?:\d{2,3})\])+)(.*)$/;
const CJK_CHAR_REGEX = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/;
const CJK_PUNCT_REGEX = /[，。！？、：；"'）\s]/;
const MS_TIMED_LINE_REGEX = /^\[(\d+),(\d+)\](.*)/;
const YRC_WORD_REGEX = /\((\d+),(\d+),(\d+)\)([^\(]*)/g;
const QRC_TAG_REGEX = /\((\d+),(\d+)(?:,\d+)?\)/g;
const KRC_WORD_REGEX = /<(\d+),(\d+)(?:,\d+)?>([^<]*)/g;
const XML_ENTITY_REGEX = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const TTML_TIME_UNIT_REGEX = /^(-?\d+(?:\.\d+)?)(h|m|s|ms)$/i;
const TTML_TIME_PART_REGEX = /^\d+(?:\.\d+)?$/;
const TTML_TEXT_REGEX = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
const TTML_HEAD_REGEX = /<head\b[\s\S]*?<\/head>/i;
const TTML_P_REGEX = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
const TTML_TOKEN_REGEX = /<(\/?)([\w:-]+)\b([^>]*?)(\/?)>|([^<]+)/g;
const BOM_REGEX = /^\uFEFF/;
const NEWLINE_SPLIT_REGEX = /\r?\n/;
const WS_SPLIT_REGEX = /\s+/;
const WS_GLOBAL_REGEX = /\s+/g;
const XML_TAG_STRIP_REGEX = /<[^>]+>/g;
const ZH_LANG_REGEX = /^zh/i;
const ALL_WS_REGEX = /^\s+$/;
const CR_LF_REGEX = /[\r\n]/;
const TAG_NS_REGEX = /^.*:/;
const TRAIL_WS_ONE_REGEX = /\s$/;
const LEAD_WS_REGEX = /^\s+/;
const TRAIL_WS_REGEX = /\s+$/;

function isSourceMigrationArtifact(text) {
    return typeof text === 'string' && text.trim() === '//';
}

function createLyricData(lines, isWordByWord) {
    const out = [];
    if (lines) {
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (!isSourceMigrationArtifact(line?.fullText)) out.push(line);
        }
    }
    return {
        lines: out,
        isWordByWord
    };
}

const round3 = (v) => Math.round(v * 1000) / 1000;

function parseTimestamp(minute, second, fraction) {
    const min = parseInt(minute, 10);
    const sec = parseInt(second, 10);
    const fl = fraction.length;
    const ms = fl === 2 ? parseInt(fraction, 10) / 100
        : fl === 3 ? parseInt(fraction, 10) / 1000
        : parseFloat(`0.${fraction}`);
    return min * 60 + sec + ms;
}

/**
 * Splits plain text into simulated timed words based on CJK/Western weighting
 */
function buildTimedWords(text, startTime, endTime) {
    const duration = Math.max(endTime - startTime, 0.1);
    const parts = text.split(WS_SPLIT_REGEX);
    const rawTokens = [];
    for (let i = 0; i < parts.length; i += 1) if (parts[i]) rawTokens.push(parts[i]);
    const words = [];
    const tokens = [];
    let totalWeight = 0;

    for (let tokenIndex = 0; tokenIndex < rawTokens.length; tokenIndex += 1) {
        const token = rawTokens[tokenIndex];
        if (CJK_CHAR_REGEX.test(token)) {
            for (let ci = 0; ci < token.length; ci += 1) {
                const char = token[ci];
                const weight = CJK_PUNCT_REGEX.test(char) ? 0 : 1;
                tokens.push({ text: char, weight });
                totalWeight += weight;
            }
        } else {
            const weight = 1 + (token.length * 0.15);
            tokens.push({ text: token, weight });
            totalWeight += weight;
        }
        // 原文里词和词之间的空格留在前一个词的末尾（和网易云逐字歌词一样），英文逐字显示时才不会粘成一串
        if (tokenIndex < rawTokens.length - 1) tokens[tokens.length - 1].text += ' ';
    }

    if (totalWeight === 0) totalWeight = 1;

    const activeDuration = duration * 0.92;
    const timePerWeight = activeDuration / totalWeight;
    let currentWordStart = startTime;

    for (let ti = 0; ti < tokens.length; ti += 1) {
        const token = tokens[ti];
        const wordDuration = token.weight * timePerWeight;
        const finalDuration = Math.max(wordDuration, 0.04);

        words.push({
            text: token.text,
            startTime: round3(currentWordStart),
            endTime: round3(currentWordStart + finalDuration)
        });

        currentWordStart += token.weight > 0 ? wordDuration : 0.04;
    }

    return words;
}

/**
 * Parses one or more leading [mm:ss.xx] timestamps from an LRC line (expanding chorus lines).
 */
function parseSimpleTimedTextEntries(line) {
    const match = line.match(LRC_MULTI_TIME_LINE_REGEX);
    if (!match) return [];

    const text = match[2].trim();
    if (!text) return [];

    const results = [];
    GLOBAL_LRC_TIME_REGEX.lastIndex = 0;
    let tagMatch;
    while ((tagMatch = GLOBAL_LRC_TIME_REGEX.exec(match[1])) !== null) {
        results.push({
            startTime: parseTimestamp(tagMatch[1], tagMatch[2], tagMatch[3]),
            text
        });
    }
    return results;
}

/**
 * Extracts line timestamp map from LRC / translation text
 */
function parseTimedEntries(content) {
    if (!content) return [];
    const entries = [];
    const rawLines = content.replace(BOM_REGEX, '').split(NEWLINE_SPLIT_REGEX);

    for (const rawLine of rawLines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('[ti:') || line.startsWith('[ar:') || line.startsWith('[al:')) continue;

        const parsed = parseSimpleTimedTextEntries(line);
        for (let i = 0; i < parsed.length; i += 1) {
            entries.push(parsed[i]);
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
function applyTimedSupplements(lines, translationEntries, romanizationEntries) {
    const hasTr = translationEntries.length > 0;
    const hasRo = romanizationEntries.length > 0;
    if (!hasTr && !hasRo) return;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (hasTr) {
            const tr = findClosestTimedText(line.startTime, translationEntries);
            if (tr) line.translation = tr;
        }
        if (hasRo) {
            const ro = findClosestTimedText(line.startTime, romanizationEntries);
            if (ro) line.romanization = ro;
        }
    }
}

/**
 * Parses NetEase YRC lyric string
 * Format: [start_ms, duration_ms](word_start_ms, word_duration_ms, 0)word_text...
 */
function parseYRC(yrcString, translationString = '', romanizationString = '') {
    if (typeof yrcString !== 'string' || !yrcString) return createLyricData([], true);
    const lines = [];
    const rawLines = yrcString.replace(BOM_REGEX, '').split(NEWLINE_SPLIT_REGEX);
    const translationEntries = parseTimedEntries(translationString);
    const romanizationEntries = parseTimedEntries(romanizationString);

    for (const rawLine of rawLines) {
        const lineMatch = rawLine.match(MS_TIMED_LINE_REGEX);
        if (!lineMatch) continue;

        const lineStartTimeMs = parseInt(lineMatch[1], 10);
        const lineDurationMs = parseInt(lineMatch[2], 10);
        const rest = lineMatch[3];
        const lineStartTime = lineStartTimeMs / 1000;
        const lineEndTime = (lineStartTimeMs + lineDurationMs) / 1000;

        const words = [];
        let fullText = '';

        YRC_WORD_REGEX.lastIndex = 0;
        let wordMatch;

        while ((wordMatch = YRC_WORD_REGEX.exec(rest)) !== null) {
            const wordStartMs = parseInt(wordMatch[1], 10);
            const wordDurationMs = parseInt(wordMatch[2], 10);
            const text = wordMatch[4];

            words.push({
                text,
                startTime: wordStartMs / 1000,
                endTime: (wordStartMs + wordDurationMs) / 1000
            });
            fullText += text;
        }

        if (words.length > 0) {
            lines.push({
                words,
                startTime: lineStartTime,
                endTime: lineEndTime,
                fullText
            });
        }
    }

    lines.sort((a, b) => a.startTime - b.startTime);
    applyTimedSupplements(lines, translationEntries, romanizationEntries);

    return createLyricData(lines, true);
}

/**
 * Parses QQ Music QRC lyric string
 * Format: [start_ms, duration_ms](word_start_ms, word_duration_ms)word_text... or with tags
 */
function parseQRC(qrcString, translationString = '', romanizationString = '') {
    if (typeof qrcString !== 'string' || !qrcString) return createLyricData([], true);
    const lines = [];
    const rawLines = qrcString.replace(BOM_REGEX, '').split(NEWLINE_SPLIT_REGEX);
    const translationEntries = parseTimedEntries(translationString);
    const romanizationEntries = parseTimedEntries(romanizationString);

    for (const rawLine of rawLines) {
        const lineMatch = rawLine.match(MS_TIMED_LINE_REGEX);
        if (!lineMatch) continue;

        const lineStartTimeMs = parseInt(lineMatch[1], 10);
        const lineDurationMs = parseInt(lineMatch[2], 10);
        const rest = lineMatch[3];
        const lineStartTime = lineStartTimeMs / 1000;
        const lineEndTime = (lineStartTimeMs + lineDurationMs) / 1000;

        const words = [];
        let fullText = '';
        QRC_TAG_REGEX.lastIndex = 0;
        const tags = [];
        let tagMatch;

        while ((tagMatch = QRC_TAG_REGEX.exec(rest)) !== null) {
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
                startTime: tag.startMs / 1000,
                endTime: (tag.startMs + tag.durationMs) / 1000
            });
            fullText += text;
        }

        if (words.length > 0) {
            lines.push({
                words,
                startTime: lineStartTime,
                endTime: lineEndTime,
                fullText
            });
        }
    }

    lines.sort((a, b) => a.startTime - b.startTime);
    applyTimedSupplements(lines, translationEntries, romanizationEntries);

    return createLyricData(lines, true);
}

/**
 * Parses Kugou KRC lyric string
 * Format: [start_ms, duration_ms]<offset_ms, duration_ms, 0>word_text...
 */
function parseKRC(krcString, translationString = '', romanizationString = '') {
    if (typeof krcString !== 'string' || !krcString) return createLyricData([], true);
    const lines = [];
    const { translations: embeddedTranslations, romanizations: embeddedRomanizations } = decodeKrcLanguageTag(krcString);
    const translationEntries = parseTimedEntries(translationString);
    const romanizationEntries = parseTimedEntries(romanizationString);
    const rawLines = krcString.replace(BOM_REGEX, '').split(NEWLINE_SPLIT_REGEX);

    for (const rawLine of rawLines) {
        const lineMatch = rawLine.match(MS_TIMED_LINE_REGEX);
        if (!lineMatch) continue;

        const lineStartTimeMs = parseInt(lineMatch[1], 10);
        const lineDurationMs = parseInt(lineMatch[2], 10);
        const rest = lineMatch[3];
        const lineStartTime = lineStartTimeMs / 1000;
        const lineEndTime = (lineStartTimeMs + lineDurationMs) / 1000;

        const words = [];
        let fullText = '';
        KRC_WORD_REGEX.lastIndex = 0;
        let wordMatch;

        while ((wordMatch = KRC_WORD_REGEX.exec(rest)) !== null) {
            const wordOffsetMs = parseInt(wordMatch[1], 10);
            const wordDurationMs = parseInt(wordMatch[2], 10);
            const text = wordMatch[3];
            const wordStartMs = lineStartTimeMs + wordOffsetMs;

            words.push({
                text,
                startTime: wordStartMs / 1000,
                endTime: (wordStartMs + wordDurationMs) / 1000
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
                startTime: lineStartTime,
                endTime: lineEndTime,
                fullText
            });
        }
    }

    lines.sort((a, b) => a.startTime - b.startTime);
    for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx];
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
    }

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
    const s = String(text || '');
    if (s.indexOf('&') === -1) return s;
    return s.replace(XML_ENTITY_REGEX, (all, name) => {
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
    const m = TTML_TIME_UNIT_REGEX.exec(text);
    if (m) {
        const v = parseFloat(m[1]);
        const unit = m[2].toLowerCase();
        return unit === 'h' ? v * 3600 : unit === 'm' ? v * 60 : unit === 'ms' ? v / 1000 : v;
    }
    let sum = 0;
    let start = 0;
    const len = text.length;
    for (let i = 0; i <= len; i += 1) {
        if (i === len || text.charCodeAt(i) === 58) {
            const part = text.slice(start, i);
            if (!TTML_TIME_PART_REGEX.test(part)) return NaN;
            sum = sum * 60 + parseFloat(part);
            start = i + 1;
        }
    }
    return sum;
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
const TTML_BLOCK_RE_CACHE = new Map();
function ttmlHeadTexts(ttmlString, tag) {
    // <translation xml:lang="zh-Hans"><text for="L1">…</text></translation>；有几种语言时中文优先
    const blocks = [];
    let blockRe = TTML_BLOCK_RE_CACHE.get(tag);
    if (!blockRe) {
        blockRe = new RegExp('<' + tag + '\\b([^>]*)>([\\s\\S]*?)</' + tag + '>', 'gi');
        TTML_BLOCK_RE_CACHE.set(tag, blockRe);
    }
    blockRe.lastIndex = 0;
    let m;
    while ((m = blockRe.exec(ttmlString)) !== null) blocks.push({ lang: ttmlAttr(m[1], 'lang'), body: m[2] });
    if (!blocks.length) return new Map();
    const pick = blocks.find(b => ZH_LANG_REGEX.test(b.lang)) || blocks[0];
    const out = new Map();
    TTML_TEXT_REGEX.lastIndex = 0;
    while ((m = TTML_TEXT_REGEX.exec(pick.body)) !== null) {
        const key = ttmlAttr(m[1], 'for');
        const value = decodeXmlText(m[2].replace(XML_TAG_STRIP_REGEX, '')).replace(WS_GLOBAL_REGEX, ' ').trim();
        if (key && value) out.set(key, value);
    }
    return out;
}

function parseTTML(ttmlString) {
    const source = String(ttmlString || '');
    const lines = [];
    const headTranslations = ttmlHeadTexts(source, 'translation');
    const headRomanizations = ttmlHeadTexts(source, 'transliteration');
    const body = source.replace(TTML_HEAD_REGEX, '');
    TTML_P_REGEX.lastIndex = 0;

    let pMatch;
    while ((pMatch = TTML_P_REGEX.exec(body)) !== null) {
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
        let bgDepth = 0;
        let tm;
        TTML_TOKEN_REGEX.lastIndex = 0;
        while ((tm = TTML_TOKEN_REGEX.exec(pMatch[2])) !== null) {
            if (tm[5] !== undefined) {
                const text = decodeXmlText(tm[5]);
                let isTrans = false, isRoman = false, isBg = bgDepth > 0, wordFrame = null;
                for (let si = stack.length - 1; si >= 0; si--) {
                    const frame = stack[si];
                    if (frame.role === 'x-translation') isTrans = true;
                    else if (frame.role === 'x-roman') isRoman = true;
                    if (!wordFrame && frame.word) wordFrame = frame;
                }
                if (isTrans) { translation += text; continue; }
                if (isRoman) { romanization += text; continue; }
                const target = isBg ? background : main;
                if (wordFrame && wordFrame.word) wordFrame.word.text += text;
                else if (ALL_WS_REGEX.test(text)) {
                    // 词之间的空格保留；带换行的是排版缩进（美化过的文件），不算
                    if (!CR_LF_REGEX.test(text) && target.length) target[target.length - 1].text += ' ';
                }
                else plain += text; // 没有逐字时间的字：整行退回按字均分
                continue;
            }
            const closing = tm[1] === '/';
            let tag = tm[2].toLowerCase();
            const nsCut = tag.lastIndexOf(':');
            if (nsCut !== -1) tag = tag.slice(nsCut + 1);
            if (tag === 'br' && !closing) { if (main.length) main[main.length - 1].text += ' '; continue; }
            if (tag !== 'span') continue;
            if (closing) {
                const popped = stack.pop();
                if (popped && popped.role === 'x-bg') bgDepth -= 1;
                continue;
            }
            const attrs = tm[3];
            const role = ttmlAttr(attrs, 'role');
            const begin = parseTtmlTime(ttmlAttr(attrs, 'begin'));
            const end = parseTtmlTime(ttmlAttr(attrs, 'end'));
            let word = null;
            if (!role && Number.isFinite(begin)) {
                word = { text: '', startTime: begin, endTime: Number.isFinite(end) && end >= begin ? end : begin };
                (bgDepth > 0 ? background : main).push(word);
            }
            if (tm[4] === '/') continue; // <span/> 自闭合
            if (role === 'x-bg') bgDepth += 1;
            stack.push({ role, word });
        }

        let words = [];
        for (let i = 0; i < main.length; i += 1) if (main[i].text !== '') words.push(main[i]);
        const bg = [];
        for (let i = 0; i < background.length; i += 1) if (background[i].text.trim() !== '') bg.push(background[i]);
        if (!words.length) {
            const cleanText = plain.replace(WS_GLOBAL_REGEX, ' ').trim();
            const end = Number.isFinite(lineEndRaw) ? lineEndRaw : lineStart + 4;
            if (cleanText) words = buildTimedWords(cleanText, lineStart, end);
        }
        if (bg.length) {
            if (words.length && !TRAIL_WS_ONE_REGEX.test(words[words.length - 1].text)) words[words.length - 1].text += ' ';
            bg[0].text = '(' + bg[0].text.replace(LEAD_WS_REGEX, '');
            bg[bg.length - 1].text = bg[bg.length - 1].text.replace(TRAIL_WS_REGEX, '') + ')';
            for (let i = 0; i < bg.length; i += 1) words.push(bg[i]);
        }
        if (!words.length) continue;
        const last = words[words.length - 1];
        last.text = last.text.replace(TRAIL_WS_REGEX, '');
        const wLen = words.length;
        const outWords = new Array(wLen);
        let maxWordEnd = lineStart;
        let fullText = '';
        for (let i = 0; i < wLen; i += 1) {
            const w = words[i];
            const st = round3(w.startTime);
            const et = round3(w.endTime);
            if (et > maxWordEnd) maxWordEnd = et;
            fullText += w.text;
            outWords[i] = { text: w.text, startTime: st, endTime: et };
        }
        const lineEnd = Number.isFinite(lineEndRaw) ? lineEndRaw : maxWordEnd;
        const line = {
            words: outWords,
            startTime: round3(lineStart),
            endTime: round3(Math.max(lineStart, lineEnd)),
            fullText
        };
        const tr = (translation ? translation.replace(WS_GLOBAL_REGEX, ' ').trim() : '') || (key && headTranslations.get(key)) || '';
        const ro = (romanization ? romanization.replace(WS_GLOBAL_REGEX, ' ').trim() : '') || (key && headRomanizations.get(key)) || '';
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
    if (typeof lrcString !== 'string' || !lrcString) return createLyricData([], false);
    const rawLines = lrcString.replace(BOM_REGEX, '').split(NEWLINE_SPLIT_REGEX);
    const rawEntries = [];
    const translationEntries = parseTimedEntries(translationString);
    const romanizationEntries = parseTimedEntries(romanizationString);

    for (const rawLine of rawLines) {
        const parsed = parseSimpleTimedTextEntries(rawLine.trim());
        for (let i = 0; i < parsed.length; i += 1) rawEntries.push(parsed[i]);
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
            startTime: round3(current.startTime),
            endTime: round3(endTime),
            fullText: current.text
        });
    }

    applyTimedSupplements(lines, translationEntries, romanizationEntries);

    return createLyricData(lines, false);
}

/**
 * Converts structured LyricData back to standard LRC string format
 */
const pad2 = (n) => (n < 10 ? `0${n}` : String(n));
function convertToLrcString(lyricData) {
    if (!lyricData || !Array.isArray(lyricData.lines)) return '';

    const formatTime = (seconds) => {
        const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
        const m = Math.floor(safe / 60);
        const s = Math.floor(safe % 60);
        const ms = Math.floor((safe % 1) * 100);
        return `[${pad2(m)}:${pad2(s)}.${pad2(ms)}]`;
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