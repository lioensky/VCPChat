(function (global) {
    'use strict';

    const R = global.MusicStageRuntime;
    const { clamp, finiteNumber, buildGlyphTimeline, hashString } = R;
    const smooth = value => { const p = clamp(value); return p * p * (3 - 2 * p); };
    const mix = (a, b, p) => a + (b - a) * p;
    // One world unit is one metre. Parameters describe intention, not objects.
    const PRESETS = Object.freeze({
        Departure: { speed: 1.3, height: 0.8, fov: 40, openness: 0.15, warmth: 0.25, density: 0.3 },
        Verse: { speed: 2.8, height: 2.2, fov: 48, openness: 0.25, warmth: 0.65, density: 1 },
        Pre: { speed: 3.5, height: 2.5, fov: 50, openness: 0.4, warmth: 1, density: 1.3 },
        Chorus: { speed: 4.2, height: 6.5, fov: 58, openness: 1, warmth: 0.45, density: 0.1 },
        Open: { speed: 3.4, height: 4.8, fov: 55, openness: 0.75, warmth: 0.4, density: 0.35 },
        Interlude: { speed: 1.5, height: 2.6, fov: 42, openness: 0.4, warmth: 0.5, density: 0.5 },
        Terminus: { speed: 0, height: 3.6, fov: 48, openness: 0.9, warmth: 0.25, density: 0.1 }
    });
    const upperBound = (items, time, key) => {
        let lo = 0, hi = items.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if ((key ? items[mid][key] : items[mid]) <= time) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const vocalEnd = line => Math.max(line.startTime,
        finiteNumber(line.vocalEndTime, finiteNumber(line.endTime, line.startTime)));
    const textKey = line => String(line.fullText || '').normalize('NFKC')
        .toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');

    // Require separated, non-overlapping blocks; a repeated single refrain is
    // not sufficient evidence of a chorus. Explicit source annotations win.
    const classifyLines = lines => {
        const kinds = lines.map(line => line.isChorus ? 'Chorus' : 'Verse');
        if (!lines.some(line => line.isChorus)) {
            const keys = lines.map(textKey);
            const pairs = new Map();
            for (let i = 0; i + 1 < keys.length; i++) {
                if (keys[i].length < 3 || keys[i + 1].length < 3) continue;
                const key = JSON.stringify([keys[i], keys[i + 1]]);
                const previous = pairs.get(key);
                if (previous !== undefined && i - previous >= 4
                    && lines[i].startTime - lines[previous].startTime >= 12) {
                    let length = 2;
                    while (length < 12 && previous + length < i && i + length < keys.length
                        && keys[previous + length] === keys[i + length]) length++;
                    for (let j = 0; j < length; j++) {
                        kinds[previous + j] = 'Chorus';
                        kinds[i + j] = 'Chorus';
                    }
                } else if (previous === undefined) pairs.set(key, i);
            }
        }
        if (!kinds.includes('Chorus')) {
            // Visual punctuation only: never claim that a fallback is a chorus.
            for (let i = 8; i < kinds.length; i += 12) {
                for (let j = i; j < Math.min(i + 4, kinds.length); j++) kinds[j] = 'Open';
            }
        }
        for (let i = 1; i < kinds.length; i++) {
            if (kinds[i] !== 'Chorus' || kinds[i - 1] === 'Chorus') continue;
            for (let j = Math.max(0, i - 2); j < i; j++) {
                if (kinds[j] === 'Verse' && lines[i].startTime - vocalEnd(lines[j]) < 12) kinds[j] = 'Pre';
            }
        }
        return kinds;
    };

    // Timings are never synthesized again here: Runtime owns glyph timing.
    const compilePhrases = lines => {
        const phrases = [];
        lines.forEach((line, lineIndex) => {
            const glyphs = buildGlyphTimeline(line);
            const cjkLine = /[\u3040-\u30ff\u3400-\u9fff]/u.test(line.fullText);
            let group = [];
            const flush = () => {
                if (!group.length) return;
                if (group.some(g => g.text.trim())) phrases.push({
                    id: phrases.length, lineIndex, glyphs: group,
                    text: group.map(g => g.text).join(''),
                    start: Math.min(...group.map(g => g.startTime)),
                    end: Math.max(...group.map(g => g.endTime))
                });
                group = [];
            };
            glyphs.forEach((glyph, i) => {
                const previous = glyphs[i - 1];
                const boundary = previous && (/[\s，。！？；,.!?;:：]/u.test(previous.text)
                    || glyph.startTime - previous.endTime > 0.4);
                const cjk = /[\u3040-\u30ff\u3400-\u9fff]/u.test(glyph.text);
                // Latin spaces delimit words, not shots. Keep several words together.
                const punctuation = previous && /[，。！？；,.!?;:：]/u.test(previous.text);
                if (cjkLine
                    ? (group.length >= 4 && boundary || group.length >= 12 && cjk || group.length >= 24)
                    : (group.length >= 36 && boundary || group.length >= 18 && punctuation
                        || group.length >= 64)) flush();
                group.push(glyph);
            });
            flush();
        });
        return phrases;
    };

    const compile = (input = {}) => {
        const lines = (input.lines || []).filter(line => Number.isFinite(line.startTime))
            .slice().sort((a, b) => a.startTime - b.startTime);
        const seed = String(input.trackId || 'last-train');
        const lastEnd = lines.reduce((end, line) => Math.max(end, vocalEnd(line),
            finiteNumber(line.renderHints?.renderEndTime, 0)), 0);
        const duration = Math.max(1, finiteNumber(input.duration, 0), lastEnd + (input.duration > lastEnd ? 0 : 8));
        const kinds = classifyLines(lines);
        const acts = [];
        const push = (kind, start, end) => {
            start = Math.max(0, start);
            end = Math.min(duration, end);
            if (end <= start) return;
            const previous = acts[acts.length - 1];
            if (previous?.kind === kind && Math.abs(previous.end - start) < 0.001) previous.end = end;
            else acts.push({ kind, start, end });
        };
        if (!lines.length) {
            push('Departure', 0, Math.min(6, duration * 0.15));
            push('Open', acts[acts.length - 1]?.end || 0, Math.max(duration * 0.15, duration - 8));
            push('Terminus', acts[acts.length - 1]?.end || 0, duration);
        } else {
            push('Departure', 0, lines[0].startTime);
            lines.forEach((line, index) => {
                const next = lines[index + 1]?.startTime ?? duration;
                const end = Math.min(next, Math.max(vocalEnd(line),
                    finiteNumber(line.renderHints?.renderEndTime, vocalEnd(line))));
                push(kinds[index], line.startTime, index === lines.length - 1 || next - end > 6 ? end : next);
                if (index === lines.length - 1) push('Terminus', end, duration);
                else if (next - end > 6) push('Interlude', end, next);
            });
        }
        if (!acts.length) push('Open', 0, duration);
        let chorusVisit = 0;
        acts.forEach((act, index) => {
            if (act.kind === 'Chorus') chorusVisit++;
            act.index = index;
            act.visit = act.kind === 'Chorus' ? chorusVisit : 0;
            act.params = { ...PRESETS[act.kind] };
            if (act.visit > 1) {
                act.params.speed *= 1 + Math.min(0.2, (act.visit - 1) * 0.1);
                act.params.height += Math.min(1.5, (act.visit - 1) * 0.6);
            }
        });
        const sample = time => {
            const t = clamp(time, 0, duration);
            const index = Math.max(0, upperBound(acts, t, 'start') - 1);
            const act = acts[index];
            const previous = acts[Math.max(0, index - 1)];
            const blend = index ? smooth((t - act.start) / Math.min(3, (act.end - act.start) * 0.45)) : 1;
            const params = {};
            for (const key of Object.keys(act.params)) params[key] = mix(previous.params[key], act.params[key], blend);
            if (act.kind === 'Departure') params.speed *= smooth(t / Math.max(1, act.end));
            return { ...params, act: act.kind, actIndex: index, visit: act.visit, blend };
        };
        // Fixed offline quadrature: sample order, refresh rate and seeks cannot
        // change distance. Long recordings retain a bounded integration table.
        const step = Math.max(1 / 30, duration / 120000);
        const count = Math.ceil(duration / step);
        const distances = new Float64Array(count + 1);
        for (let i = 1; i <= count; i++) {
            const a = (i - 1) * step, b = Math.min(duration, i * step);
            distances[i] = distances[i - 1] + (sample(a).speed + sample(b).speed) * (b - a) * 0.5;
        }
        const distanceAt = (time, speed = 1) => {
            const t = clamp(time, 0, duration);
            const i = Math.min(count - 1, Math.floor(t / step));
            const span = Math.min(duration, (i + 1) * step) - i * step;
            return mix(distances[i], distances[i + 1], clamp((t - i * step) / span))
                * clamp(speed, 0.55, 1.85);
        };
        const supplied = Array.isArray(input.beatTimes) ? input.beatTimes
            .filter(t => Number.isFinite(t) && t >= 0 && t <= duration).sort((a, b) => a - b) : [];
        const beats = supplied.filter((t, i) => !i || t - supplied[i - 1] > 0.08);
        const rhythmSource = beats.length > 1 ? 'provided-beats' : 'travel-rhythm';
        if (rhythmSource === 'travel-rhythm') {
            beats.length = 0;
            const interval = Math.max(0.9, duration / 20000);
            for (let t = 0; t <= duration; t += interval) beats.push(t);
        }
        // Union of all singing intervals protects overlaps/duets as well.
        const protectedIntervals = [];
        lines.flatMap(buildGlyphTimeline).filter(g => g.text.trim() && g.endTime > g.startTime)
            .sort((a, b) => a.startTime - b.startTime).forEach(g => {
                const last = protectedIntervals[protectedIntervals.length - 1];
                if (last && g.startTime <= last.end) last.end = Math.max(last.end, g.endTime);
                else protectedIntervals.push({ start: g.startTime, end: g.endTime });
            });
        const isSinging = t => {
            const index = upperBound(protectedIntervals, t, 'start') - 1;
            return index >= 0 && t < protectedIntervals[index].end;
        };
        const cuts = [];
        const candidates = [];
        const safe = t => !protectedIntervals.some(interval =>
            interval.start < t + 0.18 && interval.end > t - 0.18);
        acts.forEach((act, index) => {
            if (!index) return;
            const earlier = act.start - 0.35;
            const time = earlier >= acts[index - 1].start && safe(earlier) ? earlier : act.start;
            if (safe(time)) candidates.push({ time, actIndex: index, style: 'cut' });
        });
        lines.forEach((line, index) => {
            if (!index || line.startTime - vocalEnd(lines[index - 1]) < 1.2) return;
            const time = line.startTime - 0.35;
            const actIndex = Math.max(0, upperBound(acts, time, 'start') - 1);
            if (acts[actIndex].kind !== 'Verse' || time - acts[actIndex].start < 10 || !safe(time)) return;
            candidates.push({ time, actIndex, style: 'cut', rig: index % 2 ? 'WINDOW' : 'CAB' });
        });
        candidates.sort((a, b) => a.time - b.time);
        let lastCut = -Infinity;
        candidates.forEach(cut => {
            if (cut.time - lastCut < 8) return;
            cuts.push(cut);
            lastCut = cut.time;
        });
        return {
            seed, seedHash: hashString(seed), lines, duration, acts, cuts,
            phrases: compilePhrases(lines), beats, rhythmSource, protectedIntervals,
            sample, distanceAt, isSinging,
            rhythmAt(time) {
                const index = upperBound(beats, time) - 1;
                const age = index < 0 ? Infinity : time - beats[index];
                return { index, age, impulse: age >= 0 && age < 0.4
                    ? Math.sin(age * 34) * Math.exp(-age * 16) : 0 };
            }
        };
    };

    // A screen is an encounter, not a lyric phrase. Group pages by the distance
    // travelled through a comfortable viewing cone. No live audio/history here.
    const planEncounters = (timeline, options = {}) => {
        const speed = clamp(options.cameraSpeed ?? 1, 0.55, 1.85);
        const aspect = clamp(options.aspect ?? 1.6, 0.35, 3);
        const horizontalFov = 2 * Math.atan(Math.tan(48 * Math.PI / 360) * aspect);
        const lateral = 18;
        const travelBudget = clamp(2 * lateral * Math.tan(horizontalFov * 0.6), 24, 48);
        const encounters = [];
        const pageEncounter = new Map();
        let current = null;
        const isSign = phrase => options.lyricCarrier === 'sign'
            || options.lyricCarrier !== 'constellation'
                && !['Chorus', 'Open'].includes(timeline.sample(phrase.start).act);
        for (const phrase of timeline.phrases) {
            if (!isSign(phrase)) { current = null; continue; }
            const startDistance = timeline.distanceAt(phrase.start, speed);
            const endDistance = timeline.distanceAt(phrase.end, speed);
            const gap = current ? phrase.start - current.end : Infinity;
            const travelled = current ? endDistance - current.startDistance : Infinity;
            // Never split a spoken/sung phrase. Prefer an actual breath for the
            // next encounter; dense lyrics may extend a screen's residence.
            const newEncounter = !current || gap > 6
                || travelled > travelBudget && gap >= 0.65
                || travelled > travelBudget * 1.5;
            if (newEncounter) {
                current = {
                    id: encounters.length, start: phrase.start, end: phrase.end,
                    startDistance, endDistance, pages: [],
                    lateral, travelBudget
                };
                encounters.push(current);
            }
            current.pages.push(phrase.id);
            current.end = Math.max(current.end, phrase.end);
            current.endDistance = Math.max(current.endDistance, endDistance);
            pageEncounter.set(phrase.id, current.id);
        }
        encounters.forEach((encounter, index) => {
            // Fixed roadside address. It never follows the camera. A short
            // forward bias keeps the screen ahead until its final page finishes.
            encounter.address = encounter.endDistance + 10;
            encounter.previewStart = Math.max(0, encounter.start - 7);
            encounter.releaseAfter = encounter.end + 12;
            const previous = encounters[index - 1];
            encounter.separation = previous ? encounter.address - previous.address : Infinity;
            // The camera can hold its gaze through a long phrase instead of
            // inserting a second sign inside the same reading window.
            encounter.readingSpan = encounter.endDistance - encounter.startDistance;
        });
        return { encounters, pageEncounter, travelBudget };
    };

    global.MusicStageDioramaDirector = Object.freeze({
        compile, compilePhrases, planEncounters, smooth, upperBound, PRESETS
    });
})(window);