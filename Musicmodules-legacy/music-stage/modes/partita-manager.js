/* Folia Partita semantic staircase adaptation — AGPL-3.0. */
(function (global) {
    'use strict';
    const L = global.MusicStageLyricLayout;
    const P = global.MusicStageLyricPerformance;
    const { clamp } = global.MusicStageRuntime;
    const compile = (line, env) => {
        const { width, height, family, tuning, motion, measure } = env;
        const units = L.units(line, tuning.semanticLayout !== false);
        const random = P.seededRandom(`partita:${env.trackKey}:${line.startTime}`);
        const fontSize = clamp(width * 0.055, 32, 72) * L.number(tuning.fontScale, 1);
        const count = Math.max(1, Math.min(units.length, Math.floor(height / 100)));
        const chunks = [];
        let cursor = 0;
        for (let row = 0; row < count; row += 1) {
            const remaining = units.length - cursor;
            const slots = count - row;
            const average = remaining / slots;
            const length = row === count - 1 ? remaining
                : clamp(Math.round(average + (random() - 0.5) * average), 1, remaining - slots + 1);
            chunks.push(units.slice(cursor, cursor + length));
            cursor += length;
        }
        const rawMin = L.number(tuning.staggerMin, 20);
        const rawMax = L.number(tuning.staggerMax, 100);
        const min = Math.min(rawMin, rawMax);
        const max = Math.max(rawMin, rawMax);
        const power = L.number(tuning.power, 1) * motion;
        const rowHeight = fontSize * 1.95 + 22;
        const groups = chunks.map((chunk, row) => {
            const tokens = L.displayTokens(chunk);
            const stagger = (min + random() * (max - min)) * power * (row % 2 === 0 ? -1 : 1);
            let x = 0;
            const placements = tokens.map(token => {
                const wordWidth = measure(token.text, fontSize, family);
                const scale = tuning.layoutStyle === 'calm' ? 1 : 0.8 + random() * 0.9;
                const rotationRange = tuning.layoutStyle === 'calm' ? 0 : tuning.layoutStyle === 'chaotic' ? 16 : 6;
                const p = {
                    token, x, y: fontSize * 0.25, width: wordWidth, height: fontSize * 1.22,
                    scale: 1 + (scale - 1) * power,
                    rotate: (random() - 0.5) * rotationRange,
                    passedRotate: (random() - 0.5) * (tuning.layoutStyle === 'chaotic' ? 32 : 20),
                    entryX: (random() - 0.5) * 80, entryY: 45,
                    rippleScale: 1.5 + random() * 2
                };
                // Reserve the active scale envelope instead of allowing adjacent words to overlap.
                x += wordWidth + Math.max(12, wordWidth * Math.max(0, p.scale * 1.4 - 1) * 0.55);
                return p;
            });
            return {
                x: (width - x) / 2 + stagger, y: row * rowHeight,
                width: x, height: fontSize * 1.5, placements,
                side: row % 2 === 0 ? 'left' : 'right',
                startTime: chunk[0]?.startTime ?? line.startTime,
                endTime: chunk[chunk.length - 1]?.endTime ?? line.endTime
            };
        });
        const left = Math.min(0, ...groups.map(group => group.x - 40));
        const right = Math.max(width, ...groups.map(group => group.x + group.width + 40));
        groups.forEach(group => { group.x -= left; });
        const layoutHeight = Math.max(rowHeight, groups.length * rowHeight);
        return {
            width: right - left, height: layoutHeight, groups,
            fontSize, fontFamily: family, fontWeight: 700,
            fitScale: Math.min(1, width / (right - left), height / layoutHeight)
        };
    };
    global.MusicStagePartitaManager = Object.freeze({
        create: (container, services) => P.createManager('partita', '云阶', container, services, compile)
    });
})(window);