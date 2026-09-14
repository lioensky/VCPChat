(function (global) {
    'use strict';

    const finiteNumber = (value, fallback = 0) => {
        const number = typeof value === 'number' ? value
            : typeof value === 'string' && value.trim() ? Number(value) : NaN;
        return Number.isFinite(number) ? number : fallback;
    };
    const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, finiteNumber(value, min)));

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

    const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
    const splitGraphemes = (text) => {
        const value = String(text ?? '');
        return graphemeSegmenter
            ? Array.from(graphemeSegmenter.segment(value), (entry) => entry.segment)
            : Array.from(value);
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
        const startTime = finiteNumber(line?.time, finiteNumber(line?.startTime, 0));
        const next = lines[index + 1];
        const nextStart = finiteNumber(next?.time, finiteNumber(next?.startTime, NaN));
        const declaredEnd = finiteNumber(line?.endTime, 0);
        const endTime = Math.max(startTime + 0.08, declaredEnd || nextStart || startTime + 5);
        const words = Array.isArray(line?.words) && line.words.length
            ? line.words.map((word, wordIndex) => {
                const wordStart = finiteNumber(word?.startTime, startTime);
                const wordEnd = Math.max(wordStart, finiteNumber(word?.endTime, endTime));
                const syllables = Array.isArray(word?.syllables)
                    ? word.syllables.map((syllable, syllableIndex) => {
                        const syllableStart = finiteNumber(syllable?.startTime, wordStart);
                        return {
                            ...syllable,
                            text: String(syllable?.text ?? ''),
                            startTime: syllableStart,
                            endTime: Math.max(syllableStart, finiteNumber(syllable?.endTime, wordEnd)),
                            index: syllableIndex
                        };
                    })
                    : EMPTY_WORDS;
                return {
                    ...word,
                    text: String(word?.text ?? ''),
                    startTime: wordStart,
                    endTime: wordEnd,
                    syllables,
                    index: wordIndex
                };
            })
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
            isChorus: Boolean(line?.isChorus ?? line?.chorus),
            wordSegments: Array.isArray(line?.wordSegments) ? line.wordSegments.map(String) : undefined,
            renderHints: line?.renderHints && typeof line.renderHints === 'object' ? { ...line.renderHints } : undefined,
            words
        };
        normalized.resolvedWords = words.length ? words : buildFallbackWords(normalized);
        normalized.vocalEndTime = normalized.resolvedWords.reduce((latest, word) => {
            const syllableEnd = (word.syllables || []).reduce(
                (end, syllable) => Math.max(end, finiteNumber(syllable.endTime, end)),
                finiteNumber(word.endTime, latest)
            );
            return Math.max(latest, finiteNumber(word.endTime, latest), syllableEnd);
        }, startTime);
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

    const resolveSupplementalText = (line) => {
        const translation = String(line?.translation ?? '').trim();
        const romanization = String(line?.romanization ?? '').trim();
        if (translation && romanization && translation !== romanization) {
            return `${romanization}\n${translation}`;
        }
        return translation || romanization;
    };

    const buildGlyphTimeline = (line) => {
        if (!line) return EMPTY_WORDS;
        const words = line.resolvedWords || line.words || EMPTY_WORDS;
        const source = words.flatMap((word, wordIndex) => {
            const validSyllables = Array.isArray(word.syllables) && word.syllables.length
                && word.syllables.map(part => part.text).join('') === word.text;
            const parts = validSyllables ? word.syllables : [word];
            return parts.flatMap((part, partIndex) => {
                const graphemes = splitGraphemes(part.text);
                const startTime = finiteNumber(part.startTime, finiteNumber(word.startTime, line.startTime));
                const endTime = Math.max(startTime, finiteNumber(part.endTime, finiteNumber(word.endTime, line.endTime)));
                return graphemes.map((text, glyphIndex) => ({
                    text,
                    char: text,
                    startTime: startTime + (endTime - startTime) * glyphIndex / Math.max(1, graphemes.length),
                    endTime: startTime + (endTime - startTime) * (glyphIndex + 1) / Math.max(1, graphemes.length),
                    wordIndex,
                    syllableIndex: validSyllables ? partIndex : -1
                }));
            });
        });
        const fullText = splitGraphemes(line.fullText);
        if (!fullText.length || source.map(glyph => glyph.text).join('') === line.fullText) return source;

        // Reconcile tokenized words with the untouched display string. This keeps
        // spaces omitted by legacy LRC tokenization and punctuation not carrying a
        // timing tag, while every timed source glyph preserves its original clock.
        const aligned = fullText.map(text => ({
            text,
            char: text,
            startTime: line.startTime,
            endTime: line.startTime,
            wordIndex: -1,
            syllableIndex: -1
        }));
        let cursor = 0;
        let lastTime = line.startTime;
        source.forEach(glyph => {
            let target = -1;
            for (let index = cursor; index < fullText.length; index += 1) {
                if (fullText[index] === glyph.text) {
                    target = index;
                    break;
                }
            }
            if (target < 0) return;
            for (let index = cursor; index < target; index += 1) {
                aligned[index].startTime = glyph.startTime;
                aligned[index].endTime = glyph.startTime;
            }
            aligned[target] = glyph;
            cursor = target + 1;
            lastTime = Math.max(lastTime, glyph.endTime);
        });
        for (let index = cursor; index < aligned.length; index += 1) {
            aligned[index].startTime = lastTime;
            aligned[index].endTime = lastTime;
        }
        return aligned;
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

        // Absolute-time lookup: hysteresis here retains future lyrics after a backward seek.
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

    // Retained as a public utility for compatibility. The per-frame multi-band
    // resolver below uses one traversal instead of invoking this five times.
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
        if (!values.length) {
            return { power: 0, bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0, spectrum: values };
        }

        const length = values.length;
        const ranges = [
            [Math.max(0, Math.floor(length * 0.01)), Math.min(length, Math.max(1, Math.ceil(length * 0.10)))],
            [Math.max(0, Math.floor(length * 0.10)), Math.min(length, Math.max(Math.floor(length * 0.10) + 1, Math.ceil(length * 0.24)))],
            [Math.max(0, Math.floor(length * 0.24)), Math.min(length, Math.max(Math.floor(length * 0.24) + 1, Math.ceil(length * 0.46)))],
            [Math.max(0, Math.floor(length * 0.18)), Math.min(length, Math.max(Math.floor(length * 0.18) + 1, Math.ceil(length * 0.58)))],
            [Math.max(0, Math.floor(length * 0.58)), Math.min(length, Math.max(Math.floor(length * 0.58) + 1, Math.ceil(length * 0.98)))]
        ];
        const totals = [0, 0, 0, 0, 0];

        // One spectrum traversal; additions within every band retain the original
        // ascending-index order, preserving the previous audio response values.
        for (let index = 0; index < length; index += 1) {
            const value = Number(values[index]) || 0;
            for (let band = 0; band < ranges.length; band += 1) {
                if (index >= ranges[band][0] && index < ranges[band][1]) totals[band] += value;
            }
        }

        const averages = totals.map((total, index) => clamp(
            total / Math.max(1, ranges[index][1] - ranges[index][0])
        ));
        const [bass, lowMid, mid, vocal, treble] = averages;
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
        const spectrum = Array.isArray(app?.currentVisualizerData) || ArrayBuffer.isView(app?.currentVisualizerData)
            ? app.currentVisualizerData : [];
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

    const createInterludeVisualizer = (options = {}) => {
        const barCount = Math.max(20, Math.min(64, Math.round(finiteNumber(options.barCount, 36))));
        const root = document.createElement('div');
        root.className = `stage-interlude-visualizer${options.className ? ` ${options.className}` : ''}`;
        root.setAttribute('role', 'status');
        root.setAttribute('aria-live', 'polite');

        const orbit = document.createElement('span');
        orbit.className = 'stage-interlude-orbit';
        orbit.setAttribute('aria-hidden', 'true');
        const bars = document.createElement('span');
        bars.className = 'stage-interlude-bars';
        bars.setAttribute('aria-hidden', 'true');
        const barsList = Array.from({ length: barCount }, (_, index) => {
            const bar = document.createElement('i');
            bar.style.setProperty('--interlude-index', String(index));
            bar.style.setProperty('--interlude-angle', `${index * 360 / barCount}deg`);
            bars.appendChild(bar);
            return bar;
        });
        orbit.append(bars);
        root.append(orbit);

        let visible = false;
        let destroyed = false;
        let lastLabel = '';
        const update = (frame, state = {}) => {
            if (destroyed) return;
            const nextVisible = state.visible !== false;
            if (nextVisible !== visible) {
                visible = nextVisible;
                root.hidden = !visible;
            }
            const label = String(state.label || '音乐间奏');
            if (label !== lastLabel) {
                lastLabel = label;
                root.setAttribute('aria-label', label);
            }
            if (!visible) return;

            const spectrum = frame?.audio?.spectrum || EMPTY_WORDS;
            const hasSpectrum = spectrum.length > 0;
            const motion = global.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
                ? 0 : clamp(finiteNumber(state.intensity, 1), 0, 2);
            const time = finiteNumber(frame?.playbackTime, 0) * motion;
            const playing = Boolean(frame?.isPlaying);
            const power = playing ? clamp(frame?.audio?.power) * Math.min(1, motion) : 0;
            root.classList.toggle('is-playing', playing);
            root.style.setProperty('--interlude-power', power.toFixed(4));
            // Same absolute phase on pause: no change of angular speed that jumps the ring.
            root.style.setProperty('--interlude-phase', `${(time * 3) % 360}deg`);

            barsList.forEach((bar, index) => {
                const ratio = index / barCount;
                let energy;
                if (hasSpectrum) {
                    const mirrored = ratio <= 0.5 ? ratio * 2 : (1 - ratio) * 2;
                    const spectrumRatio = 0.025 + Math.pow(mirrored, 1.65) * 0.92;
                    const center = Math.min(spectrum.length - 1, Math.floor(spectrumRatio * spectrum.length));
                    const radius = Math.max(1, Math.floor(spectrum.length / 128));
                    let total = 0;
                    let samples = 0;
                    for (let sample = Math.max(0, center - radius); sample <= Math.min(spectrum.length - 1, center + radius); sample += 1) {
                        total += clamp(spectrum[sample]);
                        samples += 1;
                    }
                    energy = clamp(Math.pow(total / Math.max(1, samples), 0.72));
                } else {
                    const wave = Math.sin(time * 0.85 + index * 0.52) * 0.5
                        + Math.sin(time * 0.43 - index * 0.26) * 0.28;
                    energy = 0.16 + Math.max(0, wave) * 0.22;
                }
                const settled = playing ? energy * Math.min(1, motion) : 0;
                const length = 0.28 + settled * 0.72;
                // Translate from the centre first; scaling only changes the stroke length.
                bar.style.transform = `rotate(var(--interlude-angle)) translateY(calc(-1 * var(--interlude-radius))) scaleY(${length.toFixed(4)})`;
                bar.style.opacity = (0.3 + settled * 0.5).toFixed(4);
            });
        };
        const destroy = () => {
            if (destroyed) return;
            destroyed = true;
            barsList.length = 0;
            root.remove();
        };

        root.hidden = true;
        return Object.freeze({ root, update, destroy });
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

    // Call after intentional in-place lyric edits; normal source replacement is
    // already tracked by array identity without hashing the whole song per frame.
    const invalidateLines = (lines) => {
        if (Array.isArray(lines)) normalizedLinesCache.delete(lines);
    };

    global.MusicStageRuntime = Object.freeze({
        invalidateLines,
        finiteNumber,
        clamp,
        hashString,
        seededRandom,
        splitGraphemes,
        normalizeLines,
        buildFallbackWords,
        buildGlyphTimeline,
        resolveSupplementalText,
        resolvePlaybackTime,
        findActiveLineIndex,
        resolveWordState,
        resolveAudioBands,
        createFrame,
        createInterludeVisualizer,
        DisposableScope
    });
})(window);