/*
 * Folia Cadenza: Pretext fragments, hero emphasis, collision-aware placements.
 * Native DOM performance adapter; source design/code by Folia contributors.
 * AGPL-3.0. Pretext itself remains MIT licensed.
 */
(function (global) {
    'use strict';
    const L = global.MusicStageLyricLayout;
    const P = global.MusicStageLyricPerformance;
    const { clamp, splitGraphemes } = global.MusicStageRuntime;

    const compile = (line, env) => {
        const { width, height, family, tuning, pretext, measure } = env;
        const glyphs = L.timeline(line);
        const tokens = L.displayTokens(L.units(line, true));
        const density = glyphs.length;
        const base = clamp(width * 0.086, 34, 94)
            - Math.min(Math.max(0, density - 12) * 1.8, 34)
            - Math.min(Math.max(0, tokens.length - 7) * 1.5, 18);
        const fontSize = clamp(clamp(base, 28, 104) * L.number(tuning.fontScale, 1), 24, 132);
        const font = `700 ${fontSize}px ${family}`;
        const prepared = pretext.prepareWithSegments(line.fullText, font, { whiteSpace: 'pre-wrap' });
        const compression = density > 12 ? clamp(0.92 - (density - 12) * 0.018, 0.62, 0.92) : 0.92;
        const maxWidth = Math.max(100, Math.min(width - 48, width * L.number(tuning.widthRatio, 0.78) * compression, 820));
        const lineHeight = fontSize * (L.cjk.test(line.fullText) ? 1.22 : 1.1);
        const wrapped = pretext.layoutWithLines(prepared, maxWidth, lineHeight);
        let offset = 0;
        const segments = prepared.segments.map((text, index) => {
            const count = splitGraphemes(text).length;
            const item = { start: offset, end: offset + count, count, index };
            offset += count;
            return item;
        });
        const globalOffset = cursor => {
            const segment = segments[cursor.segmentIndex];
            return segment ? segment.start + cursor.graphemeIndex : offset;
        };
        const widthBetween = (start, end) => {
            let total = 0;
            segments.forEach(segment => {
                const from = Math.max(start, segment.start);
                const to = Math.min(end, segment.end);
                if (to <= from) return;
                const advances = prepared.breakableFitAdvances[segment.index];
                if (from === segment.start && to === segment.end) total += prepared.widths[segment.index];
                else if (advances) {
                    for (let i = from - segment.start; i < to - segment.start; i += 1) total += advances[i] || 0;
                } else {
                    total += prepared.widths[segment.index] * (to - from) / Math.max(1, segment.count);
                }
            });
            return total;
        };
        // Resolve tokens by their actual glyph identity; punctuation and whitespace
        // are retained, and a wrapped token keeps the full source glow timeline.
        const ranges = tokens.map((token, index) => {
            const start = glyphs.indexOf(token.glyphs[0]);
            // units() builds a separate timeline, so use a monotonically aligned text cursor below.
            return { token, index, start, end: start + token.glyphs.length };
        });
        let cursor = 0;
        ranges.forEach(range => {
            const target = splitGraphemes(range.token.text);
            let start = cursor;
            for (let at = cursor; at <= glyphs.length - target.length; at += 1) {
                if (target.every((char, i) => glyphs[at + i].char === char)) { start = at; break; }
            }
            range.start = start;
            range.end = start + target.length;
            cursor = range.end;
        });
        const fragments = [];
        wrapped.lines.forEach((row, rowIndex) => {
            const start = globalOffset(row.start);
            const end = globalOffset(row.end);
            ranges.forEach(range => {
                const from = Math.max(start, range.start);
                const to = Math.min(end, range.end);
                if (to <= from) return;
                const localGlyphs = range.token.glyphs.slice(from - range.start, to - range.start);
                const token = {
                    ...range.token,
                    text: localGlyphs.map(glyph => glyph.char).join(''),
                    glyphs: localGlyphs,
                    sourceGlyphCount: range.token.glyphs.length
                };
                fragments.push({
                    token, wordIndex: range.index, rowIndex,
                    split: from !== range.start || to !== range.end,
                    x: -row.width / 2 + widthBetween(start, from),
                    y: rowIndex * lineHeight - wrapped.height / 2,
                    width: Math.max(1, measure(token.text, fontSize, family)),
                    height: fontSize * 1.22
                });
            });
        });
        const hero = fragments.filter(p => !p.split && p.token.text.trim())
            .map(p => ({
                p,
                score: (L.cjk.test(p.token.text) ? 0.18 : Math.min(p.token.glyphs.length * 0.08, 0.36))
                    + (1 - Math.abs(p.wordIndex - (tokens.length - 1) / 2) / Math.max(tokens.length, 1)) * 0.18
            })).sort((a, b) => b.score - a.score)[0];
        const random = P.seededRandom(`cadenza:${env.trackKey}:${line.startTime}`);
        const occupied = [];
        const bands = new Map();
        const bandSize = Math.max(24, lineHeight);
        const register = rect => {
            const index = occupied.length;
            occupied.push(rect);
            for (let band = Math.floor(rect.top / bandSize); band <= Math.floor(rect.bottom / bandSize); band += 1) {
                if (!bands.has(band)) bands.set(band, []);
                bands.get(band).push(index);
            }
        };
        const intersects = rect => {
            for (let band = Math.floor(rect.top / bandSize); band <= Math.floor(rect.bottom / bandSize); band += 1) {
                for (const index of bands.get(band) || []) {
                    const other = occupied[index];
                    if (rect.left < other.right && rect.right > other.left
                        && rect.top < other.bottom && rect.bottom > other.top) return true;
                }
            }
            return false;
        };
        const plans = fragments.slice().sort((a, b) => (b === hero?.p ? 1 : 0) - (a === hero?.p ? 1 : 0));
        plans.forEach(p => {
            const emphasized = p === hero?.p && tuning.heroEmphasis !== false && line.fullText !== '......';
            p.scale = emphasized ? 1.46 * (1 + clamp(hero.score - 0.48, 0, 0.52)) : 1.01;
            const collisionWidth = p.width * p.scale * 1.48 + 18;
            const collisionHeight = p.height * p.scale * 1.4 + 14;
            const preferredX = emphasized ? -p.width / 2 : p.x;
            const preferredY = emphasized ? -p.height / 2 : p.y;
            let found = false;
            const rectAt = (x, y) => ({
                left: x - (collisionWidth - p.width) / 2,
                top: y - (collisionHeight - p.height) / 2,
                right: x + (collisionWidth + p.width) / 2,
                bottom: y + (collisionHeight + p.height) / 2
            });
            const step = Math.max(10, fontSize * 0.14);
            for (let radius = 0; radius <= Math.max(80, lineHeight * 2.2, collisionWidth * 0.75) && !found; radius += step) {
                const count = radius === 0 ? 1 : Math.max(12, Math.ceil(Math.PI * radius * 2 / step));
                for (let sample = 0; sample < count; sample += 1) {
                    const angle = sample / count * Math.PI * 2;
                    const x = preferredX + Math.cos(angle) * radius;
                    const y = preferredY + Math.sin(angle) * radius * 0.92;
                    const rect = rectAt(x, y);
                    if (rect.left < -maxWidth / 2 - 72 || rect.right > maxWidth / 2 + 72) continue;
                    if (intersects(rect)) continue;
                    p.x = x; p.y = y;
                    register(rect);
                    found = true;
                    break;
                }
            }
            if (!found) {
                // Deterministic collision-free overflow row; final fit includes it.
                p.x = preferredX;
                p.y = occupied.length ? Math.max(...occupied.map(rect => rect.bottom)) + collisionHeight / 2 : preferredY;
                register(rectAt(p.x, p.y));
            }
            p.rotate = 0;
            p.passedRotate = (random() - 0.5) * 12;
            const length = Math.max(1, Math.hypot(p.x, p.y));
            p.driftX = p.x / length * (5 + random() * 6);
            p.driftY = p.y / length * (5 + random() * 6) * 0.72;
            p.rippleScale = 1.5 + random() * 2;
        });
        const left = Math.min(-maxWidth / 2, ...occupied.map(rect => rect.left)) - 24;
        const top = Math.min(0, ...occupied.map(rect => rect.top)) - 24;
        const right = Math.max(maxWidth / 2, ...occupied.map(rect => rect.right)) + 24;
        const bottom = Math.max(lineHeight, ...occupied.map(rect => rect.bottom)) + 24;
        plans.forEach(p => { p.x -= left; p.y -= top; });
        return {
            width: right - left, height: bottom - top,
            fontSize, fontFamily: family, fontWeight: 700, placements: plans,
            fitScale: Math.min(1, width / (right - left), height / (bottom - top))
        };
    };
    global.MusicStageCadenzaManager = Object.freeze({
        create: (container, services) => P.createManager('cadenza', '心象', container, services, compile, { pretext: true })
    });
})(window);