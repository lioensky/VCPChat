/*
 * 雾笺（fogpane）：雨夜公交车起雾的车窗。手指一笔一笔在雾上写歌词，写过的地方透出窗外的
 * 雨夜街景（楼群、霓虹、路灯、车灯、积水倒影，跟着车往前走），过一会儿雾重新漫回来；
 * 玻璃上有雨点、挂着的水珠和往下淌的水痕，淌过的地方也清出一道。
 *
 * 全部在 GPU 上按播放时间算：
 *   - 窗外：一个小程序在 1/3 分辨率的离屏图上画，生成 mipmap（雾里看到的是它的模糊档）；
 *   - 主画面：一个全屏三角形。每句歌词准备一次「指痕图」（半分辨率画布：字按手指粗细描出来）
 *     和编号图，每个字的书写时刻、字框放进一张小浮点纹理；着色器按时刻沿书写方向把字一笔扫出来，
 *     到点再按噪点让雾漫回来。每帧不往显卡传图。
 * 负载：默认每秒 30 帧（节能 24、极致 60），暂停且输入不变时不画。
 */
(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before fogpane-manager.js');

    const { clamp, seededRandom, createElement } = Utils;
    const { resolveSupplementalText, buildGlyphTimeline, readableText } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const PIXELS = Object.freeze({ 'energy-saving': 0.9e6, standard: 1.6e6, ultimate: 3.0e6 });
    const RATIO = Object.freeze({ 'energy-saving': 1, standard: 1.5, ultimate: 2 });
    const ATLAS_SCALE = 0.5;
    const LINE_SLOTS = 3;
    const MAX_GLYPHS = 255;
    const FOG_HOLD = 4.5;
    const FOG_RETURN = 3.2;
    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

    const hexRgb = (hex, fallback) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return fallback;
        const n = parseInt(match[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const mixRgb = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const luminance = c => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

    /* ───────────────────────── 排版：每句写在窗上的位置 ───────────────────────── */

    const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

    // 整首一次排好（只用 measureText），和准备顺序无关：拖进度到哪都一样。
    /* ───────────────────────── 字的骨架（手指写的笔画） ───────────────────────── */

    // 手指在起雾的玻璃上写字：笔画是一样粗的，圆头。做法是把字画成小图、细化成一像素宽的骨架，
    // 再把骨架连成一笔一笔（从左上往右下排先后），每个点记下它在整个字里写到的进度（0..1）。
    // 结果按「字|字重」缓存，点的坐标是相对字号的（0..1，原点在字框左上）。
    const SKEL = 72;
    const skeletonCache = new Map();
    let skelCanvas = null;
    const thin = (img, w, h) => {
        // Zhang–Suen 细化
        const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]);
        let changed = true;
        const kill = [];
        while (changed) {
            changed = false;
            for (let pass = 0; pass < 2; pass += 1) {
                kill.length = 0;
                for (let y = 0; y < h; y += 1) {
                    for (let x = 0; x < w; x += 1) {
                        if (!img[y * w + x]) continue;
                        const n = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
                        const b = n.reduce((sum, v) => sum + v, 0);
                        if (b < 2 || b > 6) continue;
                        let a = 0;
                        for (let k = 0; k < 8; k += 1) if (!n[k] && n[(k + 1) % 8]) a += 1;
                        if (a !== 1) continue;
                        if (pass === 0 ? (n[0] * n[2] * n[4] || n[2] * n[4] * n[6]) : (n[0] * n[2] * n[6] || n[0] * n[4] * n[6])) continue;
                        kill.push(y * w + x);
                    }
                }
                if (kill.length) { changed = true; kill.forEach((i) => { img[i] = 0; }); }
            }
        }
        return img;
    };
    const skeletonOf = (ch, font) => {
        const key = `${ch}|${font}`;
        if (skeletonCache.has(key)) return skeletonCache.get(key);
        if (!skelCanvas) { skelCanvas = document.createElement('canvas'); skelCanvas.width = SKEL; skelCanvas.height = SKEL; }
        const c = skelCanvas.getContext('2d', { willReadFrequently: true });
        c.clearRect(0, 0, SKEL, SKEL);
        c.fillStyle = '#fff';
        c.textBaseline = 'alphabetic';
        const px = SKEL * 0.72;
        c.font = font(px);
        const w = c.measureText(ch).width;
        const ox = (SKEL - w) / 2, base = SKEL * 0.78;
        c.fillText(ch, ox, base);
        const raw = c.getImageData(0, 0, SKEL, SKEL).data;
        const img = new Uint8Array(SKEL * SKEL);
        for (let i = 0; i < img.length; i += 1) img[i] = raw[i * 4 + 3] > 110 ? 1 : 0;
        thin(img, SKEL, SKEL);
        // 连笔：从还没走过的点里挑「端点里最靠左上的」开始，沿着邻点一直走（优先不拐弯），走不动就断成一笔
        const on = (x, y) => x >= 0 && y >= 0 && x < SKEL && y < SKEL && img[y * SKEL + x] === 1;
        const nbrs = (x, y) => { const out = []; for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) if ((dx || dy) && on(x + dx, y + dy)) out.push([x + dx, y + dy]); return out; };
        const seen = new Uint8Array(SKEL * SKEL);
        const pts = [];
        for (let y = 0; y < SKEL; y += 1) for (let x = 0; x < SKEL; x += 1) if (img[y * SKEL + x]) pts.push([x, y]);
        const strokes = [];
        const rank = ([x, y]) => y * 0.7 + x * 0.3;
        while (true) {
            const left = pts.filter(([x, y]) => !seen[y * SKEL + x]);
            if (!left.length) break;
            const free = ([x, y]) => nbrs(x, y).filter(([a, b]) => !seen[b * SKEL + a]).length;
            const ends = left.filter(q => free(q) <= 1);
            const start = (ends.length ? ends : left).reduce((m, q) => (rank(q) < rank(m) ? q : m));
            const stroke = [start];
            seen[start[1] * SKEL + start[0]] = 1;
            let cur = start, dir = [0, 0];
            while (true) {
                const next = nbrs(cur[0], cur[1]).filter(([a, b]) => !seen[b * SKEL + a]);
                if (!next.length) break;
                next.sort((p, q) => {
                    const dp = (p[0] - cur[0]) * dir[0] + (p[1] - cur[1]) * dir[1];
                    const dq = (q[0] - cur[0]) * dir[0] + (q[1] - cur[1]) * dir[1];
                    return dq - dp || (Math.abs(p[0] - cur[0]) + Math.abs(p[1] - cur[1])) - (Math.abs(q[0] - cur[0]) + Math.abs(q[1] - cur[1]));
                });
                const n = next[0];
                dir = [n[0] - cur[0], n[1] - cur[1]];
                seen[n[1] * SKEL + n[0]] = 1;
                stroke.push(n);
                cur = n;
            }
            if (stroke.length >= 3) strokes.push(stroke);
        }
        const total = strokes.reduce((sum, st) => sum + st.length, 0) || 1;
        let done = 0;
        const out = strokes.map((st) => st.map(([x, y]) => { done += 1; return [(x - ox) / px, (y - base) / px, done / total]; }));
        const result = { strokes: out, width: w / px };
        skeletonCache.set(key, result);
        if (skeletonCache.size > 600) skeletonCache.delete(skeletonCache.keys().next().value);
        return result;
    };

    const planSong = (lines, W, H, fontScale, measure, seedKey, avoid = null) => {
        const sung = lines.filter(line => readableText(line.fullText));
        const placed = [];
        sung.forEach((line, index) => {
            const random = seededRandom(`fogpane:${seedKey}:${index}`);
            const glyphs = buildGlyphTimeline(line)
                .map(g => ({ text: g.text, start: g.startTime, end: g.endTime }));
            const visible = glyphs.filter(g => g.text.trim());
            if (!visible.length) return;
            const cjk = visible.filter(g => CJK.test(g.text)).length / visible.length > 0.5;
            const n = visible.length;
            const credit = line.credits || '';
            // 三种写法：一两行；大小不一、按词分两三行错开写（像 Folia 那样占满玻璃）；竖着一列列往下写
            const style = credit ? 'rows' : cjk && n <= 14 && random() < 0.25 ? 'vertical' : random() < 0.7 ? 'mixed' : 'rows';
            const perRow = style === 'mixed' ? (cjk ? 4.2 : 11) : cjk ? 9 : 20;
            const rows = Math.min(3, Math.max(1, Math.round(n / perRow)));
            // 词的边界：中文也只在词与词之间换行
            const wordEnd = new Set();
            Utils.wordPlan(glyphs, `fogpane:${seedKey}:${index}`).forEach(w => wordEnd.add(w.to - 1));
            // 字号：一行占窗宽六成上下，手写的字不会太整齐
            let base = clamp((W * (0.46 + random() * 0.14)) / Math.ceil(n / rows) / (cjk ? 1 : 0.55), Math.max(26, H * 0.065), H * 0.14) * fontScale;
            // 按行切开（拉丁字母在空格处换行）
            const rowsOf = [];
            let row = [];
            glyphs.forEach((g, i) => {
                row.push(g);
                const count = row.filter(x => x.text.trim()).length;
                const target = Math.ceil(n / rows);
                // 西文在空格、连字符处换行；一个词长得放不下时硬断
                const breakable = (cjk && wordEnd.has(i)) || !g.text.trim() || /^[-–—/]$/.test(g.text) || count >= target * 1.6;
                if (rowsOf.length < rows - 1 && count >= target && breakable) { rowsOf.push(row); row = []; }
                else if (i === glyphs.length - 1) rowsOf.push(row);
            });
            if (row.length && !rowsOf.includes(row)) rowsOf.push(row);
            const items = [];
            let width = 0;
            // 片尾的曲名、歌手：一律横着写，曲名大、歌手小
            if (credit) base = clamp(credit === 'title' ? W * 0.56 / Math.ceil(n / rows) / (cjk ? 1 : 0.55) : H * 0.05, H * 0.045, credit === 'title' ? H * 0.12 : H * 0.06) * fontScale;
            if (style === 'vertical') {
                const cols = n > 7 ? 2 : 1;
                const perCol = Math.ceil(n / cols);
                const size = clamp(H * 0.5 / perCol, H * 0.05, H * 0.11) * fontScale;
                let k = 0;
                visible.forEach((g) => {
                    const col = Math.floor(k / perCol), row = k % perCol;
                    const w = measure(g.text, size, CJK.test(g.text));
                    items.push({ g, x: (cols - 1 - col) * size * 1.45 + (size - w) / 2 + (random() - 0.5) * size * 0.1, row: 0, w,
                        size: size * (0.92 + random() * 0.16), rot: (random() - 0.5) * 0.1, dy: 0,
                        by: (row + 0.85) * size * 1.08 + col * size * 0.5 });
                    k += 1;
                });
                width = cols * size * 1.45;
            }
            const sizes = style === 'mixed' ? rowsOf.map(r => r.map(() => 1)) : null;
            if (sizes) {
                // 按词分主次：重点词写得大，「的」「着」这些写得小
                const words = Utils.wordPlan(glyphs, `fogpane:${seedKey}:${index}`);
                const scaleAt = new Map();
                words.forEach(w => glyphs.slice(w.from, w.to).forEach(g => scaleAt.set(g, w.scale)));
                rowsOf.forEach((r, ri) => r.forEach((g, gi) => { sizes[ri][gi] = scaleAt.get(g) ?? 1; }));
            }
            if (style !== 'vertical') rowsOf.forEach((r, ri) => {
                let x = (random() - 0.5) * base * 0.6 + ri * base * (random() * 0.5);
                r.forEach((g, gi) => {
                    const k = sizes ? sizes[ri][gi] : 1;
                    const w = g.text.trim() ? measure(g.text, base * k, CJK.test(g.text)) : base * (cjk ? 0.5 : 0.32);
                    if (g.text.trim()) {
                        const calm = credit ? 0.4 : 1;
                        items.push({ g, x, row: ri, w, size: base * k * (0.92 + random() * 0.16 * calm),
                            rot: (random() - 0.5) * 0.12 * calm, dy: ((random() - 0.5) * base * 0.12 + (k - 1) * base * 0.3) * calm });
                    }
                    x += w * (cjk ? 1.02 : 1);
                });
                width = Math.max(width, x);
            });
            let height = style === 'vertical' ? Math.max(...items.map(it => it.by + it.size * 0.3)) : rowsOf.length * base * 1.25 * (sizes ? 1.2 : 1);
            // 找一个和前两句重叠最少的地方（窗的安全区里）
            const safe = [W * 0.08, H * 0.16, W * 0.92, H * 0.76];
            // 还是比安全区宽（窄窗口、超长的词）：整句缩小到放得下
            const fit = Math.min(1, (safe[2] - safe[0]) / Math.max(1, width), (safe[3] - safe[1]) / Math.max(1, height));
            if (fit < 1) {
                items.forEach((it) => {
                    it.x *= fit; it.w *= fit; it.size *= fit; it.dy *= fit;
                    if (it.by !== undefined) it.by *= fit;
                });
                base *= fit; width *= fit; height *= fit;
            }
            let best = null;
            if (credit) {
                // 曲名写在玻璃正中偏上，歌手写在它下面
                const above = credit === 'artist' ? placed.findLast(p => p.line.credits === 'title') : null;
                const x0 = (W - width) / 2;
                const y0 = above ? above.box[3] + H * 0.03 : H * 0.4 - height / 2;
                best = { box: [x0, y0, x0 + width, y0 + height], cost: 0 };
            }
            for (let k = 0; k < (credit ? 0 : 16); k += 1) {
                const x0 = safe[0] + random() * Math.max(1, safe[2] - safe[0] - width);
                const y0 = safe[1] + random() * Math.max(1, safe[3] - safe[1] - height);
                const box = [x0, y0, x0 + width, y0 + height];
                const cost = placed.slice(-2).reduce((s, p, j) => s + overlap(box, p.box) * (j === placed.slice(-2).length - 1 ? 2 : 1), 0)
                    + (avoid ? overlap(box, avoid) * 6 : 0);   // 左上角的档案卡底下别写字
                if (!best || cost < best.cost) best = { box, cost };
            }
            const [bx, by] = best.box;
            items.forEach((it) => {
                it.x += bx;
                it.baseline = it.by !== undefined ? by + it.by : by + (it.row + 0.85) * base * 1.25 * (sizes ? 1.2 : 1) + it.dy;
                it.box = [it.x - it.size * 0.08, it.baseline - it.size * 0.9, it.x + it.w + it.size * 0.08, it.baseline + it.size * 0.18];
            });
            const end = Math.max(line.endTime, line.vocalEndTime || 0, ...items.map(it => it.g.end));
            placed.push({ index, line, items, box: best.box, start: line.startTime, end, cjk });
        });
        // 雾什么时候漫回来：唱完后停一会儿；后面的句子要写到它的位置上时提前漫（让位），
        // 第三句开写时最晚也要开始漫。
        placed.forEach((p, i) => {
            let back = p.end + FOG_HOLD;
            const third = placed[i + 3];
            if (third) back = Math.min(back, third.start - FOG_RETURN * 0.5);
            const credits = placed.find(q => q.line.credits);
            if (credits && !p.line.credits) back = Math.min(back, credits.start - FOG_RETURN - 0.2);   // 片尾开写前雾已经漫满
            for (const q of placed.slice(i + 1, i + 3)) {
                if (overlap(p.box, q.box) > 0) back = Math.min(back, q.start - FOG_RETURN * 0.6);
            }
            p.fogBack = p.line.credits ? 1e6 : Math.max(back, p.end + 0.3);   // 片尾写完一直留着
        });
        return placed;
    };

    /* ───────────────────────── GL ───────────────────────── */

    const VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

    const COMMON = `
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}
${Utils.NOISE_GLSL}`;

    // 窗外：x 按窗宽高比，y 朝上 0..1。车往前开，近处的东西走得快。
    const SCENE_FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uAspect;
