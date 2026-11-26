/*
 * 繁星如盛 · Starbloom — cross-line relay glyph choreography for Sonnet / Tempera.
 *
 * Every glyph state is a pure function of (lineIndex, glyphIndex, playbackTime):
 *   depart ── meteor flight ──> arrive ── rest / sung ──> exit ──> gone
 * A glyph is born at the landing slot of a glyph from the previous line (relay),
 * or falls from deep space after a long gap. No per-frame history is kept, so
 * seeking, pausing and replaying reproduce the identical frame, trails included.
 *
 * Display objects live in a line-indexed pool: only the lines visible at the
 * current time own Text / Graphics instances, and a line change creates one
 * line and releases another instead of rebuilding the whole window.
 */
(function (global) {
    'use strict';

    const R = global.MusicStageRuntime;
    const E = global.MusicStagePixiEffects;
    if (!R || !E) throw new Error('MusicStageRuntime and MusicStagePixiEffects must load before stage-starbloom.js');

    const { clamp, seededRandom } = R;
    const { amount, ease, motionScale, compilePhrases } = E;

    const TAU = Math.PI * 2;
    const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
    const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
    const KINDS = ['arc', 'cascade', 'scatter', 'wave', 'column'];

    const LINGER = 3;            // longest vocal gap still bridged by a relay flight (s)
    const FLIGHT = 0.78;         // nominal meteor flight duration (s)
    const MIN_FLIGHT = 0.2;
    const RELAY_FADE = 0.28;     // old glyph collapses into a spark while its successor departs
    const GHOST_FADE = 0.9;      // orphan glyph drifts away as a phantom
    const LAND_FLARE = 0.5;
    const PETAL_SCATTER = 0.7;
    const TRAIL_STEP = 0.028;
    const PETALS = 4;            // one primary bloom + three secondary sparks per meteor

    const cubicOut = v => 1 - Math.pow(1 - clamp(v), 3);
    const backOut = v => { const t = clamp(v) - 1, s = 1.1; return 1 + t * t * ((s + 1) * t + s); };
    const pulse = (dt, duration) => {
        if (dt < 0 || dt > duration) return 0;
        const x = dt / duration;
        return x < 0.14 ? x / 0.14 : Math.pow((1 - x) / 0.86, 1.6);
    };
    const within = (value, low, high) => low > high ? (low + high) / 2 : Math.min(high, Math.max(low, value));
    const lineEnd = line => {
        const end = Number(line.vocalEndTime ?? line.endTime);
        return Number.isFinite(end) ? end : line.startTime;
    };
    const hexNumber = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value || ''))
        ? parseInt(String(value).slice(1), 16) : fallback;
    const lastStartBefore = (lines, time) => {
        let low = 0, high = lines.length - 1, found = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (lines[mid].startTime <= time) { found = mid; low = mid + 1; } else high = mid - 1;
        }
        return found;
    };

    let measureContext = null;
    const measure = (text, size, weight) => {
        if (CJK.test(text)) return size;
        measureContext ||= global.document.createElement('canvas').getContext('2d');
        measureContext.font = `${weight} ${size}px ${FONT}`;
        return Math.max(size * 0.28, measureContext.measureText(text).width);
    };

    // Shared vector contexts: each instance only carries a transform and tint.
    const starContext = (PIXI) => {
        const context = new PIXI.GraphicsContext();
        const rays = (radius, waist, offset) => {
            const points = [];
            for (let i = 0; i < 8; i += 1) {
                const angle = offset + i * Math.PI / 4;
                const r = (i % 2 ? waist : radius) * 10;
                points.push(Math.cos(angle) * r, Math.sin(angle) * r);
            }
            return points;
        };
        context.poly(rays(1, 0.13, -Math.PI / 2)).fill({ color: 0xffffff, alpha: 1 });
        context.poly(rays(0.45, 0.09, -Math.PI / 4)).fill({ color: 0xffffff, alpha: 0.7 });
        context.circle(0, 0, 1.8).fill({ color: 0xffffff, alpha: 1 });
        return context;
    };
    const blossomContext = (PIXI) => {
        const context = new PIXI.GraphicsContext();
        for (let petal = 0; petal < 5; petal += 1) {
            const angle = petal * TAU / 5 - Math.PI / 2;
            const c = Math.cos(angle), s = Math.sin(angle);
            const points = [];
            for (let i = 0; i < 14; i += 1) {
                const phi = i / 14 * TAU;
                const along = 0.15 + 0.85 * (1 - Math.cos(phi)) / 2;
                const across = Math.sin(phi) * 0.32 * (1 - 0.35 * (1 - Math.cos(phi)) / 2);
                points.push((along * c - across * s) * 10, (along * s + across * c) * 10);
            }
            context.poly(points).fill({ color: 0xffffff, alpha: 0.82 });
        }
        context.circle(0, 0, 2.2).fill({ color: 0xffffff, alpha: 0.95 });
        return context;
    };
    const diamondContext = (PIXI) => new PIXI.GraphicsContext()
        .poly([0, -10, 5, 0, 0, 10, -5, 0]).fill({ color: 0xffffff, alpha: 0.85 })
        .poly([0, -4, 2, 0, 0, 4, -2, 0]).fill({ color: 0xffffff, alpha: 1 });
    // Hollow four-leaf clover: polar quatrefoil outline plus a short stem.
    const cloverContext = (PIXI) => {
        const points = [];
        for (let i = 0; i < 72; i += 1) {
            const theta = i / 72 * TAU + Math.PI / 4;
            const r = 10 * (0.18 + 0.82 * Math.pow(Math.abs(Math.cos(2 * theta)), 0.7));
            points.push(Math.cos(theta) * r, Math.sin(theta) * r);
        }
        return new PIXI.GraphicsContext()
            .poly(points).stroke({ color: 0xffffff, width: 1.4, alpha: 0.95 })
            .moveTo(0, 0).quadraticCurveTo(3, 6, 1.5, 12).stroke({ color: 0xffffff, width: 1.1, alpha: 0.75 });
    };
    const hollowStarContext = (PIXI) => {
        const points = [];
        for (let i = 0; i < 10; i += 1) {
            const angle = -Math.PI / 2 + i * Math.PI / 5;
            const r = i % 2 ? 4.2 : 10;
            points.push(Math.cos(angle) * r, Math.sin(angle) * r);
        }
        return new PIXI.GraphicsContext().poly(points).stroke({ color: 0xffffff, width: 1.3, alpha: 0.95 });
    };
    const sparkleContext = (PIXI) => new PIXI.GraphicsContext()
        .poly([0, -10, 1.6, -1.6, 10, 0, 1.6, 1.6, 0, 10, -1.6, 1.6, -10, 0, -1.6, -1.6]).fill({ color: 0xffffff, alpha: 1 })
        .circle(0, 0, 1.4).fill({ color: 0xffffff, alpha: 1 });
    const ringContext = (PIXI) => new PIXI.GraphicsContext()
        .circle(0, 0, 6.5).stroke({ color: 0xffffff, width: 1.3, alpha: 0.9 })
        .circle(0, 0, 1.2).fill({ color: 0xffffff, alpha: 0.8 });

    const create = (PIXI, parent, mode) => {
        const weight = mode === 'tempera' ? '900' : '750';
        const root = new PIXI.Container();
        const trails = new PIXI.Graphics();
        const petalLayer = new PIXI.Container();
        const glyphLayer = new PIXI.Container();
        const starLayer = new PIXI.Container();
        trails.blendMode = 'add';
        starLayer.blendMode = 'add';
        root.addChild(trails, petalLayer, glyphLayer, starLayer);
        parent.addChild(root);

        const star = starContext(PIXI);
        const shapes = {
            blossom: blossomContext(PIXI), diamond: diamondContext(PIXI), clover: cloverContext(PIXI),
            star5: hollowStarContext(PIXI), sparkle: sparkleContext(PIXI), ring: ringContext(PIXI)
        };
        const palette = mode === 'tempera'
            ? { primary: ['diamond', 'clover', 'star5'], secondary: ['sparkle', 'ring', 'diamond'] }
            : { primary: ['blossom', 'clover', 'star5'], secondary: ['sparkle', 'ring', 'clover'] };

        let lines = [];
        let source = null;
        let lineSignature = '';
        let signature = '';
        let seed = '';
        let width = 1;
        let height = 1;
        let tuning = {};
        let color = 0xffffff;
        let flying = 0;
        let glyphNodes = [];
        const layoutCache = new Map();
        const flightCache = new Map();
        const scheduleCache = new Map();
        const pool = new Map();

        const layoutLine = (line, index) => {
            const random = seededRandom(`starbloom:${seed}:${index}:${line.fullText}`);
            const timed = compilePhrases(line, tuning).filter(glyph => glyph.text.trim());
            const cjk = CJK.test(line.fullText || '');
            const side = index % 2 ? 1 : -1;
            const cx = width * 0.5 + side * width * (0.03 + random() * 0.07);
            const cy = height * (0.46 + (random() - 0.5) * 0.14);
            let kind = KINDS[Math.floor(random() * KINDS.length)];
            if (kind === 'column' && (!cjk || timed.length > 9)) kind = 'arc';
            const base = Math.min(width * 0.068, height * 0.1, 66) * amount(tuning.fontScale, 1, 1.5);
            const minimum = Math.min(width, height) * 0.024;
            const advanceAt = size => kind === 'column'
                ? timed.map(() => size * 1.04)
                : timed.map(glyph => measure(glyph.text, size, weight) + size * 0.06);
            const sum = values => values.reduce((total, value) => total + value, 0);
            let size = base;
            let advances = advanceAt(size);
            let total = sum(advances);
            if (kind === 'arc' || kind === 'wave' || kind === 'column') {
                const span = kind === 'column' ? height * 0.72 : width * 0.7;
                if (total > span) {
                    const shrunk = Math.max(minimum, size * span / total);
                    // Too long for one stroke: break into rows rather than shrinking into dust.
                    if (shrunk < base * 0.62) kind = 'cascade';
                    else { size = shrunk; advances = advanceAt(size); total = sum(advances); }
                }
            }

            const placed = [];
            const push = (glyph, x, y, rotation) => placed.push({
                text: glyph.text, startTime: glyph.startTime, endTime: glyph.endTime, x, y, rotation
            });
            if (kind === 'arc' || kind === 'wave' || kind === 'column') {
                const along = [];
                let cursor = -total / 2;
                advances.forEach(advance => { along.push(cursor + advance / 2); cursor += advance; });
                if (kind === 'column') {
                    timed.forEach((glyph, i) => push(glyph, cx, cy + along[i], 0));
                } else if (kind === 'arc') {
                    const radius = Math.max(total * 0.95, width * 0.42);
                    const bend = random() > 0.5 ? 1 : -1;
                    const sag = radius * (1 - Math.cos(total / 2 / radius));
                    timed.forEach((glyph, i) => {
                        const theta = along[i] / radius;
                        push(glyph, cx + Math.sin(theta) * radius,
                            cy + bend * (radius * (1 - Math.cos(theta)) - sag / 2), bend * theta);
                    });
                } else {
                    const phase = random() * TAU;
                    const amplitude = size * (0.22 + random() * 0.16);
                    const k = TAU / (size * 5.5);
                    timed.forEach((glyph, i) => {
                        const a = along[i] * k + phase;
                        push(glyph, cx + along[i], cy + Math.sin(a) * amplitude,
                            Math.atan(Math.cos(a) * amplitude * k) * 0.6);
                    });
                }
            } else {
                const rowLimit = width * 0.7 * (kind === 'cascade' ? 0.6 : 0.5);
                const rows = [[]];
                let rowWidth = 0;
                timed.forEach((glyph, i) => {
                    const row = rows[rows.length - 1];
                    const phraseBreak = row.length && row[row.length - 1].glyph.phrase !== glyph.phrase && rowWidth > size * 2;
                    if (row.length && (rowWidth + advances[i] > rowLimit || phraseBreak)) {
                        rows.push([]);
                        rowWidth = 0;
                    }
                    rows[rows.length - 1].push({ glyph, advance: advances[i], offset: rowWidth });
                    rowWidth += advances[i];
                });
                const rowHeight = size * 1.42;
                const direction = random() > 0.5 ? 1 : -1;
                rows.forEach((row, r) => {
                    const rowSpan = sum(row.map(item => item.advance));
                    const centered = r - (rows.length - 1) / 2;
                    const rx = kind === 'cascade' ? cx + centered * size * 1.6 * direction : cx + (random() - 0.5) * width * 0.22;
                    const ry = cy + centered * rowHeight + (kind === 'scatter' ? (random() - 0.5) * size * 0.5 : 0);
                    const rotation = kind === 'scatter' ? (random() - 0.5) * 0.16 : 0;
                    const c = Math.cos(rotation), s = Math.sin(rotation);
                    row.forEach(item => {
                        const local = item.offset + item.advance / 2 - rowSpan / 2;
                        push(item.glyph, rx + local * c, ry + local * s, rotation);
                    });
                });
            }

            // Fit the constellation into a safe reading area, then keep it on screen.
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            placed.forEach(p => {
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
            });
            let centerX = cx, centerY = cy;
            if (placed.length) {
                const pad = size * 0.6;
                const fit = Math.min(1, width * 0.86 / (maxX - minX + pad * 2), height * 0.72 / (maxY - minY + pad * 2));
                const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
                const halfW = ((maxX - minX) * fit) / 2 + pad * fit;
                const halfH = ((maxY - minY) * fit) / 2 + pad * fit;
                centerX = within(mx, width * 0.07 + halfW, width * 0.93 - halfW);
                centerY = within(my, height * 0.14 + halfH, height * 0.86 - halfH);
                placed.forEach(p => {
                    p.x = centerX + (p.x - mx) * fit;
                    p.y = centerY + (p.y - my) * fit;
                });
                size *= fit;
            }
            return { kind, size, cx: centerX, cy: centerY, start: line.startTime, end: lineEnd(line), glyphs: placed };
        };

        const layoutAt = index => {
            if (!layoutCache.has(index)) layoutCache.set(index, layoutLine(lines[index], index));
            return layoutCache.get(index);
        };

        // Flight plan of one line: depends only on this line and the previous one.
        const flightsAt = index => {
            if (flightCache.has(index)) return flightCache.get(index);
            const current = layoutAt(index);
            const previous = index > 0 ? layoutAt(index - 1) : null;
            const count = current.glyphs.length;
            const relay = Boolean(previous && previous.glyphs.length && current.start - previous.end <= LINGER);
            const spread = Math.min(0.6, Math.max(0, current.end - current.start) * 0.3);
            const stagger = count > 1 ? spread / (count - 1) : 0;
            const glyphs = current.glyphs.map((glyph, k) => {
                const random = seededRandom(`starbloom-flight:${seed}:${index}:${k}`);
                // A glyph never lands after its own vocal onset.
                const arrive = Math.min(glyph.startTime - 0.02, current.start + k * stagger);
                let depart = arrive - FLIGHT * (0.8 + random() * 0.4);
                let sourceIndex = -1, sx, sy;
                if (relay) {
                    sourceIndex = Math.min(previous.glyphs.length - 1, Math.floor(k * previous.glyphs.length / count));
                    const from = previous.glyphs[sourceIndex];
                    sx = from.x;
                    sy = from.y;
                    // Do not steal a glyph that is still being sung unless the lines overlap.
                    depart = Math.max(depart, Math.min(from.endTime + 0.03, arrive - MIN_FLIGHT));
                } else {
                    const angle = -Math.PI / 2 + (random() - 0.5) * Math.PI * 1.3;
                    const reach = Math.hypot(width, height) * (0.5 + random() * 0.15);
                    sx = glyph.x + Math.cos(angle) * reach;
                    sy = glyph.y + Math.sin(angle) * reach;
                }
                const dx = glyph.x - sx, dy = glyph.y - sy;
                const distance = Math.hypot(dx, dy) || 1;
                const curl = (random() < 0.5 ? -1 : 1) * (0.22 + random() * 0.38) * distance;
                return {
                    sourceIndex, sx, sy, depart, arrive,
                    qx: (sx + glyph.x) / 2 - dy / distance * curl,
                    qy: (sy + glyph.y) / 2 + dx / distance * curl - distance * 0.08,
                    spin: (random() - 0.5) * Math.PI * 1.4,
                    flareAngle: random() * Math.PI,
                    twinkle: random() * TAU,
                    petals: Array.from({ length: PETALS }, (_, i) => {
                        const primary = i === 0;
                        const pool = primary ? palette.primary : palette.secondary;
                        return {
                            primary,
                            shape: pool[Math.floor(random() * pool.length)],
                            lag: primary ? 0.05 + random() * 0.03 : 0.1 + i * 0.045 + random() * 0.05,
                            phase: random() * TAU,
                            direction: random() < 0.5 ? -1 : 1,
                            orbit: primary ? 0.32 + random() * 0.12 : 0.55 + i * 0.2 + random() * 0.2,
                            spinRate: primary ? 1.2 + random() * 1.2 : 3 + random() * 3.5,
                            size: primary ? 1.25 : 0.4 + random() * 0.25,
                            alpha: primary ? 0.88 : 0.5 + random() * 0.22,
                            flicker: primary ? 0 : 7 + random() * 9
                        };
                    })
                };
            });
            const value = { relay, glyphs };
            flightCache.set(index, value);
            return value;
        };

        // Full schedule: exits are the departures of the successors in the next line.
        const scheduleAt = index => {
            if (scheduleCache.has(index)) return scheduleCache.get(index);
            const current = layoutAt(index);
            const own = flightsAt(index);
            const next = index + 1 < lines.length ? flightsAt(index + 1) : null;
            const firstDepart = next && next.glyphs.length
                ? next.glyphs.reduce((low, glyph) => Math.min(low, glyph.depart), Infinity) : Infinity;
            const glyphs = current.glyphs.map((glyph, j) => {
                const flight = own.glyphs[j];
                let exit;
                let relayExit = false;
                if (next?.relay) {
                    let earliest = Infinity;
                    next.glyphs.forEach(successor => {
                        if (successor.sourceIndex === j) earliest = Math.min(earliest, successor.depart);
                    });
                    if (Number.isFinite(earliest)) { exit = earliest; relayExit = true; }
                    else exit = Math.max(glyph.endTime + 0.1, firstDepart);
                } else {
                    exit = next ? Math.max(glyph.endTime, current.end) + 1.2 : current.end + 2.5;
                }
                exit = Math.max(exit, flight.arrive + 0.12);
                return { ...glyph, ...flight, exit, relayExit, gone: exit + (relayExit ? RELAY_FADE : GHOST_FADE) };
            });
            const value = {
                index, size: current.size, glyphs,
                visibleFrom: glyphs.reduce((low, glyph) => Math.min(low, glyph.depart), Infinity),
                visibleTo: glyphs.reduce((high, glyph) => Math.max(high, glyph.gone), -Infinity)
            };
            scheduleCache.set(index, value);
            return value;
        };

        const flightPoint = (glyph, time, out) => {
            const u = clamp((time - glyph.depart) / Math.max(0.001, glyph.arrive - glyph.depart));
            const e = backOut(u);
            const a = 1 - e;
            out.x = a * a * glyph.sx + 2 * a * e * glyph.qx + e * e * glyph.x;
            out.y = a * a * glyph.sy + 2 * a * e * glyph.qy + e * e * glyph.y;
            out.u = u;
            return out;
        };

        const makeEntry = schedule => {
            const background = tuning.palette?.background || '#171a1d';
            const nodes = schedule.glyphs.map(glyph => {
                const text = new PIXI.Text({
                    text: glyph.text,
                    style: {
                        fontFamily: FONT, fontSize: schedule.size, fontWeight: weight, fill: '#ffffff',
                        stroke: { color: background, width: Math.max(1, schedule.size * 0.024) }
                    }
                });
                text.anchor.set(0.5);
                text.visible = false;
                glyphLayer.addChild(text);
                const flare = new PIXI.Graphics(star);
                flare.visible = false;
                starLayer.addChild(flare);
                const petals = glyph.petals.map(spec => {
                    const instance = new PIXI.Graphics(shapes[spec.shape]);
                    instance.visible = false;
                    petalLayer.addChild(instance);
                    return instance;
                });
                return { text, flare, petals };
            });
            return { schedule, nodes };
        };

        const releaseEntry = entry => entry.nodes.forEach(node => {
            node.text.destroy();
            node.flare.destroy();
            node.petals.forEach(instance => instance.destroy());
        });

        const releaseAll = () => {
            pool.forEach(releaseEntry);
            pool.clear();
            glyphNodes = [];
        };

        const reset = () => {
            releaseAll();
            layoutCache.clear();
            flightCache.clear();
            scheduleCache.clear();
        };

        const syncPool = time => {
            const base = lastStartBefore(lines, time + 2);
            const wanted = new Set();
            for (let index = Math.max(0, base - 4); index <= Math.min(lines.length - 1, base + 1); index += 1) {
                const schedule = scheduleAt(index);
                if (time >= schedule.visibleFrom - 0.05 && time <= schedule.visibleTo) wanted.add(index);
            }
            let changed = false;
            pool.forEach((entry, index) => {
                if (wanted.has(index)) return;
                releaseEntry(entry);
                pool.delete(index);
                changed = true;
            });
            wanted.forEach(index => {
                if (pool.has(index)) return;
                pool.set(index, makeEntry(scheduleAt(index)));
                changed = true;
            });
            if (changed) glyphNodes = [...pool.values()].flatMap(entry => entry.nodes.map(node => node.text));
        };

        const head = { x: 0, y: 0, u: 0 };
        const tail = { x: 0, y: 0, u: 0 };
        const lagged = { x: 0, y: 0, u: 0 };

        const drawTrail = (glyph, time, size, samples) => {
            if (!samples) return;
            flightPoint(glyph, Math.min(time, glyph.arrive), head);
            const fadeIn = Math.min(1, (time - glyph.depart) * 5);
            let px = head.x, py = head.y;
            for (let n = 1; n <= samples; n += 1) {
                const sampleTime = Math.max(glyph.depart, Math.min(glyph.arrive, time - n * TRAIL_STEP));
                flightPoint(glyph, sampleTime, tail);
                if (Math.abs(tail.x - px) + Math.abs(tail.y - py) < 0.5) { px = tail.x; py = tail.y; continue; }
                const fade = 1 - (n - 1) / samples;
                trails.moveTo(px, py).lineTo(tail.x, tail.y)
                    .stroke({ color, width: Math.max(0.6, size * 0.12 * fade), alpha: 0.6 * fade * fadeIn, cap: 'round' });
                if (n <= 3) {
                    trails.moveTo(px, py).lineTo(tail.x, tail.y)
                        .stroke({ color: 0xffffff, width: Math.max(0.5, size * 0.035 * fade), alpha: 0.75 * fade * fadeIn, cap: 'round' });
                }
                px = tail.x;
                py = tail.y;
            }
        };

        const hide = node => {
            node.text.visible = false;
            node.flare.visible = false;
            node.petals.forEach(instance => { instance.visible = false; });
        };

        const renderGlyph = (glyph, node, size, time, view) => {
            if (time < glyph.depart || time >= glyph.gone) return hide(node);
            const text = node.text;
            let x = glyph.x, y = glyph.y, scale = 1, alpha = 1, rotation = glyph.rotation, tint = view.ink;

            if (!view.flourish) {
                // Reduced motion: static constellation, no flight, trail, petal or flare.
                node.flare.visible = false;
                node.petals.forEach(instance => { instance.visible = false; });
                if (time < glyph.arrive || time >= glyph.exit) { text.visible = false; return; }
                text.visible = true;
                text.position.set(x, y);
                text.rotation = rotation;
                text.scale.set(1);
                text.alpha = time < glyph.startTime ? view.waiting : 1;
                text.tint = view.ink;
                return;
            }

            // One opacity curve for the whole life: waiting → lit while sung → settled.
            // The meteor fades from solid toward this curve, so landing never jumps.
            const lit = ease((time - glyph.startTime + 0.05) / 0.1);
            const settled = ease((time - glyph.endTime) / 0.3);
            const shimmer = 0.94 + Math.sin(time * 2.3 + glyph.twinkle) * 0.06;
            const rest = (view.waiting + (1 - view.waiting) * lit - 0.06 * settled) * shimmer;
            let flightU = 1;
            if (time < glyph.arrive) {
                flightPoint(glyph, time, head);
                flightU = head.u;
                x = head.x;
                y = head.y;
                const grow = cubicOut(flightU);
                scale = 0.32 + 0.68 * grow;
                alpha = Math.min(1, flightU * 5) * (1 + (rest - 1) * ease(flightU));
                rotation = glyph.rotation + glyph.spin * (1 - grow);
                flying += 1;
                drawTrail(glyph, time, size, view.trailSamples);
            } else if (time < glyph.exit) {
                x += Math.sin(time * 0.9 + glyph.twinkle) * size * 0.018;
                y += Math.cos(time * 0.7 + glyph.twinkle) * size * 0.018;
                if (time < glyph.arrive + 0.15) drawTrail(glyph, time, size, view.trailSamples);
                const sung = (time - glyph.startTime) / Math.max(0.05, glyph.endTime - glyph.startTime);
                if (sung >= 0 && sung <= 1) {
                    scale = 1 + Math.sin(sung * Math.PI) * 0.1;
                    if (view.invert) tint = color;
                }
                alpha = rest;
            } else {
                const e = (time - glyph.exit) / (glyph.relayExit ? RELAY_FADE : GHOST_FADE);
                const c = cubicOut(e);
                if (glyph.relayExit) {
                    scale = 1 - 0.8 * c;
                    alpha = (1 - e) * 0.94;
                } else {
                    x += Math.cos(glyph.twinkle) * size * 0.5 * c;
                    y -= size * 0.8 * c;
                    scale = 1 - 0.15 * c;
                    alpha = (1 - e) * (1 - e) * 0.8;
                    rotation += Math.sin(glyph.twinkle) * 0.3 * c;
                }
            }
            text.visible = alpha > 0.004;
            text.position.set(x, y);
            text.rotation = rotation;
            text.scale.set(scale);
            text.alpha = alpha;
            text.tint = tint;

            // Star flare: landing, vocal onset and relay hand-off.
            const landing = pulse(time - glyph.arrive, LAND_FLARE);
            const onset = glyph.startTime - glyph.arrive > 0.15 ? pulse(time - glyph.startTime, 0.34) * 0.5 : 0;
            const handoff = glyph.relayExit ? pulse(time - glyph.exit, 0.32) * 0.7 : 0;
            const flare = Math.max(landing, onset, handoff);
            node.flare.visible = flare > 0.01;
            if (node.flare.visible) {
                node.flare.position.set(glyph.x, glyph.y);
                node.flare.scale.set(size * (0.4 + 0.8 * flare + view.impact * 0.2) / 10);
                node.flare.rotation = glyph.flareAngle + (time - glyph.arrive) * 0.8;
                node.flare.alpha = flare * 0.95;
                node.flare.tint = color;
            }

            // Petals chase the meteor on lagged copies of the same path, then scatter on landing.
            node.petals.forEach((instance, i) => {
                const p = glyph.petals[i];
                if (!view.petals) { instance.visible = false; return; }
                if (time < glyph.arrive) {
                    flightPoint(glyph, time - p.lag, lagged);
                    const age = time - glyph.depart;
                    const angle = p.phase + age * p.spinRate * p.direction;
                    const radius = size * p.orbit * (1 - 0.35 * flightU);
                    instance.visible = true;
                    instance.position.set(lagged.x + Math.cos(angle) * radius, lagged.y + Math.sin(angle) * radius);
                    const flicker = p.flicker ? 0.62 + 0.38 * Math.sin(time * p.flicker + p.phase) : 1;
                    instance.alpha = Math.min(1, age * 6) * p.alpha * flicker;
                    instance.scale.set(size * 0.02 * p.size * (p.primary ? 1 + 0.15 * Math.sin(age * 5) : 1));
                    instance.rotation = angle * (p.primary ? 0.5 : 1.4);
                } else if (time < glyph.arrive + PETAL_SCATTER * (p.primary ? 1.3 : 1)) {
                    const d = (time - glyph.arrive) / (PETAL_SCATTER * (p.primary ? 1.3 : 1));
                    const c = cubicOut(d);
                    instance.visible = true;
                    if (p.primary) {
                        // The primary bloom opens beside the landed glyph instead of flying away.
                        const radius = size * p.orbit * (1 - 0.6 * c);
                        instance.position.set(glyph.x + Math.cos(p.phase) * radius, glyph.y + Math.sin(p.phase) * radius);
                        instance.alpha = (1 - d) * (1 - d) * p.alpha;
                        instance.scale.set(size * 0.02 * p.size * (1 + 0.9 * c));
                        instance.rotation = p.phase + c * 0.8 * p.direction;
                    } else {
                        const angle = p.phase + i * TAU / PETALS;
                        const radius = size * (p.orbit * 0.65 + 1.7 * c);
                        instance.position.set(glyph.x + Math.cos(angle) * radius, glyph.y + Math.sin(angle) * radius - size * 0.3 * c);
                        instance.alpha = (1 - d) * p.alpha;
                        instance.scale.set(size * 0.02 * p.size * (1 - 0.4 * c));
                        instance.rotation = angle + d * 4 * p.direction;
                    }
                } else {
                    instance.visible = false;
                    return;
                }
                instance.tint = color;
            });
        };

        return {
            update(frame, nextTuning, nextColor, nextSeed, nextWidth, nextHeight) {
                tuning = nextTuning || {};
                width = nextWidth;
                height = nextHeight;
                color = nextColor;
                const frameLines = Array.isArray(frame.lines) ? frame.lines : [];
                if (frameLines !== source) {
                    source = frameLines;
                    const nextLineSignature = `${frameLines.length}:${frameLines.map(line => `${line.startTime}|${line.fullText}`).join('\n')}`;
                    if (nextLineSignature !== lineSignature) {
                        lineSignature = nextLineSignature;
                        lines = frameLines;
                        reset();
                    }
                }
                const nextSignature = [nextSeed, width, height, tuning.fontScale, tuning.phraseLength,
                    tuning.palette?.background, tuning.palette?.ink].join(':');
                if (nextSignature !== signature) {
                    signature = nextSignature;
                    seed = String(nextSeed);
                    reset();
                }

                const time = frame.playbackTime || 0;
                const center = { x: width / 2, y: height / 2, scale: 1, rotation: 0, glyphs: glyphNodes };
                trails.clear();
                flying = 0;
                if (!lines.length) { root.visible = false; return center; }
                root.visible = true;

                syncPool(time);
                const motion = motionScale(tuning);
                const flourish = motion > 0;
                const saving = tuning.quality === 'energy-saving';
                const view = {
                    flourish,
                    trailSamples: !flourish ? 0 : saving ? 4 : 9,
                    petals: flourish && !saving && tuning.showDecor !== false && tuning.accentEffects !== false,
                    waiting: 0.42 + amount(tuning.waitingOpacity, 0.25, 1) * 0.5,
                    invert: tuning.textInversion !== false,
                    impact: clamp(tuning.performance?.impact || 0),
                    ink: hexNumber(tuning.palette?.ink, 0xf2f0e9)
                };
                pool.forEach(entry => {
                    const { schedule, nodes } = entry;
                    schedule.glyphs.forEach((glyph, k) => renderGlyph(glyph, nodes[k], schedule.size, time, view));
                });

                // Gentle camera drift toward the constellation being sung.
                const current = lastStartBefore(lines, time);
                const now = layoutAt(Math.max(0, current));
                const before = current > 0 ? layoutAt(current - 1) : now;
                const blend = current >= 0 ? ease((time - lines[current].startTime + 0.5) / 1.4) : 1;
                const focusX = before.cx + (now.cx - before.cx) * blend;
                const focusY = before.cy + (now.cy - before.cy) * blend;
                const tracking = amount(tuning.cameraTracking, 0.35, 1) * motion;
                const breath = Math.sin(time * 0.43) * 0.012 * amount(tuning.cameraBreath, 0.5) * motion;
                return {
                    x: width / 2 + (focusX - width / 2) * tracking * 0.35,
                    y: height / 2 + (focusY - height / 2) * tracking * 0.35,
                    scale: 1 + breath + view.impact * 0.006 * motion,
                    rotation: 0,
                    glyphs: glyphNodes
                };
            },
            destroy() {
                reset();
                root.removeFromParent();
                root.destroy({ children: true });
                star.destroy();
                Object.values(shapes).forEach(shape => shape.destroy());
                lines = [];
                source = null;
            },
            snapshot() {
                return {
                    bloomLines: pool.size,
                    bloomGlyphs: glyphNodes.length,
                    bloomFlying: flying,
                    bloomLayouts: layoutCache.size
                };
            }
        };
    };

    global.MusicStageStarbloom = Object.freeze({ create });
})(window);