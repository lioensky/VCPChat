/* Folia Classic layout adaptation — AGPL-3.0, Folia contributors. */
(function (global) {
    'use strict';
    const L = global.MusicStageLyricLayout;
    const P = global.MusicStageLyricPerformance;
    const { clamp } = global.MusicStageRuntime;
    const compile = (line, env) => {
        const { tuning, width, height, family, measure, motion } = env;
        const fontSize = clamp(width * 0.06, 36, 72) * L.number(tuning.fontScale, 1);
        const tokens = L.displayTokens(L.units(line, tuning.semanticLayout !== false));
        const random = P.seededRandom(`${env.trackKey}:${line.startTime}`);
        const available = Math.max(100, width - 100);
        const placements = tokens.map(token => {
            const spread = (tuning.layoutStyle === 'chaotic' ? 60 : tuning.layoutStyle === 'calm' ? 0 : 20) * motion;
            return {
                token, width: measure(token.text, fontSize, family), height: fontSize * 1.22,
                offsetX: (random() - 0.5) * spread * 2,
                offsetY: (random() - 0.5) * spread * 2,
                rotate: (random() - 0.5) * (tuning.layoutStyle === 'chaotic' ? 60 : 10),
                scale: 1.1 + random() * 0.2,
                passedRotate: (random() - 0.5) * 45,
                rippleScale: 1.5 + random() * 2
            };
        });
        const rows = [[]];
        let rowWidth = 0;
        placements.forEach((p, index) => {
            const next = placements[index + 1];
            p.gap = Math.max(fontSize * 0.12,
                p.width * (p.scale * 1.4 - 1) / 2
                + (next ? next.width * (next.scale * 1.4 - 1) / 2 : 0)
                + p.offsetX - (next?.offsetX || 0) + fontSize * 0.05) * L.number(tuning.wordSpacing, 0.7);
            if (rowWidth + p.width + p.gap > available && rows[rows.length - 1].length) {
                rows.push([]);
                rowWidth = 0;
            }
            rows[rows.length - 1].push(p);
            rowWidth += p.width + p.gap;
        });
        const rowHeight = fontSize * 2.05 + 20 * motion;
        const layoutHeight = rows.length * rowHeight;
        rows.forEach((row, rowIndex) => {
            const total = row.reduce((sum, p) => sum + p.width + p.gap, 0);
            const alignment = tuning.layoutStyle === 'calm' ? 0.5 : [0, 0.5, 1][Math.floor(random() * 3)];
            let x = Math.max(0, available - total) * alignment;
            row.forEach(p => {
                p.x = x + p.offsetX + 50;
                p.y = rowIndex * rowHeight + p.offsetY + fontSize * 0.4;
                p.entryX = Math.sin(p.offsetY) * 100;
                p.entryY = Math.cos(p.offsetX) * 50;
                x += p.width + p.gap;
            });
        });
        const widest = Math.max(width, ...placements.map(p => p.x + p.width * p.scale * 1.4 + 30));
        return {
            width: widest, height: layoutHeight, fontSize, fontFamily: family, fontWeight: 700,
            placements, fitScale: Math.min(1, height / Math.max(layoutHeight, 1), width / widest)
        };
    };
    global.MusicStageLuminousManager = Object.freeze({
        create: (container, services) => P.createManager('luminous', '流光', container, services, compile)
    });
})(window);