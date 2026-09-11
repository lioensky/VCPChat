(function (global) {
    'use strict';

    const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

    const hashString = (input) => {
        let hash = 2166136261;
        const value = String(input ?? '');
        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    };

    const seededRandom = (seed) => {
        let state = hashString(seed) || 1;
        return () => {
            state += 0x6D2B79F5;
            let value = state;
            value = Math.imul(value ^ (value >>> 15), value | 1);
            value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
            return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        };
    };

    const splitGraphemes = (text) => {
        const value = String(text ?? '');
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
            const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
            return Array.from(segmenter.segment(value), (entry) => entry.segment);
        }
        return Array.from(value);
    };

    const EMPTY_LINES = Object.freeze([]);
    const EMPTY_WORDS = Object.freeze([]);
    const normalizedLinesCache = new WeakMap();

    const buildFallbackWords = (line) => {
        if (!line?.fullText) return EMPTY_WORDS;
        const graphemes = splitGraphemes(line.fullText);
        const visibleCount = Math.max(1, graphemes.filter((char) => char.trim()).length);
        const duration = Math.max(0.4, line.endTime - line.startTime);
        let visibleIndex = 0;

        return graphemes.map((char, index) => {
            const isSpace = !char.trim();
            const ordinal = visibleIndex;
            if (!isSpace) visibleIndex += 1;
            const startRatio = ordinal / visibleCount;
            const endRatio = isSpace ? startRatio : visibleIndex / visibleCount;
            return {
                text: char,
                startTime: line.startTime + duration * startRatio,
                endTime: line.startTime + duration * Math.max(endRatio, startRatio + 0.01),
                index
            };
        });
    };

    const normalizeLine = (line, index, lines) => {
        const startTime = Number.isFinite(line?.time) ? line.time : Number(line?.startTime) || 0;
        const next = lines[index + 1];
        const nextStart = Number.isFinite(next?.time) ? next.time : Number(next?.startTime);
        const declaredEnd = Number.isFinite(line?.endTime) ? line.endTime : 0;
        const endTime = Math.max(startTime + 0.08, declaredEnd || nextStart || startTime + 5);
        const words = Array.isArray(line?.words) && line.words.length
            ? line.words.map((word, wordIndex) => ({
                text: String(word?.text ?? ''),
                startTime: Number.isFinite(word?.startTime) ? word.startTime : startTime,
                endTime: Math.max(
                    Number.isFinite(word?.startTime) ? word.startTime : startTime,
                    Number.isFinite(word?.endTime) ? word.endTime : endTime
                ),
                index: wordIndex
            }))
            : EMPTY_WORDS;
        const normalized = {
            ...line,
            index,
            startTime,
            time: startTime,
            endTime,
            fullText: String(line?.fullText ?? line?.original ?? ''),
            translation: String(line?.translation ?? ''),
            romanization: String(line?.romanization ?? ''),
            words
        };
        normalized.resolvedWords = words.length ? words : buildFallbackWords(normalized);
        return normalized;
    };

    const normalizeLines = (lines) => {
        if (!Array.isArray(lines) || !lines.length) return EMPTY_LINES;
        const cached = normalizedLinesCache.get(lines);
        if (cached) return cached;
        const normalized = lines.map((line, index) => normalizeLine(line, index, lines));
        normalizedLinesCache.set(lines, normalized);
        return normalized;
    };

    const resolvePlaybackTime = (app, now) => {
        const base = Number(app?.lastKnownCurrentTime) || 0;
        if (!app?.isPlaying) return base;
        const lastUpdate = Number(app?.lastStateUpdateTime) || now;
        return Math.max(0, base + Math.max(0, now - lastUpdate) / 1000);
    };

    const findActiveLineIndex = (lines, playbackTime, previousIndex = -1) => {
        if (!lines.length) return -1;
        let low = 0;
        let high = lines.length - 1;
        let result = -1;

        while (low <= high) {
            const middle = (low + high) >> 1;
            if (playbackTime >= lines[middle].startTime) {
                result = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        if (result < previousIndex && previousIndex >= 0) {
            const previous = lines[previousIndex];
            if (previous && playbackTime >= previous.startTime - 1.25) return previousIndex;
        }
        return result;
    };

    const resolveWordState = (line, playbackTime) => {
        if (!line) return {
            words: [],
            activeWordIndex: -1,
            wordProgress: 0,
            wordStates: []
        };

        const words = line.resolvedWords || (line.words.length ? line.words : buildFallbackWords(line));
        let activeWordIndex = -1;
        let activeProgress = 0;
        const wordStates = words.map((word, index) => {
            const duration = Math.max(0.001, word.endTime - word.startTime);
            const progress = clamp((playbackTime - word.startTime) / duration);
            const status = playbackTime < word.startTime
                ? 'waiting'
                : playbackTime >= word.endTime
                    ? 'passed'
                    : 'active';
            if (status === 'active') {
                activeWordIndex = index;
                activeProgress = progress;
            }
            return { ...word, progress, status };
        });

        return {
            words,
            activeWordIndex,
            wordProgress: activeProgress,
            wordStates
        };
    };

    const averageRange = (spectrum, startRatio, endRatio) => {
        if (!spectrum?.length) return 0;
        const start = Math.max(0, Math.floor(spectrum.length * startRatio));
        const end = Math.min(spectrum.length, Math.max(start + 1, Math.ceil(spectrum.length * endRatio)));
        let total = 0;
        for (let index = start; index < end; index += 1) total += Number(spectrum[index]) || 0;
        return clamp(total / Math.max(1, end - start));
    };

    const resolveAudioBands = (spectrum) => {
        const values = spectrum || [];
        const bass = averageRange(values, 0.01, 0.10);
        const lowMid = averageRange(values, 0.10, 0.24);
        const mid = averageRange(values, 0.24, 0.46);
        const vocal = averageRange(values, 0.18, 0.58);
        const treble = averageRange(values, 0.58, 0.98);
        const power = clamp(bass * 0.25 + lowMid * 0.2 + mid * 0.2 + vocal * 0.25 + treble * 0.1);
        return { power, bass, lowMid, mid, vocal, treble, spectrum: values };
    };

    const createFrame = (app, now = performance.now()) => {
        const wallNow = Date.now();
        const lines = normalizeLines(app?.currentLyrics);
        const playbackTime = resolvePlaybackTime(app, wallNow);
        const currentLineIndex = findActiveLineIndex(lines, playbackTime, app?.currentLyricIndex ?? -1);
        const activeLine = currentLineIndex >= 0 ? lines[currentLineIndex] : null;
        const lineDuration = activeLine ? Math.max(0.001, activeLine.endTime - activeLine.startTime) : 1;
        const lineProgress = activeLine ? clamp((playbackTime - activeLine.startTime) / lineDuration) : 0;
        const wordState = resolveWordState(activeLine, playbackTime);
        const spectrum = Array.isArray(app?.currentVisualizerData) ? app.currentVisualizerData : [];
        const track = app?.playlist?.[app?.currentTrackIndex] || null;

        return {
            now,
            wallNow,
            playbackTime,
            duration: Number(app?.lastKnownDuration) || Number(track?.duration) || 0,
            isPlaying: Boolean(app?.isPlaying),
            currentLineIndex,
            activeLine,
            previousLine: currentLineIndex > 0 ? lines[currentLineIndex - 1] : null,
            nextLines: currentLineIndex >= 0 ? lines.slice(currentLineIndex + 1, currentLineIndex + 4) : lines.slice(0, 3),
            lineProgress,
            ...wordState,
            lines,
            audio: resolveAudioBands(spectrum),
            viewport: {
                width: global.innerWidth || 1,
                height: global.innerHeight || 1,
                dpr: Math.min(2, global.devicePixelRatio || 1)
            },
            track
        };
    };

    class DisposableScope {
        constructor() {
            this.disposers = [];
            this.destroyed = false;
        }

        add(disposer) {
            if (typeof disposer !== 'function') return disposer;
            if (this.destroyed) {
                disposer();
                return disposer;
            }
            this.disposers.push(disposer);
            return disposer;
        }

        listen(target, type, listener, options) {
            target?.addEventListener?.(type, listener, options);
            this.add(() => target?.removeEventListener?.(type, listener, options));
            return listener;
        }

        timeout(callback, delay) {
            const id = global.setTimeout(() => {
                const index = this.disposers.indexOf(cancel);
                if (index >= 0) this.disposers.splice(index, 1);
                if (!this.destroyed) callback();
            }, delay);
            const cancel = () => global.clearTimeout(id);
            this.add(cancel);
            return id;
        }

        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            while (this.disposers.length) {
                try {
                    this.disposers.pop()();
                } catch (error) {
                    console.warn('[MusicStage] Resource cleanup failed:', error);
                }
            }
        }
    }

    global.MusicStageRuntime = Object.freeze({
        clamp,
        hashString,
        seededRandom,
        splitGraphemes,
        normalizeLines,
        buildFallbackWords,
        resolvePlaybackTime,
        findActiveLineIndex,
        resolveWordState,
        resolveAudioBands,
        createFrame,
        DisposableScope
    });
})(window);