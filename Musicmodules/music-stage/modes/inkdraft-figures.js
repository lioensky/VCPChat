/*
 * 墨痕（inkdraft）的线稿：像演算纸、论文插图上的那种细线图——轨道、星图、晶格、
 * 分子、探测器截面、粒子图、演算草稿、能谱、势能曲线、气泡室、企鹅图、箱图……
 *
 * 每张图在半径 1 的坐标里用 Pen 画。Pen 每调用一次算「一笔」，笔序写进编号画布的
 * G 通道，着色器按笔序一笔一笔把它显出来。同一套图也可以用粗线画进 B 通道，当作垫在
 * 字后面的半调大图（tone 模式，不记笔序，随整段一起出现）。
 *
 * 纯 2D 画布绘制，只在准备一段（一句歌词或一段间奏）时跑一次，不进每帧循环。
 */
(function (global) {
    'use strict';

    const TAU = Math.PI * 2;
    // 注记：演算纸上的衬线斜体（数学字体优先），和歌词的黑体分开
    const NOTE_FONT = '"Cambria Math", "STIX Two Math", Cambria, Georgia, "Times New Roman", "Noto Serif", "Source Han Serif SC", "Songti SC", serif';

    /*
     * 一支笔：main 是主画布（R 字、G 线稿、B 半调），ids 是编号画布（缩小 idScale 倍，
     * R 字的编号、G 笔序）。transform 把半径 1 的坐标放到世界像素：中心 x,y、半径 r、旋转 rot。
     */
    // 软边的草稿：和主画布一样大、透明的两张，整个模块共用（准备一段是同步的，同一时刻只有一处在用）。
    // 笔画先按 1/gain 的浓度不带模糊画进第一张（几笔交叠也不会顶到 255），整块模糊一次进第二张，
    // 再叠 gain 遍回主画布：和原来每笔各自模糊、相加到 255 封顶是同一个结果（只差取整），
    // 但不用每一笔开一层滤镜——一句的字和线稿原来要模糊上百次，换句时卡在这里
    let soft = null;
    const softLayer = (main) => {
        const { width, height } = main.canvas;
        if (!soft) {
            const make = () => (main.canvas.ownerDocument ? main.canvas.ownerDocument.createElement('canvas') : new OffscreenCanvas(width, height));
            soft = { canvas: make(), blurred: make(), ctx: null, bctx: null };
        }
        if (soft.canvas.width !== width || soft.canvas.height !== height || !soft.ctx) {
            soft.canvas.width = width; soft.canvas.height = height;
            soft.blurred.width = width; soft.blurred.height = height;
            soft.ctx = soft.canvas.getContext('2d');
            soft.bctx = soft.blurred.getContext('2d');
        }
        return soft;
    };
    // 把草稿上 box 那一块（已含模糊外沿）模糊后按 gain 倍加回主画布，再清掉草稿
    const flushSoft = (main, layer, box, blur, gain) => {
        const cw = main.canvas.width, ch = main.canvas.height;
        const x = Math.max(0, Math.floor(box[0])), y = Math.max(0, Math.floor(box[1]));
        const w = Math.min(cw, Math.ceil(box[2])) - x, h = Math.min(ch, Math.ceil(box[3])) - y;
        if (w <= 0 || h <= 0) return;
        const b = layer.bctx;
        b.save();
        b.clearRect(x, y, w, h);
        b.filter = blur;
        b.drawImage(layer.canvas, x, y, w, h, x, y, w, h);
        b.restore();
        main.save();
        main.globalCompositeOperation = 'lighter';
        main.filter = 'none';
        for (let i = 0; i < gain; i += 1) main.drawImage(layer.blurred, x, y, w, h, x, y, w, h);
        main.restore();
        layer.ctx.clearRect(x, y, w, h);
    };

    const createPen = (main, ids, idScale, options = {}) => {
        const tone = Boolean(options.tone);
        let order = options.startOrder || 1;
        let x0 = 0, y0 = 0, radius = 1, cos = 1, sin = 0;
        let width = options.lineWidth || 2;
        const toneLevel = options.toneLevel ?? 0.32;
        // 线的边是一道缓坡（不是一刀切）：着色器切阈值时被噪点搅过，切出来的边才是毛的
        const soft = options.soft || 0;
        // 编号图上的笔比线宽出一圈：线两边那圈网点也按这一笔的笔序出现
        const fringe = options.fringe || 0;

        const map = (x, y) => [x0 + (x * cos - y * sin) * radius, y0 + (x * sin + y * cos) * radius];
        // 软边的笔先画进草稿，整支笔画完（flush）整块模糊一次叠回主画布（见 softLayer）
        const layer = soft > 0 ? softLayer(main) : null;
        const ink = layer ? layer.ctx : main;
        const gain = tone ? 2 : 4;
        let box = null;
        let widest = 0;
        const grow = (px, py, pad = 0) => {
            if (!layer) return;
            if (!box) box = [px - pad, py - pad, px + pad, py + pad];
            else { box[0] = Math.min(box[0], px - pad); box[1] = Math.min(box[1], py - pad); box[2] = Math.max(box[2], px + pad); box[3] = Math.max(box[3], py + pad); }
        };
        const flush = () => {
            if (!layer || !box) return;
            const pad = widest / 2 + soft * 3 + 4;
            const b = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
            box = null;
            flushSoft(main, layer, b, `blur(${soft.toFixed(2)}px)`, gain);
        };

        const begin = () => {
            ink.save();
            ink.globalCompositeOperation = 'lighter';
            ink.lineCap = 'round';
            ink.lineJoin = 'round';
            if (tone) {
                const level = Math.round(255 * toneLevel / (layer ? gain : 1));
                ink.strokeStyle = `rgb(0,0,${level})`;
                ink.fillStyle = `rgb(0,0,${level})`;
            } else {
                const level = layer ? Math.ceil(255 / gain) : 255;
                ink.strokeStyle = `rgb(0,${level},0)`;
                ink.fillStyle = `rgb(0,${level},0)`;
            }
            ink.lineWidth = width;
            widest = Math.max(widest, width);
            if (ids && !tone) {
                ids.save();
                ids.globalCompositeOperation = 'lighten';
                const value = Math.min(255, order);
                ids.strokeStyle = `rgb(0,${value},0)`;
                ids.fillStyle = `rgb(0,${value},0)`;
                ids.lineCap = 'round';
                ids.lineJoin = 'round';
                ids.lineWidth = Math.max(2, (width + fringe * 2) * idScale + 2);
            }
        };
        const end = (fill = false) => {
            if (fill) ink.fill(); else ink.stroke();
            ink.restore();
            if (ids && !tone) {
                if (fill) ids.fill(); else ids.stroke();
                ids.restore();
            }
            if (!tone) order = Math.min(255, order + 1);
        };
        // Both canvases trace the same path; the ids canvas at its own scale.
        const path = (points, closed = false) => {
            if (points.length < 2) return;
            ink.beginPath();
            points.forEach(([x, y], index) => {
                const [px, py] = map(x, y);
                grow(px, py);
                if (index) ink.lineTo(px, py); else ink.moveTo(px, py);
            });
            if (closed) ink.closePath();
            if (ids && !tone) {
                ids.beginPath();
                points.forEach(([x, y], index) => {
                    const [px, py] = map(x, y);
                    if (index) ids.lineTo(px * idScale, py * idScale); else ids.moveTo(px * idScale, py * idScale);
                });
                if (closed) ids.closePath();
            }
        };
        const segments = (pairs) => {
            ink.beginPath();
            if (ids && !tone) ids.beginPath();
            pairs.forEach(([a, b]) => {
                const [ax, ay] = map(a[0], a[1]);
                const [bx, by] = map(b[0], b[1]);
                grow(ax, ay); grow(bx, by);
                ink.moveTo(ax, ay); ink.lineTo(bx, by);
                if (ids && !tone) { ids.moveTo(ax * idScale, ay * idScale); ids.lineTo(bx * idScale, by * idScale); }
            });
        };

        const pen = {
            get order() { return order; },
            // 软边的笔：画完这支笔调一次，把草稿上的笔画整块模糊叠回主画布
            flush,
            // 换笔宽（小图用细一点的笔，不然细节多的图在特写里糊成一团）
            setWidth(w) { width = w; },
            place(x, y, r, rot = 0) { x0 = x; y0 = y; radius = r; cos = Math.cos(rot); sin = Math.sin(rot); },
            line(points, closed = false) { begin(); path(points, closed); end(); },
            segments(pairs) { if (!pairs.length) return; begin(); segments(pairs); end(); },
            dashed(a, b, dash = 0.05) {
                const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
                const count = Math.max(1, Math.floor(length / (dash * 2)));
                const pairs = [];
                for (let i = 0; i < count; i += 1) {
                    const t0 = i / count, t1 = (i + 0.5) / count;
                    pairs.push([[a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]]);
                }
                pen.segments(pairs);
            },
            ellipse(cx, cy, rx, ry, rot = 0, from = 0, to = TAU, steps = 64) {
                const points = [];
                const c = Math.cos(rot), s = Math.sin(rot);
                for (let i = 0; i <= steps; i += 1) {
                    const a = from + (to - from) * i / steps;
                    const ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
                    points.push([cx + ex * c - ey * s, cy + ex * s + ey * c]);
                }
                pen.line(points, false);
            },
            circle(cx, cy, r, from = 0, to = TAU) { pen.ellipse(cx, cy, r, r, 0, from, to, Math.max(16, Math.round(48 * (to - from) / TAU))); },
            wave(a, b, waves = 5, amp = 0.04) {
                const dx = b[0] - a[0], dy = b[1] - a[1];
                const length = Math.hypot(dx, dy) || 1;
                const nx = -dy / length, ny = dx / length;
                const steps = waves * 12;
                const points = [];
                for (let i = 0; i <= steps; i += 1) {
                    const t = i / steps;
                    const o = Math.sin(t * waves * TAU) * amp;
                    points.push([a[0] + dx * t + nx * o, a[1] + dy * t + ny * o]);
                }
                pen.line(points);
            },
            arrow(a, b, head = 0.06) {
                const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
                pen.segments([[a, b],
                    [b, [b[0] - Math.cos(angle - 0.45) * head, b[1] - Math.sin(angle - 0.45) * head]],
                    [b, [b[0] - Math.cos(angle + 0.45) * head, b[1] - Math.sin(angle + 0.45) * head]]]);
            },
            dot(cx, cy, r = 0.025) {
                begin();
                const [px, py] = map(cx, cy);
                const pr = Math.max(1, r * radius);
                grow(px, py, pr);
                ink.beginPath(); ink.arc(px, py, pr, 0, TAU);
                if (ids && !tone) { ids.beginPath(); ids.arc(px * idScale, py * idScale, (pr + fringe) * idScale + 1, 0, TAU); }
                end(true);
            },
            note(text, x, y, size = 0.09, align = 'center') {
                if (tone) return;
                const [px, py] = map(x, y);
                const px2 = Math.max(9, size * radius);
                // 交给逐字层：注记的字和歌词一样按屏幕像素画（推近也不糊），这里只记下位置和笔序
                if (options.notes) {
                    options.notes.push({ text: String(text), x: px, y: py, size: px2, align, order, rot: Math.atan2(sin, cos) });
                    order = Math.min(255, order + 1);
                    return;
                }
                main.save();
                main.globalCompositeOperation = 'lighter';
                main.fillStyle = 'rgb(0,255,0)';
                main.font = `italic 400 ${px2.toFixed(1)}px ${NOTE_FONT}`;
                main.textAlign = align;
                main.textBaseline = 'middle';
                main.fillText(text, px, py);
                const width = main.measureText(text).width;
                main.restore();
                if (ids) {
                    ids.save();
                    ids.globalCompositeOperation = 'lighten';
                    ids.fillStyle = `rgb(0,${Math.min(255, order)},0)`;
                    const left = align === 'center' ? px - width / 2 : align === 'right' ? px - width : px;
                    ids.fillRect((left - 2) * idScale, (py - px2 * 0.7) * idScale, (width + 4) * idScale + 1, px2 * 1.4 * idScale + 1);
                    ids.restore();
                }
                order = Math.min(255, order + 1);
            }
        };
        return pen;
    };

    const pick = (random, list) => list[Math.floor(random() * list.length) % list.length];

    const EQUATIONS = [
        'E = mc²', '∇·E = ρ/ε₀', 'ψ(x, t)', '∂ₜρ + ∇·j = 0', 'H|ψ⟩ = E|ψ⟩', 'Γ = 2π|M|²ρ',
        'Δx Δp ≥ ħ/2', 'S = ∫ L dt', 'σ ∝ 1/s', 'ℒ = −¼ F²', 'Rμν − ½Rgμν', 'λ = h/p',
        'dN/dE', 'e^{iπ} + 1 = 0', '∮ B·dl = μ₀I', 'k_B T ln 2', 'v = H₀ d', 'ω² = k/m'
    ];

    const DRAW = {
        orbit(pen, random) {
            pen.dot(0, 0, 0.07);
            const rings = 3 + Math.floor(random() * 2);
            for (let i = 0; i < rings; i += 1) {
                const rx = 0.3 + i * 0.22;
                const ry = rx * (0.45 + random() * 0.4);
                const rot = random() * 0.6 - 0.3;
                pen.ellipse(0, 0, rx, ry, rot);
                const a = random() * TAU;
                pen.dot(Math.cos(a) * rx * Math.cos(rot) - Math.sin(a) * ry * Math.sin(rot),
                    Math.cos(a) * rx * Math.sin(rot) + Math.sin(a) * ry * Math.cos(rot), 0.03);
            }
            pen.note(`a = ${(0.4 + random() * 4).toFixed(2)} AU`, 0.55, -0.82, 0.09, 'left');
        },
        starmap(pen, random) {
            pen.circle(0, 0, 0.95, -0.2, Math.PI + 0.2);
            pen.circle(0, 0, 0.6, -0.1, Math.PI + 0.1);
            const stars = Array.from({ length: 9 }, () => [random() * 1.6 - 0.8, random() * 1.2 - 0.7]);
            stars.forEach(([x, y]) => pen.dot(x, y, 0.015 + random() * 0.03));
            const chain = stars.slice(0, 5 + Math.floor(random() * 3)).sort((a, b) => a[0] - b[0]);
            pen.line(chain);
            pen.note(pick(random, ['α Ori', 'β Lyr', 'γ Cyg', 'δ Cep', 'M42', 'NGC 1977']), chain[0][0], chain[0][1] - 0.12, 0.09);
            pen.note('RA 05ʰ35ᵐ', -0.9, 0.86, 0.075, 'left');
        },
        lattice(pen, random) {
            const ax = [0.36, 0.06 * (random() - 0.5)], ay = [0.14 * (random() - 0.5), 0.32];
            const n = 2;
            const at = (i, j) => [i * ax[0] + j * ay[0], i * ax[1] + j * ay[1]];
            for (let j = -n; j <= n; j += 1) pen.line([at(-n, j), at(n, j)]);
            for (let i = -n; i <= n; i += 1) pen.line([at(i, -n), at(i, n)]);
            for (let i = -n; i <= n; i += 1) for (let j = -n; j <= n; j += 1) if ((i + j) % 2 === 0) pen.dot(...at(i, j), 0.035);
            pen.arrow(at(0, 0), at(1, 0)); pen.note('a₁', at(1, 0)[0], at(1, 0)[1] + 0.1, 0.08);
            pen.arrow(at(0, 0), at(0, 1)); pen.note('a₂', at(0, 1)[0] - 0.1, at(0, 1)[1], 0.08);
        },
        cell(pen, random) {
            const s = 0.5, dx = 0.28, dy = -0.22;
            const f = [[-s, -s], [s, -s], [s, s], [-s, s]];
            const b = f.map(([x, y]) => [x + dx, y + dy]);
            pen.line(f, true);
            pen.line(b, true);
            pen.segments(f.map((p, i) => [p, b[i]]));
            [...f, ...b].forEach(([x, y]) => pen.dot(x, y, 0.04));
            pen.dot(dx / 2, dy / 2, 0.06);
            if (random() < 0.6) pen.dashed([-s, s], [s + dx, -s + dy], 0.04);
            pen.note('a', 0, s + 0.12, 0.09); pen.note('c', -s - 0.12, 0, 0.09);
        },
        molecule(pen, random) {
            const ring = Array.from({ length: 6 }, (_, i) => [Math.cos(i / 6 * TAU + Math.PI / 6) * 0.42, Math.sin(i / 6 * TAU + Math.PI / 6) * 0.42]);
            pen.line(ring, true);
            for (let i = 0; i < 6; i += 2) {
                const a = ring[i], c = ring[(i + 1) % 6];
                pen.line([[a[0] * 0.78, a[1] * 0.78], [c[0] * 0.78, c[1] * 0.78]]);
            }
            const labels = ['OH', 'CH₃', 'NH₂', 'O', 'Cl', 'COOH'];
            [0, 2 + Math.floor(random() * 2), 4].forEach((i) => {
                const [x, y] = ring[i];
                pen.line([[x, y], [x * 1.7, y * 1.7]]);
                pen.note(pick(random, labels), x * 2.05, y * 2.05, 0.1);
            });
        },
        detector(pen, random) {
            [0.18, 0.4, 0.62, 0.9].forEach((r) => pen.circle(0, 0, r));
            const ticks = [];
            for (let i = 0; i < 32; i += 1) {
                const a = i / 32 * TAU;
                ticks.push([[Math.cos(a) * 0.62, Math.sin(a) * 0.62], [Math.cos(a) * 0.9, Math.sin(a) * 0.9]]);
            }
            pen.segments(ticks);
            const tracks = 4 + Math.floor(random() * 4);
            for (let i = 0; i < tracks; i += 1) {
                const a = random() * TAU, bend = (random() - 0.5) * 1.2;
                const points = [];
                for (let k = 0; k <= 12; k += 1) {
                    const r = k / 12 * (0.5 + random() * 0.4);
                    points.push([Math.cos(a + bend * r) * r, Math.sin(a + bend * r) * r]);
                }
                pen.line(points);
            }
            pen.note('ECAL', 0.68, -0.98, 0.08, 'left');
            pen.note('HCAL', 0.95, 0.85, 0.08, 'left');
        },
        feynman(pen, random) {
            const v1 = [-0.3, 0], v2 = [0.3, 0];
            pen.arrow([-0.95, -0.6], v1, 0.07);
            pen.arrow(v1, [-0.95, 0.6], 0.07);
            if (random() < 0.5) pen.wave(v1, v2, 6, 0.05);
            else pen.ellipse(0, 0, 0.3, 0.16);
            pen.arrow(v2, [0.95, -0.6], 0.07);
            pen.arrow([0.95, 0.6], v2, 0.07);
            pen.dot(...v1, 0.03); pen.dot(...v2, 0.03);
            pen.note('e⁻', -1.02, -0.72, 0.1); pen.note('e⁺', -1.02, 0.72, 0.1);
            pen.note('γ', 0, -0.2, 0.1);
            pen.note(pick(random, ['μ⁻', 'q', 'τ⁻']), 1.02, -0.72, 0.1); pen.note(pick(random, ['μ⁺', 'q̄', 'τ⁺']), 1.02, 0.72, 0.1);
        },
        paths(pen, random) {
            const a = [-0.85, 0.3], b = [0.85, -0.3];
            pen.dot(...a, 0.04); pen.dot(...b, 0.04);
            for (let i = 0; i < 5; i += 1) {
                const points = [];
                const k1 = (random() - 0.5) * 1.2, k2 = (random() - 0.5) * 0.8;
                for (let s = 0; s <= 24; s += 1) {
                    const t = s / 24;
                    const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
                    const o = Math.sin(t * Math.PI) * k1 + Math.sin(t * Math.PI * 3) * k2 * 0.3;
                    points.push([x + o * 0.2, y + o * 0.6]);
                }
                pen.line(points);
            }
            pen.note('∫𝒟x e^{iS/ħ}', 0, 0.9, 0.11);
        },
        draft(pen, random) {
            const lines = 3 + Math.floor(random() * 2);
            for (let i = 0; i < lines; i += 1) {
                const y = -0.6 + i * 0.42;
                pen.note(pick(random, EQUATIONS), -0.9 + random() * 0.2, y, 0.16, 'left');
                if (random() < 0.4) pen.line([[-0.9, y + 0.12], [0.2 + random() * 0.6, y + 0.13]]);
            }
            if (random() < 0.6) pen.line([[-0.98, 0.3], [0.9, 0.3], [0.9, 0.62], [-0.98, 0.62]], true);
            pen.arrow([0.5, -0.8], [0.85, -0.45], 0.06);
        },
        shower(pen, random) {
            const segs = [];
            const grow = (x, y, a, len, depth) => {
                const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
                segs.push([[x, y], [x2, y2]]);
                if (depth <= 0) return;
                const spread = 0.25 + random() * 0.25;
                grow(x2, y2, a - spread, len * 0.78, depth - 1);
                grow(x2, y2, a + spread, len * 0.78, depth - 1);
            };
            grow(0, -0.95, Math.PI / 2, 0.34, 4);
            for (let i = 0; i < segs.length; i += 6) pen.segments(segs.slice(i, i + 6));
            pen.note('γ', 0.12, -0.9, 0.1);
            pen.note('e⁺e⁻', 0.6, 0.15, 0.09, 'left');
        },
        decay(pen, random) {
            const chain = pick(random, [['K⁺', 'π⁺', 'π⁰', 'γγ'], ['Λ', 'p', 'π⁻', 'μ⁻ν̄'], ['B⁰', 'D⁻', 'K⁺', 'π⁻π⁻'], ['τ⁻', 'ρ⁻', 'π⁰', 'ν']]);
            const pts = [[-0.8, -0.55], [-0.15, -0.1], [0.45, -0.5], [0.55, 0.5]];
            pen.note(chain[0], pts[0][0] - 0.12, pts[0][1] - 0.12, 0.13);
            pen.arrow(pts[0], pts[1], 0.07); pen.note(chain[1], pts[1][0] - 0.05, pts[1][1] + 0.16, 0.13);
            pen.arrow(pts[1], pts[2], 0.07); pen.note(chain[2], pts[2][0] + 0.12, pts[2][1] - 0.1, 0.13);
            pen.dashed(pts[1], pts[3], 0.04); pen.note(chain[3], pts[3][0] + 0.1, pts[3][1] + 0.12, 0.13);
        },
        spectrum(pen, random) {
            pen.line([[-0.9, -0.85], [-0.9, 0.7], [0.95, 0.7]]);
            const ticks = [];
            for (let i = 0; i <= 8; i += 1) ticks.push([[-0.9 + i * 0.23, 0.7], [-0.9 + i * 0.23, 0.76]]);
            pen.segments(ticks);
            const peak = 0.1 + (random() - 0.5) * 0.5;
            const hist = [];
            for (let i = 0; i < 30; i += 1) {
                const x = -0.88 + i * 0.061;
                const bg = 0.55 * Math.exp(-(x + 0.9) * 1.4);
                const sig = 0.75 * Math.exp(-((x - peak) ** 2) / 0.006);
                const y = 0.7 - Math.min(1.45, bg + sig + random() * 0.06);
                hist.push([x, y], [x + 0.061, y]);
            }
            pen.line(hist);
            pen.dashed([-0.9, 0.7 - 0.55], [0.95, 0.7 - 0.55 * Math.exp(-1.85 * 1.4)], 0.03);
            pen.note('m (GeV)', 0.7, 0.88, 0.08); pen.note(String(100 + Math.round(random() * 60)), peak, -0.85, 0.09);
        },
        potential(pen, random) {
            pen.line([[-0.95, 0.6], [0.95, 0.6]]); pen.line([[0, 0.95], [0, -0.95]]);
            const curve = [];
            for (let i = 0; i <= 60; i += 1) {
                const x = -0.9 + i / 60 * 1.8;
                const p = x / 0.6;
                curve.push([x, 0.25 + (p ** 4 - 2 * p * p) * 0.32]);
            }
            pen.line(curve);
            pen.dot(0.6, 0.25 - 0.32, 0.05);
            pen.note('V(φ)', 0.1, -0.9, 0.1, 'left'); pen.note('φ', 0.95, 0.72, 0.1);
            if (random() < 0.6) pen.arrow([0.05, -0.2], [0.5, 0.0], 0.06);
        },
        running(pen, random) {
            pen.line([[-0.9, -0.85], [-0.9, 0.75], [0.95, 0.75]]);
            const band = (shift) => Array.from({ length: 40 }, (_, i) => {
                const x = -0.85 + i / 39 * 1.75;
                return [x, -0.7 + 1.25 * (1 - 1 / (1 + (x + 0.95) * 1.6)) + shift];
            });
            pen.line(band(-0.05)); pen.line(band(0.05));
            for (let i = 0; i < 6; i += 1) {
                const x = -0.7 + i * 0.3;
                const y = -0.7 + 1.25 * (1 - 1 / (1 + (x + 0.95) * 1.6)) + (random() - 0.5) * 0.06;
                pen.dot(x, y, 0.025);
            }
            pen.note('αₛ(Q)', -0.75, -0.92, 0.1, 'left'); pen.note('Q', 0.95, 0.9, 0.1);
        },
        cherenkov(pen, random) {
            const apex = [0.85, 0];
            pen.line([[-0.95, 0], apex]);
            pen.line([apex, [-0.55, -0.7]]); pen.line([apex, [-0.55, 0.7]]);
            pen.ellipse(-0.55, 0, 0.14, 0.7);
            pen.note('θc', 0.42, -0.18, 0.1);
            pen.note('cos θ = 1/nβ', -0.2, 0.9, 0.09);
        },
        collider(pen, random) {
            pen.circle(0, 0, 0.82);
            pen.circle(-0.45, 0.42, 0.24);
            pen.line([[-0.45, 0.66], [-0.45, 0.98]]);
            const dots = [];
            for (let i = 0; i < 4; i += 1) dots.push(random() * TAU);
            dots.forEach((a) => pen.dot(Math.cos(a) * 0.82, Math.sin(a) * 0.82, 0.04));
            pen.note(pick(random, ['ATLAS', 'CMS', 'ALICE', 'LHCb']), 0.6, 0.72, 0.09, 'left');
            pen.note('√s = 13.6 TeV', 0, 0, 0.1);
        },
        // 气泡室照片：一束入射线打到顶点，一对正负电子在磁场里朝两边卷成螺旋，几条直的径迹，一串越来越密的气泡
        bubble(pen, random) {
            const vx = (random() - 0.5) * 0.3, vy = -(random() * 0.3 - 0.25);
            pen.line([[-1.05, vy + 0.25], [vx, vy]]);
            pen.dot(vx, vy, 0.03);
            const spiral = (r0, turn, sign) => {
                const pts = [];
                for (let i = 0; i <= 90; i += 1) {
                    const a = i / 90 * TAU * 2.2;
                    const r = r0 * Math.exp(-a * turn);
                    pts.push([vx + sign * (Math.sin(a) * r), vy - sign * (r0 - Math.cos(a) * r) * 0.9]);
                }
                pen.line(pts);
            };
            spiral(0.3 + random() * 0.12, 0.07, -1);
            spiral(0.36 + random() * 0.14, 0.085, 1);
            for (let n = 2 + Math.floor(random() * 2); n > 0; n -= 1) {
                const a = (random() - 0.5);
                pen.line([[vx, vy], [vx + Math.cos(a) * 1.05, vy - Math.sin(a) * 1.05]]);
            }
            for (let i = 0; i < 7; i += 1) pen.dot(-0.95 + i * (0.2 - i * 0.012), -0.75 - i * 0.03, 0.02);
            [[-0.85, 0.85], [0.85, -0.8]].forEach(([cx, cy]) => pen.segments([[[cx - 0.1, cy], [cx + 0.1, cy]], [[cx, cy - 0.1], [cx, cy + 0.1]]]));
            pen.note('γ → e⁺e⁻', vx - 0.5, vy + 0.62, 0.1);
            pen.note(pick(random, ['B = 2 T', 'p = 0.3 B r', 'Λ → p π⁻']), 0.3, 0.98, 0.09);
        },
        // 企鹅图：一条夸克线上开一个圈，圈底下甩出一根胶子，再分成一对夸克
        penguin(pen, random) {
            pen.arrow([-1.05, -0.15], [-0.45, -0.15]);
            pen.line([[-0.45, -0.15], [0.45, -0.15]]);
            pen.arrow([0.45, -0.15], [1.05, -0.15]);
            pen.circle(0, -0.15, 0.45, Math.PI, TAU);
            [[-0.45, -0.15], [0.45, -0.15], [0, -0.15]].forEach(([x, y]) => pen.dot(x, y, 0.035));
            pen.wave([0, -0.15], [0, 0.5], 9, 0.05);
            pen.dot(0, 0.5, 0.035);
            pen.arrow([0, 0.5], [0.75, 0.3]);
            pen.arrow([0.75, 0.8], [0, 0.5]);
            pen.note('b', -1.05, -0.33, 0.12); pen.note('s', 1.05, -0.33, 0.12); pen.note('W', 0, -0.76, 0.12);
            pen.note(pick(random, ['t', 'u, c, t']), -0.22, -0.02, 0.1);
            pen.note('g', 0.18, 0.2, 0.11);
            pen.note(pick(random, ['b → s g', 'Vtb V*ts', 'O(GF αs)']), -1, 0.95, 0.09, 'left');
        },
        // 箱图：上下两条夸克线，中间两根 W 波浪线连成一个方框
        box(pen, random) {
            const [meson, upper, lower] = pick(random, [['K⁰', 's', 'd'], ['B⁰', 'b', 'd'], ['D⁰', 'c', 'u']]);
            pen.arrow([-1.05, -0.38], [-0.42, -0.38]); pen.arrow([-0.42, -0.38], [0.42, -0.38]); pen.arrow([0.42, -0.38], [1.05, -0.38]);
            pen.arrow([1.05, 0.38], [0.42, 0.38]); pen.arrow([0.42, 0.38], [-0.42, 0.38]); pen.arrow([-0.42, 0.38], [-1.05, 0.38]);
            pen.wave([-0.42, -0.38], [-0.42, 0.38], 7, 0.05);
            pen.wave([0.42, -0.38], [0.42, 0.38], 7, 0.05);
            [-0.42, 0.42].forEach((x) => { pen.dot(x, -0.38, 0.035); pen.dot(x, 0.38, 0.035); });
            pen.note(upper, -0.75, -0.56, 0.11); pen.note(lower, -0.75, 0.58, 0.11);
            pen.note(lower, 0.75, -0.56, 0.11); pen.note(upper, 0.75, 0.58, 0.11);
            pen.note('u, c, t', 0, -0.56, 0.09); pen.note('W', -0.62, 0, 0.11); pen.note('W', 0.62, 0, 0.11);
            pen.note(meson, -1.25, 0, 0.12);
            pen.note(pick(random, ['Δm', 'ΔF = 2', 'ε ≈ 2.2×10⁻³']), -0.3, 1, 0.1);
        },
        // 配线图（歌词里有车、站、轨道时优先用）：上下行两股道、一组渡线道岔、一座站台、公里标和信号机
        rail(pen, random) {
            const y1 = -0.16, y2 = 0.16;
            pen.line([[-1.05, y1], [1.05, y1]]);
            pen.line([[-1.05, y2], [1.05, y2]]);
            const sx = -0.55 + random() * 0.3;
            pen.line([[sx, y2], [sx + 0.42, y1]]);
            pen.line([[sx + 0.5, y1], [sx + 0.92, y2]]);
            const px = 0.15 + random() * 0.3;
            pen.line([[px, y1 - 0.12], [px + 0.62, y1 - 0.12], [px + 0.62, y1 - 0.34], [px, y1 - 0.34]], true);
            for (let i = 0; i < 3; i += 1) pen.line([[px + 0.1 + i * 0.2, y1 - 0.34], [px + 0.2 + i * 0.2, y1 - 0.12]]);
            const k = 10 + Math.floor(random() * 30);
            [-0.9, -0.3, 0.3, 0.9].forEach((x, i) => {
                pen.line([[x, y2 + 0.04], [x, y2 + 0.14]]);
                pen.note(`K${k + i}+${pick(random, ['000', '200', '400', '600', '800'])}`, x, y2 + 0.24, 0.07);
            });
            const gx = sx - 0.25;
            pen.line([[gx, y2], [gx, y2 + 0.36]]);
            pen.circle(gx + 0.07, y2 + 0.36, 0.06);
            pen.note(pick(random, ['上行', '下行', 'Up', 'Down']), -1.0, y1 - 0.1, 0.08, 'left');
            pen.note(pick(random, ['第 1 站台', '1 番線', 'Pl. 2']), px + 0.31, y1 - 0.47, 0.08);
            pen.note(pick(random, ['R = 400 m', 'i = 2.5‰', 'v ≤ 45 km/h']), 0.4, 0.75, 0.09);
        },
        // 潮汐曲线（歌词里有海、浪、潮时优先用）：两个半日潮，高低潮标时刻和潮高，平均海面虚线，角上一个月相
        tide(pen, random) {
            pen.line([[-1, 0.62], [1, 0.62]]);
            pen.line([[-1, 0.62], [-1, -0.7]]);
            const phase = random() * TAU, amp = 0.38 + random() * 0.1;
            const at = x => -Math.sin((x + 1) * Math.PI * 2 + phase) * amp;
            const pts = [];
            for (let i = 0; i <= 80; i += 1) { const x = -1 + i / 40; pts.push([x, at(x)]); }
            pen.line(pts);
            pen.dashed([-1, 0], [1, 0], 0.05);
            pen.note('MSL', 1.02, -0.06, 0.07, 'left');
            for (let i = 0; i < 4; i += 1) {
                const x = -1 + ((i / 2 + 0.25 - phase / TAU) % 1 + 1) % 1 * 2;
                const high = Math.sin((x + 1) * Math.PI * 2 + phase) < 0;
                const y = at(x);
                pen.dot(x, y, 0.025);
                const h = (high ? 1.6 + random() * 0.8 : 0.2 + random() * 0.4).toFixed(1);
                const hh = String(Math.floor(random() * 24)).padStart(2, '0'), mm = String(Math.floor(random() * 60)).padStart(2, '0');
                pen.note(`${high ? 'HW' : 'LW'} ${hh}:${mm}  ${h} m`, x, y + (high ? -0.12 : 0.12), 0.065);
            }
            [-1, -0.5, 0, 0.5, 1].forEach((x, i) => { pen.line([[x, 0.62], [x, 0.68]]); pen.note(`${i * 6}h`, x, 0.76, 0.06); });
            pen.circle(0.82, -0.78, 0.09);
            pen.ellipse(0.82, -0.78, 0.045, 0.09, 0, -Math.PI / 2, Math.PI / 2);
        },

        /* ── 铁道 ── */
        // 列车运行图：横轴时间、竖轴车站，一列车一条斜线（快车陡、慢车缓，站上停一下是一段平线）
        timetable(pen, random) {
            const stations = ['A', 'B', 'C', 'D', 'E'];
            const ys = stations.map((_, i) => -0.7 + i * 0.35);
            pen.line([[-0.85, -0.82], [-0.85, 0.82], [1.0, 0.82]]);
            pen.segments(ys.map(y => [[-0.85, y], [1.0, y]]).filter((_, i) => i % 2 === 0));
            ys.forEach((y, i) => pen.note(pick(random, [['甲', '乙', '丙', '丁', '戊'], stations])[i], -0.95, y, 0.075, 'right'));
            const trains = 4 + Math.floor(random() * 3);
            for (let t = 0; t < trains; t += 1) {
                const down = random() < 0.5;
                let x = -0.85 + random() * 0.9;
                const v = 0.12 + random() * 0.2;
                const pts = [];
                const order = down ? ys : ys.slice().reverse();
                order.forEach((y, i) => {
                    if (i) x += v * (0.8 + random() * 0.4);
                    pts.push([x, y]);
                    if (i && i < order.length - 1 && random() < 0.5) { x += 0.04 + random() * 0.05; pts.push([x, y]); }
                });
                if (pts[pts.length - 1][0] > 1.05) continue;
                pen.line(pts);
                if (random() < 0.5) pen.note(`${down ? 'D' : 'K'}${100 + Math.floor(random() * 800)}`, pts[1][0] + 0.03, pts[1][1] - 0.07, 0.06, 'left');
            }
            [0, 6, 12, 18].forEach((h, i) => pen.note(`${h}:00`, -0.85 + i * 0.6, 0.94, 0.06));
        },
        // 信号机立面：一根柱、三显示的灯头、遮檐，旁边标灯色
        signal(pen, random) {
            pen.line([[0, 0.95], [0, -0.25]]);
            pen.line([[-0.2, 0.95], [0.2, 0.95]]);
            pen.line([[-0.17, -0.25], [0.17, -0.25], [0.17, -0.95], [-0.17, -0.95]], true);
            const lamps = [-0.82, -0.6, -0.38];
            const lit = Math.floor(random() * 3);
            lamps.forEach((y, i) => {
                pen.circle(0, y, 0.075);
                pen.line([[-0.1, y - 0.1], [0.1, y - 0.1]]);
                if (i === lit) pen.dot(0, y, 0.045);
            });
            ['R', 'Y', 'G'].forEach((c, i) => pen.note(c, 0.28, lamps[i], 0.07, 'left'));
            pen.line([[0, 0.2], [0.42, 0.2]]);
            pen.line([[0.42, 0.08], [0.78, 0.08], [0.78, 0.32], [0.42, 0.32]], true);
            pen.note(`${pick(random, ['X', 'S', 'XN', 'SF'])}${1 + Math.floor(random() * 9)}`, 0.6, 0.2, 0.08);
        },
        // 车票：圆角票面、一道撕口打孔虚线，起讫站、车次、座位
        ticket(pen, random) {
            const w = 0.95, h = 0.55, c = 0.08;
            pen.line([[-w + c, -h], [w - c, -h], [w, -h + c], [w, h - c], [w - c, h], [-w + c, h], [-w, h - c], [-w, -h + c]], true);
            const cut = 0.48 + random() * 0.12;
            const holes = [];
            for (let y = -h + 0.06; y < h - 0.04; y += 0.09) holes.push([[cut, y], [cut, y + 0.035]]);
            pen.segments(holes);
            const from = pick(random, ['海滨', '旧城', 'Seaside', '北口', '終点']), to = pick(random, ['山上', '新町', 'Hill St.', '南口', '始発']);
            pen.note(from, -0.62, -0.2, 0.14);
            pen.arrow([-0.36, -0.2], [-0.04, -0.2], 0.05);
            pen.note(to, 0.22, -0.2, 0.14);
            pen.line([[-w + 0.12, 0.08], [cut - 0.12, 0.08]]);
            pen.note(`No. ${String(Math.floor(random() * 99999)).padStart(5, '0')}`, -w + 0.14, 0.26, 0.07, 'left');
            pen.note(`${Math.floor(random() * 16) + 1} 车 ${Math.floor(random() * 90) + 1}${pick(random, ['A', 'B', 'C', 'D', 'F'])}`, -w + 0.14, 0.42, 0.07, 'left');
            pen.note('¥ ' + (Math.floor(random() * 300) + 20), (cut + w) / 2, 0.05, 0.08);
        },
        // 接触网支柱立面：立柱、腕臂、承力索和接触线的悬链，吊弦一根根垂下来
        catenary(pen, random) {
            const xs = [-0.8, 0.8];
            xs.forEach((x) => {
                pen.line([[x, 0.9], [x, -0.75]]);
                pen.line([[x, -0.62], [x + (x < 0 ? 0.24 : -0.24), -0.55]]);
            });
            const sag = 0.16 + random() * 0.1;
            const msg = [];
            for (let i = 0; i <= 32; i += 1) { const t = i / 32; const x = -0.56 + t * 1.12; msg.push([x, -0.55 + Math.sin(t * Math.PI) * sag]); }
            pen.line(msg);
            pen.line([[-0.6, 0.0], [0.6, 0.0]]);
            const droppers = [];
            for (let i = 1; i < 8; i += 1) { const t = i / 8; const x = -0.56 + t * 1.12; droppers.push([[x, -0.55 + Math.sin(t * Math.PI) * sag], [x, 0.0]]); }
            pen.segments(droppers);
            pen.line([[-1.0, 0.9], [1.0, 0.9]]);
            pen.note('1500 V DC', 0, 0.16, 0.07);
            pen.note(`L = ${Math.floor(40 + random() * 25)} m`, 0, -0.84, 0.07);
        },
        // 轨道断面：道砟梯形、轨枕、两根工字轨，标轨距
        trackSection(pen, random) {
            pen.line([[-1.0, 0.6], [-0.7, 0.15], [0.7, 0.15], [1.0, 0.6]]);
            pen.line([[-0.62, 0.15], [-0.62, 0.02], [0.62, 0.02], [0.62, 0.15]]);
            [-0.38, 0.38].forEach((x) => {
                pen.line([[x - 0.09, 0.02], [x + 0.09, 0.02], [x + 0.09, -0.01], [x + 0.025, -0.03], [x + 0.025, -0.2], [x + 0.06, -0.22], [x + 0.06, -0.28], [x - 0.06, -0.28], [x - 0.06, -0.22], [x - 0.025, -0.2], [x - 0.025, -0.03], [x - 0.09, -0.01]], true);
            });
            pen.arrow([-0.1, -0.42], [-0.38, -0.42], 0.04);
            pen.arrow([0.1, -0.42], [0.38, -0.42], 0.04);
            pen.note(pick(random, ['1435', '1067', '1520']), 0, -0.42, 0.08);
            for (let i = 0; i < 14; i += 1) pen.dot(-0.85 + random() * 1.7, 0.22 + random() * 0.34, 0.012 + random() * 0.012);
            pen.note(pick(random, ['60 kg/m', 'JIS 50N', 'UIC 60']), 0.75, -0.2, 0.07, 'left');
        },
        // 线路图：一条主线、一条支线，站是圆圈，换乘站是两个圈
        routeMap(pen, random) {
            const main = [];
            let x = -0.95, y = (random() - 0.5) * 0.3;
            for (let i = 0; i < 6; i += 1) {
                main.push([x, y]);
                x += 0.34 + random() * 0.08;
                if (random() < 0.4) y += (random() < 0.5 ? -1 : 1) * 0.25;
            }
            pen.line(main);
            const hub = main[2 + Math.floor(random() * 2)];
            const branch = [hub, [hub[0] + 0.25, hub[1] - 0.35], [hub[0] + 0.25, hub[1] - 0.75]];
            pen.line(branch);
            const names = ['北口', '中央', '港前', '桜台', '旧市街', '海岸通', '博物馆', 'Pier', 'Market'];
            main.forEach(([px, py], i) => {
                pen.circle(px, py, 0.045);
                if (i % 2 === 0 || random() < 0.4) pen.note(pick(random, names), px, py + (i % 2 ? -0.13 : 0.14), 0.065);
            });
            pen.circle(hub[0], hub[1], 0.075);
            pen.circle(branch[2][0], branch[2][1], 0.045);
        },

        /* ── 海 ── */
        // 罗盘玫瑰：两圈刻度、十六个方位的尖角，N 上面一个箭头
        compass(pen, random) {
            pen.circle(0, 0, 0.82);
            pen.circle(0, 0, 0.7);
            const ticks = [];
            for (let i = 0; i < 72; i += 1) {
                const a = i / 72 * TAU;
                const r2 = i % 9 === 0 ? 0.6 : 0.66;
                ticks.push([[Math.cos(a) * 0.7, Math.sin(a) * 0.7], [Math.cos(a) * r2, Math.sin(a) * r2]]);
            }
            pen.segments(ticks);
            for (let i = 0; i < 8; i += 1) {
                const a = i / 8 * TAU - Math.PI / 2;
                const len = i % 2 === 0 ? 0.62 : 0.38;
                const w = i % 2 === 0 ? 0.1 : 0.07;
                const tip = [Math.cos(a) * len, Math.sin(a) * len];
                const l = [Math.cos(a - Math.PI / 2) * w, Math.sin(a - Math.PI / 2) * w];
                const r = [Math.cos(a + Math.PI / 2) * w, Math.sin(a + Math.PI / 2) * w];
                pen.line([l, tip, r]);
            }
            pen.note('N', 0, -0.95, 0.12);
            pen.note(pick(random, ['VAR 7°W', 'VAR 3°E', 'MAG']), 0, 0.98, 0.07);
        },
        // 海图等深线：几道弯弯的等深线，散着测深数字，一个锚地符号
        isobaths(pen, random) {
            const base = random() * TAU;
            for (let k = 0; k < 4; k += 1) {
                const pts = [];
                const off = -0.6 + k * 0.38;
                for (let i = 0; i <= 30; i += 1) {
                    const x = -1 + i / 15;
                    pts.push([x, off + Math.sin(x * 2.2 + base + k * 0.6) * 0.12 + Math.sin(x * 5 + k) * 0.03]);
                }
                if (k % 2) pen.line(pts); else pen.segments(pts.slice(1).map((p, i) => [pts[i], p]).filter((_, i) => i % 3 !== 2));
                pen.note(`${[2, 5, 10, 20][k]}`, -0.95, off - 0.07, 0.06, 'left');
            }
            for (let i = 0; i < 10; i += 1) pen.note(String(Math.floor(3 + random() * 30)), -0.8 + random() * 1.6, -0.75 + random() * 1.5, 0.055);
            const ax = 0.4 + random() * 0.3, ay = -0.4;
            pen.line([[ax, ay - 0.1], [ax, ay + 0.1]]);
            pen.ellipse(ax, ay + 0.02, 0.08, 0.08, 0, 0.2, Math.PI - 0.2, 16);
            pen.line([[ax - 0.05, ay - 0.06], [ax + 0.05, ay - 0.06]]);
        },
        // 灯塔立面：收分的塔身、灯室、栏杆，光弧扇面标灯质
        lighthouse(pen, random) {
            pen.line([[-0.28, 0.9], [-0.16, -0.35], [0.16, -0.35], [0.28, 0.9]], true);
            [0.45, 0.0].forEach(y => { const w = 0.16 + (y + 0.35) / 1.25 * 0.12; pen.line([[-w, y], [w, y]]); });
            pen.line([[-0.22, -0.35], [0.22, -0.35]]);
            pen.line([[-0.13, -0.35], [-0.13, -0.58], [0.13, -0.58], [0.13, -0.35]]);
            pen.line([[-0.17, -0.58], [0, -0.72], [0.17, -0.58]]);
            pen.dot(0, -0.47, 0.035);
            const side = random() < 0.5 ? -1 : 1;
            pen.line([[0, -0.47], [side * 1.0, -0.62]]);
            pen.line([[0, -0.47], [side * 1.0, -0.32]]);
            pen.ellipse(0, -0.47, 0.95, 0.95, 0, side > 0 ? -0.16 : Math.PI - 0.16, side > 0 ? 0.16 : Math.PI + 0.16, 12);
            pen.note(pick(random, ['Fl W 10s', 'Oc R 4s', 'LFl 6s', 'Iso G 2s']), side * 0.6, -0.78, 0.08);
            pen.line([[-0.6, 0.9], [0.6, 0.9]]);
            pen.wave([-1.0, 0.98], [1.0, 0.98], 7, 0.025);
        },
        // 波浪剖面：一条余摆线似的浪，标波长、波高、静水面
        waveSection(pen, random) {
            const amp = 0.22 + random() * 0.08, lambda = 0.9;
            const pts = [];
            // 余摆线：浪峰尖、浪谷宽
            for (let i = 0; i <= 120; i += 1) {
                const t = (-1.1 + i / 120 * 2.2) * TAU / lambda;
                pts.push([t * lambda / TAU - Math.sin(t) * amp * 0.5, -Math.cos(t) * amp]);
            }
            pen.line(pts.filter(([x]) => x > -1.05 && x < 1.05));
            pen.dashed([-1, 0], [1, 0], 0.04);
            pen.note('SWL', 1.0, -0.07, 0.065, 'left');
            const c1 = -lambda / 2 + 0.05, c2 = c1 + lambda;
            pen.line([[c1, -amp - 0.12], [c1, -amp - 0.24]]); pen.line([[c2, -amp - 0.12], [c2, -amp - 0.24]]);
            pen.arrow([0, -amp - 0.18], [c1, -amp - 0.18], 0.04); pen.arrow([0, -amp - 0.18], [c2, -amp - 0.18], 0.04);
            pen.note('λ', 0, -amp - 0.3, 0.1);
            pen.arrow([c2 + 0.12, 0], [c2 + 0.12, -amp], 0.035); pen.note('H/2', c2 + 0.18, -amp * 0.5, 0.07, 'left');
            for (let i = 0; i < 3; i += 1) pen.ellipse(-0.5 + i * 0.5, 0.35 + i * 0.12, 0.12 - i * 0.03, 0.12 - i * 0.03, 0, 0, TAU, 24);
            pen.note(`T = ${(4 + random() * 8).toFixed(1)} s`, -0.95, 0.85, 0.07, 'left');
        },
        // 船体型线（横剖面图）：左半边是船首的几道剖面、右半边是船尾的，水线一道
        hullLines(pen, random) {
            pen.line([[0, -0.75], [0, 0.75]]);
            pen.line([[-1, 0.62], [1, 0.62]]);
            const wl = -0.05 + random() * 0.1;
            pen.dashed([-1, wl], [1, wl], 0.04);
            pen.note('DWL', 1.0, wl - 0.07, 0.065, 'left');
            for (let k = 1; k <= 5; k += 1) {
                const bw = 0.85 * (k / 5), deep = 0.6;
                const sternPts = [], bowPts = [];
                for (let i = 0; i <= 16; i += 1) {
                    const t = i / 16;
                    const y = -0.55 + t * (deep + 0.55);
                    // 船中的剖面方（U 形），越往船首越尖（V 形）
                    const stern = bw * (1 - Math.pow(t, 1.4 + k * 1.1));
                    const bow = bw * 0.9 * (1 - Math.pow(t, 0.9 + k * 0.45));
                    sternPts.push([stern, y]);
                    bowPts.push([-bow, y]);
                }
                pen.line(sternPts); pen.line(bowPts);
            }
            pen.note(pick(random, ['Body Plan', '横剖线图', 'Stn 0–10']), -0.95, -0.85, 0.075, 'left');
        },

        /* ── 星夜 ── */
        // 星座连线：几颗不同亮度的星，连成一个星座，标名字和几颗星的希腊字母
        constellation(pen, random) {
            const n = 6 + Math.floor(random() * 3);
            const stars = [];
            let x = -0.8, y = (random() - 0.5) * 0.6;
            for (let i = 0; i < n; i += 1) { stars.push([x, y]); x += 0.2 + random() * 0.12; y += (random() - 0.5) * 0.7; y = Math.max(-0.8, Math.min(0.8, y)); }
            stars.forEach(([sx, sy], i) => {
                const m = random();
                pen.dot(sx, sy, 0.018 + m * 0.035);
                if (m > 0.75) pen.segments([[[sx - 0.09, sy], [sx + 0.09, sy]], [[sx, sy - 0.09], [sx, sy + 0.09]]]);
                if (i < 4) pen.note('αβγδ'[i], sx + 0.07, sy - 0.08, 0.07, 'left');
            });
            pen.line(stars.slice(0, n - 2));
            pen.line([stars[2], stars[n - 2], stars[n - 1]]);
            pen.note(pick(random, ['Lyra', 'Cygnus', 'Cassiopeia', 'Orion', 'Ursa Minor', '天琴座', '北斗']), 0, 0.92, 0.09);
        },
        // 月相：一排月亮从新月到满月，下面标日期
        moonPhases(pen, random) {
            const n = 5;
            const start = Math.floor(random() * 20) + 1;
            for (let i = 0; i < n; i += 1) {
                const cx = -0.8 + i * 0.4, r = 0.15;
                pen.circle(cx, 0, r);
                const k = -1 + i / (n - 1) * 2;
                pen.ellipse(cx, 0, Math.abs(k) * r, r, 0, -Math.PI / 2, Math.PI / 2, 20);
                if (k < 0) pen.ellipse(cx, 0, r, r, 0, Math.PI / 2, Math.PI * 1.5, 20);
                pen.note(`${start + i * 3}`, cx, 0.3, 0.07);
            }
            pen.line([[-1, 0.45], [1, 0.45]]);
            pen.note(pick(random, ['lunation 1271', '朔望月 29.53 d', 'age 0 → 14 d']), 0, -0.36, 0.075);
        },
        // 地平坐标网：地平线、几道等高圈（弧）、方位刻度，一条星轨划过
        altaz(pen, random) {
            pen.line([[-1, 0.6], [1, 0.6]]);
            [0.35, 0.7, 1.05].forEach((r) => pen.ellipse(0, 0.6, r, r * 0.95, 0, Math.PI, TAU, 40));
            const ticks = [];
            for (let i = 0; i <= 12; i += 1) { const x = -1 + i / 6; ticks.push([[x, 0.6], [x, 0.66]]); }
            pen.segments(ticks);
            ['E', 'S', 'W'].forEach((c, i) => pen.note(c, -0.9 + i * 0.9, 0.78, 0.08));
            const pts = [];
            const r = 0.55 + random() * 0.3, cy = 0.6 + random() * 0.2;
            for (let i = 0; i <= 30; i += 1) { const a = Math.PI + 0.25 + i / 30 * (Math.PI - 0.5); pts.push([Math.cos(a) * r * 1.3, cy + Math.sin(a) * r]); }
            pen.line(pts);
            pen.dot(pts[18][0], pts[18][1], 0.035);
            pen.note(`h = ${Math.floor(20 + random() * 50)}°`, pts[18][0] + 0.08, pts[18][1] - 0.08, 0.07, 'left');
        },
        // 折射望远镜的光路：物镜、目镜，两束平行光会聚到焦点再散开
        telescope(pen, random) {
            pen.ellipse(-0.6, 0, 0.05, 0.4, 0, 0, TAU, 32);
            pen.ellipse(0.62, 0, 0.03, 0.15, 0, 0, TAU, 24);
            const f = 0.45;
            pen.dashed([-1.0, 0], [1.0, 0], 0.03);
            [-0.32, 0.32].forEach((y) => {
                pen.line([[-1.0, y], [-0.6, y], [f, 0], [0.62, -y * 0.38]]);
                pen.line([[0.62, -y * 0.38], [1.0, -y * 0.38]]);
            });
            pen.dot(f, 0, 0.025);
            pen.note('F', f, 0.12, 0.08);
            pen.note(`f = ${Math.floor(600 + random() * 900)} mm`, -0.6, 0.55, 0.07);
            pen.note(pick(random, ['×48', '×80', '×120']), 0.62, 0.28, 0.07);
        },
        // 光变曲线：一串带误差棒的测点，中间一个凹下去的掩食
        lightCurve(pen, random) {
            pen.line([[-0.9, -0.7], [-0.9, 0.55], [1.0, 0.55]]);
            const depth = 0.2 + random() * 0.15, c = (random() - 0.5) * 0.6, w = 0.18 + random() * 0.1;
            const model = x => -0.25 + depth * Math.max(0, 1 - Math.pow(Math.max(0, Math.abs(x - c) - w * 0.4) / (w * 0.6), 2)) * (Math.abs(x - c) < w ? 1 : 0);
            const pts = [];
            for (let i = 0; i <= 48; i += 1) { const x = -0.85 + i / 48 * 1.8; pts.push([x, model(x)]); }
            pen.line(pts);
            for (let i = 0; i < 22; i += 1) {
                const x = -0.82 + i / 21 * 1.74, y = model(x) + (random() - 0.5) * 0.06, e = 0.03 + random() * 0.03;
                pen.dot(x, y, 0.015);
                pen.line([[x, y - e], [x, y + e]]);
            }
            pen.note('Δm', -1.0, -0.72, 0.08, 'right');
            pen.note('phase', 0.95, 0.68, 0.07, 'right');
            pen.note(pick(random, ['P = 3.52 d', 'Algol', 'transit', 'P = 0.94 d']), 0.2, -0.6, 0.08);
        },

        /* ── 城市 ── */
        // 平面图：几间房、墙上开门的弧、窗是墙上两道细线，标面积
        floorPlan(pen, random) {
            const W = 1.7, H = 1.2, x0 = -0.85, y0 = -0.6;
            pen.line([[x0, y0], [x0 + W, y0], [x0 + W, y0 + H], [x0, y0 + H]], true);
            const vx = x0 + W * (0.4 + random() * 0.2), hy = y0 + H * (0.45 + random() * 0.15);
            pen.line([[vx, y0], [vx, hy - 0.16]]); pen.line([[vx, hy + 0.06], [vx, y0 + H]]);
            pen.line([[x0, hy], [vx - 0.2, hy]]);
            pen.ellipse(vx, hy - 0.16, 0.22, 0.22, 0, Math.PI / 2, Math.PI, 12);
            pen.line([[vx, hy - 0.16], [vx - 0.22, hy - 0.16]]);
            [[x0 + 0.25, x0 + 0.55], [vx + 0.2, vx + 0.55]].forEach(([a, b]) => pen.segments([[[a, y0 - 0.03], [b, y0 - 0.03]], [[a, y0 + 0.03], [b, y0 + 0.03]]]));
            pen.note(`${(8 + random() * 10).toFixed(1)} m²`, (x0 + vx) / 2, (y0 + hy) / 2, 0.08);
            pen.note(`${(10 + random() * 14).toFixed(1)} m²`, (vx + x0 + W) / 2, 0, 0.08);
            pen.note(pick(random, ['卧', '厨', 'LDK', '書斎']), (x0 + vx) / 2, (hy + y0 + H) / 2, 0.08);
            pen.arrow([x0, y0 + H + 0.14], [x0 + W, y0 + H + 0.14], 0.04);
            pen.note(`${Math.floor(5000 + random() * 4000)}`, x0 + W / 2, y0 + H + 0.24, 0.065);
        },
        // 街区图：斜着的路网，一条大街加粗（两道线），一个圆环交叉口，路名
        streetGrid(pen, random) {
            const a = (random() - 0.5) * 0.5, c = Math.cos(a), s = Math.sin(a);
            const R = (x, y) => [x * c - y * s, x * s + y * c];
            for (let i = -2; i <= 2; i += 1) pen.line([R(-1, i * 0.38), R(1, i * 0.38)]);
            for (let i = -2; i <= 2; i += 1) pen.line([R(i * 0.42 + (random() - 0.5) * 0.06, -0.95), R(i * 0.42, 0.95)]);
            pen.line([R(-1, 0.05), R(1, 0.05)]);
            pen.circle(...R(0.42, 0), 0.14);
            pen.note(pick(random, ['中山路', '港通り', 'Rue Haute', '长安街', 'Elm St.']), ...R(-0.55, -0.1), 0.075);
            pen.note(pick(random, ['3丁目', 'Block C', '东四']), ...R(-0.2, 0.55), 0.07);
            pen.dot(...R(-0.21, -0.57), 0.04);
        },
        // 立面：几层楼，一排排窗（有的亮着画实心），屋顶水箱和天线
        facade(pen, random) {
            const floors = 5 + Math.floor(random() * 3), w = 1.1, h = 1.6;
            const x0 = -w / 2, y1 = 0.85, y0 = y1 - h;
            pen.line([[x0, y1], [x0, y0], [x0 + w, y0], [x0 + w, y1]]);
            pen.line([[-1, y1], [1, y1]]);
            const fh = h / floors;
            for (let f = 0; f < floors; f += 1) {
                const y = y0 + f * fh;
                if (f) pen.line([[x0 - 0.03, y], [x0 + w + 0.03, y]]);
                for (let k = 0; k < 4; k += 1) {
                    const wx = x0 + 0.1 + k * 0.25, wy = y + fh * 0.25;
                    pen.line([[wx, wy], [wx + 0.15, wy], [wx + 0.15, wy + fh * 0.5], [wx, wy + fh * 0.5]], true);
                    if (random() < 0.25) pen.dot(wx + 0.075, wy + fh * 0.25, 0.03);
                }
            }
            pen.line([[0.2, y0], [0.2, y0 - 0.14], [0.42, y0 - 0.14], [0.42, y0]]);
            pen.line([[-0.3, y0], [-0.3, y0 - 0.3]]);
            pen.segments([[[-0.38, y0 - 0.24], [-0.22, y0 - 0.24]], [[-0.36, y0 - 0.18], [-0.24, y0 - 0.18]]]);
            pen.note(`${floors}F  H = ${(floors * 3.1).toFixed(1)} m`, x0 + w + 0.06, y0 + 0.1, 0.07, 'left');
        },
        // 轴测街区：几栋方盒子楼，按 30° 轴测画三个面的边
        isoBlock(pen, random) {
            const ix = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)], iy = [-Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
            const P = (x, y, z) => [x * ix[0] + y * iy[0], x * ix[1] + y * iy[1] - z];
            const box = (x, y, w, d, h) => {
                const b = [P(x, y, 0), P(x + w, y, 0), P(x + w, y + d, 0), P(x, y + d, 0)];
                const t = [P(x, y, h), P(x + w, y, h), P(x + w, y + d, h), P(x, y + d, h)];
                pen.line(t, true);
                pen.line([b[1], b[2], b[3]]);
                pen.segments([[b[1], t[1]], [b[2], t[2]], [b[3], t[3]]]);
            };
            pen.line([P(-0.8, -0.6, 0), P(0.8, -0.6, 0), P(0.8, 0.7, 0), P(-0.8, 0.7, 0)], true);
            box(-0.6, -0.4, 0.4, 0.4, 0.5 + random() * 0.4);
            box(0.0, -0.45, 0.5, 0.35, 0.3 + random() * 0.3);
            box(-0.55, 0.2, 0.35, 0.35, 0.2 + random() * 0.2);
            box(0.1, 0.15, 0.45, 0.4, 0.6 + random() * 0.3);
            pen.note(pick(random, ['Block 7', '街区 B', 'Lot 12']), 0, 0.92, 0.075);
        },
        // 路灯：弯臂的灯杆、灯罩，地上一圈照亮的范围（虚线椭圆）
        lamp(pen, random) {
            pen.line([[-0.2, 0.9], [-0.2, -0.5]]);
            pen.ellipse(0.05, -0.5, 0.25, 0.25, 0, Math.PI, Math.PI * 1.5, 12);
            pen.line([[0.05, -0.75], [0.3, -0.75]]);
            pen.line([[0.2, -0.75], [0.12, -0.62], [0.48, -0.62], [0.4, -0.75]]);
            pen.line([[0.12, -0.62], [-0.15, 0.9]]); pen.line([[0.48, -0.62], [0.85, 0.9]]);
            const pts = [];
            for (let i = 0; i <= 24; i += 1) { const t = i / 24 * TAU; pts.push([0.35 + Math.cos(t) * 0.55, 0.9 + Math.sin(t) * 0.08]); }
            pen.segments(pts.slice(1).map((p, i) => [pts[i], p]).filter((_, i) => i % 2 === 0));
            pen.line([[-0.32, 0.9], [-0.08, 0.9]]);
            pen.note(`${pick(random, ['3000 K', '2700 K', '4000 K'])}  ${Math.floor(60 + random() * 90)} W`, -0.25, -0.88, 0.07);
        },
        // 天际线剖面：一排高低不一的楼，楼顶几根天线，地面线上标距离
        skyline(pen, random) {
            const pts = [[-1, 0.6]];
            let x = -1;
            while (x < 1) {
                const w = 0.08 + random() * 0.18, h = 0.15 + random() * random() * 1.1;
                pts.push([x, 0.6 - h], [x + w, 0.6 - h]);
                if (h > 0.7 && random() < 0.6) pen.line([[x + w / 2, 0.6 - h], [x + w / 2, 0.6 - h - 0.18]]);
                x += w;
                pts.push([x, 0.6 - h * (0.2 + random() * 0.5)]);
            }
            pts.push([1, 0.6]);
            pen.line(pts.map(([px, py]) => [Math.min(1, px), py]));
            pen.line([[-1, 0.6], [1, 0.6]]);
            [-1, -0.5, 0, 0.5, 1].forEach((tx, i) => { pen.line([[tx, 0.6], [tx, 0.66]]); pen.note(`${i * 250} m`, tx, 0.75, 0.06); });
        },

        /* ── 植物 ── */
        // 叶：叶形、主脉、两边的侧脉，叶柄，标学名
        leaf(pen, random) {
            const L = 0.9, Wd = 0.35 + random() * 0.15;
            const side = sgn => { const pts = []; for (let i = 0; i <= 24; i += 1) { const t = i / 24; pts.push([-L + t * 2 * L, sgn * Math.sin(Math.PI * Math.pow(t, 0.8)) * Wd]); } return pts; };
            pen.line(side(1)); pen.line(side(-1));
            pen.line([[-L - 0.15, 0.04], [L, 0]]);
            const veins = [];
            for (let i = 1; i < 7; i += 1) {
                const t = i / 7, x = -L + t * 2 * L;
                const w = Math.sin(Math.PI * Math.pow(t, 0.8)) * Wd * 0.85;
                veins.push([[x, 0], [x + 0.18, -w]], [[x, 0], [x + 0.18, w]]);
            }
            pen.segments(veins);
            pen.note(pick(random, ['Ginkgo biloba', 'Acer palmatum', 'Prunus serrulata', 'Quercus robur', 'Ficus']), 0, Wd + 0.2, 0.08);
        },
        // 花图式：五瓣花的横切图，萼片、花瓣、雄蕊、心皮，一圈圈套着
        floralDiagram(pen, random) {
            const n = random() < 0.5 ? 5 : 4;
            for (let i = 0; i < n; i += 1) {
                const a = i / n * TAU - Math.PI / 2;
                const b = a + Math.PI / n;
                pen.ellipse(Math.cos(a) * 0.72, Math.sin(a) * 0.72, 0.1, 0.2, a + Math.PI / 2, 0, Math.PI, 14);
                pen.ellipse(Math.cos(b) * 0.5, Math.sin(b) * 0.5, 0.17, 0.08, b + Math.PI / 2, 0, TAU, 20);
                pen.circle(Math.cos(a) * 0.3, Math.sin(a) * 0.3, 0.05);
            }
            pen.circle(0, 0, 0.13);
            pen.line([[-0.13, 0], [0.13, 0]]);
            pen.dot(0, -0.98, 0.03);
            pen.note(`K${n} C${n} A${n} G(${random() < 0.5 ? 2 : 3})`, 0, 1.0, 0.08);
        },
        // 叶序：按黄金角一个个排出去的点，越往外越大，连一条螺线
        phyllotaxis(pen, random) {
            const g = Math.PI * (3 - Math.sqrt(5));
            const n = 60;
            for (let i = 1; i < n; i += 1) {
                const r = Math.sqrt(i / n) * 0.9, a = i * g;
                pen.dot(Math.cos(a) * r, Math.sin(a) * r, 0.012 + r * 0.035);
            }
            const sp = [];
            for (let i = 1; i < n; i += 8) { const r = Math.sqrt(i / n) * 0.9, a = i * g; sp.push([Math.cos(a) * r, Math.sin(a) * r]); }
            pen.line(sp);
            pen.note('137.5°', 0.7, -0.85, 0.08, 'left');
        },
        // 枝：一根分叉的枝（递归），枝头几片小叶、一两朵花苞
        branch(pen, random) {
            const segs = [];
            const tips = [];
            const grow = (x, y, a, len, depth) => {
                const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
                segs.push([[x, y], [x2, y2]]);
                if (depth <= 0) { tips.push([x2, y2, a]); return; }
                grow(x2, y2, a - 0.35 - random() * 0.3, len * (0.62 + random() * 0.15), depth - 1);
                if (random() < 0.85) grow(x2, y2, a + 0.3 + random() * 0.3, len * (0.6 + random() * 0.15), depth - 1);
            };
            grow(-0.2, 0.95, -Math.PI / 2 + (random() - 0.5) * 0.3, 0.55, 4);
            for (let i = 0; i < segs.length; i += 5) pen.segments(segs.slice(i, i + 5));
            tips.forEach(([x, y, a], i) => {
                if (i % 3 === 0) pen.circle(x, y, 0.035);
                else pen.ellipse(x + Math.cos(a) * 0.06, y + Math.sin(a) * 0.06, 0.07, 0.03, a, 0, TAU, 14);
            });
        },
        // 蒲公英的种子头：一圈放射的冠毛，每根顶上一撮伞，有一两颗飘走
        seedHead(pen, random) {
            pen.line([[0, 0.95], [0.04, 0.1]]);
            pen.circle(0.04, 0.05, 0.06);
            const rays = [];
            const n = 26;
            for (let i = 0; i < n; i += 1) {
                const a = i / n * TAU;
                if (random() < 0.15) continue;
                const x = 0.04 + Math.cos(a) * 0.55, y = 0.05 + Math.sin(a) * 0.55;
                rays.push([[0.04 + Math.cos(a) * 0.08, 0.05 + Math.sin(a) * 0.08], [x, y]]);
                rays.push([[x, y], [x + Math.cos(a - 0.4) * 0.1, y + Math.sin(a - 0.4) * 0.1]], [[x, y], [x + Math.cos(a + 0.4) * 0.1, y + Math.sin(a + 0.4) * 0.1]]);
            }
            for (let i = 0; i < rays.length; i += 12) pen.segments(rays.slice(i, i + 12));
            const fx = 0.75, fy = -0.75;
            pen.line([[fx - 0.1, fy + 0.15], [fx, fy]]);
            pen.segments([[[fx, fy], [fx - 0.08, fy - 0.08]], [[fx, fy], [fx + 0.08, fy - 0.08]], [[fx, fy], [fx, fy - 0.11]]]);
            pen.note('Taraxacum', -0.9, 0.85, 0.075, 'left');
        },
        // 发芽：一排四个阶段，从种子到两片子叶，下面一道土线，标天数
        sprout(pen, random) {
            pen.line([[-1, 0.3], [1, 0.3]]);
            [-0.75, -0.25, 0.25, 0.75].forEach((x, i) => {
                pen.ellipse(x, 0.42, 0.07, 0.045, 0.3, 0, TAU, 14);
                if (i >= 1) pen.line([[x, 0.42], [x - 0.04, 0.6 + i * 0.05]]);
                if (i >= 2) pen.line([[x, 0.38], [x + 0.02, 0.3 - i * 0.12]]);
                if (i >= 3) {
                    pen.ellipse(x - 0.1, -0.08, 0.1, 0.045, -0.4, 0, TAU, 14);
                    pen.ellipse(x + 0.12, -0.08, 0.1, 0.045, 0.4, 0, TAU, 14);
                }
                pen.note(`d${[0, 2, 4, 7][i]}`, x, 0.85, 0.07);
            });
        },

        /* ── 信笺 ── */
        // 信封：封口的三角、地址三行、右上角贴邮票的框
        envelope(pen, random) {
            const w = 0.95, h = 0.6;
            pen.line([[-w, -h], [w, -h], [w, h], [-w, h]], true);
            pen.line([[-w, -h], [0, 0.05], [w, -h]]);
            pen.line([[0.58, -h + 0.08], [0.85, -h + 0.08], [0.85, -h + 0.42], [0.58, -h + 0.42]], true);
            for (let i = 0; i < 3; i += 1) pen.line([[-0.5, 0.18 + i * 0.12], [0.1 + random() * 0.35, 0.18 + i * 0.12]]);
            pen.note(pick(random, ['To:', '寄：', '〒']), -0.62, 0.18, 0.08, 'right');
            pen.note(String(Math.floor(100000 + random() * 899999)), -0.85, -h + 0.14, 0.065, 'left');
        },
        // 邮票：齿孔边（一圈小半圆）、面值、里面一幅小画
        stamp(pen, random) {
            const w = 0.55, h = 0.72, r = 0.035;
            // 齿孔：沿四边走一圈，每个孔是往里凹的一个小半圆
            const edge = [];
            const corners = [[-w, -h], [w, -h], [w, h], [-w, h], [-w, -h]];
            for (let k = 0; k < 4; k += 1) {
                const [ax, ay] = corners[k], [bx, by] = corners[k + 1];
                const len = Math.hypot(bx - ax, by - ay), n = Math.round(len / 0.12);
                const nx = -(by - ay) / len, ny = (bx - ax) / len;
                for (let i = 0; i <= n * 6; i += 1) {
                    const t = i / (n * 6);
                    const bump = Math.max(0, Math.sin(t * n * Math.PI * 2 - Math.PI / 2)) * r;
                    edge.push([ax + (bx - ax) * t + nx * bump, ay + (by - ay) * t + ny * bump]);
                }
            }
            pen.line(edge);
            pen.line([[-w + 0.1, -h + 0.1], [w - 0.1, -h + 0.1], [w - 0.1, h - 0.28], [-w + 0.1, h - 0.28]], true);
            pen.wave([-w + 0.12, 0.05], [w - 0.12, 0.05], 3, 0.04);
            pen.circle(0.18, -0.3, 0.1);
            pen.note(`${pick(random, ['80', '1.20', '¥84', '50'])}`, 0, h - 0.14, 0.11);
        },
        // 邮戳：两个同心圆，中间日期，外圈地名，右边几道波浪线
        postmark(pen, random) {
            pen.circle(-0.35, 0, 0.42);
            pen.circle(-0.35, 0, 0.3);
            pen.line([[-0.62, -0.07], [-0.08, -0.07]]); pen.line([[-0.62, 0.07], [-0.08, 0.07]]);
            pen.note(`${2000 + Math.floor(random() * 26)}.${1 + Math.floor(random() * 12)}.${1 + Math.floor(random() * 28)}`, -0.35, 0, 0.075);
            pen.note(pick(random, ['港前', 'SEASIDE', '海滨', 'HARBOUR', '旧城']), -0.35, -0.18, 0.065);
            for (let i = 0; i < 4; i += 1) pen.wave([0.1, -0.22 + i * 0.15], [1.0, -0.22 + i * 0.15], 3, 0.035);
        },
        // 横格信纸：几道横线，一道竖的页边线，横线上手写的一串波浪（看不清的字），末尾署名
        ruledNote(pen, random) {
            pen.line([[-0.78, -0.95], [-0.78, 0.95]]);
            for (let i = 0; i < 7; i += 1) {
                const y = -0.75 + i * 0.25;
                pen.line([[-1, y], [1, y]]);
                if (i < 6) {
                    const end = i === 5 ? -0.1 : 0.6 + random() * 0.35;
                    // 手写的一行：一个个词（一段连笔的圈），词之间留空；字高、笔画疏密都不匀
                    let x = -0.7;
                    while (x < end - 0.08) {
                        const len = Math.min(end - x, 0.12 + random() * 0.28);
                        const pts = [];
                        const f = 38 + random() * 30, hgt = 0.025 + random() * 0.02, ph = random() * TAU;
                        for (let t = 0; t <= len; t += 0.008) {
                            const loop = Math.sin(t * f + ph);
                            const tall = random() < 0.04 ? 0.05 : 0;
                            pts.push([x + t + Math.cos(t * f + ph) * 0.008, y - 0.05 - loop * hgt - tall * Math.max(0, loop)]);
                        }
                        pen.line(pts);
                        x += len + 0.05 + random() * 0.04;
                    }
                }
            }
            pen.note(pick(random, ['—— 你的朋友', 'yours,', '敬上', 'P.S.']), 0.5, 0.82, 0.09);
        },
        // 寄出的路线：两个城市之间一道虚线弧，中间一只纸飞机，标里程
        airmail(pen, random) {
            const a = [-0.8, 0.4], b = [0.8, 0.2];
            pen.circle(...a, 0.05); pen.circle(...b, 0.05);
            const pts = [];
            for (let i = 0; i <= 30; i += 1) { const t = i / 30; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - Math.sin(Math.PI * t) * 0.6]); }
            pen.segments(pts.slice(1).map((p, i) => [pts[i], p]).filter((_, i) => i % 2 === 0));
            const m = pts[15];
            pen.line([[m[0] - 0.12, m[1] - 0.02], [m[0] + 0.14, m[1]], [m[0] - 0.12, m[1] + 0.08], [m[0] - 0.05, m[1] + 0.01]], true);
            pen.note(pick(random, ['北京', 'Osaka', '海滨', 'Paris']), a[0], a[1] + 0.14, 0.08);
            pen.note(pick(random, ['旧金山', 'Lisboa', '山城', 'Kyoto']), b[0], b[1] + 0.14, 0.08);
            pen.note(`${Math.floor(800 + random() * 9000)} km`, 0, 0.6, 0.075);
            pen.note('PAR AVION', 0, -0.62, 0.07);
        },
        // 火漆印：不规则的一圈、里面一个印的圈和一个字母，下面两条丝带
        waxSeal(pen, random) {
            const pts = [];
            for (let i = 0; i <= 20; i += 1) { const t = i / 20 * TAU; const r = 0.42 + (random() - 0.5) * 0.08; pts.push([Math.cos(t) * r, Math.sin(t) * r - 0.1]); }
            pts[20] = pts[0];
            pen.line(pts);
            pen.circle(0, -0.1, 0.28);
            pen.note(pick(random, ['R', 'A', 'M', '心', '✦']), 0, -0.1, 0.24);
            pen.line([[-0.15, 0.3], [-0.35, 0.9], [-0.22, 0.82], [-0.1, 0.92]]);
            pen.line([[0.15, 0.3], [0.3, 0.92], [0.18, 0.84], [0.06, 0.94]]);
        },

        /* ── 气象 ── */
        // 风玫瑰：几圈同心刻度，十六个方位各一根长短不一的风频条，中间写静风率
        windRose(pen, random) {
            [0.3, 0.55, 0.8].forEach(r => pen.circle(0, 0, r));
            const bars = [];
            for (let i = 0; i < 16; i += 1) {
                const a = i / 16 * TAU - Math.PI / 2;
                const len = 0.18 + Math.pow(random(), 1.6) * 0.72;
                bars.push([[Math.cos(a) * 0.12, Math.sin(a) * 0.12], [Math.cos(a) * len, Math.sin(a) * len]]);
            }
            pen.segments(bars);
            pen.circle(0, 0, 0.12);
            pen.note(`${Math.floor(3 + random() * 12)}%`, 0, 0, 0.07);
            pen.note('N', 0, -0.93, 0.1);
            pen.note(pick(random, ['1971–2000', 'JUL', 'DJF', '10 m']), 0.75, 0.9, 0.065, 'right');
        },
        // 云的分类：高中低三层各一朵轮廓（卷云几道钩、积云一团、积雨云砧状顶），左边标高度
        cloudTypes(pen, random) {
            pen.line([[-0.95, -0.85], [-0.95, 0.85]]);
            [[-0.6, 'Ci', '8 km'], [0, 'Ac', '4 km'], [0.55, 'Cu', '1 km']].forEach(([y, name, h]) => {
                pen.line([[-1.0, y], [-0.9, y]]);
                pen.note(h, -1.02, y - 0.05, 0.06, 'right');
                pen.note(name, 0.92, y, 0.08, 'right');
            });
            for (let i = 0; i < 3; i += 1) {
                const x = -0.55 + i * 0.4, y = -0.62 + (random() - 0.5) * 0.08;
                pen.line([[x, y], [x + 0.25, y - 0.05], [x + 0.32, y - 0.12]]);
            }
            const bumps = (cx, cy, w, n, h) => {
                const pts = [];
                for (let i = 0; i <= n * 8; i += 1) {
                    const t = i / (n * 8);
                    pts.push([cx - w / 2 + w * t, cy - Math.abs(Math.sin(t * n * Math.PI)) * h]);
                }
                pen.line(pts);
                pen.line([[cx - w / 2, cy], [cx + w / 2, cy]]);
            };
            bumps(-0.1, 0.02, 0.7, 5, 0.06);
            bumps(0.05, 0.6, 0.8, 4, 0.16);
            pen.line([[-0.25, 0.6], [-0.2, 0.36], [0.3, 0.36], [0.35, 0.6]]);
        },
        // 雨量筒：圆筒、漏斗、刻度，水位一道，旁边记降水量
        rainGauge(pen, random) {
            pen.line([[-0.3, -0.55], [-0.3, 0.85], [0.3, 0.85], [0.3, -0.55]]);
            pen.ellipse(0, -0.55, 0.3, 0.08);
            pen.line([[-0.3, -0.55], [-0.05, -0.3], [-0.05, -0.1]]);
            pen.line([[0.3, -0.55], [0.05, -0.3], [0.05, -0.1]]);
            const ticks = [];
            for (let i = 0; i <= 12; i += 1) { const y = 0.8 - i * 0.07; ticks.push([[0.3, y], [0.3 + (i % 5 === 0 ? 0.12 : 0.06), y]]); }
            pen.segments(ticks);
            const level = 0.8 - (0.15 + random() * 0.6);
            pen.wave([-0.28, level], [0.28, level], 3, 0.012);
            pen.note(`${(2 + random() * 40).toFixed(1)} mm`, 0.48, level, 0.08, 'left');
            for (let i = 0; i < 6; i += 1) { const x = -0.8 + random() * 1.6, y = -0.95 + random() * 0.3; pen.line([[x, y], [x - 0.04, y + 0.12]]); }
        },
        // 天气图：几道闭合的等压线绕着 H 和 L，一道冷锋（三角）一道暖锋（半圆）
        weatherMap(pen, random) {
            const lx = -0.35 + (random() - 0.5) * 0.2, ly = 0.05;
            [0.18, 0.36, 0.56].forEach((r, i) => {
                const pts = [];
                for (let k = 0; k <= 40; k += 1) { const a = k / 40 * TAU; const rr = r * (1 + Math.sin(a * 2 + i) * 0.12); pts.push([lx + Math.cos(a) * rr * 1.3, ly + Math.sin(a) * rr]); }
                pen.line(pts);
            });
            pen.note('L', lx, ly, 0.14);
            pen.note(`${Math.floor(985 + random() * 10)}`, lx + 0.5, ly - 0.42, 0.06);
            pen.note('H', 0.72, -0.6, 0.12);
            pen.circle(0.72, -0.6, 0.16);
            const front = [];
            for (let k = 0; k <= 20; k += 1) { const t = k / 20; front.push([lx + 0.2 + t * 0.6, ly + 0.15 + t * 0.7 - Math.sin(t * Math.PI) * 0.15]); }
            pen.line(front);
            for (let k = 2; k < 20; k += 5) {
                const [ax, ay] = front[k], [bx, by] = front[k + 2];
                pen.line([[ax, ay], [(ax + bx) / 2 + (by - ay) * 0.8, (ay + by) / 2 - (bx - ax) * 0.8], [bx, by]], true);
            }
            const warm = [];
            for (let k = 0; k <= 20; k += 1) { const t = k / 20; warm.push([lx + 0.25 + t * 0.7, ly - 0.05 - t * 0.25 + Math.sin(t * Math.PI) * 0.06]); }
            pen.line(warm);
            for (let k = 3; k < 20; k += 6) { const [cx, cy] = warm[k]; pen.ellipse(cx, cy, 0.05, 0.05, 0, Math.PI, TAU, 10); }
        },
        // 雪花：六重对称的枝晶，每根主枝两三对侧枝
        snowflake(pen, random) {
            const side = [0.3 + random() * 0.1, 0.52 + random() * 0.1, 0.72];
            const lens = [0.2 + random() * 0.08, 0.16 + random() * 0.06, 0.09];
            for (let i = 0; i < 6; i += 1) {
                const a = i / 6 * TAU;
                const ca = Math.cos(a), sa = Math.sin(a);
                const arm = [[[0, 0], [ca * 0.9, sa * 0.9]]];
                side.forEach((d, k) => {
                    const px = ca * d, py = sa * d;
                    [-1, 1].forEach((sgn) => {
                        const b = a + sgn * Math.PI / 3;
                        arm.push([[px, py], [px + Math.cos(b) * lens[k], py + Math.sin(b) * lens[k]]]);
                    });
                });
                pen.segments(arm);
            }
            pen.line(Array.from({ length: 7 }, (_, i) => [Math.cos(i / 6 * TAU) * 0.14, Math.sin(i / 6 * TAU) * 0.14]));
            pen.note(pick(random, ['P1e', 'dendrite', '−15 °C', 'C1f']), 0, 1.0, 0.07);
        },
        // 气压表盘：一道弧形刻度、指针和随动针，弧上写 RAIN / CHANGE / FAIR
        barometer(pen, random) {
            pen.circle(0, 0, 0.88);
            const from = Math.PI * 0.8, to = Math.PI * 2.2;
            pen.circle(0, 0, 0.7, from, to);
            const ticks = [];
            for (let i = 0; i <= 40; i += 1) {
                const a = from + (to - from) * i / 40;
                const r2 = i % 5 === 0 ? 0.58 : 0.64;
                ticks.push([[Math.cos(a) * 0.7, Math.sin(a) * 0.7], [Math.cos(a) * r2, Math.sin(a) * r2]]);
            }
            pen.segments(ticks);
            [['RAIN', 0.15], ['CHANGE', 0.5], ['FAIR', 0.85]].forEach(([w, k]) => {
                const a = from + (to - from) * k;
                pen.note(w, Math.cos(a) * 0.45, Math.sin(a) * 0.45, 0.07);
            });
            const a = from + (to - from) * (0.2 + random() * 0.6);
            pen.line([[-Math.cos(a) * 0.15, -Math.sin(a) * 0.15], [Math.cos(a) * 0.66, Math.sin(a) * 0.66]]);
            pen.dot(0, 0, 0.04);
            const b = a + (random() - 0.5) * 0.6;
            pen.dashed([0, 0], [Math.cos(b) * 0.6, Math.sin(b) * 0.6], 0.03);
            pen.note('hPa', 0, 0.5, 0.065);
        },

        /* ── 乐谱 ── */
        // 五线谱一小节：五道线、竖线、几个音符（符头、符干、连梁），一个拍号
        staff(pen, random) {
            const ys = [-0.32, -0.16, 0, 0.16, 0.32];
            pen.segments(ys.map(y => [[-0.95, y], [0.95, y]]));
            pen.line([[-0.95, -0.32], [-0.95, 0.32]]);
            pen.line([[0.95, -0.32], [0.95, 0.32]]);
            pen.line([[0.1, -0.32], [0.1, 0.32]]);
            pen.note(pick(random, ['4', '3', '6']), -0.78, -0.1, 0.17);
            pen.note(pick(random, ['4', '4', '8']), -0.78, 0.2, 0.17);
            const heads = [];
            for (let i = 0; i < 6; i += 1) {
                const x = -0.55 + i * (i < 3 ? 0.2 : 0.24) + (i >= 3 ? 0.08 : 0);
                const y = 0.32 - Math.floor(random() * 9) * 0.08;
                heads.push([x, y]);
                pen.ellipse(x, y, 0.065, 0.045, -0.4, 0, TAU, 16);
                pen.dot(x, y, 0.03);
                pen.line([[x + 0.06, y - 0.02], [x + 0.06, -0.62]]);
            }
            pen.line([[heads[0][0] + 0.06, -0.62], [heads[2][0] + 0.06, -0.62]]);
            pen.line([[heads[0][0] + 0.06, -0.55], [heads[2][0] + 0.06, -0.55]]);
            pen.line([[heads[3][0] + 0.06, -0.62], [heads[5][0] + 0.06, -0.62]]);
            pen.note(pick(random, ['mp', 'p', 'mf', 'pp']), -0.4, 0.55, 0.09);
            pen.line([[-0.1, 0.5], [0.4, 0.46], [0.9, 0.5]]);
        },
        // 节拍器：梯形的盒子、摆杆和砝码，摆杆两边两道虚线弧标摆幅，写 ♩= 速度
        metronome(pen, random) {
            pen.line([[-0.45, 0.85], [-0.2, -0.75], [0.2, -0.75], [0.45, 0.85]], true);
            pen.line([[-0.5, 0.85], [0.5, 0.85]]);
            const tilt = (random() - 0.5) * 0.7;
            const tip = [Math.sin(tilt) * 1.25, 0.55 - Math.cos(tilt) * 1.25];
            pen.line([[0, 0.55], tip]);
            const w = [Math.sin(tilt) * 0.75, 0.55 - Math.cos(tilt) * 0.75];
            pen.line([[w[0] - 0.08, w[1] - 0.05], [w[0] + 0.08, w[1] - 0.05], [w[0] + 0.06, w[1] + 0.07], [w[0] - 0.06, w[1] + 0.07]], true);
            pen.ellipse(0, 0.55, 1.1, 1.1, 0, -Math.PI / 2 - 0.4, -Math.PI / 2 - 0.15, 8);
            pen.ellipse(0, 0.55, 1.1, 1.1, 0, -Math.PI / 2 + 0.15, -Math.PI / 2 + 0.4, 8);
            const ticks = [];
            for (let i = 0; i < 9; i += 1) { const y = -0.5 + i * 0.12; ticks.push([[-0.06, y], [0.06, y]]); }
            pen.segments(ticks);
            pen.note(`M.M. = ${pick(random, [60, 72, 84, 96, 108, 120, 132])}`, 0.6, -0.6, 0.09, 'left');
        },
        // 音叉：U 形的叉、柄，叉尖两边一圈圈声波
        tuningFork(pen, random) {
            pen.line([[-0.12, -0.8], [-0.12, 0.05]]);
            pen.line([[0.12, -0.8], [0.12, 0.05]]);
            pen.ellipse(0, 0.05, 0.12, 0.12, 0, 0, Math.PI, 12);
            pen.line([[0, 0.17], [0, 0.9]]);
            pen.ellipse(0, 0.9, 0.06, 0.03);
            for (let k = 1; k <= 3; k += 1) {
                pen.ellipse(-0.12, -0.6, 0.15 * k, 0.22 * k, 0, Math.PI * 0.65, Math.PI * 1.35, 12);
                pen.ellipse(0.12, -0.6, 0.15 * k, 0.22 * k, 0, -Math.PI * 0.35, Math.PI * 0.35, 12);
            }
            pen.note(pick(random, ['A = 440 Hz', 'C 523.3', 'A 432']), 0.25, 0.55, 0.08, 'left');
        },
        // 一段琴键：白键一排，黑键两三一组，按下的几个键点一个圆点，下面写和弦名
        pianoKeys(pen, random) {
            const n = 10, w = 1.8 / n;
            pen.line([[-0.9, -0.4], [0.9, -0.4], [0.9, 0.45], [-0.9, 0.45]], true);
            pen.segments(Array.from({ length: n - 1 }, (_, i) => [[-0.9 + (i + 1) * w, -0.4], [-0.9 + (i + 1) * w, 0.45]]));
            [0, 1, 3, 4, 5, 7, 8].forEach((i) => {
                const x = -0.9 + (i + 1) * w - w * 0.3;
                pen.line([[x, -0.4], [x, 0.12], [x + w * 0.6, 0.12], [x + w * 0.6, -0.4]]);
            });
            const root = Math.floor(random() * 5);
            [root, root + 2, root + 4].forEach(i => pen.dot(-0.9 + (i + 0.5) * w, 0.32, 0.035));
            pen.note(pick(random, ['Cmaj7', 'Am9', 'F/G', 'Dm7', 'E♭add9']), 0, 0.68, 0.1);
        },
        // 示波器：方格、一道波形（基频加泛音），标频率和每格时间
        waveform(pen, random) {
            pen.line([[-0.9, -0.55], [0.9, -0.55], [0.9, 0.55], [-0.9, 0.55]], true);
            const grid = [];
            for (let i = 1; i < 8; i += 1) grid.push([[-0.9 + i * 0.225, -0.55], [-0.9 + i * 0.225, 0.55]]);
            for (let i = 1; i < 4; i += 1) grid.push([[-0.9, -0.55 + i * 0.275], [0.9, -0.55 + i * 0.275]]);
            pen.dashed([-0.9, 0], [0.9, 0], 0.03);
            pen.segments(grid.filter((_, i) => i % 2 === 0));
            const f = 2 + Math.floor(random() * 3), h2 = random() * 0.5, h3 = random() * 0.3;
            const pts = [];
            for (let i = 0; i <= 120; i += 1) {
                const t = i / 120;
                const v = Math.sin(t * f * TAU) + h2 * Math.sin(t * f * 2 * TAU + 1) + h3 * Math.sin(t * f * 3 * TAU);
                pts.push([-0.9 + 1.8 * t, -v * 0.3 / (1 + h2 + h3) * 1.4]);
            }
            pen.line(pts);
            pen.note(`${Math.floor(110 + random() * 800)} Hz`, -0.88, -0.65, 0.07, 'left');
            pen.note('2 ms/div', 0.88, 0.68, 0.06, 'right');
        },
        // 唱片：几圈纹路、中间标签和孔，唱臂从右上角搭过来
        vinyl(pen, random) {
            pen.circle(0, 0, 0.85);
            [0.75, 0.62, 0.5].forEach(r => pen.circle(0, 0, r, random() * TAU, random() * TAU + TAU * 0.8));
            pen.circle(0, 0, 0.28);
            pen.dot(0, 0, 0.03);
            pen.note(pick(random, ['33⅓', '45', 'A-1', 'SIDE B']), 0, 0.14, 0.07);
            pen.circle(0.85, -0.85, 0.08);
            pen.line([[0.85, -0.85], [0.95, -0.2], [0.45, 0.35]]);
            pen.line([[0.4, 0.3], [0.5, 0.42]]);
        }
    };

    const KINDS = Object.freeze(Object.keys(DRAW));

    // 意象场景：一首歌一套（Folia 只有一种演算纸）。每套有自己的线稿、垫底大图和背景纹样；
    // 线稿还是同一支笔、同一种细线插图的画法，所以换套不换手。
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    // 每套场景的版面零件用自己的说法：行号换成公里标、经纬度、赤经、门牌、图号、邮编……
    const SCENES = Object.freeze({
        notebook: {
            mark: n => `L.${pad(n)}`,
            interlude: 'INTERLUDE',
            label: '演算纸',
            kinds: ['orbit', 'starmap', 'lattice', 'cell', 'molecule', 'detector', 'feynman', 'paths', 'draft', 'shower', 'decay', 'spectrum', 'potential', 'running', 'cherenkov', 'collider', 'bubble', 'penguin', 'box'],
            tone: ['orbit', 'lattice', 'detector', 'feynman', 'paths', 'shower', 'spectrum', 'potential', 'collider', 'bubble', 'penguin'],
            backdrops: [['band', 0.34], ['graph', 0.24], ['arcs', 0.26], ['none', 0.16]]
        },
        rail: {
            mark: (n, r) => `K${10 + n}+${pad(Math.floor(r() * 10) * 100, 3)}`,
            interlude: '回送 / OUT OF SERVICE',
            label: '铁道',
            kinds: ['rail', 'timetable', 'signal', 'ticket', 'catenary', 'trackSection', 'routeMap'],
            tone: ['rail', 'timetable', 'catenary', 'routeMap', 'trackSection', 'signal'],
            backdrops: [['sleepers', 0.34], ['band', 0.22], ['graph', 0.22], ['none', 0.22]]
        },
        sea: {
            mark: (n, r) => `${(20 + r() * 30).toFixed(2)}°N ${(110 + r() * 40).toFixed(2)}°E`,
            interlude: 'SLACK WATER',
            label: '海',
            kinds: ['tide', 'compass', 'isobaths', 'lighthouse', 'waveSection', 'hullLines'],
            tone: ['compass', 'isobaths', 'lighthouse', 'waveSection', 'hullLines', 'tide'],
            backdrops: [['swell', 0.4], ['arcs', 0.22], ['band', 0.2], ['none', 0.18]]
        },
        city: {
            mark: (n, r) => `${n} 号  ${1 + Math.floor(r() * 30)}F`,
            interlude: 'CLOSED',
            label: '城市',
            kinds: ['floorPlan', 'streetGrid', 'facade', 'isoBlock', 'lamp', 'skyline'],
            tone: ['streetGrid', 'facade', 'isoBlock', 'skyline', 'floorPlan'],
            backdrops: [['blocks', 0.36], ['graph', 0.22], ['band', 0.2], ['none', 0.22]]
        },
        flora: {
            mark: n => `fig. ${n}`,
            interlude: 'dormant',
            label: '植物',
            kinds: ['leaf', 'floralDiagram', 'phyllotaxis', 'branch', 'seedHead', 'sprout'],
            tone: ['leaf', 'floralDiagram', 'phyllotaxis', 'branch', 'seedHead'],
            backdrops: [['stems', 0.4], ['arcs', 0.2], ['band', 0.2], ['none', 0.2]]
        },
        letters: {
            mark: (n, r) => `No. ${pad(n)}  〒${String(100 + Math.floor(r() * 899)).padStart(3, '0')}-${String(Math.floor(r() * 9999)).padStart(4, '0')}`,
            interlude: 'P.S.',
            label: '信笺',
            kinds: ['envelope', 'stamp', 'postmark', 'ruledNote', 'airmail', 'waxSeal'],
            tone: ['envelope', 'stamp', 'postmark', 'ruledNote', 'airmail'],
            backdrops: [['ruled', 0.42], ['band', 0.22], ['graph', 0.14], ['none', 0.22]]
        },
        weather: {
            mark: (n, r) => `${Math.floor(990 + r() * 40)} hPa  ${(r() * 30).toFixed(1)} °C`,
            interlude: 'CLEARING',
            label: '天气',
            kinds: ['windRose', 'cloudTypes', 'rainGauge', 'weatherMap', 'snowflake', 'barometer'],
            tone: ['windRose', 'weatherMap', 'barometer', 'snowflake', 'cloudTypes'],
            backdrops: [['swell', 0.26], ['arcs', 0.26], ['graph', 0.2], ['none', 0.28]]
        },
        score: {
            mark: n => `m. ${n}`,
            interlude: 'TACET',
            label: '乐谱',
            kinds: ['staff', 'metronome', 'tuningFork', 'pianoKeys', 'waveform', 'vinyl'],
            tone: ['staff', 'vinyl', 'waveform', 'pianoKeys', 'metronome'],
            backdrops: [['ruled', 0.4], ['arcs', 0.2], ['band', 0.18], ['none', 0.22]]
        },
        night: {
            mark: (n, r) => `RA ${pad(Math.floor(r() * 24))}ʰ${pad(Math.floor(r() * 60))}ᵐ  m = ${(r() * 6).toFixed(1)}`,
            interlude: 'DAWN',
            label: '星夜',
            kinds: ['starmap', 'orbit', 'constellation', 'moonPhases', 'altaz', 'telescope', 'lightCurve'],
            tone: ['orbit', 'constellation', 'altaz', 'telescope', 'moonPhases', 'starmap'],
            backdrops: [['trails', 0.42], ['radial', 0.18], ['band', 0.2], ['none', 0.2]]
        }
    });

    // 画一张图：kind、世界中心、半径、旋转。返回画完后的下一个笔序。
    const drawFigure = (pen, kind, x, y, r, rot, random) => {
        pen.place(x, y, r, rot);
        (DRAW[kind] || DRAW.orbit)(pen, random);
        return pen.order;
    };

    global.MusicStageInkFigures = Object.freeze({ createPen, softLayer, flushSoft, drawFigure, KINDS, SCENES, NOTE_FONT });
})(window);