uniform float uT;
uniform float uBump;
uniform vec3 uSky;
uniform vec3 uBld;
uniform vec3 uWin;
uniform vec3 uNeon;
uniform vec3 uNeon2;
uniform vec3 uLamp;
uniform float uRain;
uniform float uSnow;
uniform float uAqua;
out vec4 outColor;
${COMMON}
float disc(vec2 p, vec2 c, float r) {
    float d = length(p - c) / r;
    return smoothstep(1.0, 0.7, d) * (0.75 + 0.25 * smoothstep(0.6, 1.0, d));
}
vec3 lights(vec2 p, float horizonY) {
    vec3 col = vec3(0.0);
    // 霓虹招牌的光斑（中景）
    float x = p.x + uT * 0.16;
    float cw = 0.34;
    float c = floor(x / cw);
    for (int k = -1; k <= 1; k++) {
        float id = c + float(k);
        vec2 h = hash22(vec2(id, 3.0));
        if (h.x < 0.25) continue;
        vec2 center = vec2((id + 0.2 + h.y * 0.6) * cw - uT * 0.16, horizonY + 0.14 + h.x * 0.32);
        float r = 0.032 + 0.04 * hash12(vec2(id, 9.0));
        vec3 tint = hash12(vec2(id, 5.0)) < 0.55 ? uNeon : uNeon2;
        col += tint * disc(p, center, r) * 1.1;
    }
    // 路灯（近处，走得快，大光斑）
    x = p.x + uT * 0.7;
    cw = 0.95;
    c = floor(x / cw);
    for (int k = -1; k <= 1; k++) {
        float id = c + float(k);
        vec2 center = vec2((id + 0.5) * cw - uT * 0.7, 0.8 + hash12(vec2(id, 1.0)) * 0.06);
        col += uLamp * disc(p, center, 0.095) * 1.05;
    }
    // 对面车道的车灯（往反方向走）和同向的尾灯
    x = p.x - uT * 0.42;
    cw = 0.55;
    c = floor(x / cw);
    for (int k = -1; k <= 1; k++) {
        float id = c + float(k);
        if (hash12(vec2(id, 7.0)) < 0.4) continue;
        float cx = (id + 0.3) * cw + uT * 0.42;
        col += vec3(1.0, 0.95, 0.85) * (disc(p, vec2(cx, horizonY - 0.03), 0.018) + disc(p, vec2(cx + 0.06, horizonY - 0.03), 0.018)) * 0.9;
    }
    x = p.x + uT * 0.09;
    cw = 0.7;
    c = floor(x / cw);
    for (int k = -1; k <= 1; k++) {
        float id = c + float(k);
        if (hash12(vec2(id, 11.0)) < 0.5) continue;
        float cx = (id + 0.4) * cw - uT * 0.09;
        col += vec3(1.0, 0.15, 0.1) * (disc(p, vec2(cx, horizonY - 0.07), 0.013) + disc(p, vec2(cx + 0.09, horizonY - 0.07), 0.013)) * 0.85;
    }
    return col;
}
vec3 street(vec2 p) {
    float horizonY = 0.26;
    // 天：城市的光把低处的云照亮
    vec3 col = mix(uSky * 1.7 + vec3(0.07, 0.05, 0.04), uSky * 0.7, smoothstep(0.25, 1.0, p.y));
    // 远处楼群（慢）和近一层楼（快一点），亮着的窗
    for (int layer = 0; layer < 2; layer++) {
        float speed = layer == 0 ? 0.035 : 0.1;
        float cw = layer == 0 ? 0.16 : 0.27;
        float x = p.x + uT * speed;
        float c = floor(x / cw);
        float h = horizonY + (layer == 0 ? 0.3 : 0.18) + hash12(vec2(c, float(layer) * 13.0)) * (layer == 0 ? 0.4 : 0.36);
        if (p.y < h) {
            vec2 local = vec2(fract(x / cw), (p.y - horizonY) / (h - horizonY));
            vec3 b = uBld * (layer == 0 ? 0.75 : 1.0);
            vec2 w = floor(local * vec2(5.0, 14.0));
            float lit = step(0.8, hash12(w + c * 7.0 + float(layer) * 31.0));
            vec2 f = fract(local * vec2(5.0, 14.0));
            float pane = step(0.3, f.x) * step(f.x, 0.7) * step(0.3, f.y) * step(f.y, 0.7);
            col = b + uWin * lit * pane * (layer == 0 ? 0.55 : 0.8);
        }
    }
    // 马路：湿的，倒着映出灯
    if (p.y < horizonY) {
        col = uBld * 0.5;
        vec2 q = vec2(p.x, horizonY * 2.0 - p.y);
        float fade = smoothstep(0.0, horizonY, p.y);
        col += lights(q + vec2(sin(p.y * 90.0 + uT * 2.0) * 0.004, 0.0), horizonY) * 0.35 * (0.4 + 0.6 * fade);
    }
    col += lights(p, horizonY);
    // 窗外的雨丝
    float rx = floor(p.x * 140.0);
    float ry = fract(p.y * 1.6 + uT * (1.4 + hash12(vec2(rx, 2.0))) + hash12(vec2(rx, 4.0)));
    col += vec3(0.6, 0.65, 0.75) * step(0.93, hash12(vec2(rx, 8.0))) * smoothstep(0.08, 0.0, ry) * 0.18 * uRain;
    // 下雪：三层雪片，近的大、快、斜着飘
    if (uSnow > 0.0) {
        for (int L = 0; L < 3; L++) {
            float fl = float(L);
            float scale = 18.0 + fl * 14.0;
            vec2 sp = p * scale + vec2(uT * (2.0 - fl * 0.5) + sin(p.y * 3.0 + uT * 0.7 + fl) * 0.6, uT * (3.4 - fl * 0.9));
            vec2 cell = floor(sp);
            vec2 h = hash22(cell + fl * 19.0);
            vec2 f = fract(sp) - (0.25 + h * 0.5);
            float flake = smoothstep(0.12 - fl * 0.03, 0.0, length(f)) * step(0.55, h.x);
            col += vec3(0.85, 0.88, 0.95) * flake * (0.55 - fl * 0.12) * uSnow;
        }
        col = mix(col, vec3(0.75, 0.78, 0.85), smoothstep(0.26, 0.0, p.y) * 0.35 * uSnow);
    }
    return col;
}
// 水族馆：车停在一面大鱼缸前。顶上漏下来的光柱、水母、气泡、远处的鱼群、水草和沙底
vec3 aquarium(vec2 p) {
    float t = uT * 0.35;
    vec3 deep = vec3(0.005, 0.02, 0.05) + uSky * 0.15;
    vec3 shallow = vec3(0.03, 0.2, 0.3) + uNeon2 * 0.06;
    vec3 col = mix(deep, shallow, smoothstep(0.0, 1.05, p.y));
    // 光柱：斜着从水面落下，慢慢晃
    float rays = 0.0;
    for (int k = 0; k < 3; k++) {
        float fk = float(k);
        float x = (p.x + p.y * (0.32 + fk * 0.05)) * (5.0 + fk * 3.0) + sin(p.x * 1.7 + t * (0.4 + fk * 0.13) + fk) * 1.4 + t * 0.2;
        rays += pow(0.5 + 0.5 * sin(x), 8.0 + fk * 4.0) * (0.5 - fk * 0.12);
    }
    col += vec3(0.35, 0.62, 0.7) * rays * smoothstep(0.05, 1.0, p.y) * 0.6;
    // 缸顶的灯：水面上一团亮
    vec2 ld = (p - vec2(uAspect * 0.62, 1.08)) * vec2(0.6, 1.0);
    col += vec3(0.55, 0.85, 0.9) * exp(-dot(ld, ld) * 7.0) * 0.55;
    // 水面的亮纹
    float surf = smoothstep(0.86, 1.0, p.y) * (0.5 + 0.5 * sin(p.x * 22.0 + sin(p.x * 7.0 + t * 1.3) * 2.0 + t));
    col += vec3(0.4, 0.75, 0.8) * surf * 0.18;
    // 远处的鱼群：一小片暗影，整群慢慢游过去
    for (int L = 0; L < 2; L++) {
        float fl = float(L);
        float speed = 0.05 + fl * 0.04;
        vec2 sp = vec2((p.x + uT * speed) * (26.0 - fl * 8.0), (p.y - 0.42 - fl * 0.12 + sin(p.x * 2.0 + t) * 0.03) * (26.0 - fl * 8.0));
        vec2 cell = floor(sp);
        float school = smoothstep(0.55, 0.75, vnoise(vec2(cell.x * 0.12 + fl * 7.0, cell.y * 0.4)));
        vec2 f = fract(sp) - 0.5;
        f.y += (hash12(cell + fl) - 0.5) * 0.3;
        float body = smoothstep(0.08, 0.0, length(f * vec2(0.9, 2.6)) - 0.12);
        float tail = step(f.x, -0.2) * step(abs(f.y), (-0.2 - f.x) * 0.9) * step(-0.38, f.x);
        float fish = max(body, tail) * school * step(abs(sp.y), 3.0);
        col = mix(col, deep * (0.7 + fl * 0.4) + uNeon2 * 0.03, fish * (0.55 + fl * 0.2));
    }
    // 水草：几簇深色的带子，随水摆
    for (int k = 0; k < 6; k++) {
        float fk = float(k);
        float bx = (hash12(vec2(fk, 41.0)) * 1.1 - 0.05) * uAspect;
        float hgt = 0.28 + hash12(vec2(fk, 43.0)) * 0.32;
        float sway = sin(p.y * 6.0 + t * 1.4 + fk * 1.7) * 0.03 * p.y / hgt;
        float w = 0.012 * (1.0 - p.y / hgt * 0.7);
        float blade = smoothstep(w, w * 0.4, abs(p.x - bx - sway)) * step(p.y, hgt);
        col = mix(col, vec3(0.02, 0.09, 0.07), blade * 0.85);
    }
    // 沙底和岩：沙上一层晃动的焦散网
    float ground = 0.09 + vnoise(vec2(p.x * 3.0, 1.0)) * 0.06 + vnoise(vec2(p.x * 11.0, 2.0)) * 0.02;
    if (p.y < ground) {
        vec2 cq = p * 9.0;
        float c1 = abs(vnoise(cq + vec2(t * 0.6, t * 0.3)) - 0.5);
        float c2 = abs(vnoise(cq * 1.7 - vec2(t * 0.4, -t * 0.5)) - 0.5);
        float caust = pow(1.0 - min(c1, c2) * 2.0, 10.0);
        col = mix(vec3(0.07, 0.11, 0.13), vec3(0.16, 0.22, 0.24), smoothstep(0.0, ground, p.y)) + vec3(0.4, 0.7, 0.75) * caust * 0.3;
    }
    // 水母：伞盖一张一缩往上漂，触须拖在后面
    for (int i = 0; i < 5; i++) {
        float fi = float(i);
        vec2 h = hash22(vec2(fi, 17.0));
        float size = 0.07 + h.y * 0.08;
        float rise = 0.015 + h.x * 0.012;
        vec2 c = vec2(fract(h.x * 3.1 + sin(uT * 0.05 + fi) * 0.04) * uAspect,
                      fract(h.y + uT * rise) * 1.5 - 0.2);
        float pulse = sin(uT * (1.4 + h.x * 0.6) + fi * 2.3);
        vec2 q = (p - c) / size;
        q.x *= 1.0 + pulse * 0.1;
        q.y *= 1.0 - pulse * 0.08;
        vec3 tint = mix(vec3(1.0, 0.5, 0.82), vec3(0.4, 0.85, 1.0), step(0.5, hash12(vec2(fi, 23.0))));
        tint = mix(tint, uNeon2, 0.2);
        // 伞盖：半个椭圆，边上亮
        float d = length(q * vec2(1.0, 1.3));
        float bell = smoothstep(1.0, 0.85, d) * smoothstep(-0.25, 0.05, q.y);
        float rim = smoothstep(0.7, 1.0, d) * bell;
        float glow = exp(-d * d * 1.2) * 0.35;
        // 触须
        float tent = 0.0;
        for (int k = 0; k < 4; k++) {
            float ox = (float(k) - 1.5) * 0.32;
            float tx = q.x - ox - sin(q.y * 2.2 - uT * 2.0 + fi + float(k)) * 0.18 * (-q.y) * 0.4;
            tent += smoothstep(0.06, 0.0, abs(tx)) * smoothstep(-3.2 - h.x, -0.2, q.y) * step(q.y, -0.1);
        }
        float a = bell * 0.55 + rim * 0.9 + tent * 0.5;
        col += tint * (a * 1.3 + glow * 1.6 + exp(-d * d * 0.18) * 0.18);
    }
    // 气泡：三串，从底下冒上来，越往上越大
    for (int sIdx = 0; sIdx < 3; sIdx++) {
        float fs = float(sIdx);
        float sx = (0.18 + hash12(vec2(fs, 61.0)) * 0.7) * uAspect;
        for (int b = 0; b < 8; b++) {
            float fb = float(b);
            float y = fract(fb * 0.137 + hash12(vec2(fs, fb)) * 0.3 + uT * (0.09 + fs * 0.02));
            vec2 c = vec2(sx + sin(y * 12.0 + fb * 2.0 + uT) * 0.015, y * 1.1 - 0.05);
            float r = 0.004 + y * 0.008 + hash12(vec2(fb, fs + 5.0)) * 0.004;
            float dd = length(p - c);
            float ring = smoothstep(r * 0.35, 0.0, abs(dd - r)) * 0.6 + smoothstep(r * 0.5, 0.0, length(p - c - vec2(-r, r) * 0.4)) * 0.6;
            col += vec3(0.75, 0.92, 1.0) * ring * 0.5;
        }
    }
    // 缸里浮着的微尘
    vec2 dp = p * 60.0 + vec2(uT * 0.3, uT * 0.5);
    float dust = step(0.985, hash12(floor(dp))) * smoothstep(0.35, 0.0, length(fract(dp) - 0.5));
    col += vec3(0.6, 0.8, 0.85) * dust * 0.25;
    return col;
}
void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec2 p = vec2(uv.x * uAspect, uv.y + uBump);
    vec3 col = vec3(0.0);
    if (uAqua < 1.0) col = street(p);
    if (uAqua > 0.0) col = mix(col, aquarium(vec2(uv.x * uAspect, uv.y)), uAqua);
    outColor = vec4(col, 1.0);
}`;

    const MAIN_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uScene;
uniform sampler2D uFogBlur;
uniform sampler2D uFogGlow;
uniform vec2 uFogNorm;
uniform sampler2D uAtlas0;
uniform sampler2D uAtlas1;
uniform sampler2D uAtlas2;
uniform sampler2D uData0;
uniform sampler2D uData1;
uniform sampler2D uData2;
uniform vec4 uLine[${LINE_SLOTS}];   // fogBack, 有效, 种子, 0
uniform vec2 uRes;
uniform vec2 uAtlasSize;
uniform float uTime;
uniform vec4 uDrips[6];   // x, 开始时刻, 速度, 种子
uniform float uDripTop[6]; // 从哪儿开始淌（字底下的积水，或窗顶）
uniform vec4 uSpot;      // 正在写的字：x, y, 半径, 强度
uniform vec3 uBeam;      // 楼底下两盏聚光灯打向的地方：x, y, 强度
uniform vec3 uBeamCol;
uniform vec3 uBreath;    // 停唱时对着窗呵一口气：x, y, 浓度
uniform float uFireflies;
uniform float uFrost;
uniform float uAquaMain;
uniform int uDripCount;
uniform vec3 uFogCol;
uniform float uFogDensity;
uniform float uGrain;
uniform float uGrainStep;
out vec4 outColor;
${COMMON}

// 指痕外沿积的水：手指把雾推到笔画两边，聚成一圈水。这个像素自己没被擦开、
// 但旁边一小圈里有已经写到的笔画，就算在水线上（返回 0..1，越靠近笔画越满）。
float wetEdge(sampler2D atlas, sampler2D data, vec4 info, vec2 uv) {
    if (info.y < 0.5) return 0.0;
    vec2 au = vec2(uv.x, 1.0 - uv.y);
    vec4 here = texelFetch(atlas, min(ivec2(au * uAtlasSize), ivec2(uAtlasSize) - 1), 0);
    int id = int(here.g * 255.0 + 0.5);
    if (id <= 0 || here.r > 0.5) return 0.0;
    vec4 tw = texelFetch(data, ivec2(id, 0), 0);
    float prog = clamp((uTime - tw.x) / max(tw.y, 0.05), 0.0, 1.0) * 1.12;
    if (prog <= 0.0) return 0.0;
    vec2 px = 1.0 / uAtlasSize;
    float rad = 0.0042 * uAtlasSize.y;
    float wet = 0.0;
    for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.7854 + 0.39;
        vec4 t = texture(atlas, au + vec2(cos(a), sin(a)) * rad * px);
        if (t.r < 0.3) continue;
        float sp = t.b > 0.0 ? t.b : 1.0;
        wet = max(wet, smoothstep(sp - 0.03, sp, prog) * smoothstep(0.3, 0.8, t.r));
    }
    float n = vnoise(uv * vec2(9.0, 6.0) + info.z) * 0.6 + vnoise(uv * 40.0) * 0.4;
    float back = smoothstep(info.x, info.x + ${FOG_RETURN.toFixed(1)}, uTime + (n - 0.5) * 2.2);
    return wet * (1.0 - back);
}

// 一句歌词在这个像素擦掉了多少雾
float written(sampler2D atlas, sampler2D data, vec4 info, vec2 uv) {
    if (info.y < 0.5) return 0.0;
    vec2 au = vec2(uv.x, 1.0 - uv.y);
    float cov = texture(atlas, au).r;
    if (cov < 0.01) return 0.0;
    int id = int(texelFetch(atlas, min(ivec2(au * uAtlasSize), ivec2(uAtlasSize) - 1), 0).g * 255.0 + 0.5);
    if (id <= 0) return 0.0;
    vec4 tw = texelFetch(data, ivec2(id, 0), 0);
    vec4 box = texelFetch(data, ivec2(id, 1), 0);
    // 写到哪：B 是骨架上这一点在字里的进度（笔画一笔一笔写出来）；没有骨架的字从左上往右下扫
    float stroke = texelFetch(atlas, min(ivec2(au * uAtlasSize), ivec2(uAtlasSize) - 1), 0).b;
    vec2 local = (au - box.xy) / max(box.zw - box.xy, vec2(1e-4));
    float s = stroke > 0.0 ? stroke : clamp(dot(local, vec2(0.42, 0.58)) + (vnoise(local * 6.0 + info.z) - 0.5) * 0.18, 0.0, 1.0);
    float prog = clamp((uTime - tw.x) / max(tw.y, 0.05), 0.0, 1.0) * 1.12;
    float w = cov * smoothstep(s - 0.03, s, prog);
    // 雾漫回来：边上先回，一块一块地
    float n = vnoise(uv * vec2(9.0, 6.0) + info.z) * 0.6 + vnoise(uv * 40.0) * 0.4;
    float back = smoothstep(info.x, info.x + ${FOG_RETURN.toFixed(1)}, uTime + (n - 0.5) * 2.2 + (1.0 - cov) * 0.8);
    return w * (1.0 - back);
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    // 往下淌的水：走过的地方清出一道，慢慢又起雾
    float trail = 0.0;
    float bead = 0.0;
    for (int i = 0; i < 6; i++) {
        if (i >= uDripCount) break;
        vec4 dr = uDrips[i];
        // 离这道水痕横向超过 0.03 屏宽的像素，水痕和水头都碰不到
        if (abs(uv.x - dr.x) > 0.03) continue;
        float x = dr.x + sin(uv.y * 23.0 + dr.w * 6.0) * 0.004 + sin(uv.y * 61.0 + dr.w) * 0.0015;
        float top = uDripTop[i];
        float headY = top - (uTime - dr.y) * dr.z;
        float dx = abs(uv.x - x) * uRes.x / uRes.y;
        if (uv.y >= headY && uv.y <= top) {
            float passed = uTime - (dr.y + (top - uv.y) / dr.z);
            trail = max(trail, smoothstep(0.0032, 0.0012, dx) * exp(-passed / 7.0));
        }
        float hb = length(vec2(dx, (uv.y - headY) * 0.8));
        bead = max(bead, smoothstep(0.006, 0.004, hb));
    }

    float wipe = max(max(written(uAtlas0, uData0, uLine[0], uv), written(uAtlas1, uData1, uLine[1], uv)), written(uAtlas2, uData2, uLine[2], uv));
    float wet = 0.0;
    if (wipe < 0.5) wet = max(max(wetEdge(uAtlas0, uData0, uLine[0], uv), wetEdge(uAtlas1, uData1, uLine[1], uv)), wetEdge(uAtlas2, uData2, uLine[2], uv));
    wipe = max(wipe, trail * 0.85);
    // 水线不是一条匀的线，是一颗颗挤在一起的水珠：屏幕上按小格撒珠子，只在水线上的才显出来
    float edgeBead = 0.0;
    vec2 beadD = vec2(0.0);
    float beadR = 1.0;
    if (wet > 0.0) {
        vec2 bg = vec2(uRes.x / uRes.y, 1.0) * 110.0;
        vec2 bc = floor(uv * bg);
        for (int oy = -1; oy <= 1; oy++) for (int ox = -1; ox <= 1; ox++) {
            vec2 c = bc + vec2(float(ox), float(oy));
            vec2 ctr = (c + 0.5 + (hash22(c) - 0.5) * 0.7) / bg;
            if (hash12(c + 7.7) < 0.62) continue;
            float r = 0.0018 + hash12(c + 3.1) * 0.0026;
            vec2 dd = (uv - ctr) * vec2(uRes.x / uRes.y, 1.0);
            float m = smoothstep(r, r * 0.75, length(dd));
            if (m > edgeBead) { edgeBead = m; beadD = dd; beadR = r; }
        }
        edgeBead *= smoothstep(0.15, 0.6, wet);
    }

    // 雾后面两层模糊的窗外：用多级双滤波模糊（圆润），不用 mip（会糊成一块块方的光斑）
    vec3 blurred = mix(texture(uFogBlur, uv).rgb * uFogNorm.x, texture(uFogGlow, uv).rgb * uFogNorm.y, 0.5);
    float grainy = vnoise(uv * vec2(uRes.x / uRes.y, 1.0) * 180.0) - 0.5;
    float clumps = vnoise(uv * vec2(uRes.x / uRes.y, 1.0) * 7.0);
    // 雾里的灯：除了透过来的模糊光斑，再往外晕开一大圈
    vec3 wide = texture(uFogGlow, uv).rgb * uFogNorm.y;
    vec3 fog = mix(blurred * 1.15, uFogCol, uFogDensity * (0.78 + clumps * 0.22)) + grainy * 0.025 + blurred * 0.25 + max(wide - uFogCol * 0.6, 0.0) * 0.45;
    // 透过擦开的地方看窗外：眼睛对在玻璃上，窗外是虚的（窗外场景只有 1/3 分辨率，直接看会是一格格的方块）
    vec3 clear = textureLod(uScene, uv, 2.2).rgb * 1.05;
    vec3 col = mix(fog, clear, wipe);
    // 指痕边上积着一圈水，亮一点
    float rim = wipe * (1.0 - wipe) * 4.0;
    col += rim * 0.06 + rim * blurred * 0.25;
    // 指痕外沿：一圈薄水膜压暗雾，上面一颗颗水珠
    col = mix(col, clear * 0.8, wet * 0.22);
    if (edgeBead > 0.0) {
        float bl = length(beadD);
        vec3 inside = textureLod(uScene, uv - beadD * 2.0, 2.4).rgb * 1.1;
        col = mix(col, inside * (1.0 - smoothstep(beadR * 0.3, beadR, bl) * 0.7), edgeBead * 0.9);
        col += edgeBead * smoothstep(beadR * 0.3, 0.0, length(beadD + vec2(beadR * 0.35, -beadR * 0.35))) * 0.55;
    }
    col = mix(col, clear * 1.2 + fog * 0.5, bead * 0.9);
    // 呵气：一团白雾慢慢晕开，把附近写过的字也蒙上
    if (uBreath.z > 0.0) {
        vec2 bd = (uv - uBreath.xy) * vec2(uRes.x / uRes.y * 0.75, 1.0);
        float edge = vnoise(uv * 7.0 + uTime * 0.2) * 0.12;
        float b = smoothstep(0.34 + edge, 0.05, length(bd)) * uBreath.z;
        col = mix(col, uFogCol * 1.22 + blurred * 0.3, b * 0.75);
    }
    // 窗外飘着几只萤火（透过写开的地方看得更清楚）
    if (uFireflies > 0.0) {
        for (int i = 0; i < 7; i++) {
            float fi = float(i);
            vec2 c = vec2(fract(0.13 + fi * 0.37 + sin(uTime * 0.07 + fi * 2.1) * 0.08 + uTime * 0.004),
                          0.25 + fract(fi * 0.53) * 0.5 + sin(uTime * 0.31 + fi * 4.0) * 0.05);
            vec2 fd = (uv - c) * vec2(uRes.x / uRes.y, 1.0);
            float blink = smoothstep(0.2, 1.0, sin(uTime * (0.9 + fract(fi * 0.71)) + fi * 3.0));
            float g = exp(-dot(fd, fd) * mix(9000.0, 60000.0, wipe)) * blink;
            col += mix(vec3(1.0, 0.86, 0.4), vec3(0.45, 0.9, 1.0), uAquaMain) * g * mix(0.35, 1.1, wipe) * uFireflies;
        }
    }
    // 结霜：窗四角长出冰花，冰花上写不开
    if (uFrost > 0.0) {
        vec2 e = min(uv, 1.0 - uv) * vec2(uRes.x / uRes.y, 1.0);
        float edge = min(e.x, e.y);
        float n = vnoise(uv * 14.0) * 0.6 + vnoise(uv * 60.0) * 0.4;
        float hf = vnoise(gl_FragCoord.xy / 1.6) * 0.5 + vnoise(gl_FragCoord.xy / 5.0) * 0.5;
        float band = smoothstep(0.16 + n * 0.12, 0.0, edge) * uFrost;
        col = mix(col, vec3(0.82, 0.86, 0.93) * (0.72 + hf * 0.32), band * 0.62);
        float glint = step(0.996, hash12(floor(gl_FragCoord.xy / 2.0))) * band;
        col += vec3(0.9, 0.95, 1.0) * glint * 0.5;
    }
    // 正在写的那个字：指尖那一带的雾被呵暖，透出一点窗外的光
    if (uSpot.w > 0.0) {
        vec2 sd = (uv - uSpot.xy) * vec2(uRes.x / uRes.y, 1.0);
        float spot = exp(-dot(sd, sd) / (uSpot.z * uSpot.z)) * uSpot.w;
        col += (clear * 0.22 + vec3(1.0, 0.86, 0.66) * 0.05) * spot;
    }
    // 聚光灯：远处楼底下左右两盏，追着正在写的字；雾把光束散开，擦开的地方看得见光柱
    if (uBeam.z > 0.0) {
        float asp = uRes.x / uRes.y;
        float beam = 0.0;
        for (int k = 0; k < 2; k++) {
            vec2 o = vec2(k == 0 ? 0.08 : 0.92, -0.06) * vec2(asp, 1.0);
            vec2 a = uBeam.xy * vec2(asp, 1.0) - o;
            vec2 q = uv * vec2(asp, 1.0) - o;
            float L = max(length(a), 1e-3);
            vec2 dir = a / L;
            float along = dot(q, dir);
            float perp = abs(dir.x * q.y - dir.y * q.x);
            float w = 0.008 + along * 0.055;
            float flick = 0.9 + 0.1 * vnoise(vec2(uTime * 3.0, float(k) * 7.0));
            beam += smoothstep(w, w * 0.25, perp) * smoothstep(0.0, 0.12, along) * (1.0 - smoothstep(L, L * 1.3, along)) * 0.42 * flick;
            vec2 hit = q - a;
            beam += exp(-dot(hit, hit) / 0.004) * 0.35;
        }
        col += uBeamCol * beam * uBeam.z * mix(0.34, 0.14, wipe);
    }
    col += (hash12(floor(gl_FragCoord.xy / 1.5) + uGrainStep * 13.0) - 0.5) * 0.03 * uGrain;
    // 窗框四周暗一点
    vec2 v = uv - 0.5;
    col *= 1.0 - dot(v, v) * 0.55;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    // 玻璃上的水珠：按屏幕原生像素一颗颗画（窗户本身在小图上画再放大，珠子小，放大了会糊）。
    // 两层：大珠稀，小珠密。一格最多一颗，过一阵换个地方；格子和珠子都在顶点着色器里由时间算出，不占 CPU。
    // 每颗当成一个小半球透镜：透过它看到身后一大片窗外（倒过来、比雾清楚），边上一圈暗（光在边上折不出来），
    // 左上高光，下沿聚光；大珠四周一小圈雾被它吸走了，薄一点。
    const DROP_VERT = `#version 300 es
