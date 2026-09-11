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

    for (const token of rawTokens) {
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
    }

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
 * Aligns translation text with lyric start times
 */
function matchTranslations(startTimes, entries) {
    if (startTimes.length === 0 || entries.length === 0) return startTimes.map(() => undefined);

    return startTimes.map(startTime => {
        let bestEntry = undefined;
        let minDiff = 1.2; // 1.2s tolerance
        for (const entry of entries) {
            const diff = Math.abs(entry.startTime - startTime);
            if (diff < minDiff) {
                minDiff = diff;
                bestEntry = entry.text;
            }
        }
        return bestEntry;
    });
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
            trans = matchTranslations([line.startTime], translationEntries)[0];
        }
        if (!roma && romanizationEntries.length > 0) {
            roma = matchTranslations([line.startTime], romanizationEntries)[0];
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
function parseTTML(ttmlString) {
    const lines = [];
    const pRegex = /<p\b[^>]*?\bbegin="([^"]+)"[^>]*?\bend="([^"]+)"[^>]*?>([\s\S]*?)<\/p>/gi;
    const spanRegex = /<span\b[^>]*?\bbegin="([^"]+)"[^>]*?\bend="([^"]+)"[^>]*?>([\s\S]*?)<\/span>/gi;

    function parseTimeStr(str) {
        if (!str) return 0;
        const parts = str.split(':');
        if (parts.length === 2) {
            return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
        } else if (parts.length === 3) {
            return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
        }
        return parseFloat(str) || 0;
    }

    let pMatch;
    while ((pMatch = pRegex.exec(ttmlString)) !== null) {
        const lineStart = parseTimeStr(pMatch[1]);
        const lineEnd = parseTimeStr(pMatch[2]);
        const innerContent = pMatch[3];

        const words = [];
        let fullText = '';
        let spanMatch;

        spanRegex.lastIndex = 0;
        while ((spanMatch = spanRegex.exec(innerContent)) !== null) {
            const wordStart = parseTimeStr(spanMatch[1]);
            const wordEnd = parseTimeStr(spanMatch[2]);
            const text = spanMatch[3].replace(/<[^>]+>/g, '');

            if (text) {
                words.push({
                    text,
                    startTime: Number(wordStart.toFixed(3)),
                    endTime: Number(wordEnd.toFixed(3))
                });
                fullText += text;
            }
        }

        if (words.length === 0) {
            const cleanText = innerContent.replace(/<[^>]+>/g, '').trim();
            if (cleanText) {
                words.push(...buildTimedWords(cleanText, lineStart, lineEnd));
                fullText = cleanText;
            }
        }

        if (words.length > 0) {
            lines.push({
                words,
                startTime: Number(lineStart.toFixed(3)),
                endTime: Number(lineEnd.toFixed(3)),
                fullText
            });
        }
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