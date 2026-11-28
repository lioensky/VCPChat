/* Original VCP vector accompaniment; not a copy of Folia background assets. */
(function (global) {
    'use strict';
    const { clamp, seededRandom } = global.MusicStageRuntime;
    const ns = 'http://www.w3.org/2000/svg';
    const make = (tag, attrs = {}) => {
        const node = document.createElementNS(ns, tag);
        Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
        return node;
    };
    const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    let serial = 0;
    const create = (container, kind) => {
        const svg = make('svg', {
            viewBox: '0 0 1000 600', preserveAspectRatio: 'none',
            'aria-hidden': 'true', focusable: 'false', class: `lyric-vector-decor decor-${kind}`
        });
        const defs = make('defs');
        // Central quiet area: decorations cannot cross the main reading region.
        const maskId = `lyric-decor-mask-${++serial}`;
        const mask = make('mask', { id: maskId, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 1000, height: 600 });
        mask.append(make('rect', { width: 1000, height: 600, fill: 'white' }));
        mask.append(make('rect', { x: 120, y: 145, width: 760, height: 310, rx: 65, fill: 'black' }));
        defs.append(mask);
        const field = make('g', { mask: `url(#${maskId})`, fill: 'none', stroke: 'currentColor', 'stroke-width': 1 });
        svg.append(defs, field);
        container.prepend(svg);
        let parts = [];
        let seed = '';
        let destroyed = false;
        const add = (tag, attrs, motion) => {
            const node = make(tag, attrs);
            field.append(node);
            parts.push({ node, ...motion });
            return node;
        };
        const build = track => {
            seed = track;
            parts = [];
            field.replaceChildren();
            const random = seededRandom(`vector:${kind}:${track}`);
            if (kind === 'luminous') {
                for (let i = 0; i < 4; i += 1) {
                    const cx = i % 2 ? 830 : 170;
                    const cy = i < 2 ? 205 : 390;
                    const r = 115 + i * 30;
                    add('ellipse', {
                        cx, cy, rx: r, ry: r * 0.62,
                        'stroke-dasharray': `${80 + i * 28} ${30 + i * 8} 8 22`,
                        'stroke-width': i === 0 ? 1.5 : 0.8
                    }, { type: 'orbit', cx, cy, speed: (i % 2 ? -1 : 1) * (2 + i), phase: random() * 360, alpha: 0.24 });
                }
                for (let i = 0; i < 3; i += 1) {
                    const y = i % 2 ? 510 + i * 9 : 70 + i * 18;
                    add('path', {
                        d: `M -50 ${y} C 180 ${y - 90}, 320 ${y + 110}, 540 ${y} S 840 ${y - 80}, 1050 ${y + 25}`,
                        pathLength: 100, 'stroke-dasharray': '22 78', 'stroke-linecap': 'round', 'stroke-width': 1.5
                    }, { type: 'ribbon', speed: 2 + i, phase: random() * 100, alpha: 0.48 });
                }
                for (let i = 0; i < 18; i += 1) {
                    const x = 35 + random() * 930;
                    const y = i % 2 ? 490 + random() * 70 : 30 + random() * 85;
                    const radius = 2 + random() * 5;
                    add('path', {
                        d: `M ${-radius} 0 Q 0 0 0 ${-radius * 1.7} Q 0 0 ${radius} 0 Q 0 0 0 ${radius * 1.7} Q 0 0 ${-radius} 0`,
                        'stroke-width': 0.8
                    }, { type: 'spark', x, y, speed: 0.35 + random() * 0.45, phase: random() * Math.PI * 2, alpha: 0.7 });
                }
            } else if (kind === 'partita') {
                for (let side = 0; side < 2; side += 1) {
                    const x = side ? 925 : 45;
                    let path = `M ${x} 145`;
                    for (let step = 0; step < 6; step += 1) {
                        path += ` h ${step % 2 ? -30 : 30} v 48`;
                        add('rect', {
                            x: x + (step % 2 ? 0 : 30) - 3,
                            y: 145 + step * 48 - 3, width: 6, height: 6,
                            fill: 'currentColor', stroke: 'none'
                        }, { type: 'tick', phase: step / 6, alpha: 0.7 });
                    }
                    add('path', { d: path, 'stroke-width': 0.8 },
                        { type: 'static', alpha: 0.22 });
                    add('path', { d: path, pathLength: 100, 'stroke-dasharray': '14 86', 'stroke-width': 1.8 },
                        { type: 'ribbon', speed: side ? -4 : 4, phase: 0, alpha: 0.55 });
                }
                for (let i = 0; i < 24; i += 1) {
                    const x = 200 + i * 25;
                    const h = i % 3 === 0 ? 18 : 8;
                    add('path', { d: `M ${x} 104 v ${-h} M ${1000 - x} 498 v ${h}`, 'stroke-width': 2 },
                        { type: 'tick', phase: i / 24, alpha: 0.5 });
                }
                for (let i = 0; i < 3; i += 1) {
                    add('path', {
                        d: `M 200 ${118 + i * 6} H 390 l 24 -18 H 600 l 24 18 H 800`,
                        pathLength: 100, 'stroke-dasharray': '28 72', 'stroke-width': 0.7
                    }, { type: 'ribbon', speed: 1 + i * 0.5, phase: i * 30, alpha: 0.25 });
                }
            } else {
                [[70, 100], [930, 100], [70, 500], [930, 500]].forEach(([x, y], i) => {
                    const sx = x < 500 ? 1 : -1;
                    const sy = y < 300 ? 1 : -1;
                    add('path', {
                        d: `M ${x} ${y + sy * 50} V ${y} H ${x + sx * 110}`,
                        pathLength: 100, 'stroke-dasharray': '100', 'stroke-width': 1.4
                    }, { type: 'bracket', phase: i * 0.1, alpha: 0.65 });
                });
                for (let i = 0; i < 2; i += 1) {
                    const cx = i ? 905 : 95;
                    const cy = i ? 440 : 160;
                    add('rect', { x: cx - 60, y: cy - 60, width: 120, height: 120, 'stroke-dasharray': '35 9' },
                        { type: 'orbit', cx, cy, speed: i ? -3 : 3, phase: 45, alpha: 0.3 });
                    add('circle', { cx, cy, r: 83, 'stroke-dasharray': '2 12' },
                        { type: 'orbit', cx, cy, speed: i ? 2 : -2, phase: 0, alpha: 0.3 });
                }
                for (let i = 0; i < 32; i += 1) {
                    const x = 155 + i * 22;
                    const h = i % 4 === 0 ? 13 : 6;
                    add('path', { d: `M ${x} 87 v ${h} M ${1000 - x} 513 v ${-h}` },
                        { type: 'tick', phase: i / 32, alpha: 0.35 });
                }
                for (let i = 0; i < 8; i += 1) {
                    const x = i % 2 ? 925 : 75;
                    const y = 215 + Math.floor(i / 2) * 55;
                    add('path', { d: 'M -6 0 H 6 M 0 -6 V 6', 'stroke-width': 1.2 },
                        { type: 'spark', x, y, speed: 0.2, phase: random() * 6.28, alpha: 0.45 });
                }
                add('path', { d: 'M 195 112 H 430 l 14 -10 h 110 l 14 10 H 805', pathLength: 100, 'stroke-dasharray': '12 88' },
                    { type: 'ribbon', speed: 1.5, phase: 0, alpha: 0.7 });
            }
        };
        const update = (frame, tuning, intensity) => {
            if (destroyed) return;
            const opacity = clamp(finite(tuning.decorOpacity, 0.55));
            const enabled = tuning.vectorDecor !== false && opacity > 0;
            svg.style.display = enabled ? 'block' : 'none';
            if (!enabled) return;
            const track = frame.track?.path || frame.track?.title || 'idle';
            if (track !== seed) build(track);
            const motion = Math.max(0, finite(tuning.decorMotion, 1) * intensity);
            const time = frame.playbackTime * motion;
            const energy = clamp(frame.audio.vocal * 0.65 + frame.audio.bass * 0.35) * Math.min(1, motion);
            svg.style.opacity = String(opacity);
            const progress = motion > 0 ? frame.lineProgress : 0.5;
            parts.forEach(part => {
                let alpha = part.alpha;
                if (part.type === 'orbit') {
                    const angle = part.phase + time * part.speed;
                    part.node.setAttribute('transform', `rotate(${angle.toFixed(3)} ${part.cx} ${part.cy})`);
                    alpha *= 0.75 + energy * 0.8;
                } else if (part.type === 'ribbon') {
                    part.node.setAttribute('stroke-dashoffset', String(-(time * part.speed + part.phase) % 100));
                    alpha *= 0.7 + energy * 0.8;
                } else if (part.type === 'spark') {
                    const pulse = 0.5 + 0.5 * Math.sin(time * part.speed + part.phase);
                    const dy = Math.sin(time * 0.22 + part.phase) * 8 * Math.min(1, motion);
                    part.node.setAttribute('transform', `translate(${part.x} ${part.y + dy}) scale(${0.7 + pulse * 0.45 + energy * 0.3})`);
                    alpha *= 0.35 + pulse * 0.65;
                } else if (part.type === 'bracket') {
                    part.node.setAttribute('stroke-dashoffset', String(100 * (1 - clamp(progress * 5 - part.phase))));
                } else if (part.type === 'tick') {
                    alpha *= 0.35 + Math.max(0, 1 - Math.abs(progress - part.phase) * 8) * 1.4;
                }
                part.node.setAttribute('opacity', String(clamp(alpha)));
            });
        };
        return {
            update,
            destroy() {
                if (destroyed) return;
                destroyed = true;
                parts = [];
                field.replaceChildren();
                svg.remove();
            }
        };
    };
    global.MusicStageLyricDecor = Object.freeze({ create });
})(window);