precision highp float;
uniform vec2 uCanvas;
uniform float uTime;
uniform vec4 uLayer;     // 每屏高几格, 有珠的比例, 最小半径, 最大半径（屏幕高为单位）
uniform float uSalt;
out vec2 vQ;
out float vR;
out float vSize;
${COMMON}
void main() {
    float aspect = uCanvas.x / uCanvas.y;
    float cells = uLayer.x;
    float cols = ceil(aspect * cells);
    float id = float(gl_InstanceID);
    vec2 cell = vec2(mod(id, cols), floor(id / cols));
    float salt = uSalt;
    float period = 14.0 + salt * 3.0;
    float phase = hash12(cell + salt * 7.1) * period;
    float round_ = floor((uTime + phase) / period);
    float life = fract((uTime + phase) / period);
    float on = step(1.0 - uLayer.y, hash12(cell + round_ + salt * 13.0));
    float size = hash12(cell + round_ * 3.0 + salt);
    float r = mix(uLayer.z, uLayer.w, size * size) * on * smoothstep(0.0, 0.03, life) * (1.0 - smoothstep(0.85, 1.0, life));
    if (r <= 0.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); vQ = vec2(0.0); vR = 0.0; vSize = 0.0; return; }
    // 珠心留在格子里，整颗不出格
    float mg = min(0.45, r * cells * 1.3);
    vec2 centre = (cell + mg + hash22(cell + round_ * 17.0 + salt) * (1.0 - 2.0 * mg)) / cells;   // x 按屏幕高为单位
    vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
    vec2 ext = corner * 1.6;
    vec2 p = centre + ext * r;
    gl_Position = vec4(p.x / aspect * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);
    vQ = ext;
    vR = r;
    vSize = size;
}`;
    const DROP_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uMain;
uniform vec2 uCanvas;
uniform float uRing;
in vec2 vQ;
in float vR;
in float vSize;
out vec4 outColor;
void main() {
    vec2 q = vQ;
    // 水往下坠：下半截拉长一点
    if (q.y < 0.0) q.y *= mix(1.0, 0.78, vSize);
    float ql = length(q);
    float ring = uRing * smoothstep(1.55, 1.05, ql);
    if (ql > 1.0 && ring <= 0.0) discard;
    vec2 uv = gl_FragCoord.xy / uCanvas;
    float aa = 1.2 / (vR * uCanvas.y);
    float drop = 1.0 - smoothstep(1.0 - aa, 1.0, ql);
    vec2 v = uv - 0.5;
    float vig = 1.0 - dot(v, v) * 0.55;
    vec3 base = texture(uMain, uv).rgb;
    vec3 clear = textureLod(uScene, uv, 2.2).rgb * 1.05 * vig;
    // 透镜：越靠边折得越厉害，看到的是身后几倍半径外的东西，倒着
    vec2 look = -q * (0.035 + vR * 3.0) * vec2(uCanvas.y / uCanvas.x, 1.0);
    vec3 inside = textureLod(uScene, uv + look, 1.6).rgb * 1.25 * vig + base * 0.35;
    inside *= 1.0 - smoothstep(0.45, 1.0, ql) * 0.5;
    // 下沿：光从上面进来，在珠底聚成一道弯月
    float caustic = smoothstep(0.35, 0.9, dot(q, vec2(0.22, -0.97))) * (1.0 - smoothstep(0.86, 0.98, ql));
    inside += caustic * (base * 0.55 + textureLod(uScene, uv, 3.0).rgb * 0.8 * vig);
    // 高光：左上一小点，外面一圈很淡的亮边
    float spec = smoothstep(0.3, 0.05, length(q - vec2(-0.34, 0.4)));
    inside += spec * spec * 0.85 + smoothstep(0.12, 0.0, length(q - vec2(-0.3, 0.36))) * 0.35
            + smoothstep(0.82, 0.97, ql) * smoothstep(1.0, 0.97, ql) * 0.06;
    float aDrop = drop * 0.95;
    float aRing = ring * 0.18 * (1.0 - drop);
    float a = aDrop + aRing;
    if (a <= 0.001) discard;
    outColor = vec4((clamp(inside, 0.0, 1.0) * aDrop + clear * aRing) / a, a);
}`;
    const DROP_LAYERS = Object.freeze([
        { cells: 9, density: 0.42, rMin: 0.007, rMax: 0.019, salt: 1, ring: 1 },
        { cells: 28, density: 0.45, rMin: 0.0028, rMax: 0.0072, salt: 2, ring: 0 }
    ]);

    const compile = (gl, type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`[fogpane] shader: ${gl.getShaderInfoLog(shader)}`);
        return shader;
    };
    const link = (gl, frag) => {
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
        gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, frag));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`[fogpane] link: ${gl.getProgramInfoLog(program)}`);
        const uniforms = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i += 1) {
            const info = gl.getActiveUniform(program, i);
            uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
        }
        return { program, uniforms };
    };
    const createGl = (canvas) => {
        const gl = canvas.getContext('webgl2', {
            alpha: false, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'default'
        });
        if (!gl) return null;
        const scene = link(gl, SCENE_FRAG);
        const main = link(gl, MAIN_FRAG);
        const drops = Utils.compileProgram(gl, DROP_VERT, DROP_FRAG, 'fogpane:drops');
        const vao = gl.createVertexArray();
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        const texture = (filter, mip = false) => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        };
        const sceneTex = texture(gl.LINEAR, true);
        const fbo = gl.createFramebuffer();
        // 一个空槽：没有句子时绑它
        const blank = texture(gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        const blankData = texture(gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 2, 0, gl.RGBA, gl.FLOAT, new Float32Array(8));
        const slots = Array.from({ length: LINE_SLOTS + 1 }, () => ({ atlas: texture(gl.LINEAR), data: texture(gl.NEAREST), key: null, used: 0 }));
        return {
            gl, scene, main, drops, vao, sceneTex, fbo, sceneSize: [0, 0], blank, blankData, slots,
            window: Utils.createTarget(gl), upscale: Utils.createBloom(gl, { label: 'fogpane' }),
            fogBlur: Utils.createBloom(gl, { label: 'fogpane-blur' })
        };
    };

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('fogpane', '雾笺', container, services);
        const canvas = createElement('canvas', 'fogpane-canvas');
        const kicker = createElement('div', 'fogpane-kicker', '雾笺');
        const translation = createElement('div', 'stage-translation fogpane-translation');
        const notice = createElement('div', 'fogpane-notice');
        notice.hidden = true;
        mode.root.append(canvas, kicker, translation, notice);
        const card = Utils.watchOverlay(mode.root);
        mode.scope.add(() => card.destroy());

        const atlasCanvas = document.createElement('canvas');

        let strokeCanvas = null;
        const measureCtx = document.createElement('canvas').getContext('2d');
        let glState = null;
        try { glState = createGl(canvas); } catch (error) { console.error(error); }
        if (!glState) {
            notice.hidden = false;
            notice.textContent = '这台电脑的显卡不支持 WebGL2，雾笺画不出来，请换一个舞台';
        }

        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const still = Utils.createStillGate();
        let plan = [];
        let planFor = null;
        let world = { W: 0, H: 0 };
        let low = [1, 1];
        let paused = false;
        let latestFrame = null;
        let lastDraw = -Infinity;
        let colours = null;
        let caption = '';
        let lastTranslation = '';
        let lostContext = false;
        let idleHandle = 0;
        const stats = { builds: 0, buildMs: 0, draws: 0, visible: 0 };
        const dripBuffer = new Float32Array(24);
        const dripTop = new Float32Array(6);

        const settings = () => {
            const tuning = mode.config.modes?.fogpane || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                fog: clamp(tuning.fog ?? 1, 0.5, 1.5),
                drops: tuning.drops !== false,
                fireflies: clamp(tuning.fireflies ?? 1, 0, 2),
                spotlights: 0,   // 追光拿掉了：抢字、显廉价（着色器里的分支留着，强度恒为 0 就不走）
                drips: tuning.drips !== false,
                rain: tuning.rain || 'light',
                view: ['street', 'aquarium', 'alternate'].includes(tuning.view) ? tuning.view : 'alternate',
                cameraSpeed: clamp(tuning.cameraSpeed ?? 1, 0.55, 1.85),
                grain: clamp(tuning.grain ?? 0.4, 0, 1),
                showTranslation: tuning.showTranslation !== false,
                reducedMotion: Boolean(reducedMotion?.matches),
                quality: mode.config.quality || 'standard'
            };
        };

        // 主题 → 窗外夜色：背景压暗当天空和楼，强调色当霓虹
        const readColours = () => {
            const p = services?.app?.stagePalette || {};
            const light = Boolean(p.light);
            const bg = hexRgb(p.background, light ? [0.95, 0.94, 0.9] : [0.09, 0.1, 0.11]);
            const accent = hexRgb(p.accent, [0.95, 0.66, 0]);
            const secondary = hexRgb(p.secondary, [0.46, 0.75, 0.68]);
            const night = luminance(bg) > 0.4 ? mixRgb(bg, [0.05, 0.06, 0.1], 0.86) : mixRgb(bg, [0.04, 0.05, 0.09], 0.4);
            colours = {
                sky: mixRgb(night, [0.12, 0.13, 0.2], 0.4),
                bld: mixRgb(night, [0.07, 0.08, 0.11], 0.4),
                win: [1.0, 0.82, 0.55],
                neon: accent,
                neon2: secondary,
                lamp: [1.0, 0.78, 0.5],
                // 雾：浅色主题是白雾，深色主题是被车里灯光照着的灰雾
                fog: light ? mixRgb(bg, [0.86, 0.88, 0.9], 0.5) : mixRgb([0.36, 0.39, 0.43], night, 0.25),
                light
            };
            const css = (rgb, a = 1) => `rgba(${rgb.map(v => Math.round(v * 255)).join(',')},${a})`;
            mode.root.style.setProperty('--fogpane-mark', light ? 'rgba(30,34,40,0.62)' : 'rgba(236,240,245,0.66)');
            mode.root.style.setProperty('--fogpane-bg', css(colours.fog));
        };

        const resize = () => {
            const w = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            const h = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            const quality = mode.config.quality || 'standard';
            // 窗户（雾、窗外、指痕）按像素预算画在小图上再放大；画布按屏幕原生像素，水珠画在上面
            const size = Utils.sharpSizes(w, h, PIXELS[quality] || PIXELS.standard, RATIO[quality] || 2);
            const bw = size.lw, bh = size.lh;
            low = [bw, bh];
            if (canvas.width !== size.nw || canvas.height !== size.nh) { canvas.width = size.nw; canvas.height = size.nh; still.invalidate(); }
            if (glState) {
                const sw = Math.max(16, Math.round(bw / 3)), sh = Math.max(16, Math.round(bh / 3));
                if (glState.sceneSize[0] !== sw || glState.sceneSize[1] !== sh) {
                    const { gl } = glState;
                    gl.bindTexture(gl.TEXTURE_2D, glState.sceneTex);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                    gl.generateMipmap(gl.TEXTURE_2D);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, glState.fbo);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glState.sceneTex, 0);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                    glState.sceneSize = [sw, sh];
                }
            }
            // 指痕图按 CSS 像素的一半，宽高比跟窗口；比例变了才整首重排
            const W = Math.round(Math.min(1600, w) * ATLAS_SCALE * 2) / 2 | 0;
            const H = Math.round(W * h / w);
            if (Math.abs(W - world.W) > 8 || Math.abs(H - world.H) > 8) {
                world = { W: Math.max(64, W), H: Math.max(36, H) };
                atlasCanvas.width = world.W; atlasCanvas.height = world.H;
                planFor = null;
                glState?.slots.forEach((slot) => { slot.key = null; });
            }
        };

        const fontFor = (size) => `600 ${size.toFixed(1)}px ${Utils.STAGE_FONT}`;
        const measure = (text, size, cjk) => { measureCtx.font = fontFor(size, cjk); return measureCtx.measureText(text).width; };

        const ensurePlan = (frame) => {
            const s = settings();
            const b = card.box;
            const avoid = b ? [(b.left + 1) / 2 * world.W - 12, (1 - b.top) / 2 * world.H - 12, (b.right + 1) / 2 * world.W + 12, (1 - b.bottom) / 2 * world.H + 12].map(Math.round) : null;
            const key = `${frame.track?.path || frame.track?.title || ''}|${world.W}x${world.H}|${s.fontScale}|${avoid || ''}`;
            if (planFor && planFor.lines === frame.lines && planFor.key === key) return;
            plan = planSong(frame.lines || [], world.W, world.H, s.fontScale, measure, `${frame.track?.path || frame.track?.title || ''}|${world.W}x${world.H}|${s.fontScale}`, avoid);
            planFor = { lines: frame.lines, key };
            glState?.slots.forEach((slot) => { slot.key = null; });
            Utils.loadLyricFont(frame.lines, [600], () => { planFor = null; glState?.slots.forEach((slot) => { slot.key = null; }); redraw(); }, `${frame.track?.title || ''}${frame.track?.artist || ''}`);
        };

        // 一句的指痕图：G 通道是字的编号，R 通道是手指擦过的形状（字描粗、圆头）。
        const slotFor = (entry, build = true) => {
            if (!glState) return null;
            const key = `${planFor?.key}|${entry.index}`;
            const hit = glState.slots.find(slot => slot.key === key);
            if (hit) { hit.used = performance.now(); return hit; }
            if (!build) return null;
            const started = performance.now();
            const ctx = atlasCanvas.getContext('2d', { alpha: false });
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, world.W, world.H);
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.textBaseline = 'alphabetic';
            const data = new Float32Array(256 * 2 * 4);
            // 编号：字框填进 G（着色器按纹素取，不插值；重叠处取后写的字）
            ctx.globalCompositeOperation = 'lighten';
            entry.items.forEach((it, i) => {
                const id = Math.min(MAX_GLYPHS, i + 1);
                ctx.fillStyle = `rgb(0,${id},0)`;
                ctx.fillRect(Math.floor(it.box[0]), Math.floor(it.box[1]), Math.ceil(it.box[2] - it.box[0]), Math.ceil(it.box[3] - it.box[1]));
            });
            // 手指擦过的形状：沿字的骨架一笔一笔、一样粗、圆头；R 是形状，B 是这一点在字里写到的进度。
            // 先画在单独一层（后写的笔画盖住先写的），再整层加到字图上，不碰 G 的编号。
            if (!strokeCanvas || strokeCanvas.width !== world.W || strokeCanvas.height !== world.H) {
                strokeCanvas = document.createElement('canvas');
                strokeCanvas.width = world.W; strokeCanvas.height = world.H;
            }
            const sc = strokeCanvas.getContext('2d');
            sc.clearRect(0, 0, world.W, world.H);
            sc.lineJoin = 'round';
            sc.lineCap = 'round';
            entry.items.forEach((it, i) => {
                const id = Math.min(MAX_GLYPHS, i + 1);
                const skel = skeletonOf(it.g.text, fontFor);
                const px = it.size;
                const x0 = it.x + (it.w - skel.width * px) / 2;
                sc.save();
                sc.translate(it.x + it.w / 2, it.baseline - it.size * 0.35);
                sc.rotate(it.rot);
                sc.translate(-(it.x + it.w / 2), -(it.baseline - it.size * 0.35));
                sc.lineWidth = Math.max(4, px * 0.13);   // 一根手指的宽度
                skel.strokes.forEach((st) => {
                    for (let k = 1; k < st.length; k += 1) {
                        const a = st[k - 1], b = st[k];
                        sc.strokeStyle = `rgb(255,0,${Math.max(1, Math.round(b[2] * 255))})`;
                        sc.beginPath();
                        sc.moveTo(x0 + a[0] * px, it.baseline + a[1] * px);
                        sc.lineTo(x0 + b[0] * px, it.baseline + b[1] * px);
                        sc.stroke();
                    }
                });
                sc.restore();
                const dur = clamp(it.g.end - it.g.start, 0.22, 0.85);
                data[id * 4] = it.g.start;
                data[id * 4 + 1] = dur;
                const o = (256 + id) * 4;
                data[o] = it.box[0] / world.W; data[o + 1] = it.box[1] / world.H;
                data[o + 2] = it.box[2] / world.W; data[o + 3] = it.box[3] / world.H;
            });
            ctx.globalCompositeOperation = 'lighter';
            ctx.drawImage(strokeCanvas, 0, 0);
            const { gl } = glState;
            const busy = new Set(stats.visibleKeys || []);
            const slot = glState.slots.filter(s => !busy.has(s.key)).sort((a, b) => a.used - b.used)[0] || glState.slots[0];
            gl.bindTexture(gl.TEXTURE_2D, slot.atlas);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
            gl.bindTexture(gl.TEXTURE_2D, slot.data);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 2, 0, gl.RGBA, gl.FLOAT, data);
            slot.key = key;
            slot.used = performance.now();
            stats.builds += 1;
            stats.buildMs = Math.round(performance.now() - started);
            return slot;
        };

        // 这一刻窗上还看得见的句子（最多三句，最新的优先）
        const visibleAt = (t) => {
            const out = [];
            for (let i = plan.length - 1; i >= 0 && out.length < LINE_SLOTS; i -= 1) {
                const p = plan[i];
                if (p.start - 0.3 > t) continue;
                if (p.fogBack + FOG_RETURN + 1.2 < t) break;
                out.push(p);
            }
            return out;
        };

        const scheduleNext = (t) => {
            if (idleHandle || !glState) return;
            const next = plan.find(p => p.start > t);
            if (!next || slotFor(next, false)) return;
            const run = () => { idleHandle = 0; if (!mode.destroyed && !lostContext) slotFor(next, true); };
            idleHandle = global.requestIdleCallback ? global.requestIdleCallback(run, { timeout: 700 }) : global.setTimeout(run, 120);
        };

        // 窗外换景：间奏（两句之间空了 4.5 秒以上）处换一次，街景和水族馆轮流；
        // 换的时刻只由歌词时间决定，拖动进度条也对得上。
        let aquaPlan = null;
        const aquaAt = (t, view) => {
            if (view === 'street') return 0;
            if (view === 'aquarium') return 1;
            if (!aquaPlan || aquaPlan.plan !== plan) {
                const cuts = [];
                for (let i = 1; i < plan.length; i += 1) {
                    const gap = plan[i].start - plan[i - 1].end;
                    if (gap > 4.5) cuts.push((plan[i - 1].end + plan[i].start) / 2);
                }
                aquaPlan = { plan, cuts };
            }
            let state = 0;
            let value = 0;
            for (const at of aquaPlan.cuts) {
                if (t < at - 1.1) break;
                const next = 1 - state;
                value = state + (next - state) * smooth(at - 1.1, at + 1.1, t);
                if (t >= at + 1.1) state = next;
            }
            return value;
        };

        // 往下淌的水：每隔七八秒从窗顶淌下来一道，时刻、位置只由歌和序号决定
        const dripsAt = (t, seedKey, lines) => {
            let n = 0;
            dripTop.fill(1.02);
            // 写过的字底下积了水，有的会淌下来
            for (const p of lines) {
                for (const it of p.items) {
                    if (n >= 4) break;
                    const r = seededRandom(`${seedKey}:gdrip:${p.index}:${it.g.start.toFixed(2)}`);
                    if (r() > 0.22) continue;
                    const start = it.g.end + 0.4 + r() * 1.2;
                    const speed = 0.03 + r() * 0.035;
                    const top = 1 - it.box[3] / world.H;
                    if (start > t || top - (t - start) * speed < -0.3) continue;
                    dripBuffer.set([(it.x + it.w * (0.3 + r() * 0.4)) / world.W, start, speed, r() * 10], n * 4);
                    dripTop[n] = top;
                    n += 1;
                }
            }
            const period = 7.5;
            const k0 = Math.floor(t / period);
            for (let k = k0; k > k0 - 6 && n < 6; k -= 1) {
                dripTop[n] = 1.02;
                if (k < 0) break;
                const r = seededRandom(`${seedKey}:drip:${k}`);
                const start = k * period + r() * period;
                const speed = 0.035 + r() * 0.05;
                if (start > t || 1.02 - (t - start) * speed < -0.3) continue;
                dripBuffer[n * 4] = 0.05 + r() * 0.9;
                dripBuffer[n * 4 + 1] = start;
                dripBuffer[n * 4 + 2] = speed;
                dripBuffer[n * 4 + 3] = r() * 10;
                n += 1;
            }
            return n;
        };

        let lastKick = -1, bumpAt = -Infinity, bumpAmp = 0, heardAt = -Infinity;
        const beam = { x: 0.5, y: 0.5, vx: 0, vy: 0, level: 0, wall: null };
        const draw = (frame) => {
            if (!glState || lostContext) return;
            const { gl, scene, main, vao } = glState;
            const s = settings();
            const t = frame.playbackTime;
            const visible = visibleAt(t);
            stats.visibleKeys = visible.map(p => `${planFor?.key}|${p.index}`);
            const slots = visible.map(p => slotFor(p, true));
            stats.visible = visible.length;

            // 1) 窗外
            const [sw, sh] = glState.sceneSize;
            gl.bindVertexArray(vao);
            gl.bindFramebuffer(gl.FRAMEBUFFER, glState.fbo);
            gl.viewport(0, 0, sw, sh);
            gl.useProgram(scene.program);
            Utils.bindNoise(gl, scene.uniforms.uNoise, 0);
            const su = scene.uniforms;
            const clock = t * s.cameraSpeed;
            // 车颠一下：有音乐数据时跟着底鼓颠（力度够、两次隔开 0.35 秒，幅度随低音）；没有时偶尔随机颠
            const wall = (frame.now ?? performance.now()) / 1000;
            const audio = frame.audio || {};
            const kick = Number.isFinite(audio.onsets) && audio.onsets !== lastKick;
            if (Number.isFinite(audio.onsets)) lastKick = audio.onsets;
            if ((audio.power || 0) > 0.03) heardAt = wall;
            if (kick && frame.isPlaying && (audio.bass || 0) > 0.42 && wall - bumpAt > 0.35) {
                bumpAt = wall;
                bumpAmp = 0.005 + 0.011 * clamp((audio.bass - 0.42) / 0.5, 0, 1);
            }
            let bump;
            if (wall - heardAt < 2) {
                const bt = wall - bumpAt;
                bump = bt >= 0 && bt < 0.6 ? Math.sin(bt * 18) * Math.exp(-bt * 7) * bumpAmp : 0;
            } else {
                const bumpK = Math.floor(clock / 2.7);
                const br = seededRandom(`bump:${bumpK}`);
                const bt = clock - bumpK * 2.7 - br() * 2;
                bump = bt > 0 && bt < 0.5 ? Math.sin(bt * 18) * Math.exp(-bt * 7) * 0.012 * (br() < 0.6 ? 1 : 0) : 0;
            }
            if (s.reducedMotion) bump = 0;
            gl.uniform2f(su.uRes, sw, sh);
            gl.uniform1f(su.uAspect, sw / sh);
            gl.uniform1f(su.uT, clock);
            gl.uniform1f(su.uBump, bump);
            gl.uniform3fv(su.uSky, colours.sky);
            gl.uniform3fv(su.uBld, colours.bld);
            gl.uniform3fv(su.uWin, colours.win);
            gl.uniform3fv(su.uNeon, colours.neon);
            gl.uniform3fv(su.uNeon2, colours.neon2);
            gl.uniform3fv(su.uLamp, colours.lamp);
            const aqua = aquaAt(t, s.view);
            gl.uniform1f(su.uAqua, aqua);
            gl.uniform1f(su.uRain, s.rain === 'off' || s.rain === 'snow' ? 0 : s.rain === 'heavy' ? 1.8 : 1);
            gl.uniform1f(su.uSnow, s.rain === 'snow' ? 1 : 0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.bindTexture(gl.TEXTURE_2D, glState.sceneTex);
            gl.generateMipmap(gl.TEXTURE_2D);
            const fogBlur = glState.fogBlur;
            fogBlur.run({ tex: glState.sceneTex, size: glState.sceneSize }, null, [-1, 0.5], 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            // 2) 车窗（小图）
            glState.window.bind(low[0], low[1]);
            gl.useProgram(main.program);
            const u = main.uniforms;
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glState.sceneTex); gl.uniform1i(u.uScene, 0);
            Utils.bindNoise(gl, u.uNoise, 7);
            gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, fogBlur.level(2)); gl.uniform1i(u.uFogBlur, 8);
            gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, fogBlur.level(3)); gl.uniform1i(u.uFogGlow, 9);
            gl.uniform2f(u.uFogNorm, 1 / (fogBlur.levels - 2), 1 / (fogBlur.levels - 3));
            const lineInfo = new Float32Array(LINE_SLOTS * 4);
            for (let i = 0; i < LINE_SLOTS; i += 1) {
                const slot = slots[i];
                gl.activeTexture(gl.TEXTURE1 + i); gl.bindTexture(gl.TEXTURE_2D, slot ? slot.atlas : glState.blank); gl.uniform1i(u[`uAtlas${i}`], 1 + i);
                gl.activeTexture(gl.TEXTURE4 + i); gl.bindTexture(gl.TEXTURE_2D, slot ? slot.data : glState.blankData); gl.uniform1i(u[`uData${i}`], 4 + i);
                if (slot) {
                    lineInfo[i * 4] = visible[i].fogBack;
                    lineInfo[i * 4 + 1] = 1;
                    lineInfo[i * 4 + 2] = (visible[i].index * 7.31) % 50;
                }
            }
            gl.uniform4fv(u.uLine, lineInfo);
            gl.uniform2f(u.uRes, low[0], low[1]);
            gl.uniform2f(u.uAtlasSize, world.W, world.H);
            gl.uniform1f(u.uTime, t);
            const drips = s.drips && !s.reducedMotion ? dripsAt(t, planFor?.key || '', visible) : 0;
            gl.uniform4fv(u.uDrips, dripBuffer);
            gl.uniform1fv(u.uDripTop, dripTop);
            // 指尖：正在写的字
            let spot = [0, 0, 0, 0];
            for (const p of visible) {
                for (const it of p.items) {
                    if (t >= it.g.start - 0.05 && t < it.g.end + 0.25) {
                        spot = [(it.x + it.w / 2) / world.W, 1 - (it.baseline - it.size * 0.4) / world.H, it.size / world.H * 1.4, 1 - smooth(it.g.end, it.g.end + 0.25, t)];
                    }
                }
            }
            gl.uniform4f(u.uSpot, spot[0], spot[1], spot[2], s.reducedMotion ? 0 : spot[3]);
            // 聚光灯的落点：沿着正在写的字滑过去（临界阻尼弹簧，速度连续）；这句写完唱完 0.8 秒后慢慢熄
            let aim = null, lit = 0;
            for (const p of visible) {
                if (t < p.start - 0.2 || t > p.end + 2.2) continue;
                const items = p.items;
                let k = items.findIndex(it => t < it.g.end);
                if (k < 0) k = items.length - 1;
                const a = items[k], b = items[Math.min(items.length - 1, k + 1)];
                const f = clamp((t - a.g.start) / Math.max(0.05, a.g.end - a.g.start), 0, 1);
                const x = (a.x + a.w / 2) * (1 - f) + (b.x + b.w / 2) * f;
                const y = (a.baseline - a.size * 0.4) * (1 - f) + (b.baseline - b.size * 0.4) * f;
                aim = [x / world.W, 1 - y / world.H];
                lit = smooth(p.start - 0.2, p.start + 0.4, t) * (1 - smooth(p.end + 0.8, p.end + 2.2, t));
            }
            const dtBeam = clamp(wall - (beam.wall ?? wall), 0, 0.1);
            beam.wall = wall;
            if (aim) {
                if (!frame.isPlaying || beam.level <= 0.01) { beam.x = aim[0]; beam.y = aim[1]; beam.vx = 0; beam.vy = 0; } else {
                    const w = 7;
                    for (const [p, v, target] of [['x', 'vx', aim[0]], ['y', 'vy', aim[1]]]) {
                        const acc = w * w * (target - beam[p]) - 2 * w * beam[v];
                        beam[v] += acc * dtBeam;
                        beam[p] += beam[v] * dtBeam;
                    }
                }
            }
            beam.level = frame.isPlaying ? beam.level + (lit - beam.level) * (1 - Math.exp(-dtBeam * 5)) : lit;
            gl.uniform3f(u.uBeam, beam.x, beam.y, s.reducedMotion ? 0 : beam.level * s.spotlights);
            gl.uniform3fv(u.uBeamCol, colours.neon);
            // 呵气：一句唱完、下一句还没开始（空当超过 2 秒）时
            let breath = 0;
            let bx = 0.5, by = 0.35;
            if (!s.reducedMotion && plan?.length) {
                let last = null, next = null;
                for (const p of plan) { if (p.end <= t) last = p; else if (p.start > t) { next = p; break; } else { last = null; next = null; break; } }
                if (last && (!next || next.start - last.end > 2)) {
                    const gapEnd = next ? next.start : last.end + 20;
                    breath = smooth(last.end + 0.4, last.end + 1.6, t) * (1 - smooth(gapEnd - 1.4, gapEnd - 0.3, t)) * 0.85;
                    const r = seededRandom(`breath:${last.index}`);
                    bx = 0.3 + r() * 0.4; by = 0.3 + r() * 0.3;
                }
            }
            gl.uniform3f(u.uBreath, bx, by, breath);
            gl.uniform1f(u.uFireflies, s.reducedMotion || (s.rain === 'snow' && aqua < 0.5) ? 0 : s.fireflies);
            gl.uniform1f(u.uFrost, s.rain === 'snow' ? 1 - aqua : 0);
            gl.uniform1f(u.uAquaMain, aqua);
            gl.uniform1i(u.uDripCount, drips);
            gl.uniform3fv(u.uFogCol, colours.fog);
            gl.uniform1f(u.uFogDensity, clamp(0.62 * s.fog, 0.2, 0.92));
            gl.uniform1f(u.uGrain, s.grain);
            gl.uniform1f(u.uGrainStep, s.reducedMotion ? 0 : Math.floor(t * 6) % 64);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            // 3) 放大到屏幕，再按原生像素画水珠
            glState.upscale.present(glState.window, null, canvas.width, canvas.height);
            if (s.drops) {
                const { drops } = glState;
                const du = drops.uniforms;
                gl.bindVertexArray(vao);
                gl.useProgram(drops.program);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glState.sceneTex); gl.uniform1i(du.uScene, 0);
                gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glState.window.tex); gl.uniform1i(du.uMain, 1);
                gl.uniform2f(du.uCanvas, canvas.width, canvas.height);
                gl.uniform1f(du.uTime, t);
                const aspect = canvas.width / canvas.height;
                DROP_LAYERS.forEach((layer) => {
                    gl.uniform4f(du.uLayer, layer.cells, layer.density, layer.rMin, layer.rMax);
                    gl.uniform1f(du.uSalt, layer.salt);
                    gl.uniform1f(du.uRing, layer.ring);
                    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, Math.ceil(aspect * layer.cells) * layer.cells);
                });
                gl.disable(gl.BLEND);
            }
            stats.draws += 1;
            scheduleNext(t);
        };

        const updateOverlay = (frame) => {
            const next = `雾笺 · ${frame.titleOnly ? '暂无歌词' : frame.inCredits ? '片尾' : Utils.lineCounter(frame)}`;
            if (next !== caption) { caption = next; kicker.textContent = next; }
            const text = settings().showTranslation ? resolveSupplementalText(frame.activeLine) : '';
            if (text !== lastTranslation) { lastTranslation = text; translation.textContent = text; translation.hidden = !text; }
        };

        // 没有歌词：开头在玻璃上写下歌名，整首歌留着
        let titleLine = null;
        const titleOnGlass = (frame) => {
            if (frame.lines?.length) return frame;
            const title = String(frame.track?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg|aac|ape|opus)$/i, '').trim();
            const duration = frame.duration > 0 ? frame.duration : 240;
            if (!readableText(title)) return frame;
            const key = `${title}|${Math.round(duration)}`;
            if (titleLine?.key !== key) {
                const chars = Runtime.splitGraphemes(title).filter(c => c.trim());
                const words = chars.map((text, i) => ({ text, startTime: 1.6 + i * 0.32, endTime: 1.6 + (i + 1) * 0.32 }));
                titleLine = { key, lines: Runtime.normalizeLines([{ time: 1.5, endTime: Math.max(6, duration - 2), original: title, translation: '', words }]) };
            }
            const t = frame.playbackTime || 0;
            const line = titleLine.lines[0];
            const on = t >= line.startTime && t < line.endTime;
            return {
                ...frame,
                ...Runtime.resolveWordState(on ? line : null, t),
                lines: titleLine.lines,
                currentLineIndex: on ? 0 : -1,
                activeLine: on ? line : null,
                lineProgress: on ? Utils.clamp((t - line.startTime) / (line.endTime - line.startTime), 0, 1) : 0,
                titleOnly: true
            };
        };

        // 片尾：最后一句唱完 4 秒，前面的句子都起雾散掉，在玻璃正中手写曲名，下面小一点写歌手，写完一直留着
        let creditsFor = null;
        const withCredits = (frame) => {
            const lines = frame.lines;
            if (frame.titleOnly || !lines?.length) return frame;
            const title = String(frame.track?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg|aac|ape|opus)$/i, '').trim();
            const artist = String(frame.track?.artist || '').trim();
            if (!readableText(title)) return frame;
            const duration = frame.duration > 0 ? frame.duration : 0;
            if (creditsFor?.source !== lines || creditsFor.title !== title || creditsFor.artist !== artist || creditsFor.duration !== Math.round(duration)) {
                const lastEnd = Math.max(...lines.map(l => Math.max(l.endTime || 0, l.vocalEndTime || 0, l.startTime || 0)));
                let at = lastEnd + 4;
                if (duration) at = Math.min(at, Math.max(lastEnd + 1, duration - 8));
                const tail = duration ? Math.max(duration, at + 30) : at + 600;
                const make = (text, from, step, kind) => {
                    const chars = Runtime.splitGraphemes(text);
                    let k = 0;
                    const words = chars.map((c) => { const st = from + k * step; if (c.trim()) k += 1; return { text: c, startTime: st, endTime: st + step }; });
                    return { line: { time: from, endTime: tail, original: text, translation: '', words, credits: kind }, end: from + k * step };
                };
                const head = make(title, at, 0.32, 'title');
                const extra = [head.line];
                if (readableText(artist) && artist !== title) extra.push(make(artist, head.end + 0.3, 0.2, 'artist').line);
                const normal = Runtime.normalizeLines(extra).map((l, i) => ({ ...l, credits: extra[i].credits }));
                creditsFor = { source: lines, title, artist, duration: Math.round(duration), at, lines: [...lines, ...normal], extra: normal };
            }
            const t = frame.playbackTime || 0;
            if (t < creditsFor.at) return { ...frame, lines: creditsFor.lines };
            let k = -1;
            creditsFor.extra.forEach((l, i) => { if (t >= l.startTime) k = i; });
            const line = k >= 0 ? creditsFor.extra[k] : null;
            return {
                ...frame,
                ...Runtime.resolveWordState(line, t),
                lines: creditsFor.lines,
                currentLineIndex: line ? creditsFor.lines.length - creditsFor.extra.length + k : -1,
                activeLine: line,
                lineProgress: 1,
                inCredits: true
            };
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            frame = Utils.withPlainLyrics(frame);   // 只有纯文本歌词时按时长铺开
            frame = titleOnGlass(frame);
            frame = withCredits(frame);
            latestFrame = frame;
            if (!colours) readColours();
            ensurePlan(frame);
            updateOverlay(frame);
            if (!glState) return;
            const aim = 1000 / (FPS[mode.config.quality || 'standard'] || 30);
            const now = frame.now ?? performance.now();
            if (now < lastDraw) lastDraw = -Infinity;
            if (frame.isPlaying && now - lastDraw < aim - 3) return;
            if (still.same(frame, `${canvas.width}x${canvas.height}|${stats.builds}`)) return;
            lastDraw = now - lastDraw < aim * 2 ? lastDraw + aim : now;
            draw(frame);
        };

        const redraw = () => {
            still.invalidate();
            lastDraw = -Infinity;
            if (latestFrame) mode.updateFrame(latestFrame);
        };
        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => { updateConfig(config); resize(); readColours(); redraw(); };
        mode.resize = () => { card.measure(); resize(); redraw(); };
        mode.suspend = () => { paused = true; mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; mode.root.classList.remove('is-suspended'); redraw(); };
        mode.updateTheme = () => { readColours(); redraw(); };
        mode.getDebugSnapshot = () => ({
            initialized: Boolean(glState), lines: plan.length, visible: stats.visible,
            builds: stats.builds, buildMs: stats.buildMs, draws: stats.draws, buffer: `${canvas.width}x${canvas.height}`
        });

        const onLost = (event) => { event.preventDefault(); lostContext = true; };
        const onRestored = () => {
            try { glState = createGl(canvas); lostContext = false; resize(); redraw(); } catch (error) { console.error(error); }
        };
        canvas.addEventListener('webglcontextlost', onLost);
        canvas.addEventListener('webglcontextrestored', onRestored);
        mode.scope.add(() => {
            canvas.removeEventListener('webglcontextlost', onLost);
            canvas.removeEventListener('webglcontextrestored', onRestored);
            if (idleHandle) (global.cancelIdleCallback || global.clearTimeout)(idleHandle);
            if (glState) {
                const { gl } = glState;
                glState.slots.forEach((slot) => { gl.deleteTexture(slot.atlas); gl.deleteTexture(slot.data); });
                [glState.sceneTex, glState.blank, glState.blankData].forEach(t => gl.deleteTexture(t));
                gl.deleteFramebuffer(glState.fbo);
                gl.deleteProgram(glState.scene.program);
                gl.deleteProgram(glState.main.program);
                gl.deleteProgram(glState.drops.program);
                gl.deleteTexture(glState.window.tex);
                gl.getExtension('WEBGL_lose_context')?.loseContext();
            }
            glState = null;
        });

        resize();
        return mode;
    };

    global.MusicStageFogpaneManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ planSong })
    });
})(window);
