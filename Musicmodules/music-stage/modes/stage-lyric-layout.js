/*
 * Native adaptation of Folia lyric layout / grapheme timing.
 * Upstream: chthollyphile/folia-major, AGPL-3.0.
 * Preserve source timing; display grouping never rewrites the player lyrics.
 */
(function (global) {
    'use strict';
    const { splitGraphemes, clamp } = global.MusicStageRuntime;
    const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
        ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
    const cjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
    const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

    const evenTiming = (text, start, end) => {
        const chars = splitGraphemes(text);
        return chars.map((char, index) => ({
            char,
            startTime: start + (end - start) * index / chars.length,
            endTime: start + (end - start) * (index + 1) / chars.length
        }));
    };
    const wordTiming = (word) => {
        const syllables = word.syllables;
        if (Array.isArray(syllables) && syllables.length
            && syllables.map(part => part.text).join('') === word.text
            && syllables.every(part => Number.isFinite(part.startTime) && Number.isFinite(part.endTime))) {
            return syllables.flatMap(part => evenTiming(part.text, part.startTime, Math.max(part.startTime, part.endTime)));
        }
        return evenTiming(word.text, word.startTime, word.endTime);
    };

    const timeline = (line) => {
        const chars = splitGraphemes(line.fullText);
        const result = chars.map(char => ({ char, startTime: line.startTime, endTime: line.startTime, wordIndex: -1 }));
        let cursor = 0;
        let lastTime = line.startTime;
        const words = line.resolvedWords || line.words || [];
        words.forEach((word, wordIndex) => {
            const target = splitGraphemes(word.text);
            if (!target.length) return;
            let start = -1;
            for (let at = cursor; at <= chars.length - target.length; at += 1) {
                if (target.every((char, offset) => chars[at + offset] === char)) {
                    start = at;
                    break;
                }
            }
            if (start < 0) return;
            for (let at = cursor; at < start; at += 1) {
                result[at].startTime = word.startTime;
                result[at].endTime = word.startTime;
            }
            const timings = wordTiming(word);
            target.forEach((char, offset) => {
                result[start + offset] = { ...timings[offset], char, wordIndex };
            });
            cursor = start + target.length;
            lastTime = Math.max(lastTime, word.endTime);
        });
        for (let at = cursor; at < chars.length; at += 1) {
            result[at].startTime = lastTime;
            result[at].endTime = lastTime;
        }
        return result;
    };

    const makeToken = (glyphs, index) => {
        const timed = glyphs.filter(glyph => glyph.char.trim() && glyph.wordIndex !== -1);
        const timing = timed.length ? timed : glyphs;
        return {
            index,
            text: glyphs.map(glyph => glyph.char).join(''),
            glyphs,
            startTime: timing.length ? Math.min(...timing.map(glyph => glyph.startTime)) : 0,
            endTime: timing.length ? Math.max(...timing.map(glyph => glyph.endTime)) : 0
        };
    };

    const units = (line, semantic = true) => {
        const glyphs = timeline(line);
        if (!glyphs.length) return [];
        let boundaries;
        const saved = line.wordSegments;
        if (semantic && Array.isArray(saved) && saved.every(part => typeof part === 'string')
            && saved.join('') === line.fullText) {
            boundaries = saved;
        } else if (semantic && segmenter) {
            boundaries = Array.from(segmenter.segment(line.fullText), part => part.segment);
        } else {
            boundaries = [];
            let lastWord = null;
            glyphs.forEach(glyph => {
                if (glyph.wordIndex !== lastWord || !boundaries.length) boundaries.push('');
                boundaries[boundaries.length - 1] += glyph.char;
                lastWord = glyph.wordIndex;
            });
        }
        let cursor = 0;
        const groups = boundaries.filter(Boolean).map(text => {
            const length = splitGraphemes(text).length;
            const group = makeToken(glyphs.slice(cursor, cursor + length), cursor);
            cursor += length;
            return group;
        });
        const sticky = [];
        groups.forEach(group => {
            const previous = sticky[sticky.length - 1];
            if (previous && (/^[\s,.;:!?，。！？、：；）】》」』〉〕］)}\]"'’”]+$/u.test(group.text)
                || (/^(s|t|m|d|ll|re|ve|em)$/i.test(group.text) && /['’]$/.test(previous.text)))) {
                const merged = makeToken([...previous.glyphs, ...group.glyphs], previous.index);
                sticky[sticky.length - 1] = merged;
            } else {
                sticky.push(group);
            }
        });
        return sticky;
    };

    const displayTokens = (groups) => groups.flatMap(group => {
        if (!cjk.test(group.text)) return [group];
        const pieces = [];
        group.glyphs.forEach(glyph => {
            const previous = pieces[pieces.length - 1];
            if (previous && (previous.glyphs[0].wordIndex === glyph.wordIndex || /^[\s\p{P}]+$/u.test(glyph.char))) {
                pieces[pieces.length - 1] = makeToken([...previous.glyphs, glyph], previous.index);
            } else {
                pieces.push(makeToken([glyph], group.index + pieces.length));
            }
        });
        return pieces;
    });

    const profile = (line) => {
        const duration = Math.max(0, line.endTime - line.startTime);
        const hints = line.renderHints || {};
        const reveal = hints.wordRevealMode || (duration < 0.1 ? 'instant' : duration < 0.18 ? 'fast' : 'normal');
        const transition = hints.lineTransitionMode || (duration < 0.1 ? 'none' : duration < 0.18 ? 'fast' : 'normal');
        const enter = transition === 'none' ? 0 : transition === 'fast' ? clamp(duration * 0.45, 0.045, 0.06) : clamp(duration * 0.34, 0.22, 0.42);
        const exit = transition === 'none' ? 0 : transition === 'fast' ? clamp(duration * 0.22, 0.03, 0.04) : clamp(duration * 0.18, 0.18, 0.32);
        const words = line.resolvedWords || line.words || [];
        const lastEnd = Math.max(line.startTime, ...words.map(word => word.endTime));
        const exitStart = Math.max(lastEnd + (reveal === 'instant' ? 0 : 0.06), line.endTime - exit);
        return {
            reveal, transition, enter, exit, exitStart,
            end: number(hints.renderEndTime, Math.max(line.endTime, exitStart + exit)),
            lookahead: reveal === 'instant' ? 0 : reveal === 'fast' ? 0.045 : 0.15
        };
    };

    // Lazy ESM load works from the same local page as the existing Pixi assets.
    // Consumers own cancellation via their destroyed flag; this shared promise
    // only retains the module, never a mode, lyric, canvas or DOM node.
    let pretextPromise;
    const loadPretext = () => {
        pretextPromise ||= import('../../../node_modules/@chenglou/pretext/dist/layout.js').catch(error => {
            pretextPromise = null;
            throw error;
        });
        return pretextPromise;
    };

    global.MusicStageLyricLayout = Object.freeze({
        number, cjk, evenTiming, wordTiming, timeline, makeToken,
        units, displayTokens, profile, loadPretext
    });
})(window);