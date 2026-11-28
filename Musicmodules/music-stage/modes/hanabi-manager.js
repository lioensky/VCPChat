(function (global) {
    'use strict';

    /*
     * 花火：夏夜河边的烟花大会。每句歌词开唱时升起一发主烟花，唱到的字之间零星炸开小花，
     * 拖长音的字后面垂下柳火，间奏里是连发。歌词在河岸上方，被烟花的闪光照亮。
     *
     * 画法：整场烟花在歌曲载入时一次排好（纯函数，只由歌词和种子决定），存进一张数据纹理。
     * 每帧只做两件事：全屏三角形画夜空、烟、山影、河面和字；然后一次 drawArrays 画点，
     * 每个点（烟花星或它的尾迹）的位置在顶点着色器里按闭式解算出来，不在 CPU 上跑粒子。
     * 河面倒影是同一批点镜像再画一次（节能档不画）。
     */
    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before hanabi-manager.js');
    const { clamp, seededRandom, createElement } = Utils;
    const { resolveSupplementalText, buildGlyphTimeline, readableText, splitGraphemes } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const PIXELS = Object.freeze({ 'energy-saving': 0.9e6, standard: 1.6e6, ultimate: 3.0e6 });
    const PER_BURST = Object.freeze({ 'energy-saving': 72, standard: 110, ultimate: 140 });
    const TRAIL = 10;
    const SPARK_BLOOM = 1.6;   // 火星的泛光强度（只照火星，见画火星那段）
    const MAX_ACTIVE = 24;
    const MAX_BURSTS = 1024;
    const MAX_LIGHTS = 6;
    const WATER = 0.2;
    const KIND = Object.freeze({ kiku: 0, botan: 1, yanagi: 2, ring: 3, kamuro: 4, senrin: 5, pop: 6 });
    // 每种烟花的寿命（秒），CPU 用它判断哪些还在燃烧；和着色器里的表一致
    const LIFE = Object.freeze([2.1, 1.5, 3.6, 1.6, 3.6, 1.8, 1.0]);
    const ENTER = 1.1;
    const SECTION_KINDS = Object.freeze(['kiku', 'botan', 'ring', 'kamuro', 'senrin', 'kiku']);
    const PALETTE = Object.freeze([
        [1.0, 0.78, 0.38], // 金
        [1.0, 0.36, 0.3], // 红
        [0.4, 1.0, 0.62], // 绿
        [0.45, 0.62, 1.0], // 蓝
        [1.0, 0.45, 0.78], // 桃
        [0.82, 0.88, 1.0], // 银
        [0.78, 0.5, 1.0] // 紫
    ]);
    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

    const hexRgb = (hex, fallback) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return fallback;
        const n = parseInt(match[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const mixRgb = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

    /* ───────────────────────── 段落 ───────────────────────── */

    const buildCues = (lines, duration) => {
        const sung = lines.filter(line => readableText(line.fullText));
        const cues = [];
        const rest = (start, end, title) => { if (end > start + 0.05) cues.push({ kind: 'rest', start, end, title }); };
        if (!sung.length) { rest(0, Math.max(Number(duration) || 0, 720), true); return cues; }
        if (sung[0].startTime > 2) rest(0, sung[0].startTime, true);
        sung.forEach((line, i) => {
            const next = sung[i + 1];
            const lineEnd = Math.max(line.endTime, line.vocalEndTime || 0);
            const nextStart = next ? next.startTime : Infinity;
            if (nextStart - lineEnd > 4) {
                cues.push({ kind: 'line', start: line.startTime, end: lineEnd + 1.2, line, number: i + 1 });
                rest(lineEnd + 1.2, next ? nextStart : Math.max(Number(duration) || 0, lineEnd + 30), false);
            } else cues.push({ kind: 'line', start: line.startTime, end: nextStart, line, number: i + 1 });
        });
        cues[0].start = 0;
        // 副歌：整句歌词在歌里出现两次以上
        const norm = line => String(line.fullText || '').replace(/[\s，。、,.!?！？…~～'"“”‘’()（）-]/g, '').toLowerCase();
        const counts = new Map();
        sung.forEach((line) => { const k = norm(line); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
        cues.forEach((cue) => { if (cue.kind === 'line') cue.chorus = (counts.get(norm(cue.line)) || 0) >= 2; });
        return cues;
    };
    const findCue = (cues, t) => {
        let low = 0, high = cues.length - 1, result = 0;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (t >= cues[mid].start) { result = mid; low = mid + 1; } else high = mid - 1;
        }
        return result;
    };

    /* ───────────────────────── 排烟花 ───────────────────────── */

    // 整首的烟花表：{ t 炸开时刻, x 0..1, y 0..1（朝上）, kind, size, colour, two 双色, launch 升空秒数 }，按 t 排好。
    const planShow = (cues, seedKey, density = 1) => {
        const random = seededRandom(`hanabi:${seedKey}`);
        const pick = list => list[Math.floor(random() * list.length) % list.length];
        const bursts = [];
        const add = (t, kind, x, y, size, colour, anchor = null) => {
            if (!(t >= 0)) return;
            bursts.push({
                anchor,
                t, kind: KIND[kind], x, y, size,
                colour: colour || pick(PALETTE),
                two: kind !== 'yanagi' && kind !== 'kamuro' && random() < 0.35,
                launch: kind === 'pop' ? 0 : 0.75 + size * 0.35
            });
        };
        const gold = PALETTE[0];
        let section = -1;
        let count = 4;
        let sectionKind = 'kiku';
        let side = random() < 0.5 ? -1 : 1;
        cues.forEach((cue, cueIndex) => {
            if (cue.kind === 'line') {
                if (count >= 4) {
                    section += 1;
                    count = 0;
                    sectionKind = SECTION_KINDS[(section + Math.floor(random() * 3)) % SECTION_KINDS.length];
                }
                count += 1;
                side = -side;
                const start = Math.max(cue.start, cue.line.startTime);
                // 主烟花：左右交替，开在字的上方
                add(start + 0.02, sectionKind, 0.5 + side * (0.12 + random() * 0.2), 0.6 + random() * 0.12, 0.95 + random() * 0.2, sectionKind === 'kamuro' ? gold : null);
                // 长句唱到一半再补一发小一点的
                const lineEnd = Math.max(cue.line.endTime, cue.line.vocalEndTime || 0);
                if (lineEnd - start > 2.6) add(start + (lineEnd - start) * 0.5, random() < 0.5 ? 'senrin' : 'botan', 0.5 - side * (0.1 + random() * 0.25), 0.64 + random() * 0.12, 0.75 + random() * 0.15);
                // 唱到的字之间零星炸开小花；拖长音的字后面垂一次柳火
                let lastPop = start;
                let willow = false;
                buildGlyphTimeline(cue.line).forEach((g) => {
                    if (!String(g.text || '').trim()) return;
                    if (!willow && g.endTime - g.startTime > 1.1) {
                        willow = true;
                        add(g.startTime + 0.1, 'yanagi', 0.2 + random() * 0.6, 0.74 + random() * 0.08, 1, gold);
                    } else if (cue.chorus ? g.startTime - lastPop > 0.28 / density : g.startTime - lastPop > 0.95 / density && random() < 0.75 * density) {
                        // 小花开在唱到的那个字上方（字排好后按字的位置挪过去，见 anchorPops）；副歌里每个字都开一朵
                        lastPop = g.startTime;
                        add(g.startTime, 'pop', 0.1 + random() * 0.8, 0.56 + random() * 0.28, cue.chorus ? 0.42 + random() * 0.12 : 0.55 + random() * 0.2, null,
                            { cue: cueIndex, start: g.startTime });
                    }
                });
            } else {
                // 间奏：连发。开头留一秒，结尾留半秒，越到后面越密
                const span = cue.end - cue.start;
                let t = cue.start + (cue.title ? 1.6 : 0.8);
                while (t < cue.end - 0.5) {
                    const k = (t - cue.start) / Math.max(1, span);
                    const kind = random() < 0.25 ? 'pop' : pick(['kiku', 'botan', 'ring', 'senrin', 'kamuro', 'yanagi']);
                    add(t, kind, 0.12 + random() * 0.76, 0.56 + random() * 0.2, kind === 'pop' ? 0.6 : 0.8 + random() * 0.35, kind === 'yanagi' || kind === 'kamuro' ? gold : null);
                    t += (1.5 - k * 0.8) / density * (0.6 + random() * 0.8);
                }
            }
        });
        bursts.sort((a, b) => a.t - b.t);
        return bursts.slice(0, MAX_BURSTS);
    };

    // 此刻还在升空或燃烧的烟花（下标），太多时留最新的
    const activeAt = (bursts, t, out) => {
        let low = 0, high = bursts.length;
        while (low < high) { const mid = (low + high) >> 1; if (bursts[mid].t < t - 3.8) low = mid + 1; else high = mid; }
        let n = 0;
        for (let i = low; i < bursts.length; i += 1) {
            const b = bursts[i];
            if (b.t - b.launch - 0.05 > t) { if (b.t - 1.3 > t) break; continue; }
            if (t > b.t + LIFE[b.kind]) continue;
            if (n < out.length) out[n++] = i;
            else { out.copyWithin(0, 1); out[out.length - 1] = i; }
        }
        return n;
    };

    /* ───────────────────────── 卡片 ───────────────────────── */

    // 每句字贴在一张卡片上：粉纸（深色字）、小窗（标题栏）、深色签（虚线框、胶带、编号）。
    // 只画卡片本身和字的贴纸白边；字的颜色、唱到的时刻仍由着色器按 R/G 通道算。
    const CARD_STYLES = Object.freeze(['paper', 'window', 'tag']);
    const roundRect = (ctx, x, y, w, h, r) => {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    };
    const tape = (ctx, cx, cy, w, h, rot, colour) => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rot);
        ctx.fillStyle = colour;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        // 胶带两头的锯齿
        ctx.globalCompositeOperation = 'destination-out';
        const teeth = 5;
        for (let i = 0; i < teeth; i += 1) {
            const y = -h / 2 + (i + 0.5) * h / teeth;
            ctx.beginPath(); ctx.arc(-w / 2, y, h / teeth * 0.42, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(w / 2, y, h / teeth * 0.42, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        for (let x = -w / 2 + h * 0.2; x < w / 2; x += h * 0.45) ctx.fillRect(x, -h / 2, h * 0.14, h);
        ctx.restore();
    };
    const dots = (ctx, x, y, w, h, step, colour) => {
        ctx.fillStyle = colour;
        const r = Math.max(0.8, step * 0.09);
        for (let yy = y + step / 2; yy < y + h; yy += step) {
            for (let xx = x + step / 2; xx < x + w; xx += step) { ctx.beginPath(); ctx.arc(xx, yy, r, 0, Math.PI * 2); ctx.fill(); }
        }
    };
    const paintCard = (ctx, style, box, size, label, random, font) => {
        const { x0, y0, x1, y1 } = box;
        const w = x1 - x0, h = y1 - y0;
        const radius = size * 0.22;
        ctx.save();
        // 落在夜空上的影子
        ctx.shadowColor = 'rgba(6,2,18,0.55)';
        ctx.shadowBlur = size * 0.6;
        ctx.shadowOffsetY = size * 0.16;
        if (style === 'paper') {
            const rim = size * 0.12;
            roundRect(ctx, x0 - rim, y0 - rim, w + rim * 2, h + rim * 2, radius + rim);
            ctx.fillStyle = '#fbf6f8';
            ctx.fill();
            ctx.shadowColor = 'transparent';
            roundRect(ctx, x0, y0, w, h, radius);
            ctx.fillStyle = '#f5adc9';
            ctx.fill();
            ctx.save(); ctx.clip();
            dots(ctx, x0, y0, w, h, size * 0.3, 'rgba(255,255,255,0.34)');
            ctx.restore();
            tape(ctx, x0 + w * 0.1, y0 - rim * 0.4, size * 1.1, size * 0.34, -0.5 + random() * 0.2, 'rgba(178,158,232,0.82)');
            tape(ctx, x1 - w * 0.08, y1 + rim * 0.4, size * 1.1, size * 0.34, -0.5 + random() * 0.2, 'rgba(150,226,214,0.82)');
        } else if (style === 'window') {
            const bar = size * 0.46;
            roundRect(ctx, x0, y0 - bar, w, h + bar, radius);
            ctx.fillStyle = '#4d4a5e';
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.lineWidth = Math.max(1.5, size * 0.04);
            ctx.strokeStyle = '#f7b9d2';
            ctx.stroke();
            ctx.save(); roundRect(ctx, x0, y0 - bar, w, h + bar, radius); ctx.clip();
            dots(ctx, x0, y0, w, h, size * 0.3, 'rgba(255,255,255,0.07)');
            const grad = ctx.createLinearGradient(x0, 0, x1, 0);
            grad.addColorStop(0, '#fbe6a6'); grad.addColorStop(1, '#f7b9d2');
            ctx.fillStyle = grad;
            ctx.fillRect(x0, y0 - bar, w, bar);
            ctx.restore();
            ['#8fd3f4', '#a5e3b1', '#f48fb1'].forEach((c, i) => {
                ctx.fillStyle = c;
                ctx.beginPath(); ctx.arc(x1 - bar * (0.55 + i * 0.55), y0 - bar / 2, bar * 0.17, 0, Math.PI * 2); ctx.fill();
            });
            const px = size * 0.2;
            ctx.font = font(600, px);
            const text = `✦ ${label.file}`;
            const tw = ctx.measureText(text).width;
            roundRect(ctx, x0 + bar * 0.4, y0 - bar * 0.78, tw + px * 1.2, bar * 0.56, bar * 0.28);
            ctx.fillStyle = '#fffaf6'; ctx.fill();
            ctx.fillStyle = '#5b5068';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, x0 + bar * 0.4 + px * 0.6, y0 - bar * 0.5);
        } else {
            roundRect(ctx, x0, y0, w, h, radius * 0.6);
            ctx.fillStyle = '#2e2a44';
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.save(); ctx.clip();
            dots(ctx, x0, y0, w, h, size * 0.26, 'rgba(255,255,255,0.09)');
            ctx.restore();
            const inset = size * 0.14;
            ctx.setLineDash([size * 0.1, size * 0.08]);
            ctx.lineWidth = Math.max(1.2, size * 0.03);
            ctx.strokeStyle = 'rgba(255,255,255,0.75)';
            roundRect(ctx, x0 + inset, y0 + inset, w - inset * 2, h - inset * 2, radius * 0.4);
            ctx.stroke();
            ctx.setLineDash([]);
            tape(ctx, x0 + size * 0.1, y0 + size * 0.05, size * 1.0, size * 0.32, -0.75, 'rgba(190,170,240,0.85)');
            tape(ctx, x1 - size * 0.1, y1 - size * 0.05, size * 1.0, size * 0.32, -0.75, 'rgba(150,226,214,0.85)');
            const px = size * 0.24;
            ctx.font = font(700, px);
            const text = `#${String(label.number).padStart(2, '0')} ♪`;
            const tw = ctx.measureText(text).width;
            const bx = x0 + w * 0.5 - tw / 2 - px * 0.6, by = y1 - px * 0.7;
            roundRect(ctx, bx, by, tw + px * 1.2, px * 1.4, px * 0.7);
            ctx.fillStyle = '#ffd7a8'; ctx.fill();
            ctx.fillStyle = '#3a2c40';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, bx + px * 0.6, by + px * 0.72);
        }
        ctx.restore();
    };

    /* ───────────────────────── GL ───────────────────────── */

    const SKY_VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
    const SKY_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uText;
uniform sampler2D uGlyph;
uniform sampler2D uPrevText;
uniform sampler2D uCard;      // 卡片（预乘透明度）
uniform sampler2D uPrevCard;
uniform vec2 uDark;           // 这句 / 上一句是不是浅色纸卡（字用深色）
uniform float uCardIn;
uniform float uCarded;
uniform vec2 uRes;
uniform vec2 uTextSize;
uniform float uTime;
uniform float uPrevFade;
uniform float uZoom;
uniform float uPrevZoom;
uniform vec4 uEnter;      // 段落进场：纵移、旋转、模糊（mip 级）、不透明度
uniform vec2 uEnter2;     // 段落进场：缩放、闪白
uniform vec4 uLight[${MAX_LIGHTS}];
uniform vec3 uLightCol[${MAX_LIGHTS}];
uniform int uLightCount;
uniform float uSmoke;
uniform float uPower;
uniform float uSeed;
uniform vec3 uSkyTop;
uniform vec3 uSkyLow;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform float uWaiting;
uniform float uLodBias;   // 字形纹理按屏幕像素，比原来 1600 宽多出来的 mip 级数
uniform vec4 uSpark[6];
uniform int uSparkCount;
uniform vec4 uFuse;      // 导火索两端（纹理坐标）
uniform float uFuseAt;   // 烧到哪里（0..1），<0 不画
uniform float uBloom;    // 副歌泛光
uniform vec3 uTags[4];   // 纸签的颜色
uniform vec4 uPop;       // 鼓点小花：x, y（屏幕）, 已过时间, 色相种子
${Utils.SPLIT_OUT_GLSL}

const vec3 DARK_INK = vec3(0.24, 0.12, 0.2);
const float WATER = ${WATER.toFixed(3)};

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
${Utils.NOISE_GLSL}

// 烟花闪光：每发一个近处的光团和一层铺满天的微光
vec3 glowAt(vec2 p, float aspect, out float total) {
    vec3 col = vec3(0.0);
    total = 0.0;
    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
        if (i >= uLightCount) break;
        vec4 l = uLight[i];
        vec2 d = p - vec2(l.x * aspect, l.y);
        float k = l.z * (exp(-dot(d, d) / (l.w * l.w)) + 0.08);
        col += uLightCol[i] * k;
        total += k;
    }
    return col;
}

// 对岸：远处一层发灰的楼影，近处一排高低不齐的楼：楼顶有水箱、天线（顶上一颗红灯慢慢闪），
// 每栋楼按自己的格子开窗，窗有暖黄、日光灯白两种，少数在换着亮灭。返回颜色和覆盖（a）。
// rim：烟花闪光照亮楼顶边和朝天的面
vec4 skyline(vec2 uv, vec3 glow, float rim) {
    float x = uv.x;
    float y = uv.y - WATER;
    float hill = 0.018 + vnoise(vec2(x * 2.2 + uSeed, 0.0)) * 0.03;
    // 远楼：比天色暗一点，糊在雾里
    float fc = floor(x * 28.0 + uSeed * 3.0);
    float far = hill + 0.03 + hash12(vec2(fc, 21.0)) * 0.05;
    vec4 o = vec4(0.0);
    if (y < far) o = vec4(mix(uSkyLow, uSkyTop, 0.3) * 0.62 + glow * 0.05, 0.92);
    // 近楼
    float cx = x * 46.0 + uSeed * 7.0;
    float cell = floor(cx), lx = fract(cx);
    float hb = hash12(vec2(cell, 3.0));
    float h = hill + (hb < 0.15 ? 0.0 : 0.012 + hash12(vec2(cell, 7.0)) * 0.04 + step(0.9, hb) * 0.035);
    // 楼和楼之间留一条缝，楼宽不一
    float inset = hash12(vec2(cell, 5.0)) * 0.18;
    float body = step(inset, lx) * step(lx, 1.0 - inset * 0.5);
    float top = h;
    // 楼顶：水箱或机房
    float hasBox = step(0.55, hash12(vec2(cell, 13.0)));
    float bx = 0.25 + hash12(vec2(cell, 17.0)) * 0.4;
    float box = hasBox * step(bx, lx) * step(lx, bx + 0.2) * step(y, h + 0.005);
    // 天线
    float hasAnt = step(0.82, hash12(vec2(cell, 19.0)));
    float ax = 0.3 + hash12(vec2(cell, 23.0)) * 0.4;
    float antW = 0.03;
    float ant = hasAnt * step(abs(lx - ax), antW) * step(y, h + 0.02);
    if ((y < h && body > 0.5 && hb >= 0.15) || box > 0.5 || ant > 0.5 || y < hill) {
        vec3 c = mix(uSkyLow * 0.3, vec3(0.0), 0.6);
        // 朝上的面和楼顶边被烟花照到
        float edge = 1.0 - smoothstep(0.0, 0.004, (box > 0.5 ? h + 0.005 : h) - y);
        c += glow * (0.04 + edge * 0.5 * rim);
        c += glow * 0.03 * smoothstep(hill, h, y);
        // 窗：每栋 4 列，层高约 0.0045
        if (y < h - 0.004 && y > hill + 0.004 && body > 0.5 && hb >= 0.15) {
            float wx = (lx - inset) / max(1.0 - inset * 1.5, 0.1) * 4.0;
            float wy = (y - hill) / 0.0045;
            vec2 wid = vec2(floor(wx), floor(wy));
            float inWin = step(0.22, fract(wx)) * step(fract(wx), 0.78) * step(0.28, fract(wy)) * step(fract(wy), 0.78);
            float hw = hash12(wid + vec2(cell * 4.0, 31.0));
            float on = step(0.7, hw);
            // 少数窗过一阵换一次亮灭
            on = mix(on, step(0.5, fract(hw * 13.0 + floor(uTime * 0.07 + hw * 9.0) * 0.37)), step(0.94, hash12(wid + cell)));
            vec3 wc = hw > 0.9 ? vec3(0.78, 0.9, 1.0) : vec3(1.0, 0.76, 0.42);
            c += wc * inWin * on * (0.28 + 0.12 * hash12(wid * 1.7 + cell));
        }
        // 天线顶的红灯
        float lamp = hasAnt * smoothstep(0.006, 0.0, length(vec2((lx - ax) / 46.0 * 1.78, y - h - 0.02))) * (0.5 + 0.5 * sin(uTime * 2.2 + cell));
        c += vec3(1.0, 0.18, 0.12) * lamp * 1.2;
        o = vec4(c, 1.0);
    }
    return o;
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    float aspect = uRes.x / uRes.y;
    vec2 p = vec2(uv.x * aspect, uv.y);

    vec3 col = mix(uSkyLow, uSkyTop, smoothstep(WATER, 0.95, uv.y));
    col += vec3(0.05, 0.025, 0.085) * exp(-pow((uv.y - 0.55) * 3.2, 2.0));
    // 星：很淡，只在天上
    vec2 sc = floor(gl_FragCoord.xy / 2.0);
    float star = step(0.9965, hash12(sc)) * smoothstep(0.4, 0.8, uv.y) * (0.5 + 0.5 * sin(uTime * 1.3 + hash12(sc + 5.0) * 40.0));
    col += star * 0.22;
    // 天边一层暖色的余晖；流星每隔几秒划过一颗
    col += mix(uAccent, vec3(0.95, 0.35, 0.55), 0.55) * exp(-pow((uv.y - WATER - 0.06) * 7.0, 2.0)) * 0.16;
    {
        float slot = floor(uTime / 3.7);
        float ph = fract(uTime / 3.7);
        vec2 h0 = vec2(hash12(vec2(slot, 1.0)), hash12(vec2(slot, 2.0)));
        vec2 o = vec2((0.2 + h0.x * 0.8) * aspect, 0.72 + h0.y * 0.26);
        vec2 dir = normalize(vec2(-0.82, -0.38));
        vec2 head = o + dir * ph * 0.9;
        vec2 d = p - head;
        float along = -dot(d, dir);
        float across = abs(d.x * dir.y - d.y * dir.x);
        float tail = smoothstep(0.22, 0.0, along) * step(0.0, along) * smoothstep(0.0025, 0.0, across);
        col += vec3(0.9, 0.92, 1.0) * tail * smoothstep(0.0, 0.1, ph) * (1.0 - smoothstep(0.35, 0.5, ph)) * 0.55 * step(0.35, h0.x);
    }

    float total;
    vec3 glow = glowAt(p, aspect, total);
    // 火药烟：被闪光照亮才看得见，慢慢往一边飘
    vec2 sp = p * 2.4 + vec2(uTime * 0.025, uTime * 0.008);
    float smoke = vnoise(sp) * 0.6 + vnoise(sp * 2.3 + 3.0) * 0.4;
    smoke *= smoothstep(0.35, 0.7, uv.y + smoke * 0.2);
    col += glow * (0.08 + smoke * 0.45 * uSmoke);

    // 对岸和河面
    if (uv.y < WATER + 0.16 && uv.y >= WATER) {
        vec4 sk = skyline(uv, glow, 1.0);
        col = mix(col, sk.rgb, sk.a);
    }
    if (uv.y < WATER) {
        float depth = (WATER - uv.y) / WATER;
        float ripple = sin(uv.y * 380.0 / (0.3 + depth) + uTime * 1.6 + vnoise(vec2(uv.x * 8.0, uv.y * 60.0)) * 6.0);
        vec2 m = vec2(p.x + ripple * 0.004 * (0.4 + depth), WATER + (WATER - uv.y) * 1.6);
        float mt;
        vec3 mg = glowAt(m, aspect, mt);
        col = mix(uSkyLow, uSkyTop, 0.25) * 0.35 + mg * (0.18 + 0.08 * ripple) * (1.0 - depth * 0.6);
        // 对岸的倒影：楼影和亮窗在水里拉成竖条，越往近处越碎、越暗
        vec2 ru = vec2(uv.x + ripple * 0.003 * (0.3 + depth), WATER + (WATER - uv.y) * 0.4);
        vec4 rk = skyline(ru, mg, 0.0);
        col = mix(col, col * 0.55, rk.a * (1.0 - depth) * 0.7);
        col += max(rk.rgb - mix(uSkyLow * 0.3, vec3(0.0), 0.6), 0.0) * rk.a * (0.75 - depth * 0.6) * (0.75 + 0.25 * ripple);
        col += vec3(1.0, 0.78, 0.45) * step(0.985, hash12(floor(gl_FragCoord.xy / vec2(3.0, 2.0)) + floor(uTime * 3.0))) * 0.04 * (1.0 - depth);
    }

    // 字
    vec2 tc = vec2(uv.x, 1.0 - uv.y);
    vec2 t1 = (tc - 0.5) / uZoom + 0.5;
    if (uEnter.w < 0.999 || uEnter2.y > 0.0) {
        vec2 c1 = (tc - 0.5 - vec2(0.0, uEnter.x)) * vec2(aspect, 1.0);
        float cr = cos(uEnter.y), sr = sin(uEnter.y);
        c1 = mat2(cr, -sr, sr, cr) * c1 / vec2(aspect, 1.0);
        t1 = c1 / (uZoom * uEnter2.x) + 0.5;
    }
    float lit = clamp(total, 0.0, 1.5);
    vec3 tint = total > 0.001 ? glow / total : vec3(1.0);
    // 上一句（连卡片）先画，新的一句盖在上面。字的颜色在这一遍按低分辨率算好三种（没有字、
    // 被这一句的字盖住、被上一句的字盖住），覆盖率和上一句碎成火星的噪点在合成那一遍按屏幕像素算
    vec3 prevInk = vec3(0.0);
    float prevOn = 0.0;
    if (uPrevFade > 0.0) {
        vec2 t0 = (tc - 0.5) / uPrevZoom + 0.5 + vec2(0.0, -(1.0 - uPrevFade) * 0.02);
        vec4 pc = texture(uPrevCard, t0) * uPrevFade;
        col = col * (1.0 - pc.a) + pc.rgb * (0.88 + lit * 0.25);
        prevInk = mix(uInk * (0.8 + lit * 0.45), DARK_INK, uDark.y);
        prevOn = 1.0;
    }
    vec3 under = col;
    vec3 cText, cPrev;
    {
        float lod = uEnter.z > 0.01 ? uEnter.z + uLodBias : 0.0;
        float halo = textureLod(uText, t1, 3.5 + uLodBias).r;
        int gid = int(texelFetch(uText, clamp(ivec2(t1 * uTextSize), ivec2(0), ivec2(uTextSize) - 1), 0).g * 255.0 + 0.5);
        vec2 se = gid > 0 ? texelFetch(uGlyph, ivec2(gid, 0), 0).xy : vec2(1e9);
        float reveal = smoothstep(se.x - 0.12, se.x + 0.12, uTime);
        float singing = smoothstep(se.x - 0.1, se.x + 0.05, uTime) * (1.0 - smoothstep(se.y, se.y + 0.5, uTime));
        // 贴在卡片上的字没唱到也要看得清（贴纸本来就在那儿），只是浅一些
        float body = max(uWaiting, uCarded * 0.45) * (1.0 - reveal) + reveal * (0.7 + lit * 0.4);
        vec3 ink = mix(uInk, uInk * mix(vec3(1.0), tint, 0.5), clamp(lit, 0.0, 1.0)) * (0.8 + lit * 0.45);
        ink = mix(ink, mix(DARK_INK, vec3(0.86, 0.18, 0.46), singing * 0.8), uDark.x);
        vec4 cd = (lod > 0.0 ? textureLod(uCard, t1, lod) : texture(uCard, t1)) * (uEnter.w * uCardIn);
        col = col * (1.0 - cd.a) + cd.rgb * (1.0 + lit * 0.15);
        float keep = 1.0 - cd.a;   // 上一句的字被这一句的卡片盖掉多少
        // 纸签：块里第一个字开唱前 0.15 秒从下往上刷出来
        ivec2 tp = clamp(ivec2(t1 * uTextSize), ivec2(2), ivec2(uTextSize) - 3);
        int sid = int(texelFetch(uText, tp, 0).b * 255.0 + 0.5);
        // 斜着画的纸签边缘有抗锯齿的过渡值，会被当成别的编号：四周都一样才算纸签里面
        if (sid > 0) {
            int s1 = int(texelFetch(uText, tp + ivec2(2, 0), 0).b * 255.0 + 0.5);
            int s2 = int(texelFetch(uText, tp - ivec2(2, 0), 0).b * 255.0 + 0.5);
            int s3 = int(texelFetch(uText, tp + ivec2(0, 2), 0).b * 255.0 + 0.5);
            int s4 = int(texelFetch(uText, tp - ivec2(0, 2), 0).b * 255.0 + 0.5);
            if (s1 != sid || s2 != sid || s3 != sid || s4 != sid) sid = 0;
        }
        if (sid > 0) {
            float st = texelFetch(uGlyph, ivec2(sid, 0), 0).x;
            float on = smoothstep(st - 0.2, st, uTime);
            vec3 tag = uTags[sid % 4];
            col = mix(col, tag * (0.75 + lit * 0.35), on * 0.92);
            keep *= 1.0 - on * 0.92;
        }
        vec3 add = vec3(1.0, 0.96, 0.9) * uEnter2.y   // 闪白
            + (glow * 0.6 + uAccent * singing * 0.25 + uInk * 0.04) * halo * reveal * 0.5 * (1.0 - cd.a * 0.8);
        cText = mix(col, ink, clamp(body, 0.0, 1.0)) + uAccent * singing * 0.4 * (1.0 - uDark.x) + add;
        cPrev = col + (prevInk - under) * keep * prevOn + add;
        col += add;
    }
    vec3 extra = vec3(0.0);

    // 鼓点：天上随手炸开一朵小花（一圈小星，往外散、往下坠、变暗）
    if (uPop.z >= 0.0 && uPop.z < 1.1) {
        vec2 popC = vec2(uPop.x * aspect, uPop.y);
        vec2 d0 = p - popC;
        if (dot(d0, d0) < 0.06) {
            float age = uPop.z;
            vec3 pc = 0.5 + 0.5 * cos(6.2832 * (uPop.w + vec3(0.0, 0.33, 0.67)));
            float rr = 0.09 * (1.0 - exp(-age * 4.0));
            vec2 baseC = popC - vec2(0.0, age * age * 0.04);
            float starGain = (1.0 - age / 1.1) * 1.4;
            for (int i = 0; i < 20; i++) {
                float a = float(i) * 0.314159 + uPop.w * 3.0;
                vec2 d = p - (baseC + vec2(cos(a), sin(a)) * rr);
                extra += pc * exp(-dot(d, d) * 30000.0) * starGain;
            }
            extra += pc * exp(-dot(d0, d0) * 300.0) * exp(-age * 8.0) * 0.4;
        }
    }
    if (uFuseAt >= 0.0) {
        vec2 a = vec2(uFuse.x, 1.0 - uFuse.y), b = vec2(uFuse.z, 1.0 - uFuse.w);
        a = (a - 0.5) * uZoom + 0.5; b = (b - 0.5) * uZoom + 0.5;
        vec2 ab = (b - a) * vec2(aspect, 1.0);
        vec2 ap = (uv - a) * vec2(aspect, 1.0);
        float L = length(ab);
        float k = dot(ap, ab) / (L * L);
        vec2 n = vec2(-ab.y, ab.x) / L;
        float wave = sin(k * L * 70.0) * 0.006;
        float dist = abs(dot(ap, n) - wave);
        float inside = step(0.0, k) * step(k, 1.0);
        float line = smoothstep(0.0022, 0.0006, dist) * inside;
        float burnt = step(k, uFuseAt);
        // 没烧的引线淡淡发亮，烧过的只剩一道浅灰的灰烬
        vec3 fresh = mix(uInk, vec3(0.55, 0.85, 1.0), 0.35) * 0.75;
        vec3 fuseCol = mix(fresh, uInk * 0.3, burnt);
        float fuseK = line * mix(0.85, 0.35, burnt);
        col = mix(col, fuseCol, fuseK); cText = mix(cText, fuseCol, fuseK); cPrev = mix(cPrev, fuseCol, fuseK);
        extra += vec3(0.45, 0.75, 1.0) * smoothstep(0.009, 0.0, dist) * inside * (1.0 - burnt) * 0.05;
        vec2 tip = a + (b - a) * uFuseAt;
        vec2 td = (uv - tip) * vec2(aspect, 1.0);
        float flick = 0.8 + 0.2 * sin(uTime * 47.0);
        extra += vec3(1.0, 0.72, 0.35) * (exp(-dot(td, td) * 9000.0) * 1.6 + exp(-length(td) * 60.0) * 0.35) * flick;
    }
    for (int i = 0; i < 6; i++) {
        if (i >= uSparkCount) break;
        vec4 s = uSpark[i];
        vec2 d = (uv - s.xy) * vec2(aspect, 1.0) / s.z;
        if (min(abs(d.x), abs(d.y)) > 0.12 && dot(d, d) > 0.3) continue;
        float core = exp(-dot(d, d) * 60.0);
        float cross = exp(-abs(d.x) * 70.0) * exp(-abs(d.y) * 4.0) + exp(-abs(d.y) * 70.0) * exp(-abs(d.x) * 4.0);
        extra += mix(uInk, uAccent, 0.5) * (core * 1.3 + cross * 0.5) * s.w;
    }
    extra += glow * uBloom * 0.35 + mix(uSkyTop, uAccent, 0.4) * uBloom * 0.06;
    vec2 v = uv - 0.5;
    float edge = 1.0 - dot(v, v) * 0.7;
    outBase = vec4(clamp((col + extra) * edge, 0.0, 1.0), 1.0);
    outText = vec4(clamp((cText + extra) * edge, 0.0, 1.0), 1.0);
    outPrev = vec4(clamp((cPrev + extra) * edge, 0.0, 1.0), 1.0);
}`;

    // 每个点：第 slot 发烟花的第 p 颗星的第 j 个尾迹点。位置按阻力和重力的闭式解算。
    const SPARK_VERT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uBursts;
uniform int uActive[${MAX_ACTIVE}];
uniform int uActiveCount;
uniform int uPerBurst;
uniform float uTime;
uniform vec2 uRes;
uniform float uTrail;
uniform float uPower;
uniform float uMirror;
out vec3 vCol;

const int TRAIL = ${TRAIL};
const float WATER = ${WATER.toFixed(3)};
const float LIFE[7] = float[7](${LIFE.map(v => v.toFixed(2)).join(', ')});
const float RADIUS[7] = float[7](0.36, 0.30, 0.28, 0.30, 0.36, 0.09, 0.11);
const float DRAG[7] = float[7](2.4, 3.2, 1.7, 2.8, 1.9, 3.0, 3.2);
const float GRAV[7] = float[7](0.09, 0.06, 0.30, 0.06, 0.2, 0.06, 0.05);
const float TAIL[7] = float[7](1.0, 0.2, 1.7, 0.45, 1.35, 0.35, 0.3);
const float SHARE[7] = float[7](1.0, 0.85, 0.6, 0.6, 1.0, 1.0, 0.35);

float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void cull() { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); }

void main() {
    int per = uPerBurst * TRAIL;
    int slot = gl_VertexID / per;
    int rem = gl_VertexID - slot * per;
    int p = rem / TRAIL;
    int j = rem - p * TRAIL;
    if (slot >= uActiveCount) { cull(); return; }
    int bi = uActive[slot];
    vec4 a = texelFetch(uBursts, ivec2(bi, 0), 0);
    vec4 b = texelFetch(uBursts, ivec2(bi, 1), 0);
    float aspect = uRes.x / uRes.y;
    vec2 centre = vec2(a.x * aspect, a.y);
    float tb = a.z;
    int kind = int(a.w + 0.01) & 7;
    bool two = a.w - float(kind) > 0.25;
    float size = b.a;
    float seed = float(bi) * 1.618 + tb;
    float fj = float(j);
    vec2 pos;
    vec3 col;
    float bright;
    float px = uRes.y * 0.005;

    if (uTime < tb) {
        // 升空：只有第一颗星画，尾迹拖在下面，微微摆
        float launch = 0.75 + size * 0.35;
        if (p != 0 || kind == 6) { cull(); return; }
        float k = (uTime - (tb - launch) - fj * 0.03) / launch;
        if (k < 0.0) { cull(); return; }
        float e = 1.0 - (1.0 - k) * (1.0 - k);
        vec2 from = vec2(centre.x + (h1(seed) - 0.5) * 0.06, WATER + 0.02);
        pos = mix(from, centre, e) + vec2(sin(k * 18.0 + seed) * 0.003, 0.0);
        col = vec3(1.0, 0.72, 0.42);
        bright = (1.0 - fj / float(TRAIL)) * 0.7;
        px *= 0.8;
    } else {
        int count = int(float(uPerBurst) * SHARE[kind]);
        if (p >= count) { cull(); return; }
        float life = LIFE[kind];
        float tau = uTime - tb - fj * 0.014 * TAIL[kind] * uTrail;
        if (kind == 5) tau -= float(p % 6) * 0.11;
        if (tau < 0.0 || tau > life) { cull(); return; }
        float fp = float(p);
        float n = float(count);
        vec2 dir;
        if (kind == 3) {
            // 环：倾斜平面上的一圈
            float ang = fp / n * 6.2832;
            float tilt = h1(seed + 2.0) * 3.1416;
            vec2 c = vec2(cos(ang), sin(ang) * (0.35 + h1(seed + 3.0) * 0.5));
            dir = vec2(c.x * cos(tilt) - c.y * sin(tilt), c.x * sin(tilt) + c.y * cos(tilt));
        } else {
            // 球面均匀撒点再投影：边缘密，看上去是一颗立体的球
            float z = 1.0 - 2.0 * (fp + 0.5) / n;
            float rr = sqrt(max(0.0, 1.0 - z * z));
            float phi = fp * 2.39996 + seed;
            dir = vec2(cos(phi), sin(phi)) * rr * (0.9 + h1(fp + seed) * 0.16);
        }
        float R = RADIUS[kind] * size;
        vec2 c0 = centre;
        if (kind == 5) {
            float sub = float(p % 6);
            float ang = sub * 1.047 + seed;
            c0 += vec2(cos(ang), sin(ang)) * 0.12 * size;
        }
        float k = DRAG[kind];
        pos = c0 + dir * R * (1.0 - exp(-k * tau)) - vec2(0.0, GRAV[kind] * tau * tau * 0.5 / (1.0 + tau * 0.4));
        float age = tau / life;
        col = b.rgb;
        if (two && p % 3 == 0) col = col.gbr * 0.6 + vec3(0.4);
        if (kind == 2 || kind == 4) col = mix(vec3(1.0, 0.85, 0.55), vec3(1.0, 0.55, 0.2), age);
        col = mix(vec3(1.0, 0.96, 0.88), col, smoothstep(0.0, 0.18, tau));
        bright = (1.0 + 2.0 * exp(-tau * 9.0)) * smoothstep(1.0, 0.55, age);
        if (kind == 4 || kind == 0) bright *= age > 0.45 ? step(0.35, h1(fp + floor(uTime * 15.0) * 7.1 + seed)) * 1.3 : 1.0;
        bright *= pow(1.0 - fj / float(TRAIL), 1.6);
        px *= j == 0 ? 1.0 : 0.8;
        if (kind == 6) px *= 0.8;
    }
    bright *= 2.1 * (1.0 + uPower * 0.25);
    if (uMirror > 0.5) {
        if (pos.y < WATER + 0.05) { cull(); return; }
        pos.y = WATER - (pos.y - WATER) * 0.55;
        pos.x += sin(pos.y * 160.0 + uTime * 2.0) * 0.004;
        bright *= 0.28;
        px *= 0.85;
    }
    gl_Position = vec4(pos.x / aspect * 2.0 - 1.0, pos.y * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = max(1.5, px);
    vCol = col * bright;
}`;
    const SPARK_FRAG = `#version 300 es
precision mediump float;
in vec3 vCol;
out vec4 outColor;
void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(d, d);
    float a = exp(-r2 * 4.0) * 0.7 + exp(-r2 * 18.0) * 0.6;
    outColor = vec4(vCol * a, 1.0);
}`;

    // 合成那一遍：按屏幕像素重新取样字形（同样的段落进场、推近），上一句按噪点一点点熄掉，熄的边上闪火星
    const COVERAGE = `
uniform sampler2D uText;
uniform sampler2D uPrevText;
uniform float uZoom;
uniform float uPrevZoom;
uniform vec4 uEnter;
uniform vec2 uEnter2;
uniform float uPrevFade;
uniform float uLodBias;
uniform float uCell;
uniform sampler2D uCard;
uniform float uCardIn;
uniform float uPrevGlyphs;   // 1 = 上一句的字由逐字层画退场动作（这里不再画它，也不出火星）
bool inGlyph(sampler2D tex, vec2 t) {
    ivec2 size = textureSize(tex, 0);
    return texelFetch(tex, clamp(ivec2(t * vec2(size)), ivec2(0), size - 1), 0).g > 0.002;
}
vec4 coverage(vec2 uv) {
    float aspect = uRes.x / uRes.y;
    vec2 tc = vec2(uv.x, 1.0 - uv.y);
    vec2 t1 = (tc - 0.5) / uZoom + 0.5;
    if (uEnter.w < 0.999 || uEnter2.y > 0.0) {
        vec2 c1 = (tc - 0.5 - vec2(0.0, uEnter.x)) * vec2(aspect, 1.0);
        float cr = cos(uEnter.y), sr = sin(uEnter.y);
        c1 = mat2(cr, -sr, sr, cr) * c1 / vec2(aspect, 1.0);
        t1 = c1 / (uZoom * uEnter2.x) + 0.5;
    }
    // 这一句的字由逐字层画；这里只画字框以外的（背景里淡淡的大字），覆盖率留给上一句和火星做遮挡
    float r = (uEnter.z > 0.01 ? textureLod(uText, t1, uEnter.z + uLodBias) : texture(uText, t1)).r * uEnter.w;
    vec4 c = vec4(inGlyph(uText, t1) ? 0.0 : r, 0.0, 0.0, 0.0);
    if (uPrevFade > 0.0) {
        vec2 t0 = (tc - 0.5) / uPrevZoom + 0.5 + vec2(0.0, -(1.0 - uPrevFade) * 0.02);
        float r0 = texture(uPrevText, t0).r;
        float n0 = hash12(floor(gl_FragCoord.xy / uCell));
        float keep = smoothstep(1.0 - uPrevFade, 1.0 - uPrevFade + 0.08, n0);
        float ember = (1.0 - keep) * step(1.0 - uPrevFade - 0.12, n0);
        float strong = step(0.4, r0);   // 背景大字（很淡）只淡出，不碎
        c.y = r0 * mix(uPrevFade, keep, strong) * 0.8 * (1.0 - r);
        // 火星在上一句的字上，被这一句的卡片盖住的地方看不见
        float card = texture(uCard, t1).a * uEnter.w * uCardIn;
        c.z = r0 * ember * strong * uPrevFade * 1.4 * (1.0 - card) * (1.0 - r);
        if (uPrevGlyphs > 0.5 && inGlyph(uPrevText, t0)) c.yz = vec2(0.0);
    }
    return c;
}`;
    const POST = 'vec3 post(vec3 col, vec4 c) { return col + vec3(1.0, 0.7, 0.35) * c.z; }';
    // 逐字层：字图坐标 → 屏幕，和上面 coverage 里的 t1 互逆
    const HOME = `
uniform float uZoom;
uniform vec4 uEnter;
uniform vec2 uEnter2;
vec2 home(vec2 t) {
    vec2 tc;
    if (uEnter.w < 0.999 || uEnter2.y > 0.0) {
        float aspect = uTextSize.x / uTextSize.y;
        vec2 c1 = (t - 0.5) * (uZoom * uEnter2.x) * vec2(aspect, 1.0);
        float cr = cos(uEnter.y), sr = sin(uEnter.y);
        tc = mat2(cr, sr, -sr, cr) * c1 / vec2(aspect, 1.0) + 0.5 + vec2(0.0, uEnter.x);
    } else tc = (t - 0.5) * uZoom + 0.5;
    return vec2(tc.x, 1.0 - tc.y);
}`;

    const createGl = (canvas) => {
        const gl = canvas.getContext('webgl2', {
            alpha: false, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'default'
        });
        if (!gl) return null;
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        const texture = (filter, mip) => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        };
        const slots = Array.from({ length: 3 }, () => ({ text: texture(gl.LINEAR, true), card: texture(gl.LINEAR, true), glyph: texture(gl.NEAREST, false), key: null, used: 0 }));
        return {
            gl, sky: Utils.compileProgram(gl, SKY_VERT, SKY_FRAG, 'hanabi:sky'), spark: Utils.compileProgram(gl, SPARK_VERT, SPARK_FRAG, 'hanabi:spark'),
            vao: gl.createVertexArray(), slots, bursts: texture(gl.NEAREST, false), burstsKey: null,
            sharp: Utils.createSharpText(gl, { label: 'hanabi', coverage: COVERAGE, post: POST }),
            glyphs: Utils.createGlyphLayer(gl, { label: 'hanabi', home: HOME }),
            glyphData: new Float32Array(256 * Utils.GLYPH_FLOATS),
            sparkTarget: Utils.createTarget(gl), bloom: Utils.createBloom(gl, { label: 'hanabi', add: true, present: false })
        };
    };

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('hanabi', '花火', container, services);
        const canvas = createElement('canvas', 'hanabi-canvas');
        const kicker = createElement('div', 'hanabi-kicker', '花火');
        const translation = createElement('div', 'stage-translation hanabi-translation');
        const notice = createElement('div', 'hanabi-notice');
        notice.hidden = true;
        // 片尾：最后一段间奏里，右边垂下一条竖写的纸幡——今夜终演、曲名、歌手
        const credits = createElement('div', 'hanabi-credits');
        const creditsTitle = createElement('b');
        const creditsArtist = createElement('span', 'hanabi-credits-artist');
        const creditsKicker = createElement('span', 'hanabi-credits-kicker');
        creditsKicker.append(...['今', '夜', '终', '演'].map(g => createElement('i', '', g)));
        credits.append(creditsKicker, creditsTitle, creditsArtist);
        credits.setAttribute('aria-hidden', 'true');
        let creditsOn = false;
        mode.root.append(canvas, kicker, translation, credits, notice);
        const textCanvas = document.createElement('canvas');
        const cardCanvas = document.createElement('canvas');

        let glState = null;
        try { glState = createGl(canvas); } catch (error) { console.error(error); }
        if (!glState) {
            notice.hidden = false;
            notice.textContent = '这台电脑的显卡不支持 WebGL2，花火画不出来，请换一个舞台';
        }
        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const still = Utils.createStillGate();
        const active = new Int32Array(MAX_ACTIVE);
        const lights = new Float32Array(MAX_LIGHTS * 4);
        const lightColours = new Float32Array(MAX_LIGHTS * 3);
        const sparkBuffer = new Float32Array(24);
        let bloom = 0;
        let lastOnsets = -1;
        let popTime = -Infinity;
        let popAt = [0.5, 0.7, 0];
        const lightPick = [];
        let cues = [];
        let bursts = [];
        let cuesFor = null;
        let world = { W: 0, H: 0 };
        let low = [1, 1];
        let cell = 2;
        let paused = false;
        let latestFrame = null;
        let lastDraw = -Infinity;
        let colours = null;
        let caption = '';
        let lastTranslation = '';
        let lostContext = false;
        let idleHandle = 0;
        const stats = { builds: 0, buildMs: 0, draws: 0, cue: -1, bursts: 0, active: 0 };

        const settings = () => {
            const tuning = mode.config.modes?.hanabi || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                density: clamp(tuning.density ?? 1, 0.4, 1.6),
                trails: clamp(tuning.trails ?? 1, 0, 1.6),
                bloom: clamp(tuning.bloom ?? 1, 0, 2),
                collage: tuning.collage !== false,
                smoke: clamp(tuning.smoke ?? 1, 0, 2),
                reflection: tuning.reflection !== false,
                waitingOpacity: clamp(tuning.waitingOpacity ?? 0.25, 0, 1),
                audioReactivity: clamp(tuning.audioReactivity ?? 1, 0, 2),
                grain: clamp(tuning.grain ?? 0.3, 0, 1),
                showTranslation: tuning.showTranslation !== false,
                reducedMotion: global.MusicStageRuntime.isReducedMotion(reducedMotion),
                quality: mode.config.quality || 'standard'
            };
        };

        // 夜空。浅色主题也是夜里（烟花要在暗处看），只把天色往主题那边带一点。
        const readColours = () => {
            const p = services?.app?.stagePalette || {};
            const bg = hexRgb(p.background, [0.08, 0.09, 0.12]);
            const accent = hexRgb(p.accent, [1.0, 0.62, 0.3]);
            colours = {
                // 夏夜：头顶深靛，往下转紫，近地平线一层梅红
                top: mixRgb(bg, [0.016, 0.02, 0.07], 0.9),
                low: mixRgb(bg, [0.2, 0.075, 0.19], 0.85),
                ink: [0.97, 0.95, 0.92],
                accent,
                // 纸签：浴衣那几种颜色（靛、薄红、若竹、山吹）
                tags: new Float32Array([0.2, 0.36, 0.82, 0.86, 0.36, 0.5, 0.2, 0.62, 0.56, 0.92, 0.7, 0.28])
            };
            mode.root.style.setProperty('--hanabi-sky', `rgb(${colours.top.map(v => Math.round(v * 255)).join(',')})`);
        };

        const resize = () => {
            const w = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            const h = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            const quality = mode.config.quality || 'standard';
            // 画布和字形纹理按屏幕原生像素，天空、烟、倒影按像素预算的低分辨率算（见 Utils.createSharpText）
            const size = Utils.sharpSizes(w, h, PIXELS[quality] || PIXELS.standard);
            low = [size.lw, size.lh];
            cell = 2 * size.native / size.low;
            if (canvas.width !== size.nw || canvas.height !== size.nh) { canvas.width = size.nw; canvas.height = size.nh; still.invalidate(); }
            const W = Math.min(4096, size.nw);
            const H = Math.min(4096, size.nh);
            if (W !== world.W || H !== world.H) {
                world = { W, H };
                textCanvas.width = cardCanvas.width = world.W; textCanvas.height = cardCanvas.height = world.H;
                glState?.slots.forEach((slot) => { slot.key = null; });
            }
        };

        const trackKey = frame => frame.track?.path || frame.track?.title || '';
        const ensureCues = (frame, s = settings()) => {
            const density = s.density;
            const key = `${trackKey(frame)}|${Math.round(frame.duration || 0)}`;
            if (cuesFor && cuesFor.lines === frame.lines && cuesFor.key === key && cuesFor.density === density) return;
            cues = buildCues(frame.lines || [], frame.duration);
            bursts = planShow(cues, key, density);
            cuesFor = { lines: frame.lines, key, density };
            Utils.loadLyricFont(frame.lines, [800], () => { if (mode.destroyed) return; glState?.slots.forEach((slot) => { slot.key = null; }); redraw(); }, `${frame.track?.title || ''}${frame.track?.artist || ''}`);
            stats.bursts = bursts.length;
            glState?.slots.forEach((slot) => { slot.key = null; });
            if (glState) glState.burstsKey = null;
        };

        const uploadBursts = () => {
            if (!glState || glState.burstsKey === cuesFor) return;
            const data = new Float32Array(MAX_BURSTS * 2 * 4);
            bursts.forEach((b, i) => {
                data.set([b.x, b.y, b.t, b.kind + (b.two ? 0.5 : 0)], i * 4);
                data.set([b.colour[0], b.colour[1], b.colour[2], b.size], (MAX_BURSTS + i) * 4);
            });
            const { gl } = glState;
            gl.bindTexture(gl.TEXTURE_2D, glState.bursts);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, MAX_BURSTS, 2, 0, gl.RGBA, gl.FLOAT, data);
            glState.burstsKey = cuesFor;
        };

        let cachedFamily = '';
        const family = () => {
            if (!cachedFamily) cachedFamily = global.getComputedStyle?.(mode.root).fontFamily || 'system-ui, sans-serif';
            return cachedFamily;
        };

        // 荧光笔：浅纸上是黄色记号笔，深色卡和夜空上用主题色，淡一些
        const markerColour = slot => (slot.dark ? [1.0, 0.86, 0.3, 0.62] : [...(colours?.accent || [0.95, 0.66, 0]), 0.42]);
        // 字排好后，把这一句跟着字开的小花挪到那个字的正上方（屏幕坐标，y 朝上）
        const anchorPops = (index, placed) => {
            let moved = false;
            for (const b of bursts) {
                if (!b.anchor || b.anchor.cue !== index) continue;
                const g = placed.find(p => Math.abs(p.start - b.anchor.start) < 1e-3);
                if (!g) continue;
                b.x = clamp(g.x, 0.04, 0.96);
                b.y = clamp(1 - (g.y - g.size * 1.05), 0.08, 0.95);
                moved = true;
            }
            if (moved && glState) glState.burstsKey = null;
        };

        // 一句的字形图：在河岸上方居中，同一个字号；G 是字编号（字框）
        const slotFor = (index, build = true, s = settings()) => {
            if (!glState || index < 0 || index >= cues.length) return null;
            const key = `${cuesFor?.key}|${index}|${world.W}x${world.H}|${s.fontScale}|${s.collage}`;
            const hit = glState.slots.find(slot => slot.key === key);
            if (hit) { hit.used = performance.now(); return hit; }
            if (!build) return null;
            const started = performance.now();
            const cue = cues[index];
            const { W, H } = world;
            const ctx = textCanvas.getContext('2d', { alpha: false });
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, W, H);
            const cctx = cardCanvas.getContext('2d');
            cctx.setTransform(1, 0, 0, 1, 0, 0);
            cctx.clearRect(0, 0, W, H);
            let cardStyle = null;
            let glyphs = [];
            if (cue.kind === 'line') glyphs = buildGlyphTimeline(cue.line).map(g => ({ text: g.text, start: g.startTime, end: g.endTime }));
            else if (cue.title) {
                const title = String(latestFrame?.track?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg)$/i, '');
                glyphs = Array.from(title).map((text, i) => ({ text, start: cue.start + 0.8 + i * 0.07, end: cue.start + 1.2 + i * 0.07 }));
            }
            const data = new Float32Array(256 * 4);
            const placed = [];
            let fuse = null;
            const random = seededRandom(`hanabi:${cuesFor?.key}:${index}:layout`);
            if (glyphs.length) {
                const visible = glyphs.filter(g => g.text.trim()).length;
                const cjk = glyphs.filter(g => CJK.test(g.text)).length > visible / 2;
                const font = size => `800 ${size.toFixed(1)}px ${family()}`;
                // 两种排法：河岸上方一两行；或者竖着斜挂在天上，每个词块左边贴一条彩色纸签
                // 副歌改成拼贴：词块大小不一、各自歪一点，像剪下来贴在夜空上，一两块垫着彩纸
                const collage = cue.kind === 'line' && cue.chorus && s.collage && visible >= 3 && visible <= 28;
                const vertical = !collage && cue.kind === 'line' && cjk && visible <= 16 && random() < 0.5;
                cue.layout = collage ? 'collage' : vertical ? 'tanzaku' : 'row';
                const items = [];
                const tagged = [];
                let tilt = 0;
                let cols = 1;
                if (collage) {
                    const chunks = [];
                    let cur = [];
                    let left = 0;
                    glyphs.forEach((g) => {
                        if (!g.text.trim()) { if (cur.length) chunks.push(cur); cur = []; left = 0; return; }
                        if (cjk && left <= 0 && cur.length) { chunks.push(cur); cur = []; }
                        if (cjk && left <= 0) left = 1 + Math.floor(random() * 3);
                        cur.push(g);
                        left -= 1;
                    });
                    if (cur.length) chunks.push(cur);
                    const hero = chunks.reduce((best, c, i) => (c.length > chunks[best].length ? i : best), Math.floor(random() * chunks.length));
                    const boxes = chunks.map((c, ci) => {
                        const text = c.map(g => g.text).join('');
                        let size = H * (ci === hero ? 0.15 + random() * 0.04 : 0.065 + random() * 0.05) * s.fontScale;
                        ctx.font = font(size);
                        let w = ctx.measureText(text).width;
                        if (w > W * 0.62) { size *= W * 0.62 / w; ctx.font = font(size); w = ctx.measureText(text).width; }
                        const rot = (random() - 0.5) * (ci === hero ? 0.12 : 0.26);
                        return { c, size, w, rot, dy: (random() - 0.5) * size * 0.5 };
                    });
                    // 从左往右排，满了换行；整块放在河岸上方的夜空里
                    const maxW = W * 0.82;
                    const rowsC = [];
                    let rowC = [], rowW = 0;
                    boxes.forEach((b) => {
                        const gap = b.size * 0.28;
                        if (rowC.length && rowW + gap + b.w > maxW) { rowsC.push(rowC); rowC = []; rowW = 0; }
                        rowW += (rowC.length ? gap : 0) + b.w;
                        rowC.push(b);
                    });
                    if (rowC.length) rowsC.push(rowC);
                    const rowH = rowsC.map(r => Math.max(...r.map(b => b.size)) * 1.18);
                    let y = H * 0.4 - rowH.reduce((a, v) => a + v, 0) / 2;
                    y = Math.max(H * 0.1, y);
                    rowsC.forEach((r, ri) => {
                        const total = r.reduce((a, b, i) => a + b.w + (i ? b.size * 0.28 : 0), 0);
                        let x = (W - total) / 2 + (random() - 0.5) * W * 0.06;
                        const base = y + rowH[ri] * 0.82;
                        r.forEach((b, i) => {
                            if (i) x += b.size * 0.28;
                            const bl = base + b.dy;
                            const pivot = [x + b.w / 2, bl - b.size * 0.35];
                            const first = items.length + 1;
                            let gx = x;
                            b.c.forEach((g) => {
                                ctx.font = font(b.size);
                                items.push({ g, x: gx, baseline: bl, size: b.size, chunk: chunks.indexOf(b.c), rot: b.rot, pivot });
                                gx += ctx.measureText(g.text).width;
                            });
                            if (b.c === chunks[hero] || random() < 0.22) tagged.push({ x0: x, x1: x + b.w, bl, size: b.size, rot: b.rot, pivot, first: Math.min(255, first) });
                            x += b.w;
                        });
                        y += rowH[ri];
                    });
                } else if (vertical) {
                    // 竖排卡片：字多时分两列，从右往左读
                    cols = visible > 6 ? 2 : 1;
                    const perCol = Math.ceil(visible / cols);
                    const size = clamp(H * 0.5 / perCol, H * 0.05, H * 0.085) * s.fontScale;
                    tilt = (0.06 + random() * 0.12) * (random() < 0.5 ? 1 : -1);
                    const ox0 = W * (0.5 + (random() - 0.5) * 0.16) + (cols - 1) * size * 0.62;
                    const top = H * 0.4 - perCol * size * 1.04 / 2 + size * 0.8;
                    let col = 0, inCol = 0, y = top;
                    let chunk = 0, left = 0;
                    glyphs.forEach((g) => {
                        if (!g.text.trim()) { left = 0; if (inCol) y += size * 0.35; return; }
                        if (inCol >= perCol && col < cols - 1) { col += 1; inCol = 0; y = top + size * 0.5; left = 0; }
                        if (left <= 0) { chunk += 1; left = 1 + Math.floor(random() * 3); }
                        items.push({ g, x: ox0 - col * size * 1.3 - size / 2, baseline: y, size, chunk });
                        left -= 1;
                        inCol += 1;
                        y += size * 1.04;
                    });
                } else {
                    const rows = [];
                    const perRow = cjk ? 12 : 26;
                    let row = [];
                    glyphs.forEach((g, i) => {
                        row.push(g);
                        const filled = row.filter(x => x.text.trim()).length;
                        const target = Math.ceil(visible / Math.ceil(visible / perRow));
                        // 西文在空格、连字符处换行；一个词长得放不下时硬断
                        if (filled >= target && (cjk || !g.text.trim() || /^[-–—/]$/.test(g.text) || filled >= target * 1.6 || i === glyphs.length - 1)) { rows.push(row); row = []; }
                    });
                    if (row.length) rows.push(row);
                    ctx.font = font(100);
                    const widest = Math.max(...rows.map(r => ctx.measureText(r.map(g => g.text).join('').trim()).width));
                    const size = Math.min(clamp(W * 0.56 / widest * 100, H * 0.045, H * 0.085) * s.fontScale, W * 0.9 / widest * 100);
                    ctx.font = font(size);
                    const lineH = size * 1.3;
                    // 字在河岸上方，留出天空给烟花
                    // 行多了往上让，最后一行不压到河岸下面的翻译
                    const top = H * 0.42 - rows.length * lineH / 2 + size * 0.95;
                    tilt = (0.06 + random() * 0.16) * (random() < 0.5 ? 1 : -1);
                    rows.forEach((r, ri) => {
                        const trimmed = r.map(g => g.text).join('').replace(/\s+$/, '');
                        let x = (W - ctx.measureText(trimmed).width) / 2;
                        r.forEach((g) => {
                            const w = ctx.measureText(g.text).width;
                            if (g.text.trim()) items.push({ g, x, baseline: top + ri * lineH, size, chunk: 0 });
                            x += w;
                        });
                    });
                }
                // 背景：这句里最长的词放大、淡淡地斜着铺两三遍（被烟花照到才看得清）
                if (cue.kind === 'line') {
                    const words = [];
                    let w = '';
                    glyphs.forEach((g) => { if (g.text.trim()) w += g.text; else { if (w) words.push(w); w = ''; } });
                    if (w) words.push(w);
                    const word = cjk ? Array.from(words.join('')).slice(Math.floor(random() * 3), 3 + Math.floor(random() * 3)).join('')
                        : words.sort((a, b) => b.length - a.length)[0] || '';
                    if (word) {
                        ctx.save();
                        ctx.globalCompositeOperation = 'lighter';
                        ctx.fillStyle = 'rgb(26,0,0)';
                        const big = H * (0.15 + random() * 0.04);
                        ctx.font = `800 ${big.toFixed(1)}px ${family()}`;
                        ctx.translate(W * (random() < 0.5 ? 0.06 : 0.62), H * (0.2 + random() * 0.12));
                        ctx.rotate((random() - 0.5) * 0.5 + 0.18);
                        ctx.fillText(word, 0, 0);
                        ctx.restore();
                    }
                }
                // 卡片：字的外框加留白；转一点角度后整张要留在天上（河岸和翻译之上）
                const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
                let unit = 0;
                items.forEach((it) => {
                    ctx.font = font(it.size);
                    it.w = ctx.measureText(it.g.text).width;
                    box.x0 = Math.min(box.x0, it.x - (vertical ? it.size * 0.32 : 0));
                    box.x1 = Math.max(box.x1, it.x + it.w);
                    box.y0 = Math.min(box.y0, it.baseline - it.size * 0.92);
                    box.y1 = Math.max(box.y1, it.baseline + it.size * 0.2);
                    unit = Math.max(unit, it.size);
                });
                let style = null;
                if (items.length && cue.kind === 'line') {
                    const r = random();
                    style = vertical ? (r < 0.65 ? 'tag' : 'paper') : (r < 0.5 ? 'paper' : 'window');
                    cardStyle = style;
                    const padX = unit * (collage ? 0.4 : 0.55), padY = unit * 0.45;
                    box.x0 -= padX; box.x1 += padX; box.y0 -= padY; box.y1 += padY + (style === 'tag' ? unit * 0.3 : 0);
                    const cardTilt = collage ? (random() - 0.5) * 0.12 : tilt;
                    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
                    const c = Math.abs(Math.cos(cardTilt)), sn = Math.abs(Math.sin(cardTilt));
                    const hw = ((box.x1 - box.x0) * c + (box.y1 - box.y0) * sn) / 2 + unit * 0.3;
                    const hh = ((box.x1 - box.x0) * sn + (box.y1 - box.y0) * c) / 2 + unit * 0.5 + (style === 'window' ? unit * 0.46 : 0);
                    const dx = clamp(cx, W * 0.03 + hw, W * 0.97 - hw) - cx || 0;
                    const dy = clamp(cy, H * 0.05 + hh, H * 0.72 - hh) - cy || 0;
                    if (dx || dy) {
                        const moved = new Set();
                        items.forEach((it) => { it.x += dx; it.baseline += dy; if (it.pivot && !moved.has(it.pivot)) { moved.add(it.pivot); it.pivot[0] += dx; it.pivot[1] += dy; } });
                        tagged.forEach((tg) => { tg.x0 += dx; tg.x1 += dx; tg.bl += dy; if (!moved.has(tg.pivot)) { moved.add(tg.pivot); tg.pivot[0] += dx; tg.pivot[1] += dy; } });
                        box.x0 += dx; box.x1 += dx; box.y0 += dy; box.y1 += dy;
                    }
                    const bc = [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
                    cctx.save();
                    cctx.translate(bc[0], bc[1]); cctx.rotate(cardTilt); cctx.translate(-bc[0], -bc[1]);
                    const files = ['night_sky.png', 'summer.txt', 'hanabi.jpg', 'memo_0801.txt', 'river.png'];
                    paintCard(cctx, style, box, unit, { number: cue.number || index + 1, file: files[Math.floor(random() * files.length)] }, random,
                        (weight, px) => `${weight} ${px.toFixed(1)}px ${family()}`);
                    cctx.restore();
                }
                ctx.save();
                const cos = Math.cos(tilt), sin = Math.sin(tilt);
                const pivot = items.length ? [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2] : [W / 2, H / 2];
                ctx.translate(pivot[0], pivot[1]); ctx.rotate(tilt); ctx.translate(-pivot[0], -pivot[1]);
                const toTex = (x, y) => {
                    const dx = x - pivot[0], dy = y - pivot[1];
                    return [(pivot[0] + dx * cos - dy * sin) / W, (pivot[1] + dx * sin + dy * cos) / H];
                };
                // 拼贴的彩纸：B 通道存这块第一个字的编号，开唱时刷出颜色
                tagged.forEach((tg) => {
                    ctx.save();
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.translate(tg.pivot[0], tg.pivot[1]); ctx.rotate(tg.rot * 1.4); ctx.translate(-tg.pivot[0], -tg.pivot[1]);
                    ctx.globalCompositeOperation = 'lighten';
                    ctx.fillStyle = `rgb(0,0,${tg.first})`;
                    const pad = tg.size * 0.14;
                    ctx.fillRect(Math.floor(tg.x0 - pad), Math.floor(tg.bl - tg.size * 0.92 - pad * 0.5), Math.ceil(tg.x1 - tg.x0 + pad * 2), Math.ceil(tg.size * 1.12 + pad));
                    ctx.restore();
                });
                let id = 0;
                let chunkFirst = 0, lastChunk = -1;
                items.forEach(({ g, x, baseline, size, chunk, rot, pivot: own }) => {
                    ctx.font = font(size);
                    const w = ctx.measureText(g.text).width;
                    // 卡片上的字的深色描边、硬投影、浅纸压痕交给逐字层（跟着字一起动），不再画进卡片图
                    id = Math.min(255, id + 1);
                    if (own) {
                        ctx.save();
                        ctx.setTransform(1, 0, 0, 1, 0, 0);
                        ctx.translate(own[0], own[1]); ctx.rotate(rot); ctx.translate(-own[0], -own[1]);
                    }
                    if (vertical && chunk !== lastChunk) { chunkFirst = id; lastChunk = chunk; }
                    if (vertical) {
                        // 纸签（B 通道存这一块第一个字的编号，着色器按它开唱的时刻点亮）
                        ctx.globalCompositeOperation = 'lighten';
                        ctx.fillStyle = `rgb(0,0,${chunkFirst})`;
                        ctx.fillRect(Math.floor(x - size * 0.3), Math.floor(baseline - size * 0.9), Math.ceil(size * 0.16), Math.ceil(size * 0.96));
                    }
                    ctx.globalCompositeOperation = 'lighten';
                    ctx.fillStyle = `rgb(0,${id},0)`;
                    const gx = Math.floor(x - 2), gy = Math.floor(baseline - size * 0.95), gw = Math.ceil(w + 4), gh = Math.ceil(size * 1.2);
                    ctx.fillRect(gx, gy, gw, gh);
                    // 逐字层的外框：字框四角经过当前变换后的外接矩形，再留出描边和投影的边
                    const m = ctx.getTransform();
                    const corners = [[gx, gy], [gx + gw, gy], [gx, gy + gh], [gx + gw, gy + gh]].map(([u, v]) => [m.a * u + m.c * v + m.e, m.b * u + m.d * v + m.f]);
                    const padG = size * 0.14;
                    const gbox = [
                        (Math.min(...corners.map(q => q[0])) - padG) / W, (Math.min(...corners.map(q => q[1])) - padG) / H,
                        (Math.max(...corners.map(q => q[0])) + padG) / W, (Math.max(...corners.map(q => q[1])) + padG) / H
                    ];
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.fillStyle = 'rgb(255,0,0)';
                    ctx.fillText(g.text, x, baseline);
                    data[id * 4] = g.start;
                    data[id * 4 + 1] = g.end;
                    if (own) ctx.restore();
                    let c;
                    if (own) {
                        const dx = x + w / 2 - own[0], dy = baseline - size * 0.35 - own[1];
                        c = [(own[0] + dx * Math.cos(rot) - dy * Math.sin(rot)) / W, (own[1] + dx * Math.sin(rot) + dy * Math.cos(rot)) / H];
                    } else c = toTex(x + w / 2, baseline - size * 0.35);
                    placed.push({ x: c[0], y: c[1], size: size / H, w: w / W, start: g.start, end: g.end, id, box: gbox, px: size, ang: own ? rot : tilt, hw: w / 2 });
                });
                ctx.restore();
                // 导火索：沿着字走一条波浪线，按唱到的位置烧过去
                if (placed.length > 1 && cue.kind === 'line' && !collage && cols === 1 && (vertical || Math.abs(placed[0].y - placed[placed.length - 1].y) < 0.01)) {
                    const a = placed[0], b = placed[placed.length - 1];
                    const off = vertical ? [cos * a.size * 0.55 * H / W, sin * a.size * 0.55] : [0, a.size * 0.62];
                    const back = vertical ? [-sin * a.size * 0.6 * H / W, cos * a.size * 0.6] : [-a.w * 0.6, 0];
                    fuse = [a.x + off[0] - back[0], a.y + off[1] - back[1], b.x + off[0] + back[0] * 0.5, b.y + off[1] + back[1] * 0.5];
                }
            }
            const { gl } = glState;
            const busy = new Set([stats.cue, stats.cue - 1].map(i => `${cuesFor?.key}|${i}|${world.W}x${world.H}|${s.fontScale}|${s.collage}`));
            const slot = glState.slots.filter(sl => !busy.has(sl.key)).sort((a, b) => a.used - b.used)[0] || glState.slots[0];
            gl.bindTexture(gl.TEXTURE_2D, slot.text);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.bindTexture(gl.TEXTURE_2D, slot.card);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cardCanvas);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.bindTexture(gl.TEXTURE_2D, slot.glyph);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 1, 0, gl.RGBA, gl.FLOAT, data);
            slot.key = key;
            slot.dark = cardStyle === 'paper' ? 1 : 0;
            slot.carded = cardStyle ? 1 : 0;
            slot.rim = cardStyle === 'paper' ? 2 : cardStyle ? 1 : 0;
            // 这一句的字怎么进场、唱到时怎么动
            const pick = seededRandom(`hanabi:${cuesFor?.key}:${index}:glyphs`);
            const enters = cue.kind === 'line' ? ['pop', 'rise', 'drop', 'stamp', 'spin', 'slide'] : ['rise'];
            slot.enter = enters[Math.floor(pick() * enters.length)];
            slot.sing = ['bounce', 'swell', 'nod', 'flash'][Math.floor(pick() * 4)];
            // 退场：碎成火星（原来的做法）、像柳火一样落下、散成星屑、往上飘走
            slot.exit = ['dissolve', 'fall', 'scatter', 'ascend'][Math.floor(pick() * 4)];
            // 横排的句子里约四成用荧光笔：唱到哪个字，字底就擦出一道色带
            slot.marker = cue.kind === 'line' && cue.layout !== 'tanzaku' && pick() < 0.4;
            slot.glyphs = placed;
            anchorPops(index, placed);
            slot.fuse = fuse;
            slot.used = performance.now();
            stats.builds += 1;
            stats.buildMs = Math.round(performance.now() - started);
            return slot;
        };

        const cancelIdle = () => {
            if (!idleHandle) return;
            (global.cancelIdleCallback || global.clearTimeout)(idleHandle);
            idleHandle = 0;
        };

        const scheduleNext = (index, s = settings()) => {
            if (idleHandle || paused || !glState || index + 1 >= cues.length || slotFor(index + 1, false, s)) return;
            const run = () => { idleHandle = 0; if (!mode.destroyed && !paused && !lostContext) slotFor(index + 1, true); };
            idleHandle = global.requestIdleCallback ? global.requestIdleCallback(run, { timeout: 700 }) : global.setTimeout(run, 120);
        };

        const enterBuf = new Float32Array(4);
        const enter2Buf = new Float32Array(2);
        const sortByPowerDesc = (a, b) => b.power - a.power;
        // 照亮天空和字的闪光：挑此刻最亮的几发
        const pickLights = (t, count) => {
            lightPick.length = 0;
            for (let i = 0; i < count; i += 1) {
                const b = bursts[active[i]];
                const tau = t - b.t;
                if (tau < 0) continue;
                const life = LIFE[b.kind];
                const power = b.size * (Math.exp(-tau * 3.2) * 1.1 + 0.22 * (1 - smooth(0, life, tau))) * (b.kind === KIND.pop ? 0.5 : 1);
                lightPick.push({ b, power, radius: 0.16 + Math.min(tau, 1.2) * 0.14 * b.size });
            }
            if (lightPick.length > 1) lightPick.sort(sortByPowerDesc);
            const n = Math.min(MAX_LIGHTS, lightPick.length);
            for (let i = 0; i < n; i += 1) {
                const { b, power, radius } = lightPick[i];
                const o4 = i * 4;
                lights[o4] = b.x; lights[o4 + 1] = b.y; lights[o4 + 2] = power * 0.55; lights[o4 + 3] = radius;
                const o3 = i * 3;
                lightColours[o3] = b.colour[0]; lightColours[o3 + 1] = b.colour[1]; lightColours[o3 + 2] = b.colour[2];
            }
            return n;
        };

        const draw = (frame, s = settings()) => {
            if (!glState || lostContext) return;
            const { gl, sky, spark, vao } = glState;
            const t = frame.playbackTime;
            const index = findCue(cues, t);
            const cue = cues[index];
            const slot = slotFor(index, true, s);
            if (!cue || !slot) return;
            uploadBursts();
            stats.cue = index;
            const local = t - cue.start;
            const prev = index > 0 && local < 0.4 ? slotFor(index - 1, false, s) : null;
            // 段落进场：长间奏后的第一句。三种：从上方带着速度落下来（上升）、闪白、从大到小开花
            enterBuf[0] = 0; enterBuf[1] = 0; enterBuf[2] = 0; enterBuf[3] = 1;
            enter2Buf[0] = 1; enter2Buf[1] = 0;
            const enter = enterBuf, enter2 = enter2Buf;
            if (!s.reducedMotion && cue.kind === 'line' && index > 0 && cues[index - 1].kind === 'rest' && local < ENTER) {
                const p = clamp(local / ENTER, 0, 1);
                const launch = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (2 - x));
                const kinds = ['ascend', 'ascend', 'flash', 'bloom'];
                const kind = kinds[Math.floor(seededRandom(`enter:${cuesFor?.key}:${index}`)() * kinds.length)];
                if (kind === 'ascend') {
                    const k = launch(1 - p);
                    enter[0] = -0.22 * k; enter[1] = -0.22 * k; enter[2] = 3.5 * k; enter[3] = 1 - 0.8 * k;
                } else if (kind === 'flash') {
                    enter2[1] = 0.3 * Math.pow(1 - p, 2.4); enter[3] = smooth(0, 0.35, p);
                } else {
                    const k = 1 - smooth(0, 1, p);
                    enter2[0] = 1 + 0.35 * k; enter[2] = 3 * k; enter[3] = 1 - 0.85 * k;
                }
            }
            const prevFade = prev ? 1 - smooth(0, 0.4, local) : 0;
            const prevGlyphs = Boolean(prev && prev.exit && prev.exit !== 'dissolve' && prev.glyphs?.length);
            const zoom = 1 + clamp(local / Math.max(1, cue.end - cue.start), 0, 1) * 0.03;
            const audio = frame.audio || {};
            const power = clamp(((audio.power || 0) * 0.6 + (audio.bass || 0) * 0.4) * s.audioReactivity, 0, 1.5);
            const count = activeAt(bursts, t, active);
            stats.active = count;
            const lightCount = pickLights(t, count);
            // 唱到的字：右上角闪一颗星；导火索按唱到的位置烧
            let sparks = 0;
            sparkBuffer.fill(0);
            let fuseAt = -1;
            const placed = slot.glyphs || [];
            if (placed.length) {
                if (slot.fuse) {
                    let k = 0;
                    while (k < placed.length && placed[k].start <= t) k += 1;
                    if (k === 0) fuseAt = 0;
                    else if (k >= placed.length) fuseAt = 1;
                    else {
                        const a = placed[k - 1], b = placed[k];
                        fuseAt = (k - 1 + clamp((t - a.start) / Math.max(0.05, b.start - a.start), 0, 1)) / (placed.length - 1);
                    }
                }
                if (!s.reducedMotion) {
                    for (let gi = 0; gi < placed.length; gi += 1) {
                        const g = placed[gi];
                        const tau = t - g.start;
                        if (tau < -0.05 || tau > 0.7 || sparks >= 6) continue;
                        const o = sparks * 4;
                        sparkBuffer[o] = (g.x + g.w * 0.45 - 0.5) * zoom + 0.5;
                        sparkBuffer[o + 1] = 1 - ((g.y - g.size * 0.45 - 0.5) * zoom + 0.5);
                        sparkBuffer[o + 2] = g.size * 2.2;
                        sparkBuffer[o + 3] = Math.sin(clamp((tau + 0.05) / 0.75, 0, 1) * Math.PI) * 0.8;
                        sparks += 1;
                    }
                }
            }
            const energy = clamp(((audio.energy || 0) - 0.55) * 2.2 * s.audioReactivity, 0, 1);
            bloom += (energy - bloom) * 0.08;

            const { sharp } = glState;
            sharp.begin(low[0], low[1]);
            gl.bindVertexArray(vao);
            gl.disable(gl.BLEND);
            let u = sky.uniforms;
            gl.useProgram(sky.program);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.text); gl.uniform1i(u.uText, 0);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, slot.glyph); gl.uniform1i(u.uGlyph, 1);
            gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, (prev || slot).text); gl.uniform1i(u.uPrevText, 2);
            gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, slot.card); gl.uniform1i(u.uCard, 5);
            gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, (prev || slot).card); gl.uniform1i(u.uPrevCard, 6);
            gl.uniform2f(u.uDark, slot.dark || 0, prev?.dark || 0);
            gl.uniform1f(u.uCarded, slot.carded || 0);
            const cardIn = s.reducedMotion ? 1 : smooth(0, 0.16, local + (index === 0 ? 1 : 0));
            gl.uniform1f(u.uCardIn, cardIn);
            Utils.bindNoise(gl, u.uNoise, 4);
            gl.uniform2f(u.uRes, low[0], low[1]);
            gl.uniform2f(u.uTextSize, world.W, world.H);
            const lodBias = Math.log2(world.W / 1600);
            gl.uniform1f(u.uLodBias, lodBias);
            gl.uniform1f(u.uTime, t);
            gl.uniform1f(u.uPrevFade, prevFade);
            gl.uniform1f(u.uZoom, s.reducedMotion ? 1 : zoom);
            gl.uniform1f(u.uPrevZoom, s.reducedMotion ? 1 : 1.03);
            gl.uniform4fv(u.uEnter, enter);
            gl.uniform2fv(u.uEnter2, enter2);
            gl.uniform4fv(u.uLight, lights);
            gl.uniform3fv(u.uLightCol, lightColours);
            gl.uniform1i(u.uLightCount, lightCount);
            gl.uniform1f(u.uSmoke, s.smoke);
            gl.uniform1f(u.uPower, power);
            gl.uniform1f(u.uSeed, (cuesFor?.key.length || 0) % 7);
            gl.uniform3fv(u.uSkyTop, colours.top);
            gl.uniform3fv(u.uSkyLow, colours.low);
            gl.uniform3fv(u.uInk, colours.ink);
            gl.uniform3fv(u.uAccent, colours.accent);
            gl.uniform1f(u.uWaiting, s.waitingOpacity);
            gl.uniform4fv(u.uSpark, sparkBuffer);
            gl.uniform1i(u.uSparkCount, sparks);
            if (slot.fuse) gl.uniform4fv(u.uFuse, slot.fuse);
            gl.uniform1f(u.uFuseAt, slot.fuse ? fuseAt : -1);
            gl.uniform1f(u.uBloom, s.reducedMotion ? 0 : bloom * s.bloom);
            gl.uniform3fv(u.uTags, colours.tags);
            if (Number.isFinite(audio.onsets) && audio.onsets !== lastOnsets) {
                if (lastOnsets >= 0 && frame.isPlaying && s.audioReactivity > 0 && t - popTime > 0.6) {
                    popTime = t;
                    popAt = [0.15 + Math.random() * 0.7, 0.55 + Math.random() * 0.35, Math.random()];
                }
                lastOnsets = audio.onsets;
            }
            gl.uniform4f(u.uPop, popAt[0], popAt[1], s.reducedMotion ? -1 : t - popTime, popAt[2]);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            sharp.finish(canvas.width, canvas.height, { grain: s.grain, grainStep: s.reducedMotion ? 0 : Math.floor(t * 6) % 64 }, (c, unit) => {
                gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, slot.text); gl.uniform1i(c.uText, unit);
                gl.activeTexture(gl.TEXTURE0 + unit + 1); gl.bindTexture(gl.TEXTURE_2D, (prev || slot).text); gl.uniform1i(c.uPrevText, unit + 1);
                gl.uniform1f(c.uZoom, s.reducedMotion ? 1 : zoom);
                gl.uniform1f(c.uPrevZoom, s.reducedMotion ? 1 : 1.03);
                gl.uniform4fv(c.uEnter, enter);
                gl.uniform2fv(c.uEnter2, enter2);
                gl.uniform1f(c.uPrevFade, prevFade);
                gl.uniform1f(c.uLodBias, lodBias);
                gl.uniform1f(c.uCell, cell);
                gl.activeTexture(gl.TEXTURE0 + unit + 2); gl.bindTexture(gl.TEXTURE_2D, slot.card); gl.uniform1i(c.uCard, unit + 2);
                gl.uniform1f(c.uCardIn, cardIn);
                gl.uniform1f(c.uPrevGlyphs, prevGlyphs ? 1 : 0);
            });
            // 上一句的退场：字各自落下、散开或飘走（碎成火星的那种仍由合成那一遍画）
            if (prevGlyphs) {
                const data = glState.glyphData;
                const k = 1 - prevFade;
                let n = 0;
                (prev.glyphs || []).forEach((g, i) => {
                    if (!g.box || n >= 256) return;
                    const pose = Utils.glyphExit(prev.exit, k, i, s.reducedMotion);
                    if (pose[4] <= 0.001) return;
                    const o = n * Utils.GLYPH_FLOATS;
                    data.set(g.box, o);
                    data[o + 4] = g.x; data[o + 5] = g.y; data[o + 6] = g.id; data[o + 7] = g.px;
                    data[o + 8] = pose[0] * g.px; data[o + 9] = pose[1] * g.px; data[o + 10] = pose[2]; data[o + 11] = pose[3];
                    data[o + 12] = pose[4]; data[o + 13] = pose[5]; data[o + 14] = prev.rim || 0; data[o + 15] = 0;
                    data[o + 16] = prev.marker ? 1 : 0; data[o + 17] = 1; data[o + 18] = g.ang || 0; data[o + 19] = g.hw || 0;
                    n += 1;
                });
                const pz = s.reducedMotion ? 1 : 1.03;
                glState.glyphs.draw(data, n, (c) => {
                    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, prev.text); gl.uniform1i(c.uText, 0);
                    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sharp.prevLayer); gl.uniform1i(c.uTextLayer, 1);
                    gl.uniform2f(c.uTextSize, world.W, world.H);
                    gl.uniform1f(c.uLod, -1);
                    gl.uniform1f(c.uFade, 1);
                    // 退场的字飞到新卡片前面、夜空里，原位的颜色（卡片色）不再合适：用这句自己的墨色
                    const ink = prev.dark ? [0.8, 0.42, 0.62] : colours.ink.map(v => v * 0.92);
                    gl.uniform4f(c.uFill, ink[0], ink[1], ink[2], 1);
                    gl.uniform4fv(c.uBlockCol, markerColour(prev));
                    gl.uniform1f(c.uZoom, pz);
                    // 上一句的取样带一点往上的位移（见 COVERAGE 里的 t0）：借进场的平移参数表达
                    gl.uniform4f(c.uEnter, (1 - prevFade) * 0.02 * pz, 0, 0, 0.5);
                    gl.uniform2f(c.uEnter2, 1, 0);
                });
            }
            // 逐字层：每个字按自己的入场和唱到的动作画在合成好的画面上
            {
                const data = glState.glyphData;
                let n = 0;
                const still = s.reducedMotion;
                const list = slot.glyphs || [];
                const stagger = Math.min(0.045, 0.55 / Math.max(1, list.length));
                list.forEach((g, i) => {
                    if (!g.box || n >= 256) return;
                    const pose = Utils.glyphPose(slot.enter, t - cue.start - i * stagger, slot.sing, t - g.start, still);
                    if (pose[4] <= 0.001) return;
                    const o = n * Utils.GLYPH_FLOATS;
                    data.set(g.box, o);
                    data[o + 4] = g.x; data[o + 5] = g.y; data[o + 6] = g.id; data[o + 7] = g.px;
                    data[o + 8] = pose[0] * g.px; data[o + 9] = pose[1] * g.px; data[o + 10] = pose[2]; data[o + 11] = pose[3];
                    data[o + 12] = pose[4]; data[o + 13] = pose[5]; data[o + 14] = slot.rim || 0; data[o + 15] = 0;
                    data[o + 16] = slot.marker ? 1 : 0;
                    data[o + 17] = clamp((t - g.start + 0.04) / Math.max(0.14, (g.end - g.start) * 0.6), 0, 1);
                    data[o + 18] = g.ang || 0; data[o + 19] = g.hw || 0;
                    n += 1;
                });
                glState.glyphs.draw(data, n, (c) => {
                    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.text); gl.uniform1i(c.uText, 0);
                    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sharp.textLayer); gl.uniform1i(c.uTextLayer, 1);
                    gl.uniform2f(c.uTextSize, world.W, world.H);
                    gl.uniform1f(c.uLod, enter[2] > 0.01 ? enter[2] + lodBias : -1);
                    gl.uniform1f(c.uFade, enter[3]);
                    gl.uniform4f(c.uFill, 0, 0, 0, 0);
                    gl.uniform4fv(c.uBlockCol, markerColour(slot));
                    gl.uniform1f(c.uZoom, s.reducedMotion ? 1 : zoom);
                    gl.uniform4fv(c.uEnter, enter);
                    gl.uniform2fv(c.uEnter2, enter2);
                });
                stats.glyphs = n;
            }
            gl.bindVertexArray(vao);

            if (count) {
                const quality = mode.config.quality || 'standard';
                const per = PER_BURST[quality] || PER_BURST.standard;
                u = spark.uniforms;
                gl.useProgram(spark.program);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.ONE, gl.ONE);
                gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, glState.bursts); gl.uniform1i(u.uBursts, 3);
                gl.uniform1iv(u.uActive, active);
                gl.uniform1i(u.uActiveCount, count);
                gl.uniform1i(u.uPerBurst, per);
                gl.uniform1f(u.uTime, t);
                gl.uniform2f(u.uRes, canvas.width, canvas.height);
                gl.uniform1f(u.uTrail, s.trails);
                gl.uniform1f(u.uPower, power);
                const mirror = s.reflection && quality !== 'energy-saving';
                const points = () => {
                    gl.uniform1f(u.uMirror, 0);
                    gl.drawArrays(gl.POINTS, 0, count * per * TRAIL);
                    if (mirror) {
                        gl.uniform1f(u.uMirror, 1);
                        gl.drawArrays(gl.POINTS, 0, count * per * TRAIL);
                    }
                };
                points();
                // 泛光只给火星：火星另画一遍到半分辨率的小图上（黑底），模糊后叠回来。卡片和字不进泛光，不会被照白
                if (SPARK_BLOOM > 0) {
                    const { sparkTarget, bloom } = glState;
                    const hw = Math.max(1, canvas.width >> 1), hh = Math.max(1, canvas.height >> 1);
                    sparkTarget.bind(hw, hh);
                    gl.disable(gl.BLEND);
                    gl.clearColor(0, 0, 0, 1);
                    gl.clear(gl.COLOR_BUFFER_BIT);
                    gl.enable(gl.BLEND);
                    gl.uniform2f(u.uRes, hw, hh);
                    points();
                    const glowTex = bloom.run(sparkTarget, null, [0.0, 0.08], 1);
                    bloom.add(glowTex, canvas.width, canvas.height, SPARK_BLOOM * (1 + power * 0.5));
                    gl.bindVertexArray(vao);
                }
                gl.disable(gl.BLEND);
            }
            stats.draws += 1;
            scheduleNext(index, s);
        };

        const updateOverlay = (frame, s = settings()) => {
            const next = `花火 · ${Utils.lineCounter(frame)}`;
            if (next !== caption) { caption = next; kicker.textContent = next; }
            const ci = cues.length > 1 ? findCue(cues, frame.playbackTime || 0) : -1;
            const outro = ci === cues.length - 1 && cues[ci]?.kind === 'rest' && (frame.playbackTime || 0) - cues[ci].start > 1.2;
            if (outro !== creditsOn) {
                creditsOn = outro;
                if (outro) {
                    // 竖写：一个字一格往下排（不靠 writing-mode，字体缺竖排度量时也不会挤在一起）
                    const column = (el, text, max) => {
                        const glyphs = splitGraphemes(text).filter(g => g.trim()).slice(0, max);
                        el.replaceChildren(...glyphs.map(g => createElement('i', '', g)));
                    };
                    column(creditsTitle, String(frame.track?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg|aac|ape|opus)$/i, '').trim() || '无题', 14);
                    column(creditsArtist, String(frame.track?.artist || '').trim(), 10);
                }
                credits.classList.toggle('is-on', outro);
            }
            const text = s.showTranslation ? resolveSupplementalText(frame.activeLine) : '';
            if (text !== lastTranslation) { lastTranslation = text; translation.textContent = text; translation.hidden = !text; }
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            frame = Utils.withPlainLyrics(frame);   // 只有纯文本歌词时按时长铺开
            latestFrame = frame;
            if (!colours) readColours();
            const s = settings();
            ensureCues(frame, s);
            updateOverlay(frame, s);
            if (!glState || lostContext || !Runtime.programsReady(glState.gl, redraw)) return;
            const aim = 1000 / (FPS[s.quality] || 30);
            const now = frame.now ?? performance.now();
            if (now < lastDraw) lastDraw = -Infinity;
            if (frame.isPlaying && now - lastDraw < aim - 3) return;
            if (!frame.isPlaying && still.same(frame, `${canvas.width}x${canvas.height}|${stats.builds}`)) return;
            if (frame.isPlaying) still.invalidate();
            lastDraw = now - lastDraw < aim * 2 ? lastDraw + aim : now;
            draw(frame, s);
        };

        const redraw = () => { still.invalidate(); lastDraw = -Infinity; if (latestFrame) mode.updateFrame(latestFrame); };
        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => { updateConfig(config); cachedFamily = ''; resize(); readColours(); redraw(); };
        mode.resize = () => { resize(); redraw(); };
        mode.suspend = () => { paused = true; cancelIdle(); mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; mode.root.classList.remove('is-suspended'); redraw(); };
        mode.updateTheme = () => { cachedFamily = ''; readColours(); redraw(); };
        mode.getDebugSnapshot = () => ({
            initialized: Boolean(glState), cues: cues.length, cue: stats.cue, bursts: stats.bursts, active: stats.active,
            builds: stats.builds, buildMs: stats.buildMs, draws: stats.draws, buffer: `${canvas.width}x${canvas.height}`, effects: `${low[0]}x${low[1]}`
        });

        const onLost = (event) => { event.preventDefault(); lostContext = true; Runtime.cancelPrograms(glState?.gl); };
        const onRestored = () => { try { glState = createGl(canvas); lostContext = false; redraw(); } catch (error) { console.error(error); } };
        canvas.addEventListener('webglcontextlost', onLost);
        canvas.addEventListener('webglcontextrestored', onRestored);
        mode.scope.add(() => {
            canvas.removeEventListener('webglcontextlost', onLost);
            canvas.removeEventListener('webglcontextrestored', onRestored);
            cancelIdle();
            if (glState) {
                const { gl } = glState;
                Runtime.cancelPrograms(gl);
                glState.slots.forEach((slot) => { gl.deleteTexture(slot.text); gl.deleteTexture(slot.card); gl.deleteTexture(slot.glyph); });
                gl.deleteTexture(glState.bursts);
                gl.deleteProgram(glState.sky.program);
                gl.deleteProgram(glState.spark.program);
                glState.sharp.dispose();
                glState.glyphs.dispose();
                glState.sparkTarget.dispose();
                glState.bloom.dispose();
                gl.deleteVertexArray(glState.vao);
                Runtime.releaseWebGLContext(gl);
            }
            glState = null;
            textCanvas.width = textCanvas.height = 0;
            cardCanvas.width = cardCanvas.height = 0;
        });

        resize();
        return mode;
    };

    global.MusicStageHanabiManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ buildCues, findCue, planShow, activeAt, LIFE })
    });
})(window);
