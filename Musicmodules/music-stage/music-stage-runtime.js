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
        // A timestamp-only line owns no end time. Letting it run to the next
        // line turns every instrumental break into one very long sung line, so
        // cap it with the same reading estimate the structured parser applies.
        let inferredEnd = nextStart || startTime + 5;
        if (!declaredEnd && !(Array.isArray(line?.words) && line.words.length)) {
            const text = String(line?.fullText ?? line?.original ?? '');
            const reading = splitGraphemes(text).length * 0.45 + 2;
            const gap = inferredEnd - startTime;
            if (gap > 5 && gap > reading) inferredEnd = startTime + reading;
        }
        const endTime = Math.max(startTime + 0.08, declaredEnd || inferredEnd);
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

    // Lyric files carry marker lines and placeholder translations ("//",
    // "●●●", dashes) that time a break but are not text. A string counts as
    // text only if it holds a letter or a digit, in any script.
    const readableText = (text) => /[\p{L}\p{N}]/u.test(String(text ?? ''));

    const resolveSupplementalText = (line) => {
        const keep = text => { const value = String(text ?? '').trim(); return readableText(value) ? value : ''; };
        const translation = keep(line?.translation);
        const romanization = keep(line?.romanization);
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

    // Every poll re-anchors the extrapolation with a few milliseconds of
    // transport latency, which shows up as a small step four times a second in
    // any continuously moving camera. Follow the polled clock through a slow
    // filter instead, and snap only for real discontinuities.
    const steadyClocks = new WeakMap();
    const STEADY_CLOCK_SNAP = 0.12;
    const STEADY_CLOCK_SECONDS = 0.6;
    const resolveSteadyPlaybackTime = (app, now) => {
        const raw = resolvePlaybackTime(app, now);
        if (!app || typeof app !== 'object') return raw;
        if (!app.isPlaying) {
            steadyClocks.delete(app);
            return raw;
        }
        const wall = now / 1000;
        const instant = raw - wall;
        const clock = steadyClocks.get(app);
        if (!clock || now < clock.at || Math.abs(instant - clock.offset) > STEADY_CLOCK_SNAP) {
            steadyClocks.set(app, { offset: instant, at: now });
            return raw;
        }
        clock.offset += (instant - clock.offset) * (1 - Math.exp(-(now - clock.at) / 1000 / STEADY_CLOCK_SECONDS));
        clock.at = now;
        return Math.max(0, wall + clock.offset);
    };

    const findActiveLineIndex = (lines, playbackTime, previousIndex = -1) => {
        const len = lines.length;
        if (!len) return -1;
        // Fast path for monotonic playback: stay on previousIndex or step to previousIndex + 1 in O(1).
        if (previousIndex >= 0 && previousIndex < len && playbackTime >= lines[previousIndex].startTime) {
            const next = previousIndex + 1;
            if (next >= len || playbackTime < lines[next].startTime) return previousIndex;
            const afterNext = next + 1;
            if (afterNext >= len || playbackTime < lines[afterNext].startTime) return next;
        }
        let low = 0;
        let high = len - 1;
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

    const EMPTY_WORD_STATE = Object.freeze({
        words: EMPTY_WORDS,
        activeWordIndex: -1,
        wordProgress: 0,
        wordStates: EMPTY_WORDS
    });
    let lastWordLine = null;
    let lastWordTime = NaN;
    let lastWordResult = EMPTY_WORD_STATE;
    const resolveWordState = (line, playbackTime) => {
        if (!line) return EMPTY_WORD_STATE;
        if (line === lastWordLine && playbackTime === lastWordTime) return lastWordResult;

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

        lastWordLine = line;
        lastWordTime = playbackTime;
        lastWordResult = {
            words,
            activeWordIndex,
            wordProgress: activeProgress,
            wordStates
        };
        return lastWordResult;
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
        const length = values.length;
        if (!length) {
            return { power: 0, bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0, spectrum: values };
        }

        const r0a = Math.max(0, Math.floor(length * 0.01));
        const r0b = Math.min(length, Math.max(1, Math.ceil(length * 0.10)));
        const r1a = Math.max(0, Math.floor(length * 0.10));
        const r1b = Math.min(length, Math.max(r1a + 1, Math.ceil(length * 0.24)));
        const r2a = Math.max(0, Math.floor(length * 0.24));
        const r2b = Math.min(length, Math.max(r2a + 1, Math.ceil(length * 0.46)));
        const r3a = Math.max(0, Math.floor(length * 0.18));
        const r3b = Math.min(length, Math.max(r3a + 1, Math.ceil(length * 0.58)));
        const r4a = Math.max(0, Math.floor(length * 0.58));
        const r4b = Math.min(length, Math.max(r4a + 1, Math.ceil(length * 0.98)));

        let t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0;
        // Five tight branchless loops over the exact band slices; avoids 5 range checks per bin.
        for (let i = r0a; i < r0b; i += 1) t0 += Number(values[i]) || 0;
        for (let i = r1a; i < r1b; i += 1) t1 += Number(values[i]) || 0;
        for (let i = r2a; i < r2b; i += 1) t2 += Number(values[i]) || 0;
        for (let i = r3a; i < r3b; i += 1) t3 += Number(values[i]) || 0;
        for (let i = r4a; i < r4b; i += 1) t4 += Number(values[i]) || 0;

        const bass = clamp(t0 / Math.max(1, r0b - r0a));
        const lowMid = clamp(t1 / Math.max(1, r1b - r1a));
        const mid = clamp(t2 / Math.max(1, r2b - r2a));
        const vocal = clamp(t3 / Math.max(1, r3b - r3a));
        const treble = clamp(t4 / Math.max(1, r4b - r4a));
        const power = clamp(bass * 0.25 + lowMid * 0.2 + mid * 0.2 + vocal * 0.25 + treble * 0.1);
        return { power, bass, lowMid, mid, vocal, treble, spectrum: values };
    };

    // Renderer-independent live spectral-flux detector. This is deliberately
    // NOT a beat grid: history-dependent transients must never place scenery,
    // schedule cuts or change a deterministic camera pose.
    const createAudioOnset = () => {
        const bins = new Float32Array(48);
        let binsDirty = false;
        let lastTime = null, track = null, source = null, playing = false;
        let baseline = 0.02, energy = 0, hitAt = -Infinity, hitStrength = 0, hits = 0;
        const state = { impact: 0, energy: 0, time: 0, reset: true, onsets: 0 };
        const pulse = age => age >= 0 && age < 0.85
            ? (1 - Math.exp(-age * 35)) * Math.exp(-age * 5) : 0;
        return {
            update(frame) {
                const time = finiteNumber(frame.playbackTime);
                const identity = frame.track?.path || frame.track?.title || '';
                const dt = lastTime === null ? 0 : time - lastTime;
                const reset = lastTime === null || identity !== track || source !== frame.lines
                    || dt < -0.025 || dt > 0.5;
                const resumed = frame.isPlaying && !playing;
                const spectrum = frame.audio?.spectrum || EMPTY_WORDS;
                if (reset || resumed || (frame.isPlaying && dt > 0)) {
                    let flux = 0;
                    const specLen = spectrum.length;
                    if (specLen > 0) {
                        binsDirty = true;
                        const scale = specLen / bins.length;
                        for (let i = 0; i < bins.length; i++) {
                            const value = clamp(spectrum[Math.floor(i * scale)]);
                            flux += Math.max(0, value - bins[i]);
                            bins[i] = value;
                        }
                        flux /= bins.length;
                    } else if (binsDirty) {
                        bins.fill(0);
                        binsDirty = false;
                    }
                    if (reset || resumed) {
                        baseline = 0.02;
                        hitAt = -Infinity;
                        hitStrength = 0;
                        energy = clamp(frame.audio?.power);
                    } else {
                        energy += (clamp(frame.audio?.power) - energy) * (1 - Math.exp(-dt * 3));
                        const threshold = Math.max(0.018, baseline * 1.8);
                        if (flux > threshold && energy > 0.035 && time - hitAt > 0.38) {
                            hitAt = time;
                            hitStrength = clamp((flux - threshold) * 10 + 0.35);
                            hits++;
                        }
                        baseline += (flux - baseline) * (1 - Math.exp(-dt * 1.8));
                    }
                }
                state.impact = pulse(time - hitAt) * hitStrength;
                state.energy = energy;
                state.time = time;
                state.reset = reset;
                state.onsets = hits;
                lastTime = time;
                track = identity;
                source = frame.lines;
                playing = Boolean(frame.isPlaying);
                return state;
            },
            snapshot() { return { ...state, historyBins: bins.length }; },
            reset() { lastTime = null; hitAt = -Infinity; bins.fill(0); }
        };
    };

    const plainLinesCache = new WeakMap();
    const plainLinesOf = (source) => {
        if (!Array.isArray(source) || !source.length) return EMPTY_LINES;
        let cached = plainLinesCache.get(source);
        if (!cached) {
            cached = Object.freeze(source.map(text => String(text ?? '').trim()).filter(readableText));
            plainLinesCache.set(source, cached);
        }
        return cached;
    };

    let lastNextLinesSrc = null;
    let lastNextLinesIdx = -2;
    let lastNextLinesVal = EMPTY_LINES;
    const nextLinesOf = (lines, currentLineIndex) => {
        if (!lines.length) return EMPTY_LINES;
        if (lines === lastNextLinesSrc && currentLineIndex === lastNextLinesIdx) return lastNextLinesVal;
        lastNextLinesSrc = lines;
        lastNextLinesIdx = currentLineIndex;
        const slice = currentLineIndex >= 0
            ? lines.slice(currentLineIndex + 1, currentLineIndex + 4)
            : lines.slice(0, 3);
        lastNextLinesVal = slice.length ? Object.freeze(slice) : EMPTY_LINES;
        return lastNextLinesVal;
    };

    const createFrame = (app, now = performance.now()) => {
        const wallNow = Date.now();
        const lines = normalizeLines(app?.currentLyrics);
        const playbackTime = resolveSteadyPlaybackTime(app, wallNow);
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
            nextLines: nextLinesOf(lines, currentLineIndex),
            lineProgress,
            ...wordState,
            lines,
            // 只有纯文本、不带时间的歌词（app.currentLyricsPlainLines）：原样交给舞台，
            // 要不要按时长铺开由舞台自己决定（MusicStageModeUtils.withPlainLyrics）
            plainLines: lines.length ? EMPTY_LINES : plainLinesOf(app?.currentLyricsPlainLines),
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
        const barSpectrumRatios = new Float32Array(barCount);
        const barsList = Array.from({ length: barCount }, (_, index) => {
            const ratio = index / barCount;
            const mirrored = ratio <= 0.5 ? ratio * 2 : (1 - ratio) * 2;
            barSpectrumRatios[index] = 0.025 + Math.pow(mirrored, 1.65) * 0.92;
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
        let settledIdle = false;
        let lastPlaying = null;
        let lastPowerText = '';
        let lastPhaseText = '';
        const lastBarScale = new Array(barCount).fill('');
        const lastBarOpacity = new Array(barCount).fill('');
        const reducedMotionQuery = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const update = (frame, state = {}) => {
            if (destroyed) return;
            const nextVisible = state.visible !== false;
            if (nextVisible !== visible) {
                visible = nextVisible;
                root.hidden = !visible;
                settledIdle = false;
            }
            const label = String(state.label || '音乐间奏');
            if (label !== lastLabel) {
                lastLabel = label;
                root.setAttribute('aria-label', label);
            }
            if (!visible) return;

            const spectrum = frame?.audio?.spectrum || EMPTY_WORDS;
            const hasSpectrum = spectrum.length > 0;
            const motion = isReducedMotion(reducedMotionQuery)
                ? 0 : clamp(finiteNumber(state.intensity, 1), 0, 2);
            const time = finiteNumber(frame?.playbackTime, 0) * motion;
            const playing = Boolean(frame?.isPlaying);
            const power = playing ? clamp(frame?.audio?.power) * Math.min(1, motion) : 0;
            if (playing !== lastPlaying) {
                lastPlaying = playing;
                root.classList.toggle('is-playing', playing);
            }
            const powerText = power.toFixed(3);
            if (powerText !== lastPowerText) {
                lastPowerText = powerText;
                root.style.setProperty('--interlude-power', powerText);
            }
            // Same absolute phase on pause: no change of angular speed that jumps the ring.
            const phaseText = `${((time * 3) % 360).toFixed(2)}deg`;
            if (phaseText !== lastPhaseText) {
                lastPhaseText = phaseText;
                root.style.setProperty('--interlude-phase', phaseText);
            }
            if (!playing && settledIdle) return;
            settledIdle = !playing;

            const specLen = spectrum.length;
            const radius = hasSpectrum ? Math.max(1, Math.floor(specLen / 128)) : 1;
            const motionScale = Math.min(1, motion);
            for (let index = 0; index < barsList.length; index += 1) {
                const bar = barsList[index];
                let energy;
                if (hasSpectrum) {
                    const center = Math.min(specLen - 1, Math.floor(barSpectrumRatios[index] * specLen));
                    let total = 0;
                    let samples = 0;
                    const hi = Math.min(specLen - 1, center + radius);
                    for (let sample = Math.max(0, center - radius); sample <= hi; sample += 1) {
                        total += clamp(spectrum[sample]);
                        samples += 1;
                    }
                    energy = clamp(Math.pow(total / Math.max(1, samples), 0.72));
                } else {
                    const wave = Math.sin(time * 0.85 + index * 0.52) * 0.5
                        + Math.sin(time * 0.43 - index * 0.26) * 0.28;
                    energy = 0.16 + Math.max(0, wave) * 0.22;
                }
                const settled = playing ? energy * motionScale : 0;
                const lengthStr = (0.28 + settled * 0.72).toFixed(3);
                if (lengthStr !== lastBarScale[index]) {
                    lastBarScale[index] = lengthStr;
                    // Translate from the centre first; scaling only changes the stroke length.
                    bar.style.transform = `rotate(var(--interlude-angle)) translateY(calc(-1 * var(--interlude-radius))) scaleY(${lengthStr})`;
                }
                const opStr = (0.3 + settled * 0.5).toFixed(3);
                if (opStr !== lastBarOpacity[index]) {
                    lastBarOpacity[index] = opStr;
                    bar.style.opacity = opStr;
                }
            }
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

    const isReducedMotion = (mediaQuery) => {
        if (typeof global.MusicMotion?.reduced === 'function') return Boolean(global.MusicMotion.reduced());
        return Boolean(mediaQuery?.matches);
    };

    // Call after intentional in-place lyric edits; normal source replacement is
    // already tracked by array identity without hashing the whole song per frame.
    const invalidateLines = (lines) => {
        if (Array.isArray(lines)) normalizedLinesCache.delete(lines);
    };

    global.MusicStageRuntime = Object.freeze({
        invalidateLines,
        isReducedMotion,
        finiteNumber,
        clamp,
        hashString,
        seededRandom,
        splitGraphemes,
        normalizeLines,
        readableText,
        buildFallbackWords,
        buildGlyphTimeline,
        resolveSupplementalText,
        resolvePlaybackTime,
        resolveSteadyPlaybackTime,
        findActiveLineIndex,
        resolveWordState,
        resolveAudioBands,
        createFrame,
        createAudioOnset,
        createInterludeVisualizer,
        DisposableScope
    });
})(window);